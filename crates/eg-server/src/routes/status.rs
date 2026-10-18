//! `GET /api/status` and `GET /api/health`.

use axum::Json;
use axum::extract::State;
use chrono::Utc;
use eg_ingest::remaining_calls;

use crate::auth::extract::CurrentUser;
use crate::background::next_utc_midnight;
use crate::dto::{StatusDto, rfc3339};
use crate::error::ApiError;
use crate::state::AppState;

/// `GET /api/health`: open without a session.
pub async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

/// The quota figures and `jobs_active`/`queued_calls` are the viewer's own;
/// `server_paused`, the gate and client figures are server-wide.
pub async fn status(
    State(s): State<AppState>,
    user: CurrentUser,
) -> Result<Json<StatusDto>, ApiError> {
    let active = s.store.user_active_jobs(user.id).await?;
    let queued_calls = active
        .iter()
        .map(|j| remaining_calls(j, &s.ctx.cfg))
        .fold(0u32, u32::saturating_add);
    let server = *s.gate.subscribe_quota().borrow();
    let mine = s.gate.user_quota(user.id);
    let stats = s.stats.snapshot();
    // An invalid key fails every call; the frontend shows a banner.
    let degraded = stats
        .errors
        .get("invalid_key")
        .is_some_and(|n| *n > 0)
        .then(|| "invalid_key".to_owned());
    Ok(Json(StatusDto {
        quota_used: mine.used,
        quota_limit: mine.limit,
        paused: mine.exhausted() || server.paused,
        server_paused: server.paused,
        reset_at: rfc3339(next_utc_midnight(Utc::now())),
        queue_len: s.gate.queue_len(),
        rate: s.gate.current_rate(),
        jobs_active: active.len(),
        queued_calls,
        calls: stats.calls,
        retries: stats.retries,
        errors: stats.errors,
        degraded,
    }))
}
