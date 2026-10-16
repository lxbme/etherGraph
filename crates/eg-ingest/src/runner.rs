//! Job runner: workers claim jobs from Postgres and dispatch to handlers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use eg_core::source::{ChainSource, SourceError};
use eg_store::{JobKind, JobRow, JobStatus, Store, StoreError};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::config::IngestConfig;
use crate::events::{Event, EventBus};

#[derive(thiserror::Error, Debug)]
pub enum JobError {
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("cancelled")]
    Cancelled,
    #[error("invalid job: {0}")]
    Invalid(String),
}

impl JobError {
    fn is_retryable(&self) -> bool {
        match self {
            JobError::Source(e) => e.is_retryable(),
            JobError::Store(_) => true,
            JobError::Cancelled | JobError::Invalid(_) => false,
        }
    }
}

#[derive(Clone)]
pub struct JobCtx {
    pub store: Store,
    pub source: Arc<dyn ChainSource>,
    pub bus: EventBus,
    pub cfg: Arc<IngestConfig>,
    pub wake: Arc<Notify>,
}

#[async_trait]
pub trait JobHandler: Send + Sync {
    async fn run(&self, job: &JobRow, ctx: &JobCtx) -> Result<(), JobError>;
}

pub struct Runner;

type Handlers = Arc<HashMap<JobKind, Arc<dyn JobHandler>>>;

impl Runner {
    pub fn spawn(
        ctx: JobCtx,
        workers: usize,
        handlers: HashMap<JobKind, Arc<dyn JobHandler>>,
    ) -> Vec<JoinHandle<()>> {
        let handlers: Handlers = Arc::new(handlers);
        (0..workers)
            .map(|_| tokio::spawn(worker_loop(ctx.clone(), handlers.clone())))
            .collect()
    }
}

fn publish_status(ctx: &JobCtx, job: &JobRow, status: JobStatus) {
    ctx.bus.publish(Event::JobProgress {
        job_id: job.id,
        kind: job.kind,
        fetched: 0,
        cursor_block: None,
        status,
    });
}

async fn worker_loop(ctx: JobCtx, handlers: Handlers) {
    loop {
        match ctx.store.claim_next().await {
            Ok(Some(job)) => process(&ctx, &handlers, job).await,
            Ok(None) => idle(&ctx).await,
            Err(e) => {
                tracing::warn!(error = %e, "claim_next failed");
                idle(&ctx).await;
            }
        }
    }
}

async fn idle(ctx: &JobCtx) {
    let _ = tokio::time::timeout(Duration::from_secs(1), ctx.wake.notified()).await;
}

async fn process(ctx: &JobCtx, handlers: &Handlers, job: JobRow) {
    publish_status(ctx, &job, JobStatus::Running);
    let result = match handlers.get(&job.kind) {
        Some(h) => h.run(&job, ctx).await,
        None => Err(JobError::Invalid("no handler".into())),
    };
    let (status, outcome) = match result {
        Ok(()) => (JobStatus::Done, ctx.store.complete_job(job.id).await),
        Err(JobError::Source(SourceError::QuotaExhausted)) => (
            JobStatus::PausedQuota,
            ctx.store.pause_job_quota(job.id).await,
        ),
        Err(JobError::Cancelled) => (JobStatus::Cancelled, ctx.store.mark_cancelled(job.id).await),
        Err(e) => {
            let retry = e.is_retryable() && job.attempts + 1 < ctx.cfg.max_attempts;
            let status = if retry {
                JobStatus::Pending
            } else {
                JobStatus::Failed
            };
            (
                status,
                ctx.store.fail_job(job.id, &e.to_string(), retry).await,
            )
        }
    };
    match outcome {
        Ok(()) => publish_status(ctx, &job, status),
        Err(e) => tracing::error!(job_id = job.id, error = %e, "failed to record job outcome"),
    }
    if status == JobStatus::Pending {
        ctx.wake.notify_waiters();
    }
}
