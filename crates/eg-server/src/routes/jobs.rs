//! `GET /api/jobs?active=true|false`, `DELETE /api/jobs?scope=background`,
//! `GET /api/jobs/{id}`, `DELETE /api/jobs/{id}`: the viewer's jobs only;
//! another user's job is 404, like a missing one.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use eg_ingest::handlers::SyncParams;
use eg_ingest::{Audience, Event, other_sync_active};
use eg_store::{JobKind, JobRow, JobStatus, StoreError};
use serde::Deserialize;

use crate::auth::extract::CurrentUser;
use crate::dto::{CancelledDto, JobDto};
use crate::error::{ApiError, invalid};
use crate::routes::{ApiPath, ApiQuery};
use crate::state::AppState;

/// Jobs listed by `active=false`.
const RECENT_JOBS: u32 = 50;

#[derive(Deserialize)]
pub struct JobsQuery {
    /// Parsed by hand so a malformed value gets the JSON error body.
    pub active: Option<String>,
}

/// `active=true` (default): pending, running and paused jobs, oldest first.
/// `active=false`: the 50 most recent jobs of any status, newest first.
pub async fn list(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiQuery(q): ApiQuery<JobsQuery>,
) -> Result<Json<Vec<JobDto>>, ApiError> {
    let jobs = match q.active.as_deref() {
        None | Some("true") => s.store.user_active_jobs(user.id).await?,
        Some("false") => s.store.recent_jobs(user.id, RECENT_JOBS).await?,
        Some(other) => {
            return Err(invalid(format!(
                "active must be \"true\" or \"false\", got {other:?}"
            )));
        }
    };
    Ok(Json(with_batches(&s, jobs).await?))
}

async fn with_batches(s: &AppState, jobs: Vec<JobRow>) -> Result<Vec<JobDto>, ApiError> {
    let ids: Vec<i64> = jobs.iter().map(|j| j.id).collect();
    let mut batches = s.store.job_batches(&ids).await?;
    Ok(jobs
        .into_iter()
        .map(|j| {
            let b = batches.remove(&j.id).unwrap_or_default();
            JobDto::new(j, b)
        })
        .collect())
}

#[derive(Deserialize)]
pub struct CancelQuery {
    pub scope: Option<String>,
}

/// `scope=background` (required): cancels every active job of the viewer
/// that is not Interactive.
pub async fn cancel_scope(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiQuery(q): ApiQuery<CancelQuery>,
) -> Result<Json<CancelledDto>, ApiError> {
    if q.scope.as_deref() != Some("background") {
        return Err(invalid(format!(
            "scope must be \"background\", got {:?}",
            q.scope
        )));
    }
    let cancelled = s.store.cancel_background(user.id).await?;
    Ok(Json(after_cancels(&s, user.id, cancelled).await))
}

fn parse_id(raw: &str) -> Result<i64, ApiError> {
    raw.parse()
        .map_err(|_| invalid(format!("invalid job id {raw:?}")))
}

/// One of the viewer's jobs, of any status; 404 when it does not exist or is
/// another user's.
pub async fn get(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<JobDto>, ApiError> {
    let id = parse_id(&id)?;
    let job = s
        .store
        .user_job(user.id, id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no job {id}")))?;
    let mut dto = with_batches(&s, vec![job]).await?;
    Ok(Json(dto.remove(0)))
}

/// 204 when the job was cancelled (pending or quota-paused) or flagged for
/// cancellation (running); 404 when it does not exist, is another user's or
/// has already finished. An immediate cancellation is announced here; the
/// runner announces flagged ones.
pub async fn cancel(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = parse_id(&id)?;
    let (kind, status) = s
        .store
        .cancel_user_job(user.id, id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no active job {id}")))?;
    after_cancel(&s, user.id, id, kind, status).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Follow-up for a job of `user` the store just cancelled or flagged: an
/// immediate cancellation settles a sync's `syncing` kinds and is announced
/// to `user` here; the runner announces flagged (running) ones.
async fn after_cancel(s: &AppState, user: i64, id: i64, kind: JobKind, status: JobStatus) {
    if status != JobStatus::Cancelled {
        return;
    }
    if kind == JobKind::SyncAddress {
        settle_cancelled_sync(s, id).await;
    }
    s.ctx.bus.publish(
        Audience::User(user),
        Event::JobProgress {
            job_id: id,
            kind,
            fetched: 0,
            cursor_block: None,
            status,
            error: None,
        },
    );
}

/// [`after_cancel`] for each of `user`'s jobs; lists them all, flagged ones
/// included.
pub(crate) async fn after_cancels(
    s: &AppState,
    user: i64,
    jobs: Vec<(i64, JobKind, JobStatus)>,
) -> CancelledDto {
    let mut cancelled = Vec::with_capacity(jobs.len());
    for (id, kind, status) in jobs {
        after_cancel(s, user, id, kind, status).await;
        cancelled.push(id);
    }
    CancelledDto { cancelled }
}

/// A pending or paused sync may have left kinds `syncing` (it ran before being
/// re-queued or paused); nothing will finish them now. Kinds are left alone
/// while another sync of the same address is still active. Failures are
/// logged: the cancellation itself already happened.
async fn settle_cancelled_sync(s: &AppState, id: i64) {
    let result: Result<(), StoreError> = async {
        let Some(job) = s.store.job(id).await? else {
            return Ok(());
        };
        let p = match serde_json::from_value::<SyncParams>(job.params) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(job_id = id, error = %e, "cancelled sync has bad params");
                return Ok(());
            }
        };
        if !other_sync_active(&s.store, p.address, Some(id)).await? {
            s.store.settle_syncing(p.address).await?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tracing::warn!(job_id = id, error = %e, "settling a cancelled sync failed");
    }
}
