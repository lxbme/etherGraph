//! `POST /api/graph/edges`: aggregated edges around center addresses plus
//! summaries of every node they touch.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::State;
use eg_core::filter::{AssetFilter, EdgeFilter, EdgeQuery, SortBy, TimeRange};
use eg_core::types::Address;
use eg_store::Store;

use crate::dto::{
    EdgeDto, EdgeFilterDto, GraphRequestDto, GraphResponseDto, SyncStatusDto, hex_addr,
};
use crate::error::{ApiError, invalid};
use crate::nodes::{enqueue_missing_meta, load_nodes, token_map};
use crate::parse::{parse_amount, parse_asset, parse_direction, parse_kind, parse_time};
use crate::routes::{ApiJson, parse_addresses};
use crate::state::AppState;

const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 1000;
const ETH_DECIMALS: u8 = 18;

pub async fn edges(
    State(s): State<AppState>,
    ApiJson(req): ApiJson<GraphRequestDto>,
) -> Result<Json<GraphResponseDto>, ApiError> {
    let centers = parse_addresses(&req.addresses)?;
    let filter = edge_filter(&s.store, req.filter.unwrap_or_default()).await?;
    let sort = match req.sort.as_deref() {
        None | Some("count") => SortBy::Count,
        Some("recent") => SortBy::Recent,
        Some("amount") => {
            let assets: HashSet<_> = filter.assets.iter().map(|a| a.asset).collect();
            if assets.len() != 1 {
                return Err(invalid(
                    "sort \"amount\" requires exactly one asset in filter.assets",
                ));
            }
            SortBy::Amount
        }
        Some(other) => {
            return Err(invalid(format!(
                "sort must be \"count\", \"amount\" or \"recent\", got {other:?}"
            )));
        }
    };
    let limit = req
        .limit_per_address
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let res = s
        .store
        .query_edges(&EdgeQuery {
            centers: centers.clone(),
            filter,
            limit_per_center: limit,
            sort,
        })
        .await?;

    // Nodes: the centers first, then other endpoints in edge order.
    let mut seen: HashSet<Address> = centers.iter().copied().collect();
    let mut nodes = centers;
    let mut neighbours: HashMap<Address, HashSet<Address>> = HashMap::new();
    for e in &res.edges {
        for a in [e.from, e.to] {
            if seen.insert(a) {
                nodes.push(a);
            }
        }
        if e.from != e.to {
            neighbours.entry(e.from).or_default().insert(e.to);
            neighbours.entry(e.to).or_default().insert(e.from);
        }
    }
    let degree: HashMap<Address, u64> = nodes
        .iter()
        .map(|a| {
            let returned = neighbours.get(a).map_or(0, |n| n.len() as u64);
            (*a, returned + res.omitted.get(a).copied().unwrap_or(0))
        })
        .collect();

    let mut assets: Vec<Address> = res.edges.iter().filter_map(|e| e.asset).collect();
    assets.sort();
    assets.dedup();
    let tokens = token_map(&s.store, &assets).await?;
    let loaded = load_nodes(&s.store, &nodes, &degree, s.ctx.cfg.hot_neighbor_threshold).await?;
    enqueue_missing_meta(&s, &nodes, &assets).await;

    let coverage = nodes
        .iter()
        .map(|a| {
            let rows = loaded.sync.get(a).map_or(&[][..], Vec::as_slice);
            (hex_addr(*a), rows.iter().map(SyncStatusDto::from).collect())
        })
        .collect();
    Ok(Json(GraphResponseDto {
        nodes: loaded.nodes,
        edges: res.edges.iter().map(|e| EdgeDto::new(e, &tokens)).collect(),
        omitted: res
            .omitted
            .iter()
            .map(|(a, n)| (hex_addr(*a), *n))
            .collect(),
        coverage,
    }))
}

/// Converts the request filter; `min_amount`s are scaled as in [`asset_filters`].
async fn edge_filter(store: &Store, f: EdgeFilterDto) -> Result<EdgeFilter, ApiError> {
    let time = f.time.unwrap_or_default();
    let time = TimeRange {
        from: time
            .from
            .as_deref()
            .map(|t| parse_time(t, "time.from"))
            .transpose()?,
        to: time
            .to
            .as_deref()
            .map(|t| parse_time(t, "time.to"))
            .transpose()?,
    };
    let kinds = f
        .kinds
        .unwrap_or_default()
        .iter()
        .map(|k| parse_kind(k))
        .collect::<Result<Vec<_>, _>>()?;
    let direction = parse_direction(f.direction.as_deref())?;

    let mut parsed = Vec::new();
    for a in f.assets.unwrap_or_default() {
        let asset = a.asset.as_deref().map(parse_asset).transpose()?.flatten();
        parsed.push((asset, a.min_amount));
    }
    let assets = asset_filters(store, parsed).await?;
    Ok(EdgeFilter {
        time,
        kinds,
        direction,
        assets,
    })
}

/// Per-asset filters from `(asset, min_amount)` pairs (`None` asset is ETH).
/// A `min_amount` is a decimal string in whole units, scaled by the asset's
/// decimals (18 for ETH, `tokens.decimals` otherwise); unknown decimals or a
/// malformed amount are `invalid_input`.
pub(crate) async fn asset_filters(
    store: &Store,
    parsed: Vec<(Option<Address>, Option<String>)>,
) -> Result<Vec<AssetFilter>, ApiError> {
    let need_decimals: Vec<Address> = parsed
        .iter()
        .filter(|(_, min)| min.is_some())
        .filter_map(|(a, _)| *a)
        .collect();
    let tokens = token_map(store, &need_decimals).await?;
    let mut assets = Vec::with_capacity(parsed.len());
    for (asset, min) in parsed {
        let min_raw = match min {
            None => None,
            Some(m) => {
                let decimals = match asset {
                    None => ETH_DECIMALS,
                    Some(a) => tokens
                        .get(&a)
                        .and_then(|t| t.decimals)
                        .ok_or_else(|| invalid(format!("unknown decimals for {}", hex_addr(a))))?,
                };
                let raw = parse_amount(&m, decimals)
                    .map_err(|e| invalid(format!("invalid min_amount {m:?}: {e}")))?;
                Some(raw)
            }
        };
        assets.push(AssetFilter { asset, min_raw });
    }
    Ok(assets)
}
