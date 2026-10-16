use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::Address;
use async_trait::async_trait;
use eg_core::source::{Priority, SourceError};
use eg_core::testing::FakeSource;
use eg_ingest::config::IngestConfig;
use eg_ingest::{Event, EventBus, JobCtx, JobError, JobHandler, Runner, enqueue_meta};
use eg_store::{JobKind, JobRow, JobStatus, NewJob, Store};
use serde_json::json;
use sqlx::PgPool;
use tokio::sync::Notify;

fn ctx(pool: PgPool) -> JobCtx {
    JobCtx {
        store: Store::from_pool(pool),
        source: Arc::new(FakeSource::new()),
        bus: EventBus::new(),
        cfg: Arc::new(IngestConfig::default()),
        wake: Arc::new(Notify::new()),
    }
}

fn job(key: &str) -> NewJob {
    NewJob {
        key: key.into(),
        kind: JobKind::FetchTx,
        params: json!({}),
        priority: Priority::Background,
    }
}

fn handlers(h: Arc<dyn JobHandler>) -> HashMap<JobKind, Arc<dyn JobHandler>> {
    HashMap::from([(JobKind::FetchTx, h)])
}

async fn status(ctx: &JobCtx, id: i64) -> (String, i32) {
    sqlx::query_as("SELECT status, attempts FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(ctx.store.pool())
        .await
        .unwrap()
}

async fn wait_status(ctx: &JobCtx, id: i64, want: &str) -> i32 {
    for _ in 0..200 {
        let (s, a) = status(ctx, id).await;
        if s == want {
            return a;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("job {id} never reached {want}: {:?}", status(ctx, id).await);
}

struct OkHandler;
#[async_trait]
impl JobHandler for OkHandler {
    async fn run(&self, _: &JobRow, _: &JobCtx) -> Result<(), JobError> {
        Ok(())
    }
}

/// Returns QuotaExhausted until `open` is flipped.
struct QuotaHandler(Mutex<bool>);
#[async_trait]
impl JobHandler for QuotaHandler {
    async fn run(&self, _: &JobRow, _: &JobCtx) -> Result<(), JobError> {
        if *self.0.lock().unwrap() {
            Ok(())
        } else {
            Err(SourceError::QuotaExhausted.into())
        }
    }
}

struct FlakyHandler;
#[async_trait]
impl JobHandler for FlakyHandler {
    async fn run(&self, _: &JobRow, _: &JobCtx) -> Result<(), JobError> {
        Err(SourceError::Network("down".into()).into())
    }
}

struct SeenProgress(Mutex<Vec<Option<serde_json::Value>>>);
#[async_trait]
impl JobHandler for SeenProgress {
    async fn run(&self, j: &JobRow, _: &JobCtx) -> Result<(), JobError> {
        self.0.lock().unwrap().push(j.progress.clone());
        Ok(())
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn runs_and_completes(pool: PgPool) {
    let c = ctx(pool);
    let mut rx = c.bus.subscribe();
    let (id, _) = c.store.enqueue(&job("a")).await.unwrap();
    let hs = Runner::spawn(c.clone(), 2, handlers(Arc::new(OkHandler)));
    wait_status(&c, id, "done").await;
    let mut saw_done = false;
    while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
        if let Event::JobProgress {
            job_id,
            status: JobStatus::Done,
            ..
        } = e
        {
            assert_eq!(job_id, id);
            saw_done = true;
            break;
        }
    }
    assert!(saw_done);
    hs.iter().for_each(|h| h.abort());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn quota_pauses_job(pool: PgPool) {
    let c = ctx(pool);
    let (id, _) = c.store.enqueue(&job("a")).await.unwrap();
    let h = Arc::new(QuotaHandler(Mutex::new(false)));
    let hs = Runner::spawn(c.clone(), 1, handlers(h.clone()));
    wait_status(&c, id, "paused_quota").await;
    *h.0.lock().unwrap() = true;
    assert_eq!(c.store.resume_paused().await.unwrap(), 1);
    c.wake.notify_waiters();
    wait_status(&c, id, "done").await;
    hs.iter().for_each(|h| h.abort());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn retryable_error_retries_then_fails(pool: PgPool) {
    let c = ctx(pool);
    let (id, _) = c.store.enqueue(&job("a")).await.unwrap();
    let hs = Runner::spawn(c.clone(), 1, handlers(Arc::new(FlakyHandler)));
    let attempts = wait_status(&c, id, "failed").await;
    assert_eq!(attempts, 3);
    hs.iter().for_each(|h| h.abort());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn crash_resume_keeps_progress(pool: PgPool) {
    let c = ctx(pool);
    let (id, _) = c.store.enqueue(&job("a")).await.unwrap();
    let claimed = c.store.claim_next().await.unwrap().unwrap();
    assert_eq!(claimed.id, id);
    let p = json!({"cursor": 42});
    c.store.update_progress(id, &p).await.unwrap();
    assert_eq!(c.store.reset_running().await.unwrap(), 1);
    let h = Arc::new(SeenProgress(Mutex::new(vec![])));
    let hs = Runner::spawn(c.clone(), 1, handlers(h.clone()));
    wait_status(&c, id, "done").await;
    assert_eq!(*h.0.lock().unwrap(), vec![Some(p)]);
    hs.iter().for_each(|h| h.abort());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn missing_handler_fails_without_retry(pool: PgPool) {
    let c = ctx(pool);
    let (id, _) = c.store.enqueue(&job("a")).await.unwrap();
    let hs = Runner::spawn(c.clone(), 1, HashMap::new());
    assert_eq!(wait_status(&c, id, "failed").await, 1);
    hs.iter().for_each(|h| h.abort());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn enqueue_meta_chunks_and_dedupes(pool: PgPool) {
    let c = ctx(pool);
    let addrs: Vec<Address> = (1u8..=45).map(Address::repeat_byte).collect();
    let ids = enqueue_meta(&c, &addrs).await.unwrap();
    assert_eq!(ids.len(), 3);
    let mut rev = addrs.clone();
    rev.reverse();
    rev.push(addrs[0]);
    assert_eq!(enqueue_meta(&c, &rev).await.unwrap(), ids);
    let rows = c.store.active_jobs().await.unwrap();
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|r| r.key.starts_with("meta:") && r.key.len() == 21)
    );
    assert_eq!(rows[0].params["addresses"].as_array().unwrap().len(), 20);
}

struct PanicHandler;
#[async_trait]
impl JobHandler for PanicHandler {
    async fn run(&self, j: &JobRow, _: &JobCtx) -> Result<(), JobError> {
        if j.key == "boom" {
            panic!("kaboom");
        }
        Ok(())
    }
}

struct ErrHandler(fn() -> JobError);
#[async_trait]
impl JobHandler for ErrHandler {
    async fn run(&self, _: &JobRow, _: &JobCtx) -> Result<(), JobError> {
        Err((self.0)())
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn panicking_handler_fails_job_and_worker_survives(pool: PgPool) {
    let c = ctx(pool);
    let (bad, _) = c.store.enqueue(&job("boom")).await.unwrap();
    let hs = Runner::spawn(c.clone(), 1, handlers(Arc::new(PanicHandler)));
    wait_status(&c, bad, "failed").await;
    let err: Option<String> = sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
        .bind(bad)
        .fetch_one(c.store.pool())
        .await
        .unwrap();
    assert!(err.unwrap().contains("handler panicked: kaboom"));
    let (good, _) = c.store.enqueue(&job("fine")).await.unwrap();
    c.wake.notify_waiters();
    wait_status(&c, good, "done").await;
    hs.iter().for_each(|h| h.abort());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn non_retryable_source_error_fails_immediately(pool: PgPool) {
    let c = ctx(pool);
    let (id, _) = c.store.enqueue(&job("a")).await.unwrap();
    let h = Arc::new(ErrHandler(|| SourceError::InvalidKey.into()));
    let hs = Runner::spawn(c.clone(), 1, handlers(h));
    assert_eq!(wait_status(&c, id, "failed").await, 1);
    hs.iter().for_each(|h| h.abort());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancelled_handler_marks_cancelled(pool: PgPool) {
    let c = ctx(pool);
    let (id, _) = c.store.enqueue(&job("a")).await.unwrap();
    let h = Arc::new(ErrHandler(|| JobError::Cancelled));
    let hs = Runner::spawn(c.clone(), 1, handlers(h));
    wait_status(&c, id, "cancelled").await;
    hs.iter().for_each(|h| h.abort());
}

/// Jobs whose key starts with `long` block until permits are added.
struct BlockingHandler(tokio::sync::Semaphore);
#[async_trait]
impl JobHandler for BlockingHandler {
    async fn run(&self, j: &JobRow, _: &JobCtx) -> Result<(), JobError> {
        if j.key.starts_with("long") {
            self.0.acquire().await.unwrap().forget();
        }
        Ok(())
    }
}

async fn count_status(ctx: &JobCtx, want: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE status = $1")
        .bind(want)
        .fetch_one(ctx.store.pool())
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn reserved_worker_runs_interactive_while_others_busy(pool: PgPool) {
    let c = ctx(pool);
    let mut long = Vec::new();
    for k in ["long1", "long2", "long3"] {
        long.push(c.store.enqueue(&job(k)).await.unwrap().0);
    }
    let h = Arc::new(BlockingHandler(tokio::sync::Semaphore::new(0)));
    let hs = Runner::spawn(c.clone(), 3, handlers(h.clone()));
    for _ in 0..200 {
        if count_status(&c, "running").await == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // Worker #0 only takes Interactive jobs, so one long job stays queued.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(count_status(&c, "running").await, 2);
    assert_eq!(count_status(&c, "pending").await, 1);

    let (quick, _) = c
        .store
        .enqueue(&NewJob {
            priority: Priority::Interactive,
            ..job("quick")
        })
        .await
        .unwrap();
    c.wake.notify_waiters();
    wait_status(&c, quick, "done").await;
    assert_eq!(count_status(&c, "running").await, 2);

    h.0.add_permits(3);
    for id in long {
        wait_status(&c, id, "done").await;
    }
    hs.iter().for_each(|h| h.abort());
}
