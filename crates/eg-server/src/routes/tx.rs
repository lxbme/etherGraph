//! `GET /api/tx/{hash}`: fund-flow view of one transaction, fetched on demand.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use eg_core::types::{Address, TransferKind};
use eg_ingest::{enqueue_fetch_tx, load_tx_flow};

use crate::dto::{
    DecodedCallDto, DecodedEventDto, FlowDto, TxFlowDto, TxMetaDto, TxResponseDto, hex_addr,
    rfc3339,
};
use crate::error::ApiError;
use crate::nodes::{enqueue_missing_meta, load_nodes, token_map};
use crate::parse::parse_tx_hash;
use crate::routes::ApiPath;
use crate::state::AppState;

pub async fn tx(
    State(s): State<AppState>,
    ApiPath(raw): ApiPath<String>,
) -> Result<Json<TxResponseDto>, ApiError> {
    let hash = parse_tx_hash(&raw)?;
    let Some(f) = load_tx_flow(&s.store, hash).await? else {
        let job_id = enqueue_fetch_tx(&s.ctx, hash).await?;
        return Ok(Json(TxResponseDto {
            status: "pending".into(),
            flow: None,
            job_id: Some(job_id),
        }));
    };

    let mut token_addrs: Vec<Address> = f
        .flows
        .iter()
        .filter(|fl| fl.kind == TransferKind::Erc20)
        .filter_map(|fl| fl.asset)
        .collect();
    token_addrs.sort();
    token_addrs.dedup();
    let tokens = token_map(&s.store, &token_addrs).await?;
    let nodes = load_nodes(
        &s.store,
        &f.participants,
        &HashMap::new(),
        s.ctx.cfg.hot_neighbor_threshold,
    )
    .await?
    .nodes;
    enqueue_missing_meta(&s, &f.participants, &token_addrs).await;

    let completeness = serde_json::to_value(f.completeness)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(ApiError::internal)?;
    Ok(Json(TxResponseDto {
        status: "ready".into(),
        flow: Some(TxFlowDto {
            tx: TxMetaDto {
                hash: format!("{:#x}", f.tx.hash),
                block_number: f.tx.block_number,
                ts: rfc3339(f.tx.ts),
                from: hex_addr(f.tx.from),
                to: f.tx.to.map(hex_addr),
                value: f.tx.value.to_string(),
                success: f.tx.success,
                gas_used: f.tx.gas_used.to_string(),
                fee: f.tx.fee.to_string(),
                method: f.call.as_ref().map(|c| c.name.clone()),
                selector: f.tx.selector.map(alloy_primitives::hex::encode_prefixed),
            },
            call: f.call.as_ref().map(DecodedCallDto::from),
            nodes,
            flows: f.flows.iter().map(|fl| FlowDto::new(fl, &tokens)).collect(),
            events: f.events.iter().map(DecodedEventDto::from).collect(),
            completeness,
        }),
        job_id: None,
    }))
}
