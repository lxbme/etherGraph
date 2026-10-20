//! `GET /api/address/{addr}?sync=auto|none`: address profile.
//! A cross-site request (see [`MayStartWork`]) starts no sync or metadata
//! job.
//!
//! `none` (default) never starts a sync: syncing costs upstream calls the
//! user has to confirm, and stale coverage is refreshed only when the user
//! asks. `auto`, used when the user opened the address from search, starts an
//! Interactive Latest sync when not every kind is covered yet.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use eg_core::source::Priority;
use eg_ingest::{SyncDirection, enqueue_sync};
use serde::Deserialize;

use crate::auth::extract::{CurrentUser, MayStartWork};
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
    MayStartWork(may_start): MayStartWork,
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

    if may_start && auto && !node.synced {
        // Serve what is stored now; the sync result arrives over SSE.
        if let Err(e) = enqueue_sync(
            &s.ctx,
            Some(user.id),
            addr,
            SyncDirection::Latest,
            Priority::Interactive,
            Some(s.ctx.cfg.shallow_cap()),
            None,
        )
        .await
        {
            tracing::warn!(error = %e, address = %hex_addr(addr), "enqueueing sync failed");
        }
    }
    if may_start {
        enqueue_missing_meta(&s, user.id, &[addr], &[addr], &[]).await;
    }

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
