//! `ResolveNames`: ENS reverse lookups through the UniversalResolver, batched
//! with Multicall3.

use async_trait::async_trait;
use chrono::Utc;
use eg_core::source::{Priority, SourceError};
use eg_core::types::Address;
use eg_decode::{
    Call3, ReverseResult, decode_aggregate3, decode_reverse, encode_aggregate3, encode_reverse,
};
use eg_store::{EnsRow, EnsStatus, JobRow};
use serde::Deserialize;

use crate::events::{Event, NameItem};
use crate::runner::{JobCtx, JobError, JobHandler};

#[derive(Deserialize)]
struct Params {
    addresses: Vec<Address>,
}

pub struct ResolveNamesHandler;

fn error_row(address: Address, now: chrono::DateTime<Utc>) -> EnsRow {
    EnsRow {
        address,
        name: None,
        status: EnsStatus::Error,
        resolved_at: now,
    }
}

#[async_trait]
impl JobHandler for ResolveNamesHandler {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let Params { addresses } = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad resolve_names params: {e}")))?;
        let now = Utc::now();
        let mut rows = Vec::with_capacity(addresses.len());
        for chunk in addresses.chunks(ctx.cfg.multicall_batch_size.max(1)) {
            let calls: Vec<Call3> = chunk
                .iter()
                .map(|a| Call3 {
                    target: ctx.cfg.universal_resolver,
                    allow_failure: true,
                    call_data: encode_reverse(*a),
                })
                .collect();
            let ret = match ctx
                .source
                .eth_call(Priority::Low, ctx.cfg.multicall3, encode_aggregate3(&calls))
                .await
            {
                Ok(r) => r,
                Err(SourceError::Rpc { .. }) => {
                    rows.extend(chunk.iter().map(|a| error_row(*a, now)));
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            match decode_aggregate3(&ret) {
                Ok(results) if results.len() == chunk.len() => {
                    for (a, r) in chunk.iter().zip(&results) {
                        let (name, status) = match decode_reverse(r) {
                            ReverseResult::Name(n) => (Some(n), EnsStatus::Ok),
                            ReverseResult::NoName => (None, EnsStatus::None),
                            ReverseResult::Offchain => (None, EnsStatus::Offchain),
                        };
                        rows.push(EnsRow {
                            address: *a,
                            name,
                            status,
                            resolved_at: now,
                        });
                    }
                }
                other => {
                    tracing::warn!(
                        decoded = ?other.map(|r| r.len()),
                        expected = chunk.len(),
                        "bad multicall result for ENS batch"
                    );
                    rows.extend(chunk.iter().map(|a| error_row(*a, now)));
                }
            }
        }
        ctx.store.upsert_ens(&rows).await?;
        ctx.bus.publish(Event::NamesResolved {
            items: rows
                .into_iter()
                .map(|r| NameItem {
                    address: r.address,
                    name: r.name,
                    status: r.status,
                })
                .collect(),
        });
        Ok(())
    }
}
