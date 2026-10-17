//! `FetchBlock`: backfills the header of a stored transaction fetched before
//! block headers were kept, then announces the tx as updated.

use async_trait::async_trait;
use eg_core::source::Priority;
use eg_core::types::TxHash;
use serde::Deserialize;

use crate::events::Event;
use crate::runner::{JobCtx, JobError, JobHandler};

#[derive(Deserialize)]
struct Params {
    number: u64,
    hash: TxHash,
}

pub struct FetchBlockHandler;

#[async_trait]
impl JobHandler for FetchBlockHandler {
    async fn run(&self, job: &eg_store::JobRow, ctx: &JobCtx) -> Result<(), JobError> {
        let Params { number, hash } = serde_json::from_value(job.params.clone())
            .map_err(|e| JobError::Invalid(format!("bad fetch_block params: {e}")))?;
        let block = ctx.source.block(Priority::Background, number).await?;
        ctx.store.upsert_block(&block).await?;
        ctx.bus.publish(Event::TxReady { hash });
        Ok(())
    }
}
