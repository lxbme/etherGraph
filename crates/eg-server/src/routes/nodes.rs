//! `POST /api/nodes`: summaries of given addresses as the graph shows them,
//! without enqueuing any job or writing anything.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;

use crate::auth::extract::CurrentUser;
use crate::dto::{NodeSummaryDto, NodesRequestDto};
use crate::error::{ApiError, invalid};
use crate::nodes::load_nodes;
use crate::parse::parse_address;
use crate::routes::ApiJson;
use crate::state::AppState;

/// Most addresses accepted by one request.
const MAX_NODES: usize = 2000;

pub async fn nodes(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiJson(req): ApiJson<NodesRequestDto>,
) -> Result<Json<Vec<NodeSummaryDto>>, ApiError> {
    if req.addresses.is_empty() || req.addresses.len() > MAX_NODES {
        return Err(invalid(format!(
            "addresses must hold 1 to {MAX_NODES} entries, got {}",
            req.addresses.len()
        )));
    }
    let addrs = req
        .addresses
        .iter()
        .map(|a| parse_address(a))
        .collect::<Result<Vec<_>, _>>()?;
    let loaded = load_nodes(
        &s.store,
        &addrs,
        &HashMap::new(),
        s.ctx.cfg.hot_neighbor_threshold,
        user.id,
    )
    .await?;
    Ok(Json(loaded.nodes))
}
