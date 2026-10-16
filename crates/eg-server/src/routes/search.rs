//! `GET /api/search?q=`: classify an address, transaction hash or ENS name.

use axum::Json;
use axum::extract::{Query, State};
use eg_core::source::{Priority, SourceError};
use eg_core::types::Address;
use eg_decode::{decode_resolve_addr, encode_resolve_addr, normalize};
use serde::Deserialize;

use crate::dto::{SearchResultDto, hex_addr};
use crate::error::{ApiError, invalid};
use crate::parse::{is_hex, parse_address, parse_tx_hash};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

pub async fn search(
    State(s): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<SearchResultDto>, ApiError> {
    let q = q.q.unwrap_or_default();
    let q = q.trim();
    let result = |kind: &str, value: String, resolved_address| SearchResultDto {
        kind: kind.to_owned(),
        value,
        resolved_address,
    };
    let dto = if is_hex(q, 40) {
        result("address", hex_addr(parse_address(q)?), None)
    } else if is_hex(q, 64) {
        result("tx", format!("{:#x}", parse_tx_hash(q)?), None)
    } else if q.contains('.') {
        let name = normalize(q).map_err(|e| invalid(e.to_string()))?;
        let addr = resolve(&s, &name).await?;
        result("ens", name, Some(hex_addr(addr)))
    } else {
        return Err(invalid(format!(
            "{q:?} is not an address, transaction hash or ENS name"
        )));
    };
    Ok(Json(dto))
}

/// Forward resolution through the UniversalResolver; a revert or the zero
/// address is 404.
async fn resolve(s: &AppState, name: &str) -> Result<Address, ApiError> {
    let data = encode_resolve_addr(name).map_err(|e| invalid(e.to_string()))?;
    let unresolved = || ApiError::not_found(format!("{name} does not resolve to an address"));
    let ret = match s
        .source
        .eth_call(Priority::Interactive, s.cfg.ens.universal_resolver, data)
        .await
    {
        Ok(ret) => ret,
        Err(SourceError::Rpc { .. }) => return Err(unresolved()),
        Err(e) => return Err(e.into()),
    };
    decode_resolve_addr(&ret).ok_or_else(unresolved)
}
