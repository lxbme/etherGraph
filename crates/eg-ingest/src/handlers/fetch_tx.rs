//! `FetchTx`: fetches one transaction with its receipt, block time and
//! internal transfers, stores it, looks up its recipient's current EIP-7702
//! delegate when its call decodes no other way, and queues metadata for its
//! own parties (sender, recipient, EIP-7702 delegates) and its tokens. With
//! `current_delegate_only`, it only does that lookup for a stored tx (one
//! fetched before lookups were made).

use std::collections::HashSet;

use async_trait::async_trait;
use eg_core::source::{Priority, SourceError};
use eg_core::types::{Address, Transfer, TransferKind, TxHash, U256, assign_sub_ids};
use eg_decode::decode_transfer_logs;
use eg_store::{JobRow, JobStatus, TxRow};
use serde::Deserialize;

use crate::authorization::{authorizations, auto_meta_parties, effective_delegations, tx_nonce};
use crate::enqueue::{enqueue_meta, enqueue_tokens};
use crate::events::{Audience, Event};
use crate::handlers::fetch_trace::current_delegate;
use crate::runner::{JobCtx, JobError, JobHandler};
use crate::txflow::{TxFlow, load_tx_flow};

#[derive(Deserialize)]
struct Params {
    hash: TxHash,
    #[serde(default)]
    current_delegate_only: bool,
}

pub struct FetchTxHandler;

/// Pre-London receipts have no effective gas price; use the tx's `gasPrice`.
fn gas_price_of(json: &serde_json::Value) -> U256 {
    json.get("gasPrice")
        .and_then(|v| v.as_str())
        .and_then(|s| U256::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .unwrap_or(U256::ZERO)
}

/// The revert reason is optional detail: a lookup that failed for this tx
/// (parse error, upstream NOTOK…) leaves it unset instead of failing the fetch.
/// Retryable errors propagate so the runner retries the job; quota exhaustion
/// and a rejected API key propagate so it pauses the job or surfaces the bad key.
async fn revert_reason(
    ctx: &JobCtx,
    p: Priority,
    hash: TxHash,
) -> Result<Option<String>, SourceError> {
    match ctx.source.tx_status(p, hash).await {
        Ok(reason) => Ok(reason),
        Err(e) if e.is_retryable() || e.is_quota() || matches!(e, SourceError::InvalidKey) => {
            Err(e)
        }
        Err(e) => {
            tracing::warn!(tx = %hash, error = %e, "revert reason lookup failed");
            Ok(None)
        }
    }
}

/// Looks up the current EIP-7702 delegate of `flow`'s recipient when it is
/// due ([`TxFlow::delegate_lookup_due`]) and records it, returning it. A
/// lookup that fails for that account (see [`current_delegate`]) is recorded
/// as none found, so it is not repeated.
async fn lookup_current_delegate(
    ctx: &JobCtx,
    p: Priority,
    flow: &TxFlow,
) -> Result<Option<Address>, JobError> {
    let Some(to) = flow.tx.to.filter(|_| flow.delegate_lookup_due) else {
        return Ok(None);
    };
    let found = current_delegate(ctx, p, to).await?;
    ctx.store
        .set_to_current_delegate(flow.tx.hash, found)
        .await?;
    Ok(found)
}

/// The `current_delegate_only` job: the lookup for a stored tx, metadata for
/// the delegate found, and `TxReady` so views reload it.
async fn current_delegate_only(
    job: &JobRow,
    ctx: &JobCtx,
    p: Priority,
    hash: TxHash,
) -> Result<(), JobError> {
    let flow = load_tx_flow(&ctx.store, hash)
        .await?
        .ok_or_else(|| JobError::Invalid("transaction not fetched".into()))?;
    if let Some(d) = lookup_current_delegate(ctx, p, &flow).await? {
        let stale = ctx.store.addrs_needing_meta(&[d], ctx.cfg.meta_ttl).await?;
        enqueue_meta(ctx, job.user_id, &stale).await?;
    }
    ctx.bus
        .publish(Audience::of(job.user_id), Event::TxReady { hash });
    Ok(())
}

#[async_trait]
impl JobHandler for FetchTxHandler {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let Params {
            hash,
            current_delegate_only: only,
        } = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad fetch_tx params: {e}")))?;
        let p = Priority::Interactive;
        if only {
            return current_delegate_only(job, ctx, p, hash).await;
        }
        let tx = ctx
            .source
            .tx(p, hash)
            .await?
            .ok_or_else(|| JobError::Invalid("tx not found".into()))?;
        let block = tx
            .block_number
            .ok_or_else(|| JobError::Invalid("tx not mined".into()))?;
        let receipt = ctx
            .source
            .receipt(p, hash)
            .await?
            .ok_or_else(|| JobError::Invalid("receipt not found".into()))?;
        // A block is fetched once: a stored header (from an earlier tx of the same block) is reused.
        let ts = match ctx.store.block(block).await? {
            Some(stored) => stored.ts,
            None => {
                let header = ctx.source.block(p, block).await?;
                ctx.store.upsert_block(&header).await?;
                header.ts
            }
        };
        let revert_reason = if receipt.success {
            None
        } else {
            revert_reason(ctx, p, hash).await?
        };
        let internals = ctx.source.internal_txs(p, hash).await?;

        let mut transfers = Vec::new();
        if receipt.success {
            // Contract creation sends its value to the new contract.
            if let Some(to) = tx.to.or(receipt.contract_address) {
                transfers.push(Transfer {
                    tx_hash: hash,
                    sub_id: "top".into(),
                    kind: TransferKind::Native,
                    block_number: block,
                    ts,
                    from: tx.from,
                    to,
                    asset: None,
                    amount: tx.value,
                    token_id: None,
                    trace_id: None,
                    log_index: None,
                    call_index: None,
                });
            }
        }
        transfers.extend(decode_transfer_logs(&receipt.logs, hash, block, ts));
        if receipt.success {
            transfers.extend(internals.into_iter().map(|t| Transfer {
                tx_hash: hash,
                block_number: block,
                ts,
                ..t
            }));
        }
        assign_sub_ids(&mut transfers);
        ctx.store.upsert_transfers(&transfers).await?;

        let price = if receipt.effective_gas_price.is_zero() {
            gas_price_of(&tx.json)
        } else {
            receipt.effective_gas_price
        };
        ctx.store
            .upsert_transaction(&TxRow {
                hash,
                block_number: block,
                ts,
                from: tx.from,
                to: tx.to,
                value: tx.value,
                selector: tx.input.get(..4).and_then(|s| <[u8; 4]>::try_from(s).ok()),
                success: receipt.success,
                gas_used: receipt.gas_used,
                fee: receipt.gas_used.saturating_mul(price),
                raw_tx: tx.json.clone(),
                raw_receipt: receipt.json.clone(),
                revert_reason,
            })
            .await?;

        let flow = load_tx_flow(&ctx.store, hash)
            .await?
            .ok_or_else(|| JobError::Invalid("transaction not stored".into()))?;
        // Best-effort here: a failed lookup records nothing, so it stays due
        // and the tx's view queues a `current_delegate_only` job for it later.
        let current = match lookup_current_delegate(ctx, p, &flow).await {
            Ok(found) => found,
            Err(e) => {
                tracing::warn!(tx = %hash, error = %e, "current delegate lookup failed");
                None
            }
        };

        // The rest are identified on demand (`POST /api/identify`).
        let delegations =
            effective_delegations(&authorizations(&tx.json), tx.from, tx_nonce(&tx.json));
        let mut parties =
            auto_meta_parties(tx.from, tx.to.or(receipt.contract_address), &delegations);
        parties.extend(current);
        let stale = ctx
            .store
            .addrs_needing_meta(&parties, ctx.cfg.meta_ttl)
            .await?;
        enqueue_meta(ctx, job.user_id, &stale).await?;
        let tokens: Vec<Address> = transfers
            .iter()
            .filter(|t| t.kind == TransferKind::Erc20)
            .filter_map(|t| t.asset)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let missing = ctx
            .store
            .tokens_needing_meta(&tokens, ctx.cfg.meta_ttl)
            .await?;
        enqueue_tokens(ctx, job.user_id, &missing).await?;

        ctx.bus.publish(
            Audience::of(job.user_id),
            Event::JobProgress {
                job_id: job.id,
                kind: job.kind,
                fetched: u32::try_from(transfers.len()).unwrap_or(u32::MAX),
                cursor_block: Some(block),
                status: JobStatus::Running,
                error: None,
            },
        );
        ctx.bus
            .publish(Audience::of(job.user_id), Event::TxReady { hash });
        Ok(())
    }
}
