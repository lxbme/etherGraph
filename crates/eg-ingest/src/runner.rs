//! Job runner: workers claim jobs from Postgres and dispatch to handlers.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use eg_core::source::{ChainSource, Priority, SourceError};
use eg_store::{JobKind, JobRow, JobStatus, Store, StoreError};
use futures::FutureExt;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tracing::Instrument;

use crate::config::IngestConfig;
use crate::events::{Event, EventBus};

#[derive(thiserror::Error, Debug)]
pub enum JobError {
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("cancelled")]
    Cancelled,
    #[error("invalid job: {0}")]
    Invalid(String),
}

impl JobError {
    fn is_retryable(&self) -> bool {
        match self {
            JobError::Source(e) => e.is_retryable(),
            JobError::Store(_) => true,
            JobError::Cancelled | JobError::Invalid(_) => false,
        }
    }
}

/// Whether the runner re-queues `job` after it failed with `e` (quota pauses
/// are handled separately).
pub(crate) fn will_retry(e: &JobError, job: &JobRow, cfg: &IngestConfig) -> bool {
    e.is_retryable() && job.attempts + 1 < cfg.max_attempts
}

#[derive(Clone)]
pub struct JobCtx {
    pub store: Store,
    pub source: Arc<dyn ChainSource>,
    pub bus: EventBus,
    pub cfg: Arc<IngestConfig>,
    pub wake: Arc<Notify>,
}

#[async_trait]
pub trait JobHandler: Send + Sync {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError>;
}

pub struct Runner;

type Handlers = Arc<HashMap<JobKind, Arc<dyn JobHandler>>>;

impl Runner {
    /// With two or more workers, worker #0 is reserved for Interactive jobs so
    /// a user request never waits behind long Background/Low jobs.
    pub fn spawn(
        ctx: JobCtx,
        workers: usize,
        handlers: HashMap<JobKind, Arc<dyn JobHandler>>,
    ) -> Vec<JoinHandle<()>> {
        let handlers: Handlers = Arc::new(handlers);
        (0..workers)
            .map(|i| {
                let max = if i == 0 && workers > 1 {
                    Priority::Interactive.as_i16()
                } else {
                    i16::MAX
                };
                tokio::spawn(worker_loop(ctx.clone(), handlers.clone(), max))
            })
            .collect()
    }
}

fn publish_status(ctx: &JobCtx, job: &JobRow, status: JobStatus) {
    ctx.bus.publish(Event::JobProgress {
        job_id: job.id,
        kind: job.kind,
        fetched: 0,
        cursor_block: None,
        status,
    });
}

/// Claims only jobs whose priority is at most `max_priority`.
async fn worker_loop(ctx: JobCtx, handlers: Handlers, max_priority: i16) {
    loop {
        // Register interest before claiming so a notify between the claim and
        // the wait is not lost.
        let notified = ctx.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        match ctx.store.claim_next_with_max_priority(max_priority).await {
            Ok(Some(job)) => {
                let span = tracing::info_span!("job", id = job.id, kind = job.kind.as_str());
                process(&ctx, &handlers, job).instrument(span).await
            }
            Ok(None) => {
                let _ = tokio::time::timeout(Duration::from_secs(1), notified).await;
            }
            Err(e) => {
                tracing::warn!(error = %e, "claim_next failed");
                let _ = tokio::time::timeout(Duration::from_secs(1), notified).await;
            }
        }
    }
}

fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown".into())
}

async fn record_outcome(
    ctx: &JobCtx,
    job: &JobRow,
    result: &Result<(), JobError>,
) -> (JobStatus, Result<(), StoreError>) {
    match result {
        Ok(()) => (JobStatus::Done, ctx.store.complete_job(job.id).await),
        Err(JobError::Source(SourceError::QuotaExhausted)) => (
            JobStatus::PausedQuota,
            ctx.store.pause_job_quota(job.id).await,
        ),
        Err(JobError::Cancelled) => (JobStatus::Cancelled, ctx.store.mark_cancelled(job.id).await),
        Err(e) => {
            let retry = will_retry(e, job, &ctx.cfg);
            let status = if retry {
                JobStatus::Pending
            } else {
                JobStatus::Failed
            };
            (
                status,
                ctx.store.fail_job(job.id, &e.to_string(), retry).await,
            )
        }
    }
}

async fn process(ctx: &JobCtx, handlers: &Handlers, job: JobRow) {
    publish_status(ctx, &job, JobStatus::Running);
    let result = match handlers.get(&job.kind) {
        Some(h) => match AssertUnwindSafe(h.run(&job, ctx)).catch_unwind().await {
            Ok(r) => r,
            Err(p) => Err(JobError::Invalid(format!(
                "handler panicked: {}",
                panic_message(p.as_ref())
            ))),
        },
        None => Err(JobError::Invalid("no handler".into())),
    };
    // Retrying the write re-applies the same idempotent-enough transition; a
    // failed write would otherwise leave the job stuck in `running`.
    let mut backoff = Duration::from_millis(100);
    for attempt in 0..4 {
        let (status, outcome) = record_outcome(ctx, &job, &result).await;
        match outcome {
            Ok(()) => {
                publish_status(ctx, &job, status);
                if status == JobStatus::Pending {
                    ctx.wake.notify_waiters();
                }
                return;
            }
            Err(e) if attempt == 3 => {
                tracing::error!(job_id = job.id, error = %e, "failed to record job outcome");
                return;
            }
            Err(e) => {
                tracing::warn!(job_id = job.id, error = %e, "retrying outcome write");
                tokio::time::sleep(backoff).await;
                backoff *= 2;
            }
        }
    }
}
