//! `TokenMeta`: decimals / symbol / name of ERC-20 tokens via Multicall3.

use async_trait::async_trait;
use eg_core::source::{Priority, TokenInfo};
use eg_core::types::{Address, TransferKind};
use eg_decode::{
    Call3, decode_aggregate3, decode_string_or_bytes32, decode_u8, encode_aggregate3,
    encode_decimals, encode_name, encode_symbol,
};
use eg_store::JobRow;
use serde::Deserialize;

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

#[async_trait]
impl JobHandler for TokenMetaHandler {
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
            let ret = ctx
                .source
                .eth_call(Priority::Low, ctx.cfg.multicall3, encode_aggregate3(&calls))
                .await?;
            let results = decode_aggregate3(&ret)
                .map_err(|e| JobError::Invalid(format!("bad multicall result: {e}")))?;
            if results.len() != calls.len() {
                return Err(JobError::Invalid("multicall result length mismatch".into()));
            }
            for (t, r) in chunk.iter().zip(results.chunks(CALLS_PER_TOKEN)) {
                let ok = |i: usize| r[i].success.then(|| &r[i].return_data[..]);
                infos.push(TokenInfo {
                    address: *t,
                    kind: TransferKind::Erc20,
                    decimals: ok(0).and_then(decode_u8),
                    symbol: non_empty(ok(1).and_then(decode_string_or_bytes32)),
                    name: non_empty(ok(2).and_then(decode_string_or_bytes32)),
                });
            }
        }
        ctx.store.upsert_tokens(&infos).await?;
        Ok(())
    }
}
