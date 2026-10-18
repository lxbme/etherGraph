use std::collections::HashMap;

use chrono::{DateTime, Utc};
use eg_core::source::Priority;
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
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
    /// Waiting for its user's daily quota to reset.
    PausedUserQuota,
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
            JobStatus::PausedUserQuota => "paused_user_quota",
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
            "paused_user_quota" => JobStatus::PausedUserQuota,
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
    /// The user the job is run for; `None` for a system job.
    pub user_id: Option<i64>,
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
    /// The user the job is run for; `None` for a system job.
    pub user_id: Option<i64>,
}

/// The statuses of an active job, as an SQL list; matches the `jobs_active_key`
/// index predicate.
macro_rules! active_statuses {
    () => {
        "('pending', 'running', 'paused_quota', 'paused_user_quota')"
    };
}
pub(crate) use active_statuses;

macro_rules! job_cols {
    () => {
        "id, key, kind, params, priority, status, progress, attempts, error, created_at, \
         updated_at, user_id"
    };
}

/// `UPDATE` cancelling the active jobs matching `$where`: pending and
/// quota-paused (server or user) ones become cancelled, running ones get
/// `cancel_requested`.
/// Returns `(id, kind, status)` rows.
macro_rules! cancel_active {
    ($where:literal) => {
        concat!(
            "UPDATE jobs SET updated_at = now(), \
             status = CASE WHEN status = 'running' THEN status ELSE 'cancelled' END, \
             cancel_requested = (status = 'running') OR cancel_requested \
             WHERE status IN ",
            active_statuses!(),
            " AND ",
            $where,
            " RETURNING id, kind, status"
        )
    };
}

/// Parses `cancel_active!` rows, sorted by id.
fn cancelled(rows: Vec<(i64, String, String)>) -> Result<Vec<(i64, JobKind, JobStatus)>> {
    let mut out = rows
        .into_iter()
        .map(|(id, k, st)| Ok((id, JobKind::parse(&k)?, JobStatus::parse(&st)?)))
        .collect::<Result<Vec<_>>>()?;
    out.sort_by_key(|r| r.0);
    Ok(out)
}

/// [`Store::cancel_job`] for each of `ids` that is still active, inside the
/// caller's transaction.
pub(crate) async fn cancel_ids(
    conn: &mut PgConnection,
    ids: &[i64],
) -> Result<Vec<(i64, JobKind, JobStatus)>> {
    let rows = sqlx::query_as(cancel_active!("id = ANY($1)"))
        .bind(ids)
        .fetch_all(conn)
        .await?;
    cancelled(rows)
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
        user_id: r.try_get("user_id")?,
    })
}

impl Store {
    /// Returns `(id, true)` for a new job, or the existing active job's
    /// `(id, false)` when one with the same key and the same owner is active
    /// (pending, running or paused on either quota). A more urgent request
    /// raises the existing job's priority. An active job with the same key
    /// and another owner is never joined: `Conflict` (callers scope keys by
    /// owner, so this means a caller bug, not a race).
    pub async fn enqueue(&self, j: &NewJob) -> Result<(i64, bool)> {
        self.enqueue_as(j, "pending").await
    }

    /// Like [`Store::enqueue`], a new job starting in `paused_user_quota`
    /// (its user is over their daily quota); a joined job keeps its status.
    pub async fn enqueue_user_paused(&self, j: &NewJob) -> Result<(i64, bool)> {
        self.enqueue_as(j, "paused_user_quota").await
    }

    async fn enqueue_as(&self, j: &NewJob, status: &str) -> Result<(i64, bool)> {
        // The conflicting job may finish between the INSERT and the SELECT, so retry.
        for _ in 0..5 {
            let inserted: Option<i64> = sqlx::query_scalar(concat!(
                "INSERT INTO jobs (key, kind, params, priority, status, user_id) \
                 VALUES ($1, $2, $3, $4, $6, $5) \
                 ON CONFLICT (key) WHERE status IN ",
                active_statuses!(),
                " DO NOTHING RETURNING id"
            ))
            .bind(&j.key)
            .bind(j.kind.as_str())
            .bind(&j.params)
            .bind(j.priority.as_i16())
            .bind(j.user_id)
            .bind(status)
            .fetch_optional(&self.pool)
            .await?;
            if let Some(id) = inserted {
                return Ok((id, true));
            }
            let existing: Option<i64> = sqlx::query_scalar(concat!(
                "SELECT id FROM jobs WHERE key = $1 AND user_id IS NOT DISTINCT FROM $2 \
                 AND status IN ",
                active_statuses!()
            ))
            .bind(&j.key)
            .bind(j.user_id)
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
        // A transient race, not an invalid value: the caller may retry.
        Err(StoreError::Conflict)
    }

    /// Claims the most urgent pending job and marks it running. A job waiting
    /// longer than [`AGING_SECS`] is ordered as if it were Background. Among
    /// jobs of the same (effective) priority, the owner with the fewest
    /// running jobs goes first (system jobs count as one owner), then the
    /// oldest job, so one user's long queue cannot hold up everyone else.
    pub async fn claim_next(&self) -> Result<Option<JobRow>> {
        self.claim_next_with_max_priority(i16::MAX).await
    }

    /// Like [`Store::claim_next`], restricted to jobs whose own priority is at
    /// most `max` (`0` claims Interactive jobs only); aging affects ordering only.
    pub async fn claim_next_with_max_priority(&self, max: i16) -> Result<Option<JobRow>> {
        let sql = concat!(
            "UPDATE jobs SET status = 'running', updated_at = now() WHERE id = ( \
             SELECT j.id FROM jobs j \
             LEFT JOIN (SELECT user_id, count(*) AS n FROM jobs WHERE status = 'running' \
                        GROUP BY user_id) r ON r.user_id IS NOT DISTINCT FROM j.user_id \
             WHERE j.status = 'pending' AND j.priority <= $1 \
             ORDER BY LEAST(j.priority, CASE WHEN now() - j.created_at > make_interval(secs => $2) \
             THEN 1 ELSE j.priority END) ASC, COALESCE(r.n, 0) ASC, j.created_at ASC, j.id ASC \
             FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING ",
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

    /// The job waits for its user's daily quota to reset.
    pub async fn pause_job_user_quota(&self, id: i64) -> Result<()> {
        self.set_status(id, "paused_user_quota", false).await
    }

    /// Requeues the jobs paused on the server quota (`paused_quota` only).
    pub async fn resume_paused(&self) -> Result<u64> {
        let res = sqlx::query(
            "UPDATE jobs SET status = 'pending', updated_at = now() WHERE status = 'paused_quota'",
        )
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Requeues the jobs paused on their user's quota: those of `users`, or
    /// of every user (`None`).
    pub async fn resume_user_paused(&self, users: Option<&[i64]>) -> Result<u64> {
        let res = sqlx::query(
            "UPDATE jobs SET status = 'pending', updated_at = now() \
             WHERE status = 'paused_user_quota' AND ($1::bigint[] IS NULL OR user_id = ANY($1))",
        )
        .bind(users)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// The users with jobs paused on their own quota, by id.
    pub async fn user_paused_owners(&self) -> Result<Vec<i64>> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT user_id FROM jobs \
             WHERE status = 'paused_user_quota' AND user_id IS NOT NULL ORDER BY user_id",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Per user, how many of their jobs wait for quota (paused on the
    /// server's or their own); users without such jobs are omitted.
    pub async fn user_waiting_job_counts(&self) -> Result<HashMap<i64, u32>> {
        let rows: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT user_id, count(*) FROM jobs \
             WHERE status IN ('paused_quota', 'paused_user_quota') AND user_id IS NOT NULL \
             GROUP BY user_id",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(u, n)| (u, u32::try_from(n).unwrap_or(u32::MAX)))
            .collect())
    }

    /// Pending and quota-paused (server or user) jobs become cancelled;
    /// running jobs get `cancel_requested`. Returns the job's kind and
    /// resulting status (`Cancelled`, or `Running` when only flagged); `None`
    /// for an unknown or finished job.
    pub async fn cancel_job(&self, id: i64) -> Result<Option<(JobKind, JobStatus)>> {
        let row: Option<(i64, String, String)> = sqlx::query_as(cancel_active!("id = $1"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(cancelled(row.into_iter().collect())?
            .pop()
            .map(|(_, k, st)| (k, st)))
    }

    /// [`Store::cancel_job`] for one of `user`'s jobs; another user's job is
    /// `None`, like an unknown one.
    pub async fn cancel_user_job(
        &self,
        user: i64,
        id: i64,
    ) -> Result<Option<(JobKind, JobStatus)>> {
        let row: Option<(i64, String, String)> =
            sqlx::query_as(cancel_active!("id = $1 AND user_id = $2"))
                .bind(id)
                .bind(user)
                .fetch_optional(&self.pool)
                .await?;
        Ok(cancelled(row.into_iter().collect())?
            .pop()
            .map(|(_, k, st)| (k, st)))
    }

    /// [`Store::cancel_job`] applied to every active job of `user` that is
    /// not Interactive; returns each affected job's id, kind and resulting
    /// status.
    pub async fn cancel_background(&self, user: i64) -> Result<Vec<(i64, JobKind, JobStatus)>> {
        let rows = sqlx::query_as(cancel_active!("priority > $1 AND user_id = $2"))
            .bind(Priority::Interactive.as_i16())
            .bind(user)
            .fetch_all(&self.pool)
            .await?;
        cancelled(rows)
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

    /// `user`'s `limit` most recently created jobs of any status, newest first.
    pub async fn recent_jobs(&self, user: i64, limit: u32) -> Result<Vec<JobRow>> {
        let sql = concat!(
            "SELECT ",
            job_cols!(),
            " FROM jobs WHERE user_id = $2 ORDER BY created_at DESC, id DESC LIMIT $1"
        );
        let rows = sqlx::query(sql)
            .bind(i64::from(limit))
            .bind(user)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(job_row).collect()
    }

    pub async fn job(&self, id: i64) -> Result<Option<JobRow>> {
        let sql = concat!("SELECT ", job_cols!(), " FROM jobs WHERE id = $1");
        let row = sqlx::query(sql).bind(id).fetch_optional(&self.pool).await?;
        row.as_ref().map(job_row).transpose()
    }

    /// One of `user`'s jobs; another user's job is `None`, like an unknown one.
    pub async fn user_job(&self, user: i64, id: i64) -> Result<Option<JobRow>> {
        let sql = concat!(
            "SELECT ",
            job_cols!(),
            " FROM jobs WHERE id = $1 AND user_id = $2"
        );
        let row = sqlx::query(sql)
            .bind(id)
            .bind(user)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(job_row).transpose()
    }

    /// `user`'s active jobs, oldest first.
    pub async fn user_active_jobs(&self, user: i64) -> Result<Vec<JobRow>> {
        let sql = concat!(
            "SELECT ",
            job_cols!(),
            " FROM jobs WHERE user_id = $1 AND status IN ",
            active_statuses!(),
            " ORDER BY created_at, id"
        );
        let rows = sqlx::query(sql).bind(user).fetch_all(&self.pool).await?;
        rows.iter().map(job_row).collect()
    }

    /// Every user's (and system) active jobs, oldest first.
    pub async fn active_jobs(&self) -> Result<Vec<JobRow>> {
        let sql = concat!(
            "SELECT ",
            job_cols!(),
            " FROM jobs WHERE status IN ",
            active_statuses!(),
            " ORDER BY created_at, id"
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
            user_id: None,
        }
    }

    fn owned(key: &str, p: Priority, user: i64) -> NewJob {
        NewJob {
            user_id: Some(user),
            ..nj(key, p)
        }
    }

    async fn user(s: &Store, byte: u8) -> i64 {
        s.upsert_user_on_login(crate::Address::repeat_byte(byte))
            .await
            .unwrap()
            .id
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
    async fn user_quota_paused_job_stays_active(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (id, _) = s.enqueue(&nj("a", Priority::Background)).await.unwrap();
        sqlx::query("UPDATE jobs SET status = 'paused_user_quota' WHERE id = $1")
            .bind(id)
            .execute(s.pool())
            .await
            .unwrap();
        assert!(s.claim_next().await.unwrap().is_none());
        assert_eq!(
            s.enqueue(&nj("a", Priority::Background)).await.unwrap(),
            (id, false)
        );
        let dup = sqlx::query(
            "INSERT INTO jobs (key, kind, params, priority, status) \
             VALUES ('a', 'sync_address', '{}', 1, 'pending')",
        )
        .execute(s.pool())
        .await;
        assert!(dup.is_err(), "jobs_active_key must cover paused_user_quota");
        let act = s.active_jobs().await.unwrap();
        assert_eq!(act.len(), 1);
        assert_eq!(act[0].status, JobStatus::PausedUserQuota);
        assert_eq!(
            s.cancel_job(id).await.unwrap(),
            Some((JobKind::SyncAddress, JobStatus::Cancelled))
        );
        assert!(!s.cancel_requested(id).await.unwrap());
        assert!(s.active_jobs().await.unwrap().is_empty());
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
        let me = user(&s, 0xe0).await;
        let bg = Priority::Background;
        let (a, _) = s.enqueue(&owned("a", bg, me)).await.unwrap();
        let (b, _) = s.enqueue(&owned("b", bg, me)).await.unwrap();
        let (c, _) = s.enqueue(&owned("c", bg, me)).await.unwrap();
        let first = s.claim_next().await.unwrap().unwrap();
        s.fail_job(first.id, "boom", false).await.unwrap();
        s.cancel_job(b).await.unwrap();
        let all: Vec<(i64, JobStatus)> = s
            .recent_jobs(me, 10)
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
        assert_eq!(s.recent_jobs(me, 2).await.unwrap().len(), 2);
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

    #[sqlx::test]
    async fn user_scoped_reads_and_cancels(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (me, other) = (user(&s, 0xe0).await, user(&s, 0xe1).await);
        let bg = Priority::Background;
        let (mine, _) = s.enqueue(&owned("m", bg, me)).await.unwrap();
        let (mine_hi, _) = s
            .enqueue(&owned("mi", Priority::Interactive, me))
            .await
            .unwrap();
        let (theirs, _) = s.enqueue(&owned("t", bg, other)).await.unwrap();
        let (system, _) = s.enqueue(&nj("s", bg)).await.unwrap();
        assert_eq!(s.job(mine).await.unwrap().unwrap().user_id, Some(me));
        assert_eq!(s.job(system).await.unwrap().unwrap().user_id, None);

        let ids = |rows: Vec<JobRow>| rows.iter().map(|j| j.id).collect::<Vec<_>>();
        assert_eq!(ids(s.user_active_jobs(me).await.unwrap()), [mine, mine_hi]);
        assert_eq!(ids(s.user_active_jobs(other).await.unwrap()), [theirs]);
        assert_eq!(ids(s.recent_jobs(other, 10).await.unwrap()), [theirs]);
        assert_eq!(s.active_jobs().await.unwrap().len(), 4);
        assert!(s.user_job(other, mine).await.unwrap().is_none());
        assert!(s.user_job(me, system).await.unwrap().is_none());
        assert_eq!(s.user_job(me, mine).await.unwrap().unwrap().id, mine);

        // Another user's (or a system) job cannot be cancelled.
        assert_eq!(s.cancel_user_job(other, mine).await.unwrap(), None);
        assert_eq!(s.cancel_user_job(me, system).await.unwrap(), None);
        assert_eq!(s.cancel_background(other).await.unwrap().len(), 1);
        let mine_row = s.job(mine).await.unwrap().unwrap();
        assert_eq!(mine_row.status, JobStatus::Pending);
        assert_eq!(
            s.job(system).await.unwrap().unwrap().status,
            JobStatus::Pending
        );
        let cancelled = s.cancel_background(me).await.unwrap();
        assert_eq!(
            cancelled,
            [(mine, JobKind::SyncAddress, JobStatus::Cancelled)]
        );
        assert_eq!(
            s.cancel_user_job(me, mine_hi).await.unwrap(),
            Some((JobKind::SyncAddress, JobStatus::Cancelled))
        );
        // Another owner's job (here a system job) is never joined.
        assert!(matches!(
            s.enqueue(&owned("s", bg, me)).await,
            Err(StoreError::Conflict)
        ));
        assert_eq!(s.job(system).await.unwrap().unwrap().user_id, None);
    }

    #[sqlx::test]
    async fn enqueue_joins_only_the_same_owners_job(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, b) = (user(&s, 0xa0).await, user(&s, 0xb0).await);
        let bg = Priority::Background;
        let (id, _) = s.enqueue(&owned("k", bg, a)).await.unwrap();
        assert_eq!(s.enqueue(&owned("k", bg, a)).await.unwrap(), (id, false));
        assert!(matches!(
            s.enqueue(&owned("k", Priority::Interactive, b)).await,
            Err(StoreError::Conflict)
        ));
        let j = s.job(id).await.unwrap().unwrap();
        assert_eq!((j.user_id, j.priority), (Some(a), bg));
    }

    #[sqlx::test]
    async fn claim_prefers_the_user_with_fewer_running_jobs(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, b) = (user(&s, 0xa0).await, user(&s, 0xb0).await);
        let bg = Priority::Background;
        for i in 0..50 {
            s.enqueue(&owned(&format!("a{i}"), bg, a)).await.unwrap();
        }
        let (b_job, _) = s.enqueue(&owned("b", bg, b)).await.unwrap();
        let first = s.claim_next().await.unwrap().unwrap();
        let second = s.claim_next().await.unwrap().unwrap();
        assert!(
            [first.id, second.id].contains(&b_job),
            "B's job was not among the next 2 claims: {}, {}",
            first.key,
            second.key
        );
        // Then A's remaining jobs, oldest first.
        let third = s.claim_next().await.unwrap().unwrap();
        assert_eq!(third.user_id, Some(a));
        assert!(third.id < s.claim_next().await.unwrap().unwrap().id);
    }

    #[sqlx::test]
    async fn fairness_never_overrides_priority(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, b) = (user(&s, 0xa0).await, user(&s, 0xb0).await);
        s.enqueue(&owned("a-run", Priority::Interactive, a))
            .await
            .unwrap();
        s.claim_next().await.unwrap().unwrap();
        let (a_hi, _) = s
            .enqueue(&owned("a-hi", Priority::Interactive, a))
            .await
            .unwrap();
        let (a_bg, _) = s
            .enqueue(&owned("a-bg", Priority::Background, a))
            .await
            .unwrap();
        let (b_bg, _) = s
            .enqueue(&owned("b-bg", Priority::Background, b))
            .await
            .unwrap();
        let (sys, _) = s.enqueue(&nj("sys", Priority::Background)).await.unwrap();
        let mut order = Vec::new();
        while let Some(j) = s.claim_next().await.unwrap() {
            order.push(j.id);
        }
        // A's Interactive job first despite A's running job; among the
        // Background jobs, those of owners with fewer running jobs (B, then
        // the system) before A's older one.
        assert_eq!(order, vec![a_hi, b_bg, sys, a_bg]);
    }

    #[sqlx::test]
    async fn user_quota_pause_and_resume(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, b) = (user(&s, 0xa0).await, user(&s, 0xb0).await);
        let bg = Priority::Background;
        // Created paused: not claimable; joining keeps it paused.
        let (pa, created) = s.enqueue_user_paused(&owned("x", bg, a)).await.unwrap();
        assert!(created);
        assert_eq!(
            s.job(pa).await.unwrap().unwrap().status,
            JobStatus::PausedUserQuota
        );
        assert_eq!(s.enqueue(&owned("x", bg, a)).await.unwrap(), (pa, false));
        assert_eq!(
            s.enqueue_user_paused(&owned("x", bg, a)).await.unwrap(),
            (pa, false)
        );
        let (pb, _) = s.enqueue(&owned("y", bg, b)).await.unwrap();
        assert_eq!(s.claim_next().await.unwrap().unwrap().id, pb);
        assert!(s.claim_next().await.unwrap().is_none());
        s.pause_job_user_quota(pb).await.unwrap();
        assert_eq!(
            s.job(pb).await.unwrap().unwrap().status,
            JobStatus::PausedUserQuota
        );
        assert_eq!(s.user_paused_owners().await.unwrap(), vec![a, b]);
        // The server-quota resume leaves user pauses alone.
        assert_eq!(s.resume_paused().await.unwrap(), 0);
        assert_eq!(s.resume_user_paused(Some(&[a])).await.unwrap(), 1);
        assert_eq!(s.job(pa).await.unwrap().unwrap().status, JobStatus::Pending);
        assert_eq!(
            s.job(pb).await.unwrap().unwrap().status,
            JobStatus::PausedUserQuota
        );
        assert_eq!(s.resume_user_paused(None).await.unwrap(), 1);
        assert!(s.user_paused_owners().await.unwrap().is_empty());
    }

    #[sqlx::test]
    async fn waiting_job_counts_per_user(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, b) = (user(&s, 0xa0).await, user(&s, 0xb0).await);
        let bg = Priority::Background;
        s.enqueue_user_paused(&owned("a1", bg, a)).await.unwrap();
        s.enqueue_user_paused(&owned("a2", bg, a)).await.unwrap();
        let (b1, _) = s.enqueue(&owned("b1", bg, b)).await.unwrap();
        s.pause_job_quota(b1).await.unwrap();
        // Pending, running and system jobs are not waiting for quota.
        s.enqueue(&owned("b2", bg, b)).await.unwrap();
        let (sys, _) = s.enqueue(&nj("sys", bg)).await.unwrap();
        s.pause_job_quota(sys).await.unwrap();
        let counts = s.user_waiting_job_counts().await.unwrap();
        assert_eq!(counts, HashMap::from([(a, 2), (b, 1)]));
    }
}
