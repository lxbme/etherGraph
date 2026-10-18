//! `GET /api/tx/{hash}`: fund-flow view and detail of one transaction, fetched
//! on demand. `GET /api/tx/{hash}/raw`: its stored tx and receipt JSON.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use eg_core::types::{Address, TransferKind};
use eg_ingest::{enqueue_fetch_block, enqueue_fetch_tx, load_tx_flow};

use crate::dto::{
    DecodedCallDto, DecodedEventDto, FlowDto, TxFlowDto, TxMetaDto, TxRawDto, TxResponseDto,
    hex_addr, rfc3339,
};
use crate::error::ApiError;
use crate::nodes::{enqueue_missing_meta, load_nodes, token_map};
use crate::parse::parse_tx_hash;
use crate::routes::ApiPath;
use crate::state::AppState;
use crate::txdetail::tx_detail;

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
    // Only the tx's own parties are identified automatically: the sender and
    // the recipient (or the contract the tx created).
    let created = f.tx.raw_receipt["contractAddress"]
        .as_str()
        .and_then(|a| a.parse::<Address>().ok());
    let parties: Vec<Address> = std::iter::once(f.tx.from)
        .chain(f.tx.to.or(created))
        .collect();
    enqueue_missing_meta(&s, &parties, &f.participants, &token_addrs).await;
    let block = s.store.block(f.tx.block_number).await?;
    if block.is_none() {
        // Fetched before headers were kept; the job key dedupes repeat views.
        if let Err(e) = enqueue_fetch_block(&s.ctx, f.tx.block_number, hash).await {
            tracing::warn!(error = %e, "enqueueing block backfill failed");
        }
    }
    let head = s.head.get(&s);

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
            detail: tx_detail(&f.tx, block.as_ref(), head),
            call: f.call.as_ref().map(DecodedCallDto::from),
            nodes,
            flows: f.flows.iter().map(|fl| FlowDto::new(fl, &tokens)).collect(),
            events: f.events.iter().map(DecodedEventDto::from).collect(),
            completeness,
        }),
        job_id: None,
    }))
}

pub async fn raw(
    State(s): State<AppState>,
    ApiPath(raw): ApiPath<String>,
) -> Result<Json<TxRawDto>, ApiError> {
    let hash = parse_tx_hash(&raw)?;
    let row = s
        .store
        .transaction(hash)
        .await?
        .ok_or_else(|| ApiError::not_found("transaction not fetched"))?;
    Ok(Json(TxRawDto {
        tx: row.raw_tx,
        receipt: row.raw_receipt,
    }))
}
