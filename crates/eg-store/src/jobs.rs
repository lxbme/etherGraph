use chrono::{DateTime, Utc};
use eg_core::source::Priority;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::postgres::PgRow;
use ts_rs::TS;

use crate::{Result, Store, StoreError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JobKind {
    SyncAddress,
    FetchTx,
    ContractMeta,
    ResolveNames,
    TokenMeta,
    FetchBlock,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::SyncAddress => "sync_address",
            JobKind::FetchTx => "fetch_tx",
            JobKind::ContractMeta => "contract_meta",
            JobKind::ResolveNames => "resolve_names",
            JobKind::TokenMeta => "token_meta",
            JobKind::FetchBlock => "fetch_block",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "sync_address" => JobKind::SyncAddress,
            "fetch_tx" => JobKind::FetchTx,
            "contract_meta" => JobKind::ContractMeta,
            "resolve_names" => JobKind::ResolveNames,
            "token_meta" => JobKind::TokenMeta,
            "fetch_block" => JobKind::FetchBlock,
            _ => return Err(StoreError::Invalid(format!("unknown job kind {s}"))),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JobStatus {
    Pending,
    Running,
    PausedQuota,
    Done,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Pending => "pending",
            JobStatus::Running => "running",
            JobStatus::PausedQuota => "paused_quota",
            JobStatus::Done => "done",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "pending" => JobStatus::Pending,
            "running" => JobStatus::Running,
            "paused_quota" => JobStatus::PausedQuota,
            "done" => JobStatus::Done,
            "failed" => JobStatus::Failed,
            "cancelled" => JobStatus::Cancelled,
            _ => return Err(StoreError::Invalid(format!("unknown job status {s}"))),
        })
    }
}

/// Pending jobs older than this are claimed as if their priority were Background.
pub const AGING_SECS: f64 = 120.0;

#[derive(Clone, Debug)]
pub struct NewJob {
    pub key: String,
    pub kind: JobKind,
    pub params: serde_json::Value,
    pub priority: Priority,
}

#[derive(Clone, Debug)]
pub struct JobRow {
    pub id: i64,
    pub key: String,
    pub kind: JobKind,
    pub params: serde_json::Value,
    pub priority: Priority,
    pub status: JobStatus,
    pub progress: Option<serde_json::Value>,
    pub attempts: i32,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

macro_rules! job_cols {
    () => {
        "id, key, kind, params, priority, status, progress, attempts, error, created_at, updated_at"
    };
}

fn job_row(r: &PgRow) -> Result<JobRow> {
    let kind: String = r.try_get("kind")?;
    let status: String = r.try_get("status")?;
    Ok(JobRow {
        id: r.try_get("id")?,
        key: r.try_get("key")?,
        kind: JobKind::parse(&kind)?,
        params: r.try_get("params")?,
        priority: Priority::from_i16(r.try_get("priority")?),
        status: JobStatus::parse(&status)?,
        progress: r.try_get("progress")?,
        attempts: r.try_get("attempts")?,
        error: r.try_get("error")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

impl Store {
    /// Returns `(id, true)` for a new job, or the existing active job's
    /// `(id, false)` when one with the same key is pending/running/paused. A
    /// more urgent request raises the existing job's priority.
    pub async fn enqueue(&self, j: &NewJob) -> Result<(i64, bool)> {
        // The conflicting job may finish between the INSERT and the SELECT, so retry.
        for _ in 0..5 {
            let inserted: Option<i64> = sqlx::query_scalar(
                "INSERT INTO jobs (key, kind, params, priority, status) \
                 VALUES ($1, $2, $3, $4, 'pending') \
                 ON CONFLICT (key) WHERE status IN ('pending','running','paused_quota') \
                 DO NOTHING RETURNING id",
            )
            .bind(&j.key)
            .bind(j.kind.as_str())
            .bind(&j.params)
            .bind(j.priority.as_i16())
            .fetch_optional(&self.pool)
            .await?;
            if let Some(id) = inserted {
                return Ok((id, true));
            }
            let existing: Option<i64> = sqlx::query_scalar(
                "SELECT id FROM jobs WHERE key = $1 \
                 AND status IN ('pending','running','paused_quota')",
            )
            .bind(&j.key)
            .fetch_optional(&self.pool)
            .await?;
            if let Some(id) = existing {
                // Same as `priority = LEAST(priority, $2)`, without rewriting
                // the row when nothing changes.
                sqlx::query("UPDATE jobs SET priority = $2 WHERE id = $1 AND priority > $2")
                    .bind(id)
                    .bind(j.priority.as_i16())
                    .execute(&self.pool)
                    .await?;
                return Ok((id, false));
            }
        }
        Err(StoreError::Invalid(format!(
            "enqueue of key {} kept racing with job completion",
            j.key
        )))
    }

    /// Claims the most urgent, oldest pending job and marks it running. A job
    /// waiting longer than [`AGING_SECS`] is ordered as if it were Background.
    pub async fn claim_next(&self) -> Result<Option<JobRow>> {
        self.claim_next_with_max_priority(i16::MAX).await
    }

    /// Like [`Store::claim_next`], restricted to jobs whose own priority is at
    /// most `max` (`0` claims Interactive jobs only); aging affects ordering only.
    pub async fn claim_next_with_max_priority(&self, max: i16) -> Result<Option<JobRow>> {
        let sql = concat!(
            "UPDATE jobs SET status = 'running', updated_at = now() WHERE id = ( \
             SELECT id FROM jobs WHERE status = 'pending' AND priority <= $1 \
             ORDER BY LEAST(priority, CASE WHEN now() - created_at > make_interval(secs => $2) \
             THEN 1 ELSE priority END) ASC, created_at ASC, id ASC \
             FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING ",
            job_cols!()
        );
        let row = sqlx::query(sql)
            .bind(max)
            .bind(AGING_SECS)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(job_row).transpose()
    }

    pub async fn update_progress(&self, id: i64, p: &serde_json::Value) -> Result<()> {
        let res = sqlx::query("UPDATE jobs SET progress = $1, updated_at = now() WHERE id = $2")
            .bind(p)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub async fn complete_job(&self, id: i64) -> Result<()> {
        self.set_status(id, "done", true).await
    }

    /// Increments `attempts`, records the error, and re-queues (`retry`) or fails the job.
    pub async fn fail_job(&self, id: i64, err: &str, retry: bool) -> Result<()> {
        let status = if retry { "pending" } else { "failed" };
        let res = sqlx::query(
            "UPDATE jobs SET status = $1, error = $2, attempts = attempts + 1, \
             updated_at = now() WHERE id = $3",
        )
        .bind(status)
        .bind(err)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub async fn pause_job_quota(&self, id: i64) -> Result<()> {
        self.set_status(id, "paused_quota", false).await
    }

    pub async fn resume_paused(&self) -> Result<u64> {
        let res = sqlx::query(
            "UPDATE jobs SET status = 'pending', updated_at = now() WHERE status = 'paused_quota'",
        )
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Pending and quota-paused jobs become cancelled; running jobs get
    /// `cancel_requested`. Returns the job's kind and resulting status (`Cancelled`, or `Running`
    /// when only flagged); `None` for an unknown or finished job.
    pub async fn cancel_job(&self, id: i64) -> Result<Option<(JobKind, JobStatus)>> {
        let row: Option<(String, String)> = sqlx::query_as(
            "UPDATE jobs SET updated_at = now(), \
             status = CASE WHEN status IN ('pending', 'paused_quota') THEN 'cancelled' \
             ELSE status END, \
             cancel_requested = (status = 'running') OR cancel_requested \
             WHERE id = $1 AND status IN ('pending', 'running', 'paused_quota') \
             RETURNING kind, status",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|(k, st)| Ok((JobKind::parse(&k)?, JobStatus::parse(&st)?)))
            .transpose()
    }

    /// [`Store::cancel_job`] applied to every active job that is not
    /// Interactive; returns each affected job's id, kind and resulting status.
    pub async fn cancel_background(&self) -> Result<Vec<(i64, JobKind, JobStatus)>> {
        let rows: Vec<(i64, String, String)> = sqlx::query_as(
            "UPDATE jobs SET updated_at = now(), \
             status = CASE WHEN status IN ('pending', 'paused_quota') THEN 'cancelled' \
             ELSE status END, \
             cancel_requested = (status = 'running') OR cancel_requested \
             WHERE priority > $1 AND status IN ('pending', 'running', 'paused_quota') \
             RETURNING id, kind, status",
        )
        .bind(Priority::Interactive.as_i16())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(id, k, st)| Ok((id, JobKind::parse(&k)?, JobStatus::parse(&st)?)))
            .collect()
    }

    pub async fn cancel_requested(&self, id: i64) -> Result<bool> {
        sqlx::query_scalar("SELECT cancel_requested FROM jobs WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(StoreError::NotFound)
    }

    pub async fn mark_cancelled(&self, id: i64) -> Result<()> {
        self.set_status(id, "cancelled", false).await
    }

    /// Startup recovery: running jobs go back to pending.
    pub async fn reset_running(&self) -> Result<u64> {
        let res = sqlx::query(
            "UPDATE jobs SET status = 'pending', updated_at = now() WHERE status = 'running'",
        )
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// The `limit` most recently created jobs of any status, newest first.
    pub async fn recent_jobs(&self, limit: u32) -> Result<Vec<JobRow>> {
        let sql = concat!(
            "SELECT ",
            job_cols!(),
            " FROM jobs ORDER BY created_at DESC, id DESC LIMIT $1"
        );
        let rows = sqlx::query(sql)
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(job_row).collect()
    }

    pub async fn job(&self, id: i64) -> Result<Option<JobRow>> {
        let sql = concat!("SELECT ", job_cols!(), " FROM jobs WHERE id = $1");
        let row = sqlx::query(sql).bind(id).fetch_optional(&self.pool).await?;
        row.as_ref().map(job_row).transpose()
    }

    pub async fn active_jobs(&self) -> Result<Vec<JobRow>> {
        let sql = concat!(
            "SELECT ",
            job_cols!(),
            " FROM jobs \
             WHERE status IN ('pending','running','paused_quota') ORDER BY created_at, id"
        );
        let rows = sqlx::query(sql).fetch_all(&self.pool).await?;
        rows.iter().map(job_row).collect()
    }

    async fn set_status(&self, id: i64, status: &str, clear_error: bool) -> Result<()> {
        let res = sqlx::query(
            "UPDATE jobs SET status = $1, updated_at = now(), \
             error = CASE WHEN $3 THEN NULL ELSE error END WHERE id = $2",
        )
        .bind(status)
        .bind(id)
        .bind(clear_error)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::PgPool;

    fn nj(key: &str, p: Priority) -> NewJob {
        NewJob {
            key: key.into(),
            kind: JobKind::SyncAddress,
            params: json!({"a": 1}),
            priority: p,
        }
    }

    #[sqlx::test]
    async fn enqueue_dedupes_active_key(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, new_a) = s.enqueue(&nj("k", Priority::Background)).await.unwrap();
        let (b, new_b) = s.enqueue(&nj("k", Priority::Background)).await.unwrap();
        assert!(new_a && !new_b);
        assert_eq!(a, b);
        let j = s.claim_next().await.unwrap().unwrap();
        s.complete_job(j.id).await.unwrap();
        let (c, new_c) = s.enqueue(&nj("k", Priority::Background)).await.unwrap();
        assert!(new_c);
        assert_ne!(a, c);
    }

    #[sqlx::test]
    async fn enqueue_races_with_completion(pool: PgPool) {
        let s = Store::from_pool(pool);
        let enq = {
            let s = s.clone();
            tokio::spawn(async move {
                for _ in 0..50 {
                    let (id, _) = s.enqueue(&nj("race", Priority::Background)).await.unwrap();
                    let _ = s.complete_job(id).await;
                }
            })
        };
        let done = {
            let s = s.clone();
            tokio::spawn(async move {
                for _ in 0..50 {
                    let (id, _) = s.enqueue(&nj("race", Priority::Background)).await.unwrap();
                    let _ = s.complete_job(id).await;
                }
            })
        };
        enq.await.unwrap();
        done.await.unwrap();
    }

    #[sqlx::test]
    async fn claim_respects_priority(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.enqueue(&nj("low", Priority::Low)).await.unwrap();
        s.enqueue(&nj("hi", Priority::Interactive)).await.unwrap();
        let j = s.claim_next().await.unwrap().unwrap();
        assert_eq!(j.key, "hi");
        assert_eq!(j.status, JobStatus::Running);
        assert_eq!(j.priority, Priority::Interactive);
        assert_eq!(j.kind, JobKind::SyncAddress);
        assert_eq!(j.params, json!({"a": 1}));
        assert_eq!(s.claim_next().await.unwrap().unwrap().key, "low");
        assert!(s.claim_next().await.unwrap().is_none());
    }

    #[sqlx::test]
    async fn enqueue_conflict_upgrades_priority(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, _) = s.enqueue(&nj("k", Priority::Background)).await.unwrap();
        let (b, new_b) = s.enqueue(&nj("k", Priority::Interactive)).await.unwrap();
        assert!(!new_b);
        assert_eq!(a, b);
        // A less urgent request never downgrades the queued job.
        s.enqueue(&nj("k", Priority::Low)).await.unwrap();
        let j = s.claim_next().await.unwrap().unwrap();
        assert_eq!((j.id, j.priority), (a, Priority::Interactive));
    }

    #[sqlx::test]
    async fn aged_low_job_orders_as_background(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (old_low, _) = s.enqueue(&nj("old-low", Priority::Low)).await.unwrap();
        sqlx::query("UPDATE jobs SET created_at = now() - interval '121 seconds' WHERE id = $1")
            .bind(old_low)
            .execute(s.pool())
            .await
            .unwrap();
        let (fresh_low, _) = s.enqueue(&nj("fresh-low", Priority::Low)).await.unwrap();
        let (bg, _) = s.enqueue(&nj("bg", Priority::Background)).await.unwrap();
        let (hi, _) = s.enqueue(&nj("hi", Priority::Interactive)).await.unwrap();
        let mut order = Vec::new();
        while let Some(j) = s.claim_next().await.unwrap() {
            order.push(j.id);
        }
        assert_eq!(order, vec![hi, old_low, bg, fresh_low]);
    }

    #[sqlx::test]
    async fn claim_with_max_priority_skips_less_urgent(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (low, _) = s.enqueue(&nj("low", Priority::Low)).await.unwrap();
        sqlx::query("UPDATE jobs SET created_at = now() - interval '1 hour' WHERE id = $1")
            .bind(low)
            .execute(s.pool())
            .await
            .unwrap();
        let (bg, _) = s.enqueue(&nj("bg", Priority::Background)).await.unwrap();
        // An aged Low job is ordered like Background but is still not Interactive.
        assert!(s.claim_next_with_max_priority(0).await.unwrap().is_none());
        let (hi, _) = s.enqueue(&nj("hi", Priority::Interactive)).await.unwrap();
        assert_eq!(
            s.claim_next_with_max_priority(0).await.unwrap().unwrap().id,
            hi
        );
        assert!(s.claim_next_with_max_priority(0).await.unwrap().is_none());
        // The filter uses the job's own priority, not the aged one.
        assert_eq!(
            s.claim_next_with_max_priority(1).await.unwrap().unwrap().id,
            bg
        );
        assert!(s.claim_next_with_max_priority(1).await.unwrap().is_none());
        assert_eq!(s.claim_next().await.unwrap().unwrap().id, low);
    }

    #[sqlx::test]
    async fn claim_skip_locked_no_double_claim(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.enqueue(&nj("a", Priority::Background)).await.unwrap();
        s.enqueue(&nj("b", Priority::Background)).await.unwrap();
        let (x, y) = tokio::join!(s.claim_next(), s.claim_next());
        let (x, y) = (x.unwrap().unwrap(), y.unwrap().unwrap());
        assert_ne!(x.id, y.id);
    }

    #[sqlx::test]
    async fn reset_running_requeues(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.enqueue(&nj("a", Priority::Background)).await.unwrap();
        let j = s.claim_next().await.unwrap().unwrap();
        assert_eq!(s.reset_running().await.unwrap(), 1);
        let again = s.claim_next().await.unwrap().unwrap();
        assert_eq!(again.id, j.id);
    }

    #[sqlx::test]
    async fn pause_and_resume(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.enqueue(&nj("a", Priority::Background)).await.unwrap();
        let j = s.claim_next().await.unwrap().unwrap();
        s.pause_job_quota(j.id).await.unwrap();
        assert!(s.claim_next().await.unwrap().is_none());
        let act = s.active_jobs().await.unwrap();
        assert_eq!(act.len(), 1);
        assert_eq!(act[0].status, JobStatus::PausedQuota);
        assert_eq!(s.resume_paused().await.unwrap(), 1);
        assert_eq!(s.claim_next().await.unwrap().unwrap().id, j.id);
    }

    #[sqlx::test]
    async fn cancel_pending_vs_running(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (first, _) = s
            .enqueue(&nj("first", Priority::Interactive))
            .await
            .unwrap();
        let (second, _) = s
            .enqueue(&nj("second", Priority::Background))
            .await
            .unwrap();
        let running = s.claim_next().await.unwrap().unwrap();
        assert_eq!(running.id, first);
        // `first` (Interactive) is running, `second` is pending
        assert_eq!(
            s.cancel_job(second).await.unwrap(),
            Some((JobKind::SyncAddress, JobStatus::Cancelled))
        );
        assert!(!s.cancel_requested(second).await.unwrap());
        assert!(s.claim_next().await.unwrap().is_none());
        assert_eq!(
            s.cancel_job(first).await.unwrap(),
            Some((JobKind::SyncAddress, JobStatus::Running))
        );
        assert!(s.cancel_requested(first).await.unwrap());
        s.mark_cancelled(first).await.unwrap();
        assert!(s.active_jobs().await.unwrap().is_empty());
        assert_eq!(s.cancel_job(first).await.unwrap(), None);
        assert_eq!(s.cancel_job(9999).await.unwrap(), None);
    }

    #[sqlx::test]
    async fn cancel_paused_job(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.enqueue(&nj("a", Priority::Background)).await.unwrap();
        let j = s.claim_next().await.unwrap().unwrap();
        s.pause_job_quota(j.id).await.unwrap();
        assert_eq!(
            s.cancel_job(j.id).await.unwrap(),
            Some((JobKind::SyncAddress, JobStatus::Cancelled))
        );
        assert!(!s.cancel_requested(j.id).await.unwrap());
        assert!(s.active_jobs().await.unwrap().is_empty());
        assert_eq!(s.resume_paused().await.unwrap(), 0);
        assert_eq!(s.cancel_job(j.id).await.unwrap(), None);
    }

    #[sqlx::test]
    async fn fail_progress_complete(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.enqueue(&nj("a", Priority::Background)).await.unwrap();
        let j = s.claim_next().await.unwrap().unwrap();
        s.update_progress(j.id, &json!({"n": 3})).await.unwrap();
        s.fail_job(j.id, "boom", true).await.unwrap();
        let j2 = s.claim_next().await.unwrap().unwrap();
        assert_eq!(j2.attempts, 1);
        assert_eq!(j2.error.as_deref(), Some("boom"));
        assert_eq!(j2.progress, Some(json!({"n": 3})));
        s.fail_job(j2.id, "dead", false).await.unwrap();
        let st: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
            .bind(j2.id)
            .fetch_one(s.pool())
            .await
            .unwrap();
        assert_eq!(st, "failed");
        s.enqueue(&nj("b", Priority::Background)).await.unwrap();
        let b = s.claim_next().await.unwrap().unwrap();
        s.fail_job(b.id, "x", true).await.unwrap();
        let b = s.claim_next().await.unwrap().unwrap();
        s.complete_job(b.id).await.unwrap();
        let e: Option<String> = sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
            .bind(b.id)
            .fetch_one(s.pool())
            .await
            .unwrap();
        assert!(e.is_none());
    }

    #[sqlx::test]
    async fn recent_jobs_newest_first_any_status(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, _) = s.enqueue(&nj("a", Priority::Background)).await.unwrap();
        let (b, _) = s.enqueue(&nj("b", Priority::Background)).await.unwrap();
        let (c, _) = s.enqueue(&nj("c", Priority::Background)).await.unwrap();
        let first = s.claim_next().await.unwrap().unwrap();
        s.fail_job(first.id, "boom", false).await.unwrap();
        s.cancel_job(b).await.unwrap();
        let all: Vec<(i64, JobStatus)> = s
            .recent_jobs(10)
            .await
            .unwrap()
            .iter()
            .map(|j| (j.id, j.status))
            .collect();
        assert_eq!(
            all,
            vec![
                (c, JobStatus::Pending),
                (b, JobStatus::Cancelled),
                (a, JobStatus::Failed)
            ]
        );
        assert_eq!(s.recent_jobs(2).await.unwrap().len(), 2);
        let j = s.job(a).await.unwrap().unwrap();
        assert_eq!(j.error.as_deref(), Some("boom"));
        assert!(s.job(9999).await.unwrap().is_none());
    }

    #[sqlx::test]
    async fn unknown_status_text_is_invalid(pool: PgPool) {
        let s = Store::from_pool(pool);
        sqlx::query(
            "INSERT INTO jobs (key, kind, params, priority, status) \
             VALUES ('k', 'bogus', '{}', 1, 'pending')",
        )
        .execute(s.pool())
        .await
        .unwrap();
        assert!(matches!(
            s.claim_next().await.unwrap_err(),
            StoreError::Invalid(_)
        ));
    }
}
