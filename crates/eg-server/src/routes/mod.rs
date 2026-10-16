pub mod address;
pub mod events;
pub mod graph;
pub mod jobs;
pub mod search;
pub mod status;
pub mod sync;
pub mod transfers;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use eg_core::types::Address;

use crate::error::{ApiError, invalid};
use crate::parse::parse_address;

/// Most addresses accepted by one graph or sync request.
pub const MAX_ADDRESSES: usize = 50;

/// Unwraps a JSON body, turning a rejection into a JSON `invalid_input` error.
pub fn json_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(v)| v).map_err(|e| invalid(e.body_text()))
}

/// 1 to [`MAX_ADDRESSES`] addresses, deduplicated in input order.
pub fn parse_addresses(raw: &[String]) -> Result<Vec<Address>, ApiError> {
    if raw.is_empty() {
        return Err(invalid("addresses must not be empty"));
    }
    if raw.len() > MAX_ADDRESSES {
        return Err(invalid(format!(
            "at most {MAX_ADDRESSES} addresses per request, got {}",
            raw.len()
        )));
    }
    let mut out: Vec<Address> = Vec::with_capacity(raw.len());
    for s in raw {
        let a = parse_address(s)?;
        if !out.contains(&a) {
            out.push(a);
        }
    }
    Ok(out)
}
