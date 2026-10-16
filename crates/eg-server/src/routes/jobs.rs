//! `GET /api/jobs?active=true`, `DELETE /api/jobs/{id}`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use eg_ingest::Event;
use eg_ingest::handlers::SyncParams;
use eg_store::{JobKind, JobStatus};
use serde::Deserialize;

use crate::dto::JobDto;
use crate::error::{ApiError, invalid};
use crate::routes::{ApiPath, ApiQuery};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct JobsQuery {
    /// Parsed by hand so a malformed value gets the JSON error body.
    pub active: Option<String>,
}

/// Only active jobs (pending, running, paused) are listed; `active` defaults to true.
pub async fn list(
    State(s): State<AppState>,
    ApiQuery(q): ApiQuery<JobsQuery>,
) -> Result<Json<Vec<JobDto>>, ApiError> {
    match q.active.as_deref() {
        None | Some("true") => {}
        Some(other) => {
            return Err(invalid(format!(
                "active={other:?} is not supported; use true"
            )));
        }
    }
    let jobs = s.store.active_jobs().await?;
    Ok(Json(jobs.into_iter().map(JobDto::from).collect()))
}

/// 204 when the job was cancelled (pending or quota-paused) or flagged for
/// cancellation (running); 404 when it does not exist or has already finished.
/// An immediate cancellation is announced here; the runner announces flagged ones.
pub async fn cancel(
    State(s): State<AppState>,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    let id: i64 = id
        .parse()
        .map_err(|_| invalid(format!("invalid job id {id:?}")))?;
    let (kind, status) = s
        .store
        .cancel_job(id)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no active job {id}")))?;
    if status == JobStatus::Cancelled {
        if kind == JobKind::SyncAddress {
            settle_cancelled_sync(&s, id).await?;
        }
        s.ctx.bus.publish(Event::JobProgress {
            job_id: id,
            kind,
            fetched: 0,
            cursor_block: None,
            status,
        });
    }
    Ok(StatusCode::NO_CONTENT)
}

/// A pending or paused sync may have left kinds `syncing` (it ran before being
/// re-queued or paused); nothing will finish them now.
async fn settle_cancelled_sync(s: &AppState, id: i64) -> Result<(), ApiError> {
    let Some(job) = s.store.job(id).await? else {
        return Ok(());
    };
    match serde_json::from_value::<SyncParams>(job.params) {
        Ok(p) => {
            s.store.settle_syncing(p.address).await?;
        }
        Err(e) => tracing::warn!(job_id = id, error = %e, "cancelled sync has bad params"),
    }
    Ok(())
}
