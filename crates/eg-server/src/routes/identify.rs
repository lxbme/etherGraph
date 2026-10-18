//! `POST /api/identify`: queues contract-metadata jobs for the addresses that
//! lack real metadata, at interactive priority.

use axum::Json;
use axum::extract::State;
use eg_core::source::Priority;
use eg_ingest::enqueue_meta_owned;

use crate::auth::extract::CurrentUser;
use crate::dto::{IdentifyRequestDto, IdentifyResponseDto};
use crate::error::{ApiError, invalid};
use crate::routes::batches::validate_batch;
use crate::routes::{ApiJson, parse_address};
use crate::state::AppState;

/// Most addresses one request may identify.
const MAX_IDENTIFY: usize = 500;

pub async fn identify(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiJson(req): ApiJson<IdentifyRequestDto>,
) -> Result<Json<IdentifyResponseDto>, ApiError> {
    if !(1..=MAX_IDENTIFY).contains(&req.addresses.len()) {
        return Err(invalid(format!(
            "1 to {MAX_IDENTIFY} addresses per request, got {}",
            req.addresses.len()
        )));
    }
    if let Some(b) = &req.batch {
        validate_batch(b)?;
    }
    let mut addrs = req
        .addresses
        .iter()
        .map(|a| parse_address(a))
        .collect::<Result<Vec<_>, _>>()?;
    addrs.sort();
    addrs.dedup();
    let needed = s
        .store
        .addrs_needing_meta(&addrs, s.ctx.cfg.meta_ttl)
        .await?;
    let jobs = enqueue_meta_owned(
        &s.ctx,
        Some(user.id),
        &needed,
        Priority::Interactive,
        req.batch.as_deref(),
    )
    .await?;
    Ok(Json(IdentifyResponseDto {
        queued: u32::try_from(needed.len()).unwrap_or(u32::MAX),
        jobs,
    }))
}
