pub mod address;
pub mod batches;
pub mod counterparties;
pub mod events;
pub mod graph;
pub mod identify;
pub mod jobs;
pub mod labels;
pub mod probe;
pub mod search;
pub mod status;
pub mod sync;
pub mod transfers;
pub mod tx;
pub mod workspaces;

use axum::Json;
use axum::extract::{FromRequest, FromRequestParts, Path, Query, Request};
use axum::http::request::Parts;
use eg_core::types::Address;
use serde::de::DeserializeOwned;

use crate::error::{ApiError, invalid};
use crate::parse::parse_address;

/// Most addresses accepted by one graph or sync request.
pub const MAX_ADDRESSES: usize = 50;

// Wrappers around axum's extractors whose rejections become the JSON
// `invalid_input` body instead of axum's plain-text responses.

/// [`Query`] with a JSON `invalid_input` rejection.
pub struct ApiQuery<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequestParts<S> for ApiQuery<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(v)| Self(v))
            .map_err(|e| invalid(e.body_text()))
    }
}

/// [`Path`] with a JSON `invalid_input` rejection.
pub struct ApiPath<T>(pub T);

impl<T: DeserializeOwned + Send, S: Send + Sync> FromRequestParts<S> for ApiPath<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Path::<T>::from_request_parts(parts, state)
            .await
            .map(|Path(v)| Self(v))
            .map_err(|e| invalid(e.body_text()))
    }
}

/// [`Json`] body with a JSON `invalid_input` rejection.
pub struct ApiJson<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(v)| Self(v))
            .map_err(|e| invalid(e.body_text()))
    }
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
