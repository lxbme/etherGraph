//! Helpers that create jobs (deduplicated by key) and wake the workers.

use std::fmt;

use eg_core::source::Priority;
use eg_core::types::{Address, TxHash};
use eg_store::{JobKind, NewJob, Store, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::runner::JobCtx;

const META_CHUNK: usize = 20;

/// Times [`enqueue_owned`] retries when the job it found ended before it could
/// be joined.
const OWNER_ATTEMPTS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncDirection {
    Latest,
    Older,
}

impl fmt::Display for SyncDirection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            SyncDirection::Latest => "latest",
            SyncDirection::Older => "older",
        })
    }
}

async fn enqueue_one(ctx: &JobCtx, job: NewJob) -> Result<i64, StoreError> {
    let (id, created) = ctx.store.enqueue(&job).await?;
    if created {
        ctx.wake.notify_waiters();
    }
    Ok(id)
}

fn sync_key_prefix(addr: Address) -> String {
    format!("sync:{addr:#x}:")
}

/// Enqueues (or joins) the address's sync in `dir` for `user` (`None`: a
/// system job) and records `owner` (a batch id, or `None` for a batch-less
/// caller) as one of its owners. `cap`
/// limits the records fetched per kind (`None`: `max_records_per_category`);
/// a joined job keeps its own cap. A job that is cancelled (or finishes)
/// before the owner is recorded is not joined: a fresh job is enqueued.
pub async fn enqueue_sync(
    ctx: &JobCtx,
    user: Option<i64>,
    addr: Address,
    dir: SyncDirection,
    p: Priority,
    cap: Option<u32>,
    owner: Option<&str>,
) -> Result<i64, StoreError> {
    let job = NewJob {
        key: format!("{}{dir}", sync_key_prefix(addr)),
        kind: JobKind::SyncAddress,
        params: json!({
            "address": format!("{addr:#x}"),
            "direction": dir,
            "kinds": [],
            "cap": cap,
        }),
        priority: p,
        user_id: user,
    };
    enqueue_owned(ctx, job, owner).await
}

pub async fn enqueue_fetch_tx(
    ctx: &JobCtx,
    user: Option<i64>,
    hash: TxHash,
) -> Result<i64, StoreError> {
    enqueue_one(
        ctx,
        NewJob {
            key: format!("tx:{hash:#x}"),
            kind: JobKind::FetchTx,
            params: json!({"hash": format!("{hash:#x}")}),
            priority: Priority::Interactive,
            user_id: user,
        },
    )
    .await
}

pub async fn enqueue_fetch_block(
    ctx: &JobCtx,
    user: Option<i64>,
    number: u64,
    hash: TxHash,
) -> Result<i64, StoreError> {
    enqueue_one(
        ctx,
        NewJob {
            key: format!("block:{number}"),
            kind: JobKind::FetchBlock,
            params: json!({"number": number, "hash": format!("{hash:#x}")}),
            priority: Priority::Background,
            user_id: user,
        },
    )
    .await
}

fn sorted_unique(addrs: &[Address]) -> Vec<Address> {
    let mut v = addrs.to_vec();
    v.sort();
    v.dedup();
    v
}

fn chunk_key(prefix: &str, chunk: &[Address]) -> String {
    let joined = chunk
        .iter()
        .map(|a| format!("{a:#x}"))
        .collect::<Vec<_>>()
        .join(",");
    let digest = Sha256::digest(joined.as_bytes());
    format!("{prefix}{}", &hex::encode(digest)[..16])
}

#[allow(clippy::too_many_arguments)]
async fn enqueue_chunks(
    ctx: &JobCtx,
    user: Option<i64>,
    addrs: &[Address],
    chunk_size: usize,
    prefix: &str,
    kind: JobKind,
    field: &str,
    priority: Priority,
    owner: Option<&str>,
) -> Result<Vec<i64>, StoreError> {
    let mut ids = Vec::new();
    for chunk in sorted_unique(addrs).chunks(chunk_size.max(1)) {
        let list: Vec<String> = chunk.iter().map(|a| format!("{a:#x}")).collect();
        let job = NewJob {
            key: chunk_key(prefix, chunk),
            kind,
            params: json!({ field: list }),
            priority,
            user_id: user,
        };
        ids.push(enqueue_owned(ctx, job, owner).await?);
    }
    Ok(ids)
}

/// Enqueues (or joins) `job` and records `owner` as one of its owners; a job
/// cancelled before the owner is recorded is enqueued afresh.
async fn enqueue_owned(ctx: &JobCtx, job: NewJob, owner: Option<&str>) -> Result<i64, StoreError> {
    for _ in 0..OWNER_ATTEMPTS {
        let id = enqueue_one(ctx, job.clone()).await?;
        if ctx.store.add_job_owner(id, owner).await? {
            return Ok(id);
        }
    }
    // A transient race, not bad input: the caller may simply retry.
    tracing::warn!(key = %job.key, "enqueue kept racing with job cancellation");
    Err(StoreError::Conflict)
}

/// Low-priority contract-metadata jobs for `user` (`None`: system jobs).
pub async fn enqueue_meta(
    ctx: &JobCtx,
    user: Option<i64>,
    addrs: &[Address],
) -> Result<Vec<i64>, StoreError> {
    enqueue_meta_owned(ctx, user, addrs, Priority::Low, None).await
}

/// Contract-metadata jobs for `user` in chunks of [`META_CHUNK`] at
/// `priority`, each owned by `owner` (a batch id; `None` for a batch-less
/// caller).
pub async fn enqueue_meta_owned(
    ctx: &JobCtx,
    user: Option<i64>,
    addrs: &[Address],
    priority: Priority,
    owner: Option<&str>,
) -> Result<Vec<i64>, StoreError> {
    enqueue_chunks(
        ctx,
        user,
        addrs,
        META_CHUNK,
        "meta:",
        JobKind::ContractMeta,
        "addresses",
        priority,
        owner,
    )
    .await
}

pub async fn enqueue_names(
    ctx: &JobCtx,
    user: Option<i64>,
    addrs: &[Address],
) -> Result<Vec<i64>, StoreError> {
    let n = ctx.cfg.multicall_batch_size;
    enqueue_chunks(
        ctx,
        user,
        addrs,
        n,
        "ens:",
        JobKind::ResolveNames,
        "addresses",
        Priority::Low,
        None,
    )
    .await
}

pub async fn enqueue_tokens(
    ctx: &JobCtx,
    user: Option<i64>,
    tokens: &[Address],
) -> Result<Vec<i64>, StoreError> {
    let n = ctx.cfg.multicall_batch_size;
    enqueue_chunks(
        ctx,
        user,
        tokens,
        n,
        "token:",
        JobKind::TokenMeta,
        "tokens",
        Priority::Low,
        None,
    )
    .await
}

/// Whether a SyncAddress job for `addr` other than `except` is pending,
/// running or paused, i.e. some job will still settle its `syncing` kinds.
pub async fn other_sync_active(
    store: &Store,
    addr: Address,
    except: Option<i64>,
) -> Result<bool, StoreError> {
    let prefix = sync_key_prefix(addr);
    Ok(store.active_jobs().await?.iter().any(|j| {
        j.kind == JobKind::SyncAddress && Some(j.id) != except && j.key.starts_with(&prefix)
    }))
}
