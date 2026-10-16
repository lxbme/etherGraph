use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::{Address, B256, Bytes, U256};
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use eg_core::source::{
    ChainSource, ContractCreation, ContractSource, HistoryPage, HistoryQuery, Priority, RawReceipt,
    RawTx, SourceError,
};
use eg_core::testing::FakeSource;
use eg_core::types::{Transfer, TransferKind, TxHash};
use eg_ingest::config::IngestConfig;
use eg_ingest::handlers::SyncAddressHandler;
use eg_ingest::{Event, EventBus, JobCtx, JobError, JobHandler, Runner, default_handlers};
use eg_store::{JobKind, JobStatus, NewJob, Store, SyncRow, SyncState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::Notify;

/// Wraps `FakeSource`, recording every history query and optionally failing
/// the n-th one (1-based) through `FakeSource::fail_next`.
struct Spy {
    inner: Arc<FakeSource>,
    queries: Mutex<Vec<(Priority, HistoryQuery)>>,
    fail_at: Mutex<Option<(usize, SourceError)>>,
}

impl Spy {
    fn fail_history_at(&self, n: usize, e: SourceError) {
        *self.fail_at.lock().unwrap() = Some((n, e));
    }

    fn queries(&self) -> Vec<(Priority, HistoryQuery)> {
        self.queries.lock().unwrap().clone()
    }
}

#[async_trait]
impl ChainSource for Spy {
    async fn history_page(
        &self,
        p: Priority,
        q: &HistoryQuery,
    ) -> Result<HistoryPage, SourceError> {
        let n = {
            let mut qs = self.queries.lock().unwrap();
            qs.push((p, q.clone()));
            qs.len()
        };
        let due = {
            let mut fail = self.fail_at.lock().unwrap();
            match fail.take() {
                Some((at, err)) if at == n => Some(err),
                other => {
                    *fail = other;
                    None
                }
            }
        };
        if let Some(err) = due {
            self.inner.fail_next(err);
        }
        self.inner.history_page(p, q).await
    }
    async fn tx(&self, p: Priority, h: TxHash) -> Result<Option<RawTx>, SourceError> {
        self.inner.tx(p, h).await
    }
    async fn receipt(&self, p: Priority, h: TxHash) -> Result<Option<RawReceipt>, SourceError> {
        self.inner.receipt(p, h).await
    }
    async fn internal_txs(&self, p: Priority, h: TxHash) -> Result<Vec<Transfer>, SourceError> {
        self.inner.internal_txs(p, h).await
    }
    async fn block_timestamp(&self, p: Priority, b: u64) -> Result<DateTime<Utc>, SourceError> {
        self.inner.block_timestamp(p, b).await
    }
    async fn latest_block(&self, p: Priority) -> Result<u64, SourceError> {
        self.inner.latest_block(p).await
    }
    async fn contract_source(
        &self,
        p: Priority,
        a: Address,
    ) -> Result<ContractSource, SourceError> {
        self.inner.contract_source(p, a).await
    }
    async fn contract_creation(
        &self,
        p: Priority,
        a: &[Address],
    ) -> Result<Vec<ContractCreation>, SourceError> {
        self.inner.contract_creation(p, a).await
    }
    async fn eth_call(&self, p: Priority, to: Address, d: Bytes) -> Result<Bytes, SourceError> {
        self.inner.eth_call(p, to, d).await
    }
}

const ADDR: Address = Address::repeat_byte(0xaa);

struct Env {
    ctx: JobCtx,
    fake: Arc<FakeSource>,
    spy: Arc<Spy>,
}

fn env(pool: PgPool, cap: u32) -> Env {
    let fake = Arc::new(FakeSource::new());
    let spy = Arc::new(Spy {
        inner: fake.clone(),
        queries: Mutex::new(vec![]),
        fail_at: Mutex::new(None),
    });
    let cfg = IngestConfig {
        max_records_per_category: cap,
        ..IngestConfig::default()
    };
    let ctx = JobCtx {
        store: Store::from_pool(pool),
        source: spy.clone(),
        bus: EventBus::new(),
        cfg: Arc::new(cfg),
        wake: Arc::new(Notify::new()),
    };
    Env { ctx, fake, spy }
}

/// Transfer `i` of `kind` involving `ADDR`; tx hashes are unique per (kind, i).
fn tr(kind: TransferKind, i: u64, block: u64) -> Transfer {
    let tag = u64::from(kind.as_i16().unsigned_abs()) << 32;
    Transfer {
        tx_hash: B256::from(U256::from(tag + i)),
        sub_id: if kind == TransferKind::Native {
            "top".into()
        } else {
            format!("{}:{i}", kind.as_str())
        },
        kind,
        block_number: block,
        ts: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        from: ADDR,
        to: Address::repeat_byte(0xbb),
        asset: None,
        amount: U256::from(1u64),
        token_id: None,
        trace_id: None,
        log_index: None,
    }
}

/// One native transfer per block in `1..=n`.
fn native_blocks(e: &Env, n: u64) {
    let ts = (1..=n).map(|b| tr(TransferKind::Native, b, b)).collect();
    e.fake.add_history(ADDR, TransferKind::Native, ts, vec![]);
}

async fn enqueue(e: &Env, key: &str, params: Value) -> i64 {
    let (id, _) = e
        .ctx
        .store
        .enqueue(&NewJob {
            key: key.into(),
            kind: JobKind::SyncAddress,
            params,
            priority: Priority::Interactive,
        })
        .await
        .unwrap();
    id
}

fn params(dir: &str, kinds: &[&str]) -> Value {
    json!({"address": format!("{ADDR:#x}"), "direction": dir, "kinds": kinds})
}

/// Claims the next job (which must be `id`) and runs the handler on it once.
async fn run_once(e: &Env, id: i64) -> Result<(), JobError> {
    let job = e
        .ctx
        .store
        .claim_next()
        .await
        .unwrap()
        .expect("pending job");
    assert_eq!(job.id, id);
    SyncAddressHandler.run(&job, &e.ctx).await
}

async fn run_to_done(e: &Env, key: &str, p: Value) -> i64 {
    let id = enqueue(e, key, p).await;
    run_once(e, id).await.unwrap();
    e.ctx.store.complete_job(id).await.unwrap();
    id
}

async fn transfer_count(e: &Env) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM transfers")
        .fetch_one(e.ctx.store.pool())
        .await
        .unwrap()
}

async fn rows(e: &Env) -> Vec<SyncRow> {
    e.ctx.store.sync_rows(&[ADDR]).await.unwrap()
}

async fn row(e: &Env, kind: TransferKind) -> SyncRow {
    rows(e)
        .await
        .into_iter()
        .find(|r| r.kind == kind)
        .expect("sync row")
}

async fn job_status(e: &Env, id: i64) -> String {
    sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(e.ctx.store.pool())
        .await
        .unwrap()
}

async fn wait_status(e: &Env, id: i64, want: &str) {
    for _ in 0..400 {
        if job_status(e, id).await == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("job {id} never reached {want}: {}", job_status(e, id).await);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_fetches_all_kinds_and_sets_coverage(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(1000);
    for k in TransferKind::ALL {
        let ts = [100, 200, 300].map(|b| tr(k, b, b)).to_vec();
        e.fake.add_history(ADDR, k, ts, vec![]);
    }
    let mut rx = e.ctx.bus.subscribe();
    let id = enqueue(&e, "s", params("latest", &[])).await;
    run_once(&e, id).await.unwrap();

    assert_eq!(transfer_count(&e).await, 15);
    let rs = rows(&e).await;
    assert_eq!(rs.len(), 5);
    for (r, k) in rs.iter().zip(TransferKind::ALL) {
        assert_eq!(r.kind, k);
        assert_eq!((r.from_block, r.to_block), (Some(0), Some(1000)));
        assert!(!r.truncated);
        assert_eq!(r.state, SyncState::Ok);
        assert!(r.last_synced_at.is_some());
    }
    let qs = e.spy.queries();
    let kinds: Vec<TransferKind> = qs.iter().map(|(_, q)| q.kind).collect();
    assert_eq!(kinds, TransferKind::ALL.to_vec());
    for (p, q) in &qs {
        assert_eq!(*p, Priority::Interactive);
        assert_eq!(
            (q.address, q.start_block, q.end_block, q.page, q.offset),
            (ADDR, 0, 1000, 1, 1000)
        );
    }

    let mut changed = 0;
    let mut progress = vec![];
    while let Ok(ev) = rx.try_recv() {
        match ev {
            Event::AddressDataChanged { address } => {
                assert_eq!(address, ADDR);
                changed += 1;
            }
            Event::JobProgress {
                job_id,
                kind,
                fetched,
                cursor_block,
                status,
            } => {
                assert_eq!(
                    (job_id, kind, status),
                    (id, JobKind::SyncAddress, JobStatus::Running)
                );
                progress.push((fetched, cursor_block));
            }
            other => panic!("unexpected event {other:?}"),
        }
    }
    assert_eq!(changed, 5);
    assert_eq!(progress, vec![(3, Some(1000)); 5]);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_over_10000_slides_without_duplicates(pool: PgPool) {
    let e = env(pool, 20_000);
    e.fake.set_latest_block(3000);
    // Five transfers per block, blocks 1..=2500.
    let ts = (0..12_500u64)
        .map(|i| tr(TransferKind::Native, i, i / 5 + 1))
        .collect();
    e.fake.add_history(ADDR, TransferKind::Native, ts, vec![]);
    run_to_done(&e, "s", params("latest", &["native"])).await;

    assert_eq!(transfer_count(&e).await, 12_500);
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(0), Some(3000), false)
    );
    assert_eq!(r.state, SyncState::Ok);

    let qs = e.spy.queries();
    // 10 pages fill the first window (oldest block 501), then 2505 rows remain
    // in blocks 1..=501: three pages in the second window.
    assert_eq!(qs.len(), 13);
    assert_eq!(qs[0].0, Priority::Interactive);
    assert!(qs[1..].iter().all(|(p, _)| *p == Priority::Background));
    assert!(qs.iter().all(|(_, q)| q.page * q.offset <= 10_000));
    let windows: Vec<(u64, u32)> = qs.iter().map(|(_, q)| (q.end_block, q.page)).collect();
    assert_eq!(windows[9], (3000, 10));
    assert_eq!(&windows[10..], &[(501, 1), (501, 2), (501, 3)]);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_cap_marks_truncated(pool: PgPool) {
    let e = env(pool, 3000);
    e.fake.set_latest_block(6000);
    native_blocks(&e, 5000);
    run_to_done(&e, "s", params("latest", &["native"])).await;

    assert_eq!(transfer_count(&e).await, 3000);
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(2001), Some(6000), true)
    );
    assert_eq!(r.state, SyncState::Ok);
    assert_eq!(e.spy.queries().len(), 3);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn resume_after_crash_does_not_refetch_done_pages(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(5000);
    native_blocks(&e, 4500);
    e.spy
        .fail_history_at(3, SourceError::Network("reset".into()));
    let id = enqueue(&e, "s", params("latest", &["native"])).await;

    let err = run_once(&e, id).await.unwrap_err();
    assert!(matches!(err, JobError::Source(SourceError::Network(_))));
    // What the runner does with a retryable error.
    e.ctx
        .store
        .fail_job(id, &err.to_string(), true)
        .await
        .unwrap();
    assert_eq!(job_status(&e, id).await, "pending");
    assert_eq!(transfer_count(&e).await, 2000);
    let r = row(&e, TransferKind::Native).await;
    assert_eq!((r.from_block, r.to_block), (None, None));
    assert_eq!(r.state, SyncState::Syncing);

    let before = e.fake.calls();
    run_once(&e, id).await.unwrap();
    // Pages 3, 4 and 5 only; the head is not re-fetched either.
    assert_eq!(e.fake.calls() - before, 3);
    let pages: Vec<u32> = e.spy.queries().iter().map(|(_, q)| q.page).collect();
    assert_eq!(pages, vec![1, 2, 3, 3, 4, 5]);
    assert_eq!(transfer_count(&e).await, 4500);
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(0), Some(5000), false)
    );
    assert_eq!(r.state, SyncState::Ok);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn latest_incremental_starts_at_to_minus_reorg(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(5000);
    for k in TransferKind::ALL {
        e.fake.add_history(ADDR, k, vec![tr(k, 1, 4000)], vec![]);
    }
    run_to_done(&e, "s", params("latest", &[])).await;
    let first = e.spy.queries().len();

    e.fake.set_latest_block(6000);
    for k in TransferKind::ALL {
        let ts = vec![tr(k, 1, 4000), tr(k, 2, 5500)];
        e.fake.add_history(ADDR, k, ts, vec![]);
    }
    run_to_done(&e, "s", params("latest", &[])).await;

    let qs = e.spy.queries()[first..].to_vec();
    assert_eq!(qs.len(), 5);
    for (_, q) in &qs {
        assert_eq!((q.start_block, q.end_block), (5000 - 64, 6000));
    }
    assert_eq!(transfer_count(&e).await, 10);
    for r in rows(&e).await {
        assert_eq!(
            (r.from_block, r.to_block, r.truncated),
            (Some(0), Some(6000), false)
        );
        assert_eq!(r.state, SyncState::Ok);
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn quota_mid_sync_keeps_coverage_honest(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(5000);
    native_blocks(&e, 4500);
    e.spy.fail_history_at(2, SourceError::QuotaExhausted);
    let id = enqueue(&e, "s", params("latest", &[])).await;
    let hs = Runner::spawn(e.ctx.clone(), 1, default_handlers());

    wait_status(&e, id, "paused_quota").await;
    let rs = rows(&e).await;
    assert!(rs.iter().all(|r| r.state != SyncState::Ok), "{rs:?}");
    let r = row(&e, TransferKind::Native).await;
    assert_eq!((r.from_block, r.to_block), (None, None));
    assert_eq!(r.state, SyncState::Syncing);
    assert_eq!(transfer_count(&e).await, 1000);

    // After the quota resets, the job resumes and finishes with full coverage.
    e.ctx.store.resume_paused().await.unwrap();
    e.ctx.wake.notify_waiters();
    wait_status(&e, id, "done").await;
    hs.iter().for_each(|h| h.abort());
    assert_eq!(transfer_count(&e).await, 4500);
    let rs = rows(&e).await;
    assert_eq!(rs.len(), 5);
    assert!(
        rs.iter()
            .all(|r| r.state == SyncState::Ok && r.to_block == Some(5000))
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn older_extends_coverage_down_to_zero(pool: PgPool) {
    let e = env(pool, 3000);
    e.fake.set_latest_block(6000);
    native_blocks(&e, 5000);
    run_to_done(&e, "latest", params("latest", &[])).await;
    assert_eq!(row(&e, TransferKind::Native).await.from_block, Some(2001));
    let first = e.spy.queries().len();

    run_to_done(&e, "older", params("older", &[])).await;
    // Only the truncated kind has anything older to fetch.
    let qs = e.spy.queries()[first..].to_vec();
    assert_eq!(qs.len(), 3);
    for (_, q) in &qs {
        assert_eq!(
            (q.kind, q.start_block, q.end_block),
            (TransferKind::Native, 0, 2001)
        );
    }
    assert_eq!(qs[0].0, Priority::Interactive);
    assert_eq!(transfer_count(&e).await, 5000);
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(0), Some(6000), false)
    );
    assert_eq!(r.state, SyncState::Ok);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_requested_stops_before_next_page(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(5000);
    native_blocks(&e, 100);
    let id = enqueue(&e, "s", params("latest", &["native"])).await;
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    assert!(e.ctx.store.cancel_job(id).await.unwrap());

    let err = SyncAddressHandler.run(&job, &e.ctx).await.unwrap_err();
    assert!(matches!(err, JobError::Cancelled));
    assert!(e.spy.queries().is_empty());
    assert_eq!(transfer_count(&e).await, 0);
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.state),
        (None, None, SyncState::Failed)
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn window_too_large_is_invalid(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(5000);
    e.spy.fail_history_at(1, SourceError::WindowTooLarge);
    let id = enqueue(&e, "s", params("latest", &["erc20"])).await;

    let err = run_once(&e, id).await.unwrap_err();
    assert!(matches!(err, JobError::Invalid(_)), "{err:?}");
    let r = row(&e, TransferKind::Erc20).await;
    assert_eq!((r.from_block, r.state), (None, SyncState::Failed));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn bad_params_are_invalid(pool: PgPool) {
    let e = env(pool, 10_000);
    let id = enqueue(&e, "s", json!({"address": "nope"})).await;
    let err = run_once(&e, id).await.unwrap_err();
    assert!(matches!(err, JobError::Invalid(_)), "{err:?}");
}
