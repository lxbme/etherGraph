//! `TokenMeta`: decimals / symbol / name of token contracts via Multicall3.

use std::collections::HashSet;

use async_trait::async_trait;
use eg_core::source::{Priority, SourceError, TokenInfo};
use eg_core::types::{Address, TransferKind};
use eg_decode::{
    Call3, decode_aggregate3, decode_string_or_bytes32, decode_u8, encode_aggregate3,
    encode_decimals, encode_name, encode_symbol,
};
use eg_store::JobRow;
use serde::Deserialize;

use crate::events::Event;
use crate::runner::{JobCtx, JobError, JobHandler};

const CALLS_PER_TOKEN: usize = 3;

#[derive(Deserialize)]
struct Params {
    tokens: Vec<Address>,
}

pub struct TokenMetaHandler;

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}

/// A token with nothing found; still recorded so it counts as attempted.
fn unknown(address: Address) -> TokenInfo {
    TokenInfo {
        address,
        kind: TransferKind::Erc20,
        name: None,
        symbol: None,
        decimals: None,
    }
}

#[async_trait]
impl JobHandler for TokenMetaHandler {
    /// Every listed token is recorded as attempted, so tokens without
    /// decimals (NFTs, non-standard contracts) are not re-queued until the TTL
    /// passes. `kind` is only set for tokens not yet stored (as ERC-20).
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let Params { tokens } = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad token_meta params: {e}")))?;
        let per_batch = (ctx.cfg.multicall_batch_size / CALLS_PER_TOKEN).max(1);
        let mut infos = Vec::with_capacity(tokens.len());
        for chunk in tokens.chunks(per_batch) {
            let calls: Vec<Call3> = chunk
                .iter()
                .flat_map(|t| {
                    [encode_decimals(), encode_symbol(), encode_name()].map(|d| Call3 {
                        target: *t,
                        allow_failure: true,
                        call_data: d,
                    })
                })
                .collect();
            let ret = match ctx
                .source
                .eth_call(Priority::Low, ctx.cfg.multicall3, encode_aggregate3(&calls))
                .await
            {
                Ok(r) => r,
                Err(e @ SourceError::Rpc { .. }) => {
                    tracing::warn!(job_id = job.id, error = %e, "token multicall reverted");
                    infos.extend(chunk.iter().copied().map(unknown));
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            let results = match decode_aggregate3(&ret) {
                Ok(r) if r.len() == calls.len() => r,
                other => {
                    tracing::warn!(
                        job_id = job.id,
                        decoded = ?other.map(|r| r.len()),
                        expected = calls.len(),
                        "bad multicall result for token batch"
                    );
                    infos.extend(chunk.iter().copied().map(unknown));
                    continue;
                }
            };
            for (t, r) in chunk.iter().zip(results.chunks(CALLS_PER_TOKEN)) {
                let ok = |i: usize| r[i].success.then(|| &r[i].return_data[..]);
                infos.push(TokenInfo {
                    decimals: ok(0).and_then(decode_u8),
                    symbol: non_empty(ok(1).and_then(decode_string_or_bytes32)),
                    name: non_empty(ok(2).and_then(decode_string_or_bytes32)),
                    ..unknown(*t)
                });
            }
        }
        ctx.store.record_token_meta(&infos).await?;
        let mut seen = HashSet::new();
        let addresses: Vec<Address> = infos
            .iter()
            .map(|t| t.address)
            .filter(|a| seen.insert(*a))
            .collect();
        if !addresses.is_empty() {
            ctx.bus.publish(Event::MetaUpdated { addresses });
        }
        Ok(())
    }
}
