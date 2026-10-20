//! `GET /api/address/{addr}/assets[?with={b}]`: the assets `addr` moved over
//! all its stored transfers (or, with `with`, per direction between `addr` and
//! `b`), for the transfer table's own filter. Unfiltered by any graph filter;
//! reads local data only and never starts a sync.

use axum::Json;
use axum::extract::State;
use serde::Deserialize;

use crate::dto::{AddressAssetDto, asset_meta, asset_trust, hex_addr};
use crate::error::ApiError;
use crate::nodes::token_map;
use crate::parse::parse_address;
use crate::routes::{ApiPath, ApiQuery};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct AssetsQuery {
    /// The other address of a pair.
    pub with: Option<String>,
}

pub async fn list(
    State(s): State<AppState>,
    ApiPath(raw): ApiPath<String>,
    ApiQuery(q): ApiQuery<AssetsQuery>,
) -> Result<Json<Vec<AddressAssetDto>>, ApiError> {
    let addr = parse_address(&raw)?;
    let with = q.with.as_deref().map(parse_address).transpose()?;
    let rows = s.store.address_assets(addr, with).await?;
    let mut assets: Vec<_> = rows.iter().filter_map(|r| r.asset).collect();
    assets.sort();
    assets.dedup();
    let tokens = token_map(&s.store, &assets).await?;
    let trust = s.trust.get(&s.store).await;
    let items = rows
        .iter()
        .map(|r| {
            let (decimals, symbol) = asset_meta(r.asset, &tokens);
            AddressAssetDto {
                from: r.from.map(hex_addr),
                to: r.to.map(hex_addr),
                asset: r.asset.map(hex_addr),
                asset_kind: r.asset_kind.as_str().to_owned(),
                count: r.count,
                sum: r.sum.to_string(),
                decimals,
                symbol,
                trust: asset_trust(&trust, r.asset, r.asset_kind, &tokens),
            }
        })
        .collect();
    Ok(Json(items))
}
