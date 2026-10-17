//! `FetchTx`: fetches one transaction with its receipt, block time and
//! internal transfers, stores it, and queues metadata for the addresses it
//! touched.

use std::collections::HashSet;

use async_trait::async_trait;
use eg_core::source::Priority;
use eg_core::types::{Address, Transfer, TransferKind, TxHash, U256, assign_sub_ids};
use eg_decode::decode_transfer_logs;
use eg_store::{JobRow, JobStatus, TxRow};
use serde::Deserialize;

use crate::enqueue::{enqueue_meta, enqueue_tokens};
use crate::events::Event;
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
        let ts = ctx.source.block_timestamp(p, block).await?;
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
            })
            .await?;

        let mut seen = HashSet::new();
        let participants: Vec<Address> = [tx.from]
            .into_iter()
            .chain(tx.to.or(receipt.contract_address))
            .chain(transfers.iter().flat_map(|t| [t.from, t.to]))
            .chain(receipt.logs.iter().map(|l| l.address))
            .filter(|a| seen.insert(*a))
            .collect();
        let stale = ctx
            .store
            .addrs_needing_meta(&participants, ctx.cfg.meta_ttl)
            .await?;
        enqueue_meta(ctx, &stale).await?;
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
        enqueue_tokens(ctx, &missing).await?;

        ctx.bus.publish(Event::JobProgress {
            job_id: job.id,
            kind: job.kind,
            fetched: u32::try_from(transfers.len()).unwrap_or(u32::MAX),
            cursor_block: Some(block),
            status: JobStatus::Running,
            error: None,
        });
        ctx.bus.publish(Event::TxReady { hash });
        Ok(())
    }
}
