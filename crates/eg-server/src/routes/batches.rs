//! `DELETE /api/batches/{id}`: releases a batch's jobs.

use axum::Json;
use axum::extract::State;

use crate::dto::CancelledDto;
use crate::error::{ApiError, invalid};
use crate::routes::ApiPath;
use crate::routes::jobs::after_cancels;
use crate::state::AppState;

/// Longest accepted batch id.
const MAX_BATCH_LEN: usize = 64;

/// A batch id is 1 to 64 characters of `[A-Za-z0-9-]`.
pub fn validate_batch(id: &str) -> Result<(), ApiError> {
    let ok = (1..=MAX_BATCH_LEN).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "batch must be 1 to {MAX_BATCH_LEN} characters of [A-Za-z0-9-], got {id:?}"
        )))
    }
}

/// Drops the batch's ownership and cancels the active jobs left without any
/// owner; jobs another batch or a batch-less request also owns keep running.
/// An unknown batch cancels nothing.
pub async fn release(
    State(s): State<AppState>,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<CancelledDto>, ApiError> {
    validate_batch(&id)?;
    let cancelled = s.store.release_batch(&id).await?;
    Ok(Json(after_cancels(&s, cancelled).await))
}
