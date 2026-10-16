//! `GET /api/jobs?active=true|false`, `GET /api/jobs/{id}`, `DELETE /api/jobs/{id}`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use eg_ingest::Event;
use eg_ingest::handlers::SyncParams;
use eg_store::{JobKind, JobStatus, StoreError};
use serde::Deserialize;

use crate::dto::JobDto;
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
    ApiQuery(q): ApiQuery<JobsQuery>,
) -> Result<Json<Vec<JobDto>>, ApiError> {
    let jobs = match q.active.as_deref() {
        None | Some("true") => s.store.active_jobs().await?,
        Some("false") => s.store.recent_jobs(RECENT_JOBS).await?,
        Some(other) => {
            return Err(invalid(format!(
                "active must be \"true\" or \"false\", got {other:?}"
            )));
        }
    };
    Ok(Json(jobs.into_iter().map(JobDto::from).collect()))
}

fn parse_id(raw: &str) -> Result<i64, ApiError> {
    raw.parse()
        .map_err(|_| invalid(format!("invalid job id {raw:?}")))
}

/// One job of any status; 404 when it does not exist.
pub async fn get(
    State(s): State<AppState>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<JobDto>, ApiError> {
    let id = parse_id(&id)?;
    let job = s
        .store
        .job(id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no job {id}")))?;
    Ok(Json(job.into()))
}

/// 204 when the job was cancelled (pending or quota-paused) or flagged for
/// cancellation (running); 404 when it does not exist or has already finished.
/// An immediate cancellation is announced here; the runner announces flagged ones.
pub async fn cancel(
    State(s): State<AppState>,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = parse_id(&id)?;
    let (kind, status) = s
        .store
        .cancel_job(id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no active job {id}")))?;
    if status == JobStatus::Cancelled {
        if kind == JobKind::SyncAddress {
            settle_cancelled_sync(&s, id).await;
        }
        s.ctx.bus.publish(Event::JobProgress {
            job_id: id,
            kind,
            fetched: 0,
            cursor_block: None,
            status,
            error: None,
        });
    }
    Ok(StatusCode::NO_CONTENT)
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
        let prefix = format!("sync:{:#x}:", p.address);
        let other_active = s
            .store
            .active_jobs()
            .await?
            .iter()
            .any(|j| j.kind == JobKind::SyncAddress && j.key.starts_with(&prefix));
        if !other_active {
            s.store.settle_syncing(p.address).await?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tracing::warn!(job_id = id, error = %e, "settling a cancelled sync failed");
    }
}
