//! `GET /api/transfers`: keyset-paginated transfer list for one address
//! (`address=`) or one ordered pair (`from=&to=`).

use axum::Json;
use axum::extract::{Query, State};
use eg_core::filter::{EdgeFilter, TimeRange};
use eg_store::{TransferCursor, TransferQuery, TransferScope};
use serde::Deserialize;

use crate::dto::{TransferDto, TransferPageDto};
use crate::error::{ApiError, invalid};
use crate::nodes::token_map;
use crate::parse::{parse_address, parse_asset, parse_kind, parse_time};
use crate::state::AppState;

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;

/// All fields are strings so malformed values get the JSON error body.
#[derive(Deserialize)]
pub struct TransfersQuery {
    pub address: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    /// `eth` or a token address.
    pub asset: Option<String>,
    pub time_from: Option<String>,
    pub time_to: Option<String>,
    /// Comma-separated transfer kinds.
    pub kinds: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<String>,
}

pub async fn list(
    State(s): State<AppState>,
    Query(q): Query<TransfersQuery>,
) -> Result<Json<TransferPageDto>, ApiError> {
    let scope = match (&q.address, &q.from, &q.to) {
        (Some(a), None, None) => TransferScope::Address(parse_address(a)?),
        (None, Some(f), Some(t)) => TransferScope::Pair {
            from: parse_address(f)?,
            to: parse_address(t)?,
        },
        _ => return Err(invalid("pass either address or both from and to")),
    };
    let asset = q.asset.as_deref().map(parse_asset).transpose()?;
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
                ..EdgeFilter::default()
            },
            cursor,
            limit,
        })
        .await?;
    let mut assets: Vec<_> = items.iter().filter_map(|t| t.asset).collect();
    assets.sort();
    assets.dedup();
    let tokens = token_map(&s.store, &assets).await?;
    Ok(Json(TransferPageDto {
        items: items.iter().map(|t| TransferDto::new(t, &tokens)).collect(),
        next_cursor: next.map(|c| c.encode()),
    }))
}
