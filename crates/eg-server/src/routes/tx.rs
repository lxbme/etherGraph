//! `GET /api/tx/{hash}`: fund-flow view and detail of one transaction, fetched
//! on demand. `GET /api/tx/{hash}/raw`: its stored tx and receipt JSON.
//! `GET /api/tx/{hash}/trace`: its decoded call trace, fetched on demand.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use eg_core::source::Priority;
use eg_core::types::{Address, TransferKind};
use eg_ingest::{
    MAX_AUTO_META, auto_meta_parties, auto_meta_targets, decode_trace,
    enqueue_current_delegate_lookup, enqueue_fetch_block, enqueue_fetch_trace, enqueue_fetch_tx,
    enqueue_meta_owned, guess_flow, guess_frames, load_tx_flow, trace_delegates,
};

use crate::auth::extract::{CurrentUser, MayStartWork};
use crate::dto::{
    CallFrameDto, CallTraceResponseDto, DecodedCallDto, DecodedEventDto, FlowDto, TxFlowDto,
    TxMetaDto, TxRawDto, TxResponseDto, hex_addr, rfc3339,
};
use crate::error::ApiError;
use crate::nodes::{enqueue_missing_meta, load_nodes, token_map};
use crate::parse::parse_tx_hash;
use crate::routes::ApiPath;
use crate::state::AppState;
use crate::txdetail::tx_detail;

/// A cross-site request (see [`MayStartWork`]) is served from what is
/// stored: a transaction not fetched yet is 404, and no job is started.
pub async fn tx(
    State(s): State<AppState>,
    user: CurrentUser,
    MayStartWork(may_start): MayStartWork,
    ApiPath(raw): ApiPath<String>,
) -> Result<Json<TxResponseDto>, ApiError> {
    let hash = parse_tx_hash(&raw)?;
    let Some(mut f) = load_tx_flow(&s.store, hash).await? else {
        if !may_start {
            return Err(ApiError::not_found("transaction not fetched"));
        }
        let job_id = enqueue_fetch_tx(&s.ctx, Some(user.id), hash).await?;
        return Ok(Json(TxResponseDto {
            status: "pending".into(),
            flow: None,
            job_id: Some(job_id),
        }));
    };

    if s.signatures_enabled() {
        guess_flow(&s.store, &mut f).await?;
    }

    let mut token_addrs: Vec<Address> = f
        .flows
        .iter()
        .filter(|fl| fl.kind == TransferKind::Erc20)
        .filter_map(|fl| fl.asset)
        .collect();
    token_addrs.sort();
    token_addrs.dedup();
    let tokens = token_map(&s.store, &token_addrs).await?;
    let trust = s.trust.get(&s.store).await;
    let nodes = load_nodes(
        &s.store,
        &f.participants,
        &HashMap::new(),
        s.ctx.cfg.hot_neighbor_threshold,
        user.id,
    )
    .await?
    .nodes;
    // Only the tx's own parties are identified automatically: the sender, the
    // recipient (or the contract the tx created), its first EIP-7702
    // delegates and the recipient's current delegate.
    let created = f.tx.raw_receipt["contractAddress"]
        .as_str()
        .and_then(|a| a.parse::<Address>().ok());
    let mut parties = auto_meta_parties(f.tx.from, f.tx.to.or(created), &f.delegations);
    parties.extend(f.to_current_delegate);
    if may_start {
        enqueue_missing_meta(&s, user.id, &parties, &f.participants, &token_addrs).await;
    }
    if f.delegate_lookup_due && may_start {
        // Fetched before the recipient's current delegate was looked up; the
        // job key dedupes repeat views and the recorded lookup ends them.
        if let Err(e) = enqueue_current_delegate_lookup(&s.ctx, Some(user.id), hash).await {
            tracing::warn!(error = %e, "enqueueing current delegate lookup failed");
        }
    }
    let block = s.store.block(f.tx.block_number).await?;
    if block.is_none() && may_start {
        // Fetched before headers were kept; the job key dedupes repeat views.
        if let Err(e) = enqueue_fetch_block(&s.ctx, Some(user.id), f.tx.block_number, hash).await {
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
                method: f
                    .call
                    .as_ref()
                    .filter(|_| !f.call_guessed)
                    .map(|c| c.name.clone()),
                selector: f.tx.selector.map(alloy_primitives::hex::encode_prefixed),
            },
            detail: tx_detail(
                &f.tx,
                block.as_ref(),
                head,
                &f.authorizations,
                &f.delegations,
            ),
            call: f.call.as_ref().map(|c| {
                if f.call_guessed {
                    DecodedCallDto::guessed(c, &f.call_alternatives)
                } else {
                    DecodedCallDto::new(c, f.call_via_delegate, f.call_via_delegate_current)
                }
            }),
            nodes,
            flows: f
                .flows
                .iter()
                .map(|fl| FlowDto::new(fl, &tokens, &trust))
                .collect(),
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

/// Only the person viewing a call tree pays for its trace: the fetch job is
/// started here, never by the fund-flow view. A cross-site request (see
/// [`MayStartWork`]) is served from the cache and starts nothing. Of the
/// contracts the default view shows (see [`auto_meta_targets`]), the first
/// [`MAX_AUTO_META`] are identified automatically, billed to the viewer; the
/// rest lacking metadata are listed in `undecoded`.
pub async fn trace(
    State(s): State<AppState>,
    user: CurrentUser,
    MayStartWork(may_start): MayStartWork,
    ApiPath(raw): ApiPath<String>,
) -> Result<Json<CallTraceResponseDto>, ApiError> {
    let hash = parse_tx_hash(&raw)?;
    let Some(row) = s.store.call_trace(hash).await? else {
        if s.store.transaction(hash).await?.is_none() {
            return Err(ApiError::not_found("transaction not fetched"));
        }
        if !may_start {
            return Err(ApiError::not_found("trace not fetched"));
        }
        let job_id = enqueue_fetch_trace(&s.ctx, Some(user.id), hash).await?;
        return Ok(Json(CallTraceResponseDto {
            status: "pending".into(),
            frames: None,
            job_id: Some(job_id),
            undecoded: Vec::new(),
        }));
    };

    // The cap applies to the targets, not to those still lacking metadata,
    // so repeat views never move on past the first `MAX_AUTO_META`.
    let tx = s.store.transaction(hash).await?;
    let delegates = trace_delegates(tx.as_ref(), &row);
    let targets = auto_meta_targets(&row, &delegates);
    let split = targets.len().min(MAX_AUTO_META);
    let (auto, rest) = targets.split_at(split);
    let ttl = s.ctx.cfg.meta_ttl;
    let mut undecoded = s.store.addrs_needing_meta(rest, ttl).await?;
    let auto = s.store.addrs_needing_meta(auto, ttl).await?;
    if !may_start {
        undecoded.splice(0..0, auto);
    } else if !auto.is_empty()
        && let Err(e) =
            enqueue_meta_owned(&s.ctx, Some(user.id), &auto, Priority::Interactive, None).await
    {
        tracing::warn!(error = %e, "enqueueing trace metadata jobs failed");
    }

    let mut frames = decode_trace(&s.store, &row, &delegates).await?;
    if s.signatures_enabled() {
        guess_frames(&s.store, &mut frames).await?;
    }
    Ok(Json(CallTraceResponseDto {
        status: "ready".into(),
        frames: Some(frames.iter().map(CallFrameDto::new).collect()),
        job_id: None,
        undecoded: undecoded.into_iter().map(hex_addr).collect(),
    }))
}
