//! `GET /api/jobs?active=true`, `DELETE /api/jobs/{id}`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use eg_ingest::Event;
use eg_store::JobStatus;
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
