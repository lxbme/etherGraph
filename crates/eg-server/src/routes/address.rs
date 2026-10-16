//! `GET /api/address/{addr}`: address profile; triggers a sync when the
//! address was never synced (Interactive) or its coverage is stale (Background).

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use chrono::Utc;
use eg_core::source::Priority;
use eg_ingest::{SyncDirection, enqueue_sync};
use eg_store::SyncRow;

use crate::dto::{AddressProfileDto, SyncStatusDto, hex_addr, rfc3339};
use crate::error::ApiError;
use crate::nodes::{enqueue_missing_meta, load_nodes};
use crate::parse::parse_address;
use crate::state::AppState;

pub async fn profile(
    State(s): State<AppState>,
    Path(raw): Path<String>,
) -> Result<Json<AddressProfileDto>, ApiError> {
    let addr = parse_address(&raw)?;
    let mut loaded = load_nodes(
        &s.store,
        &[addr],
        &HashMap::new(),
        s.ctx.cfg.hot_neighbor_threshold,
    )
    .await?;
    let activity = s.store.address_activity(addr).await?;
    let node = loaded.nodes.remove(0);
    let rows = loaded.sync.remove(&addr).unwrap_or_default();
    let account = loaded.accounts.remove(&addr);

    let refresh = if !node.synced {
        Some(Priority::Interactive)
    } else if is_stale(&s, &rows) {
        Some(Priority::Background)
    } else {
        None
    };
    if let Some(p) = refresh {
        // Serve what is stored now; the sync result arrives over SSE.
        if let Err(e) = enqueue_sync(&s.ctx, addr, SyncDirection::Latest, p).await {
            tracing::warn!(error = %e, address = %hex_addr(addr), "enqueueing sync failed");
        }
    }
    enqueue_missing_meta(&s, &[addr], &[]).await;

    Ok(Json(AddressProfileDto {
        node,
        is_proxy: account.as_ref().is_some_and(|a| a.is_proxy),
        implementation: account
            .as_ref()
            .and_then(|a| a.implementation)
            .map(hex_addr),
        creator: account.as_ref().and_then(|a| a.creator).map(hex_addr),
        creation_tx: account
            .as_ref()
            .and_then(|a| a.creation_tx)
            .map(|h| format!("{h:#x}")),
        coverage: rows.iter().map(SyncStatusDto::from).collect(),
        first_seen: activity.map(|(first, _)| rfc3339(first)),
        last_seen: activity.map(|(_, last)| rfc3339(last)),
    }))
}

/// Any category synced longer ago than `stale_after` (or never).
fn is_stale(s: &AppState, rows: &[SyncRow]) -> bool {
    let stale = chrono::Duration::from_std(s.ctx.cfg.stale_after).unwrap_or(chrono::Duration::MAX);
    let now = Utc::now();
    rows.iter().any(|r| {
        r.last_synced_at
            .is_none_or(|t| now.signed_duration_since(t) > stale)
    })
}
