//! `ContractMeta`: classifies addresses as EOA or contract, stores ABIs and
//! proxy implementations.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use chrono::Utc;
use eg_core::types::{AccountKind, Address};
use eg_store::{AccountRow, JobRow};
use serde::Deserialize;

use crate::enqueue::enqueue_meta;
use crate::events::Event;
use crate::runner::{JobCtx, JobError, JobHandler};

const CREATION_CHUNK: usize = 5;

#[derive(Deserialize)]
struct Params {
    addresses: Vec<Address>,
}

pub struct ContractMetaHandler;

#[async_trait]
impl JobHandler for ContractMetaHandler {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let Params { addresses } = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad contract_meta params: {e}")))?;
        let mut seen = HashSet::new();
        let addrs: Vec<Address> = addresses.into_iter().filter(|a| seen.insert(*a)).collect();
        // A retried job only redoes addresses that still lack fresh metadata.
        let addrs = ctx
            .store
            .addrs_needing_meta(&addrs, ctx.cfg.meta_ttl)
            .await?;
        let p = job.priority;

        let mut creations = HashMap::new();
        for chunk in addrs.chunks(CREATION_CHUNK) {
            for c in ctx.source.contract_creation(p, chunk).await? {
                creations.insert(c.address, c);
            }
        }

        let now = Utc::now();
        let mut rows = Vec::with_capacity(addrs.len());
        let mut impls = Vec::new();
        let mut done = Vec::with_capacity(addrs.len());
        let mut first_err: Option<JobError> = None;
        for addr in &addrs {
            let Some(creation) = creations.get(addr) else {
                rows.push(AccountRow {
                    address: *addr,
                    kind: AccountKind::Eoa,
                    contract_name: None,
                    is_proxy: false,
                    implementation: None,
                    creator: None,
                    creation_tx: None,
                    meta_fetched_at: now,
                });
                done.push(*addr);
                continue;
            };
            let src = match ctx.source.contract_source(p, *addr).await {
                Ok(src) => src,
                Err(e) => {
                    first_err.get_or_insert(e.into());
                    continue;
                }
            };
            ctx.store.upsert_abi(*addr, src.abi_json.as_deref()).await?;
            if let Some(imp) = src.implementation.filter(|_| src.is_proxy) {
                impls.push(imp);
            }
            rows.push(AccountRow {
                address: *addr,
                kind: AccountKind::Contract,
                contract_name: src.name,
                is_proxy: src.is_proxy,
                implementation: src.implementation,
                creator: Some(creation.creator),
                creation_tx: Some(creation.tx_hash),
                meta_fetched_at: now,
            });
            done.push(*addr);
        }
        ctx.store.upsert_accounts(&rows).await?;

        if !impls.is_empty() {
            let need = ctx
                .store
                .addrs_needing_meta(&impls, ctx.cfg.meta_ttl)
                .await?;
            if !need.is_empty() {
                enqueue_meta(ctx, &need).await?;
            }
        }
        if !done.is_empty() {
            ctx.bus.publish(Event::MetaUpdated { addresses: done });
        }
        // Partial progress is stored; fail so the runner retries the rest.
        first_err.map_or(Ok(()), Err)
    }
}
