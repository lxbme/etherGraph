//! `POST /api/sync`: estimate (dry run) or enqueue address syncs.

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use chrono::Utc;
use eg_core::source::Priority;
use eg_ingest::{SyncDirection, enqueue_sync, estimate};

use crate::dto::{SyncRequestDto, SyncResponseDto};
use crate::error::{ApiError, invalid};
use crate::routes::{json_body, parse_addresses};
use crate::state::AppState;

pub async fn sync(
    State(s): State<AppState>,
    body: Result<Json<SyncRequestDto>, JsonRejection>,
) -> Result<Json<SyncResponseDto>, ApiError> {
    let req = json_body(body)?;
    let addrs = parse_addresses(&req.addresses)?;
    let dir = match req.direction.as_deref() {
        None | Some("latest") => SyncDirection::Latest,
        Some("older") => SyncDirection::Older,
        Some(other) => {
            return Err(invalid(format!(
                "direction must be \"latest\" or \"older\", got {other:?}"
            )));
        }
    };
    if req.dry_run.unwrap_or(false) {
        let rows = s.store.sync_rows(&addrs).await?;
        let cfg = &s.ctx.cfg;
        let e = estimate(
            &addrs,
            &rows,
            dir,
            Utc::now(),
            cfg.stale_after,
            cfg.rate_per_sec,
        );
        return Ok(Json(SyncResponseDto {
            estimated_calls: Some(e.calls),
            estimated_seconds: Some(e.seconds),
            jobs: None,
        }));
    }
    let mut jobs = Vec::with_capacity(addrs.len());
    for a in addrs {
        jobs.push(enqueue_sync(&s.ctx, a, dir, Priority::Background).await?);
    }
    Ok(Json(SyncResponseDto {
        estimated_calls: None,
        estimated_seconds: None,
        jobs: Some(jobs),
    }))
}
