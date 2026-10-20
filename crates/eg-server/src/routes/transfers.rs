//! `GET /api/transfers`: keyset-paginated transfer list for one address
//! (`address=`, optionally narrowed by `direction=in|out|both`) or one
//! ordered pair (`from=&to=`).

use axum::Json;
use axum::extract::State;
use eg_core::filter::{Direction, EdgeFilter, TimeRange};
use eg_store::{TransferCursor, TransferQuery, TransferScope};
use serde::Deserialize;

use crate::dto::{TransferBatchRequestDto, TransferDto, TransferPageDto};
use crate::error::{ApiError, invalid};
use crate::nodes::token_map;
use crate::parse::{parse_address, parse_asset, parse_direction, parse_kind, parse_time};
use crate::routes::graph::{asset_filters, edge_filter};
use crate::routes::{ApiJson, ApiQuery};
use crate::state::AppState;

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;
const BATCH_DEFAULT_LIMIT: u32 = 500;
const BATCH_MAX_LIMIT: u32 = 1000;
const BATCH_MAX_PAIRS: usize = 5000;

/// All fields are strings so malformed values get the JSON error body.
#[derive(Deserialize)]
pub struct TransfersQuery {
    pub address: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    /// `eth` or a token address.
    pub asset: Option<String>,
    /// Decimal string in whole units of `asset` (required with it), scaled by
    /// the asset's decimals as for graph edges.
    pub min_amount: Option<String>,
    pub time_from: Option<String>,
    pub time_to: Option<String>,
    /// Comma-separated transfer kinds.
    pub kinds: Option<String>,
    /// `in` / `out` / `both` relative to `address`; only valid with the address scope.
    pub direction: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<String>,
}

pub async fn list(
    State(s): State<AppState>,
    ApiQuery(q): ApiQuery<TransfersQuery>,
) -> Result<Json<TransferPageDto>, ApiError> {
    let scope = match (&q.address, &q.from, &q.to) {
        (Some(a), None, None) => TransferScope::Address(parse_address(a)?),
        (None, Some(f), Some(t)) => TransferScope::Pair {
            from: parse_address(f)?,
            to: parse_address(t)?,
        },
        _ => return Err(invalid("pass either address or both from and to")),
    };
    if q.direction.is_some() && !matches!(scope, TransferScope::Address(_)) {
        return Err(invalid("direction is only valid with address"));
    }
    let direction = parse_direction(q.direction.as_deref())?;
    let asset = q.asset.as_deref().map(parse_asset).transpose()?;
    let assets = match (asset, q.min_amount) {
        (_, None) => Vec::new(),
        (None, Some(_)) => return Err(invalid("min_amount requires asset")),
        (Some(a), Some(min)) => asset_filters(&s.store, vec![(a, Some(min))]).await?,
    };
    let kinds = q
        .kinds
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(parse_kind)
        .collect::<Result<Vec<_>, _>>()?;
    let time = TimeRange {
        from: q
            .time_from
            .as_deref()
            .map(|t| parse_time(t, "time_from"))
            .transpose()?,
        to: q
            .time_to
            .as_deref()
            .map(|t| parse_time(t, "time_to"))
            .transpose()?,
    };
    let cursor = q
        .cursor
        .as_deref()
        .map(|c| TransferCursor::decode(c).ok_or_else(|| invalid("invalid cursor")))
        .transpose()?;
    let limit = match q.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(l) => l
            .parse::<u32>()
            .map_err(|_| invalid(format!("limit must be a non-negative integer, got {l:?}")))?
            .clamp(1, MAX_LIMIT),
    };

    let (items, next) = s
        .store
        .list_transfers(&TransferQuery {
            scope,
            asset,
            filter: EdgeFilter {
                time,
                kinds,
                assets,
                direction,
                exclude_assets: Vec::new(),
            },
            cursor,
            limit,
        })
        .await?;
    let mut assets: Vec<_> = items.iter().filter_map(|t| t.asset).collect();
    assets.sort();
    assets.dedup();
    let tokens = token_map(&s.store, &assets).await?;
    let trust = s.trust.get(&s.store).await;
    Ok(Json(TransferPageDto {
        items: items
            .iter()
            .map(|t| TransferDto::new(t, &tokens, &trust))
            .collect(),
        next_cursor: next.map(|c| c.encode()),
    }))
}

/// `POST /api/transfers/batch`: the transfers behind a set of graph edges
/// (`pairs`), under the graph's filter, newest first and keyset-paginated.
pub async fn batch(
    State(s): State<AppState>,
    ApiJson(req): ApiJson<TransferBatchRequestDto>,
) -> Result<Json<TransferPageDto>, ApiError> {
    if req.pairs.is_empty() || req.pairs.len() > BATCH_MAX_PAIRS {
        return Err(invalid(format!(
            "pairs must hold 1 to {BATCH_MAX_PAIRS} entries, got {}",
            req.pairs.len()
        )));
    }
    let pairs = req
        .pairs
        .iter()
        .map(|p| {
            let asset = p.asset.as_deref().map(parse_asset).transpose()?.flatten();
            Ok((parse_address(&p.from)?, parse_address(&p.to)?, asset))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let mut filter = edge_filter(&s, req.filter).await?;
    // The pairs are already the chosen edges, whichever side they were found from.
    filter.direction = Direction::Both;
    let cursor = req
        .cursor
        .as_deref()
        .map(|c| TransferCursor::decode(c).ok_or_else(|| invalid("invalid cursor")))
        .transpose()?;
    let limit = req
        .limit
        .unwrap_or(BATCH_DEFAULT_LIMIT)
        .clamp(1, BATCH_MAX_LIMIT);

    let (items, next) = s
        .store
        .list_transfers_for_pairs(&pairs, &filter, cursor.as_ref(), limit)
        .await?;
    let mut assets: Vec<_> = items.iter().filter_map(|t| t.asset).collect();
    assets.sort();
    assets.dedup();
    let tokens = token_map(&s.store, &assets).await?;
    let trust = s.trust.get(&s.store).await;
    Ok(Json(TransferPageDto {
        items: items
            .iter()
            .map(|t| TransferDto::new(t, &tokens, &trust))
            .collect(),
        next_cursor: next.map(|c| c.encode()),
    }))
}
