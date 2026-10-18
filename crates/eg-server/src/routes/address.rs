//! `GET /api/address/{addr}?sync=auto|none`: address profile.
//!
//! `none` (default) never starts a first sync: syncing a new address costs
//! upstream calls the user has to confirm. Existing coverage that is stale is
//! refreshed in the background (Latest, Background priority). `auto`, used
//! when the user opened the address from search, additionally starts an
//! Interactive Latest sync when not every kind is covered yet.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use chrono::Utc;
use eg_core::source::Priority;
use eg_ingest::{SyncDirection, enqueue_sync};
use eg_store::SyncRow;
use serde::Deserialize;

use crate::auth::extract::CurrentUser;
use crate::dto::{AddressProfileDto, SyncStatusDto, hex_addr, rfc3339};
use crate::error::{ApiError, invalid};
use crate::nodes::{enqueue_missing_meta, load_nodes};
use crate::parse::parse_address;
use crate::routes::{ApiPath, ApiQuery};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ProfileQuery {
    /// `auto` or `none` (default).
    pub sync: Option<String>,
}

pub async fn profile(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiPath(raw): ApiPath<String>,
    ApiQuery(q): ApiQuery<ProfileQuery>,
) -> Result<Json<AddressProfileDto>, ApiError> {
    let addr = parse_address(&raw)?;
    let auto = match q.sync.as_deref() {
        None | Some("none") => false,
        Some("auto") => true,
        Some(other) => {
            return Err(invalid(format!(
                "sync must be \"auto\" or \"none\", got {other:?}"
            )));
        }
    };
    let mut loaded = load_nodes(
        &s.store,
        &[addr],
        &HashMap::new(),
        s.ctx.cfg.hot_neighbor_threshold,
        user.id,
    )
    .await?;
    let activity = s.store.address_activity(addr).await?;
    let node = loaded.nodes.remove(0);
    let rows = loaded.sync.remove(&addr).unwrap_or_default();
    let account = loaded.accounts.remove(&addr);

    let refresh = if auto && !node.synced {
        Some(Priority::Interactive)
    } else if is_stale(&s, &rows) {
        Some(Priority::Background)
    } else {
        None
    };
    if let Some(p) = refresh {
        // Serve what is stored now; the sync result arrives over SSE.
        if let Err(e) = enqueue_sync(
            &s.ctx,
            Some(user.id),
            addr,
            SyncDirection::Latest,
            p,
            Some(s.ctx.cfg.page_size),
            None,
        )
        .await
        {
            tracing::warn!(error = %e, address = %hex_addr(addr), "enqueueing sync failed");
        }
    }
    enqueue_missing_meta(&s, user.id, &[addr], &[addr], &[]).await;

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

/// Some covered kind (`to_block` set) was synced longer ago than
/// `stale_after`. Kinds without coverage (never synced, or failed for good)
/// do not count, so they cannot trigger a refresh on every view.
fn is_stale(s: &AppState, rows: &[SyncRow]) -> bool {
    let stale = chrono::Duration::from_std(s.ctx.cfg.stale_after).unwrap_or(chrono::Duration::MAX);
    let now = Utc::now();
    rows.iter().filter(|r| r.to_block.is_some()).any(|r| {
        r.last_synced_at
            .is_none_or(|t| now.signed_duration_since(t) > stale)
    })
}
