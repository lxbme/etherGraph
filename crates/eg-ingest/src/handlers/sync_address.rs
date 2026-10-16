//! `SyncAddress`: pages an address's transfer history into Postgres, newest
//! first, one kind at a time, resuming from the saved progress.
//!
//! Progress is committed with every page, so a resumed job continues at the
//! next unfetched page. Coverage (`address_sync` blocks) is only written in
//! the same transaction as a kind's last page.

use async_trait::async_trait;
use eg_core::source::{HistoryQuery, Priority, SourceError};
use eg_core::types::{Address, TransferKind};
use eg_store::{JobRow, JobStatus, SyncRow, SyncState, SyncUpdate};
use serde::{Deserialize, Serialize};

use crate::cursor::{Cursor, Step, advance};
use crate::enqueue::SyncDirection;
use crate::events::Event;
use crate::runner::{JobCtx, JobError, JobHandler, will_retry};

#[derive(Serialize, Deserialize)]
pub struct SyncParams {
    pub address: Address,
    pub direction: SyncDirection,
    /// Empty means all five kinds.
    pub kinds: Vec<TransferKind>,
}

impl SyncParams {
    fn kinds(&self) -> Vec<TransferKind> {
        if self.kinds.is_empty() {
            TransferKind::ALL.to_vec()
        } else {
            self.kinds.clone()
        }
    }
}

/// `kind_index == kinds.len()` once every kind is done. `start_block` and
/// `cursor` belong to the kind at `kind_index`.
#[derive(Serialize, Deserialize)]
pub struct SyncProgress {
    pub kind_index: usize,
    pub cursor: Cursor,
    pub head: u64,
    pub start_block: u64,
}

pub struct SyncAddressHandler;

/// Everything a run needs that does not change between pages.
struct Plan<'a> {
    job: &'a JobRow,
    ctx: &'a JobCtx,
    address: Address,
    direction: SyncDirection,
    kinds: Vec<TransferKind>,
}

#[async_trait]
impl JobHandler for SyncAddressHandler {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let params: SyncParams = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad sync params: {e}")))?;
        let plan = Plan {
            job,
            ctx,
            address: params.address,
            direction: params.direction,
            kinds: params.kinds(),
        };
        let mut prog = match &job.progress {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| JobError::Invalid(format!("bad sync progress: {e}")))?,
            None => {
                let head = ctx.source.latest_block(Priority::Interactive).await?;
                let rows = ctx.store.sync_rows(&[plan.address]).await?;
                let p = plan.progress_from(0, &rows, head);
                ctx.store.update_progress(job.id, &to_json(&p)?).await?;
                p
            }
        };
        while let Some(&kind) = plan.kinds.get(prog.kind_index) {
            ctx.store
                .set_sync_state(plan.address, kind, SyncState::Syncing)
                .await?;
            match plan.sync_kind(kind, prog).await {
                Ok(next) => prog = next,
                Err(e) => {
                    plan.mark_failed_unless_resumed(kind, &e).await;
                    return Err(e);
                }
            }
        }
        Ok(())
    }
}

impl Plan<'_> {
    /// Block range `(start, end)` to fetch for `kind`, or `None` when there
    /// is nothing to fetch in this direction.
    fn range(&self, existing: Option<&SyncRow>, head: u64) -> Option<(u64, u64)> {
        match self.direction {
            SyncDirection::Latest => {
                let reorg = self.ctx.cfg.reorg_window_blocks;
                let start = existing
                    .and_then(|r| r.to_block)
                    .map_or(0, |to| to.saturating_sub(reorg));
                Some((start, head))
            }
            SyncDirection::Older => match existing? {
                SyncRow {
                    from_block: Some(from),
                    to_block: Some(_),
                    truncated: true,
                    ..
                } if *from > 0 => Some((0, *from)),
                _ => None,
            },
        }
    }

    /// Progress positioned at the first kind at or after `index` that has
    /// something to fetch.
    fn progress_from(&self, index: usize, rows: &[SyncRow], head: u64) -> SyncProgress {
        for (i, kind) in self.kinds.iter().enumerate().skip(index) {
            let existing = rows.iter().find(|r| r.kind == *kind);
            if let Some((start_block, end)) = self.range(existing, head) {
                return SyncProgress {
                    kind_index: i,
                    cursor: Cursor::new(end),
                    head,
                    start_block,
                };
            }
        }
        SyncProgress {
            kind_index: self.kinds.len(),
            cursor: Cursor::new(0),
            head,
            start_block: 0,
        }
    }

    /// Coverage after a kind completed. `min_block` falls back to the window
    /// end when nothing was seen (only possible with a zero cap).
    fn coverage(
        &self,
        kind: TransferKind,
        existing: Option<&SyncRow>,
        prog: &SyncProgress,
        truncated: bool,
        min_block: Option<u64>,
    ) -> SyncUpdate {
        let oldest = min_block.unwrap_or(prog.cursor.end_block);
        let (from_block, to_block, truncated) = match self.direction {
            SyncDirection::Latest if truncated => (oldest, prog.head, true),
            // The older boundary is unchanged, and so is its truncation.
            SyncDirection::Latest => (
                existing.and_then(|r| r.from_block).unwrap_or(0),
                prog.head,
                existing.is_some_and(|r| r.truncated),
            ),
            SyncDirection::Older => (
                if truncated { oldest } else { 0 },
                existing.and_then(|r| r.to_block).unwrap_or(prog.head),
                truncated,
            ),
        };
        SyncUpdate {
            address: self.address,
            kind,
            from_block,
            to_block,
            truncated,
        }
    }

    /// Pages through `kind` until done; returns the progress for the next kind.
    async fn sync_kind(
        &self,
        kind: TransferKind,
        mut prog: SyncProgress,
    ) -> Result<SyncProgress, JobError> {
        let (ctx, job) = (self.ctx, self.job);
        let page_size = ctx.cfg.page_size;
        let cap = ctx.cfg.max_records_per_category;
        loop {
            if ctx.store.cancel_requested(job.id).await? {
                return Err(JobError::Cancelled);
            }
            let priority = if prog.cursor.fetched == 0 {
                Priority::Interactive
            } else {
                Priority::Background
            };
            let q = HistoryQuery {
                address: self.address,
                kind,
                start_block: prog.start_block,
                end_block: prog.cursor.end_block,
                page: prog.cursor.page,
                offset: page_size,
            };
            let page = match ctx.source.history_page(priority, &q).await {
                Err(SourceError::WindowTooLarge) => {
                    return Err(JobError::Invalid(format!(
                        "result window exceeded: page {} x {page_size}",
                        q.page
                    )));
                }
                r => r?,
            };
            let fetched = prog.cursor.fetched.saturating_add(page.row_count);
            let (next, update) = match advance(&prog.cursor, &page, page_size, cap) {
                Step::Next(cursor) => (SyncProgress { cursor, ..prog }, None),
                Step::Done {
                    truncated,
                    min_block,
                } => {
                    let rows = ctx.store.sync_rows(&[self.address]).await?;
                    let existing = rows.iter().find(|r| r.kind == kind);
                    let update = self.coverage(kind, existing, &prog, truncated, min_block);
                    let next = self.progress_from(prog.kind_index + 1, &rows, prog.head);
                    (next, Some(update))
                }
            };
            ctx.store
                .write_page(
                    job.id,
                    &page.transfers,
                    &page.tokens,
                    &to_json(&next)?,
                    update.as_ref(),
                )
                .await?;
            ctx.bus.publish(Event::AddressDataChanged {
                address: self.address,
            });
            ctx.bus.publish(Event::JobProgress {
                job_id: job.id,
                kind: job.kind,
                fetched,
                cursor_block: Some(q.end_block),
                status: JobStatus::Running,
            });
            if update.is_some() {
                return Ok(next);
            }
            prog = next;
        }
    }

    /// Leaves the kind `syncing` when the runner will resume the job (quota
    /// pause or retry); otherwise marks it `failed`. Coverage is untouched.
    async fn mark_failed_unless_resumed(&self, kind: TransferKind, e: &JobError) {
        let resumed = matches!(e, JobError::Source(SourceError::QuotaExhausted))
            || will_retry(e, self.job, &self.ctx.cfg);
        if resumed {
            return;
        }
        if let Err(err) = self
            .ctx
            .store
            .set_sync_state(self.address, kind, SyncState::Failed)
            .await
        {
            tracing::warn!(job_id = self.job.id, error = %err, "failed to mark sync failed");
        }
    }
}

fn to_json(p: &SyncProgress) -> Result<serde_json::Value, JobError> {
    serde_json::to_value(p).map_err(|e| JobError::Invalid(format!("encode progress: {e}")))
}
