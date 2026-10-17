//! `POST /api/sync`: estimate (dry run) or enqueue address syncs.

use axum::Json;
use axum::extract::State;
use chrono::Utc;
use eg_core::source::Priority;
use eg_ingest::{SyncDirection, enqueue_sync, estimate};

use crate::dto::{SyncRequestDto, SyncResponseDto, hex_addr};
use crate::error::{ApiError, invalid};
use crate::routes::batches::validate_batch;
use crate::routes::{ApiJson, parse_addresses};
use crate::state::AppState;

pub async fn sync(
    State(s): State<AppState>,
    ApiJson(req): ApiJson<SyncRequestDto>,
) -> Result<Json<SyncResponseDto>, ApiError> {
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
    let shallow = match req.depth.as_deref() {
        None | Some("shallow") => true,
        Some("full") => false,
        Some(other) => {
            return Err(invalid(format!(
                "depth must be \"shallow\" or \"full\", got {other:?}"
            )));
        }
    };
    if let Some(b) = &req.batch {
        validate_batch(b)?;
    }
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
            per_address: Some(
                e.per_address
                    .iter()
                    .map(|(a, n)| (hex_addr(*a), *n))
                    .collect(),
            ),
            jobs: None,
        }));
    }
    // Shallow: one page per kind. Loading older records is always full depth.
    let cap = (shallow && dir == SyncDirection::Latest).then_some(s.ctx.cfg.page_size);
    let mut jobs = Vec::with_capacity(addrs.len());
    for a in addrs {
        jobs.push(
            enqueue_sync(
                &s.ctx,
                a,
                dir,
                Priority::Background,
                cap,
                req.batch.as_deref(),
            )
            .await?,
        );
    }
    Ok(Json(SyncResponseDto {
        estimated_calls: None,
        estimated_seconds: None,
        per_address: None,
        jobs: Some(jobs),
    }))
}
