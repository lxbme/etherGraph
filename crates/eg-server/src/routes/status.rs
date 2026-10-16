//! `GET /api/status`.

use axum::Json;
use axum::extract::State;
use chrono::Utc;

use crate::background::next_utc_midnight;
use crate::dto::{StatusDto, rfc3339};
use crate::error::ApiError;
use crate::state::AppState;

pub async fn status(State(s): State<AppState>) -> Result<Json<StatusDto>, ApiError> {
    let jobs_active = s.store.active_jobs().await?.len();
    let quota = *s.gate.subscribe_quota().borrow();
    let stats = s.stats.snapshot();
    Ok(Json(StatusDto {
        quota_used: quota.used,
        quota_limit: quota.limit,
        paused: quota.paused,
        reset_at: rfc3339(next_utc_midnight(Utc::now())),
        queue_len: s.gate.queue_len(),
        rate: s.gate.current_rate(),
        jobs_active,
        calls: stats.calls,
        retries: stats.retries,
        errors: stats.errors,
    }))
}
