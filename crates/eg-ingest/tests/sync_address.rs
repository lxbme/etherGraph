use std::sync::{Arc, Mutex};
use std::time::Duration;

use alloy_primitives::{Address, B256, Bytes, U256};
use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use eg_core::source::{
    ChainSource, ContractCreation, ContractSource, HistoryPage, HistoryQuery, Priority, RawBlock,
    RawReceipt, RawTx, SourceError,
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
/// the n-th one (1-based) through `FakeSource::fail_next`, or running SQL just
/// before it to simulate a concurrent writer.
struct Spy {
    inner: Arc<FakeSource>,
    pool: PgPool,
    queries: Mutex<Vec<(Priority, HistoryQuery)>>,
    fail_at: Mutex<Option<(usize, SourceError)>>,
    sql_at: Mutex<Option<(usize, &'static str)>>,
}

impl Spy {
    fn fail_history_at(&self, n: usize, e: SourceError) {
        *self.fail_at.lock().unwrap() = Some((n, e));
    }

    fn sql_before_history(&self, n: usize, sql: &'static str) {
        *self.sql_at.lock().unwrap() = Some((n, sql));
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
        let sql = {
            let mut at = self.sql_at.lock().unwrap();
            match at.take() {
                Some((k, sql)) if k == n => Some(sql),
                other => {
                    *at = other;
                    None
                }
            }
        };
        if let Some(sql) = sql {
            sqlx::query(sql).execute(&self.pool).await.unwrap();
        }
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
    async fn block(&self, p: Priority, b: u64) -> Result<RawBlock, SourceError> {
        self.inner.block(p, b).await
    }
    async fn tx_status(&self, p: Priority, h: TxHash) -> Result<Option<String>, SourceError> {
        self.inner.tx_status(p, h).await
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
    async fn tx_count(&self, p: Priority, a: Address) -> Result<u64, SourceError> {
        self.inner.tx_count(p, a).await
    }
    async fn code(&self, p: Priority, a: Address) -> Result<Bytes, SourceError> {
        self.inner.code(p, a).await
    }
    async fn balances(
        &self,
        p: Priority,
        a: &[Address],
    ) -> Result<Vec<(Address, U256)>, SourceError> {
        self.inner.balances(p, a).await
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
        pool: pool.clone(),
        queries: Mutex::new(vec![]),
        fail_at: Mutex::new(None),
        sql_at: Mutex::new(None),
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
        call_index: None,
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
            user_id: None,
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
                error,
            } => {
                assert_eq!(
                    (job_id, kind, status, error),
                    (id, JobKind::SyncAddress, JobStatus::Running, None)
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
async fn shallow_sync_stops_after_one_page(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(6000);
    native_blocks(&e, 2500);
    let mut p = params("latest", &["native"]);
    p["cap"] = json!(1000);
    run_to_done(&e, "s", p).await;

    let qs = e.spy.queries();
    assert_eq!(qs.len(), 1, "one history page for the kind");
    assert_eq!(qs[0].1.kind, TransferKind::Native);
    assert_eq!(transfer_count(&e).await, 1000);
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(1501), Some(6000), true)
    );
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
    assert!(e.ctx.store.cancel_job(id).await.unwrap().is_some());

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
async fn cancel_restores_ok_when_coverage_exists(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(5000);
    native_blocks(&e, 100);
    run_to_done(&e, "s", params("latest", &["native"])).await;
    let before = row(&e, TransferKind::Native).await;

    e.fake.set_latest_block(6000);
    let id = enqueue(&e, "s", params("latest", &["native"])).await;
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    assert!(e.ctx.store.cancel_job(id).await.unwrap().is_some());
    let err = SyncAddressHandler.run(&job, &e.ctx).await.unwrap_err();
    assert!(matches!(err, JobError::Cancelled));
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(r.state, SyncState::Ok);
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (before.from_block, before.to_block, before.truncated)
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn older_does_not_claim_gap_left_by_concurrent_latest(pool: PgPool) {
    let e = env(pool, 3000);
    e.fake.set_latest_block(6000);
    native_blocks(&e, 5000);
    run_to_done(&e, "latest", params("latest", &["native"])).await;
    let r = row(&e, TransferKind::Native).await;
    assert_eq!((r.from_block, r.truncated), (Some(2001), true));

    // Older pages [0, 2001] in three queries (4..=6). Before its second page a
    // truncated Latest sync completes with a window far above the old one.
    e.spy.sql_before_history(
        5,
        "UPDATE address_sync SET from_block = 30000, to_block = 50000, truncated = true, \
         state = 'ok', last_synced_at = now()",
    );
    run_to_done(&e, "older", params("older", &["native"])).await;
    assert_eq!(e.spy.queries().len(), 6);
    assert_eq!(transfer_count(&e).await, 5000);
    let r = row(&e, TransferKind::Native).await;
    // Blocks 6001..30000 were never fetched: no claim may span them.
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(30000), Some(50000), true)
    );
    assert_eq!(r.state, SyncState::Ok);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn over_full_block_stays_truncated_across_older_sync(pool: PgPool) {
    const M: u64 = 500;
    let e = env(pool, 50_000);
    e.fake.set_latest_block(1000);
    let mut ts = vec![
        tr(TransferKind::Native, 1, 700),
        tr(TransferKind::Native, 2, 600),
    ];
    ts.extend((10..10_510).map(|i| tr(TransferKind::Native, i, M)));
    ts.push(tr(TransferKind::Native, 3, 200));
    ts.push(tr(TransferKind::Native, 4, 100));
    e.fake.add_history(ADDR, TransferKind::Native, ts, vec![]);

    run_to_done(&e, "latest", params("latest", &["native"])).await;
    // Window 1 (end 1000) ends inside M, window 2 (end M) is all M and skips
    // the rest of it, window 3 (end M-1) finishes.
    let ends: Vec<u64> = e.spy.queries().iter().map(|(_, q)| q.end_block).collect();
    assert_eq!(ends.len(), 21);
    assert_eq!((ends[10], ends[20]), (M, M - 1));
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(M), Some(1000), true)
    );

    run_to_done(&e, "older", params("older", &["native"])).await;
    let r = row(&e, TransferKind::Native).await;
    assert_eq!(
        (r.from_block, r.to_block, r.truncated),
        (Some(M), Some(1000), true)
    );
    assert_eq!(r.state, SyncState::Ok);
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

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn background_job_never_uses_interactive_priority(pool: PgPool) {
    let e = env(pool, 10_000);
    e.fake.set_latest_block(1000);
    native_blocks(&e, 3);
    for p in [Priority::Background, Priority::Low] {
        let (id, _) = e
            .ctx
            .store
            .enqueue(&NewJob {
                key: format!("bg-{p:?}"),
                kind: JobKind::SyncAddress,
                params: params("latest", &[]),
                priority: p,
                user_id: None,
            })
            .await
            .unwrap();
        run_once(&e, id).await.unwrap();
        e.ctx.store.complete_job(id).await.unwrap();
    }
    let qs = e.spy.queries();
    assert_eq!(qs.len(), 10);
    assert!(
        qs.iter().all(|(p, _)| *p == Priority::Background),
        "{:?}",
        qs.iter().map(|(p, _)| *p).collect::<Vec<_>>()
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn guard_miss_settles_syncing_state(pool: PgPool) {
    let e = env(pool, 3000);
    e.fake.set_latest_block(6000);
    native_blocks(&e, 5000);
    run_to_done(&e, "latest", params("latest", &["native"])).await;
    // Before the Older sync's last page another job moves the boundary and
    // is itself still syncing the kind.
    e.spy.sql_before_history(
        6,
        "UPDATE address_sync SET from_block = 30000, to_block = 50000, truncated = true, \
         state = 'syncing', last_synced_at = now()",
    );
    run_to_done(&e, "older", params("older", &["native"])).await;
    let r = row(&e, TransferKind::Native).await;
    assert_eq!((r.from_block, r.to_block), (Some(30000), Some(50000)));
    assert_eq!(r.state, SyncState::Ok);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn guard_miss_leaves_state_to_another_active_sync(pool: PgPool) {
    let e = env(pool, 3000);
    e.fake.set_latest_block(6000);
    native_blocks(&e, 5000);
    run_to_done(&e, "latest", params("latest", &["native"])).await;
    e.spy.sql_before_history(
        6,
        "UPDATE address_sync SET from_block = 30000, to_block = 50000, truncated = true, \
         state = 'syncing', last_synced_at = now()",
    );
    let id = enqueue(&e, "older", params("older", &["native"])).await;
    // The concurrent Latest sync that moved the boundary is still queued.
    e.ctx
        .store
        .enqueue(&NewJob {
            key: format!("sync:{ADDR:#x}:latest"),
            kind: JobKind::SyncAddress,
            params: params("latest", &["native"]),
            priority: Priority::Background,
            user_id: None,
        })
        .await
        .unwrap();
    run_once(&e, id).await.unwrap();
    assert_eq!(
        row(&e, TransferKind::Native).await.state,
        SyncState::Syncing
    );
}

async fn owners(e: &Env, id: i64) -> Vec<Option<String>> {
    sqlx::query_scalar("SELECT batch_id FROM job_owners WHERE job_id = $1 ORDER BY batch_id")
        .bind(id)
        .fetch_all(e.ctx.store.pool())
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn enqueue_sync_never_joins_a_job_cancelled_under_it(pool: PgPool) {
    use eg_ingest::{SyncDirection, enqueue_sync};
    let e = env(pool.clone(), 10_000);
    let dir = SyncDirection::Latest;
    let first = enqueue_sync(
        &e.ctx,
        None,
        ADDR,
        dir,
        Priority::Background,
        None,
        Some("b1"),
    )
    .await
    .unwrap();
    // A batch release locks the job, then cancels it, while a second request
    // has already found the job by key and is adding itself as an owner.
    let mut release = pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE")
        .bind(first)
        .execute(&mut *release)
        .await
        .unwrap();
    let join = tokio::spawn({
        let ctx = e.ctx.clone();
        async move {
            enqueue_sync(
                &ctx,
                None,
                ADDR,
                dir,
                Priority::Background,
                None,
                Some("b2"),
            )
            .await
            .unwrap()
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !join.is_finished(),
        "the owner insert waits for the release"
    );
    sqlx::query("DELETE FROM job_owners WHERE batch_id = 'b1'")
        .execute(&mut *release)
        .await
        .unwrap();
    sqlx::query("UPDATE jobs SET status = 'cancelled' WHERE id = $1")
        .bind(first)
        .execute(&mut *release)
        .await
        .unwrap();
    release.commit().await.unwrap();

    let second = join.await.unwrap();
    assert_ne!(second, first, "a fresh job replaces the cancelled one");
    assert_eq!(job_status(&e, second).await, "pending");
    assert_eq!(owners(&e, second).await, vec![Some("b2".to_string())]);
    assert!(owners(&e, first).await.is_empty());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn enqueue_sync_reports_a_conflict_when_joining_keeps_racing(pool: PgPool) {
    use eg_ingest::{SyncDirection, enqueue_sync};
    use eg_store::StoreError;
    let e = env(pool.clone(), 10_000);
    // Every owner insert sees its job cancelled under it (then rolled back with
    // it), so each attempt finds the same job and fails to join it.
    sqlx::raw_sql(
        "CREATE FUNCTION cancel_owned() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN UPDATE jobs SET status = 'cancelled' WHERE id = NEW.job_id; RETURN NEW; END $$; \
         CREATE TRIGGER cancel_owned BEFORE INSERT ON job_owners \
         FOR EACH ROW EXECUTE FUNCTION cancel_owned();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let err = enqueue_sync(
        &e.ctx,
        None,
        ADDR,
        SyncDirection::Latest,
        Priority::Background,
        None,
        Some("b1"),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, StoreError::Conflict), "{err:?}");
}
