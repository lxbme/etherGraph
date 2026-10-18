//! `GET /api/address/{addr}/counterparties`: the addresses `addr` has traded
//! with, for expansion candidates and for browsing a contract's interactions.
//! Reads local data only and never starts a sync.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use eg_core::filter::{EdgeFilter, TimeRange};
use eg_core::types::TransferKind;
use eg_store::{AccountKindFilter, CounterpartySort};
use serde::Deserialize;

use crate::auth::extract::CurrentUser;
use crate::dto::{
    AssetRefDto, CounterpartyDto, CounterpartyPageDto, asset_meta, asset_trust, hex_addr, rfc3339,
};
use crate::error::{ApiError, invalid};
use crate::nodes::{enqueue_missing_names, load_nodes, token_map};
use crate::parse::{parse_address, parse_time};
use crate::routes::{ApiPath, ApiQuery};
use crate::state::AppState;

const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 1000;
/// Most rows of one page whose ENS names are queued for resolution.
const NAME_LOOKUPS: usize = 100;

/// All fields are strings so malformed values get the JSON error body.
#[derive(Deserialize)]
pub struct CounterpartiesQuery {
    /// `count_asc`, `count_desc` (default) or `recent`.
    pub sort: Option<String>,
    pub limit: Option<String>,
    pub offset: Option<String>,
    /// `eoa` (includes unknown), `contract` or `all` (default).
    pub kind: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

pub async fn list(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiPath(raw): ApiPath<String>,
    ApiQuery(q): ApiQuery<CounterpartiesQuery>,
) -> Result<Json<CounterpartyPageDto>, ApiError> {
    let addr = parse_address(&raw)?;
    let sort = match q.sort.as_deref() {
        None | Some("count_desc") => CounterpartySort::CountDesc,
        Some("count_asc") => CounterpartySort::CountAsc,
        Some("recent") => CounterpartySort::Recent,
        Some(o) => {
            return Err(invalid(format!(
                "sort must be count_asc, count_desc or recent, got {o:?}"
            )));
        }
    };
    let kind = match q.kind.as_deref() {
        None | Some("all") => None,
        Some("eoa") => Some(AccountKindFilter::Eoa),
        Some("contract") => Some(AccountKindFilter::Contract),
        Some(o) => {
            return Err(invalid(format!(
                "kind must be eoa, contract or all, got {o:?}"
            )));
        }
    };
    let limit = match q.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(l) => match l.parse::<u32>() {
            Ok(n) if (1..=MAX_LIMIT).contains(&n) => n,
            _ => {
                return Err(invalid(format!(
                    "limit must be an integer from 1 to {MAX_LIMIT}, got {l:?}"
                )));
            }
        },
    };
    let offset = match q.offset.as_deref() {
        None => 0,
        Some(o) => o
            .parse::<u32>()
            .map_err(|_| invalid(format!("offset must be a non-negative integer, got {o:?}")))?,
    };
    let filter = EdgeFilter {
        time: TimeRange {
            from: q
                .from
                .as_deref()
                .map(|t| parse_time(t, "from"))
                .transpose()?,
            to: q.to.as_deref().map(|t| parse_time(t, "to")).transpose()?,
        },
        ..EdgeFilter::default()
    };

    let (rows, total) = s
        .store
        .counterparties(addr, &filter, kind, sort, limit, offset)
        .await?;
    let addrs: Vec<_> = rows.iter().map(|r| r.address).collect();
    let mut assets: Vec<_> = rows
        .iter()
        .flat_map(|r| r.assets.iter().copied().flatten())
        .collect();
    assets.sort();
    assets.dedup();
    let tokens = token_map(&s.store, &assets).await?;
    let trust = s.trust.get(&s.store).await;
    let nodes = load_nodes(
        &s.store,
        &addrs,
        &HashMap::new(),
        s.ctx.cfg.hot_neighbor_threshold,
        user.id,
    )
    .await?
    .nodes;
    // Candidate kinds come from the probe; only cheap, batched ENS lookups for
    // the head of the page, never contract or token metadata.
    enqueue_missing_names(&s, user.id, &addrs[..addrs.len().min(NAME_LOOKUPS)]).await;
    let items = rows
        .iter()
        .zip(nodes)
        .map(|(r, node)| CounterpartyDto {
            node,
            count: r.count,
            last_ts: rfc3339(r.last_ts),
            assets: r
                .assets
                .iter()
                .map(|&a| {
                    // The stored standard, else ERC-20 (ETH ignores the kind).
                    let kind = a
                        .and_then(|a| tokens.get(&a))
                        .map_or(TransferKind::Erc20, |t| t.kind);
                    AssetRefDto {
                        asset: a.map(hex_addr),
                        symbol: asset_meta(a, &tokens).1,
                        trust: asset_trust(&trust, a, kind, &tokens),
                    }
                })
                .collect(),
        })
        .collect();
    Ok(Json(CounterpartyPageDto { items, total }))
}
