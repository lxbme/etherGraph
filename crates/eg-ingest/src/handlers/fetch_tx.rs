//! `FetchTx`: fetches one transaction with its receipt, block time and
//! internal transfers, stores it, and queues metadata for its own parties
//! (sender, recipient, EIP-7702 delegates) and its tokens.

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
use crate::runner::{JobCtx, JobError, JobHandler};

#[derive(Deserialize)]
struct Params {
    hash: TxHash,
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

#[async_trait]
impl JobHandler for FetchTxHandler {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let Params { hash } = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad fetch_tx params: {e}")))?;
        let p = Priority::Interactive;
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

        // The rest are identified on demand (`POST /api/identify`).
        let delegations =
            effective_delegations(&authorizations(&tx.json), tx.from, tx_nonce(&tx.json));
        let parties = auto_meta_parties(tx.from, tx.to.or(receipt.contract_address), &delegations);
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
