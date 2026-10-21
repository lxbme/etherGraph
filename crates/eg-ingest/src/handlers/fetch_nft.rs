//! `FetchNft`: fetches an NFT's metadata from the trace provider and caches
//! it for everyone. A provider 404 is cached as "not found"; any other error
//! fails the job and caches nothing, so a later view retries. An empty row
//! past its TTL ([`NftMetaRow::is_stale`]) is fetched again.

use async_trait::async_trait;
use chrono::Utc;
use eg_core::source::Priority;
use eg_core::types::{Address, U256};
use eg_store::{JobRow, NftMetaRow};
use serde::Deserialize;

use crate::events::{Audience, Event};
use crate::runner::{JobCtx, JobError, JobHandler};

#[derive(Deserialize)]
struct Params {
    token: Address,
    /// Decimal.
    token_id: String,
}

pub struct FetchNftHandler;

#[async_trait]
impl JobHandler for FetchNftHandler {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let bad = |e: String| JobError::Invalid(format!("bad fetch_nft params: {e}"));
        let Params { token, token_id } =
            serde_json::from_value(job.params.clone()).map_err(|e| bad(e.to_string()))?;
        let id = U256::from_str_radix(&token_id, 10).map_err(|e| bad(e.to_string()))?;
        let ready = || {
            ctx.bus.publish(
                Audience::of(job.user_id),
                Event::NftReady {
                    token: format!("{token:#x}"),
                    token_id: id.to_string(),
                },
            )
        };
        // Cached by another user's job meanwhile: nothing to fetch.
        if ctx
            .store
            .nft_meta(token, id)
            .await?
            .is_some_and(|row| !row.is_stale(Utc::now()))
        {
            ready();
            return Ok(());
        }
        let meta = ctx
            .trace_source
            .nft_metadata(Priority::Interactive, token, id)
            .await?;
        ctx.store
            .upsert_nft_meta(&NftMetaRow {
                token,
                token_id: id,
                meta,
                fetched_at: Utc::now(),
            })
            .await?;
        ready();
        Ok(())
    }
}
