use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, B256, Bytes, U256, address, b256};
use chrono::{TimeZone, Utc};
use eg_blockscout::parse_raw_trace;
use eg_core::source::{CallFrame, SourceError};
use eg_core::testing::{FakeSource, FakeTraceSource};
use eg_core::types::AccountKind;
use eg_ingest::config::IngestConfig;
use eg_ingest::gate::{GateConfig, PriorityGate};
use eg_ingest::handlers::FetchTraceHandler;
use eg_ingest::{
    Audience, Event, EventBus, JobCtx, JobError, JobHandler, Runner, default_handlers,
    enqueue_fetch_trace,
};
use eg_store::{AccountRow, JobStatus, Store, TxRow};
use serde_json::json;
use sqlx::PgPool;
use tokio::sync::Notify;

/// Raw trace of the ENS ".eth" registration
/// 0x461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3.
const ENS: &str = include_str!("../../eg-blockscout/tests/data/ens_register.json");
const HASH: B256 = b256!("461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3");
/// The EIP-7702 delegated sender.
const SENDER: Address = address!("82eb45562f991329ed2867f43fc60f0ba52c3dab");
const CONTROLLER: Address = address!("253553366da8546fc250f225fe3d25d0c782303b");
const NAME_WRAPPER: Address = address!("d4416b13d2b3a9abae7acd5d6c2bbdbe25686401");
const DELEGATE: Address = Address::repeat_byte(0xde);

struct Env {
    ctx: JobCtx,
    fake: Arc<FakeSource>,
    trace: Arc<FakeTraceSource>,
    user: i64,
}

async fn env(pool: PgPool) -> Env {
    let fake = Arc::new(FakeSource::new());
    let trace = Arc::new(FakeTraceSource::new());
    let ctx = JobCtx {
        store: Store::from_pool(pool),
        source: fake.clone(),
        bus: EventBus::new(),
        cfg: Arc::new(IngestConfig::default()),
        wake: Arc::new(Notify::new()),
        gate: PriorityGate::spawn(GateConfig {
            rate_per_sec: 1000.0,
            daily_limit: u32::MAX,
            initial_used: 0,
            default_user_limit: u32::MAX,
            user_limits: HashMap::new(),
            initial_user_used: HashMap::new(),
        }),
        trace_source: trace.clone(),
    };
    let user = ctx
        .store
        .upsert_user_on_login(Address::repeat_byte(0x01))
        .await
        .unwrap()
        .id;
    Env {
        ctx,
        fake,
        trace,
        user,
    }
}

fn ens_frames() -> Vec<CallFrame> {
    parse_raw_trace(ENS).unwrap()
}

/// The stored transaction matching the fixture's root frame.
fn ens_tx() -> TxRow {
    let root = &ens_frames()[0];
    TxRow {
        hash: HASH,
        block_number: 23_000_000,
        ts: Utc.timestamp_opt(1_760_000_000, 0).unwrap(),
        from: SENDER,
        to: Some(CONTROLLER),
        value: U256::from(22_616_028_901_072_185u64),
        selector: Some([0x74, 0x69, 0x4a, 0x2b]),
        success: true,
        gas_used: U256::from(0x3498du64),
        fee: U256::ZERO,
        raw_tx: json!({"hash": format!("{HASH:#x}"), "input": format!("{}", root.input)}),
        raw_receipt: json!({"status": "0x1"}),
        revert_reason: None,
    }
}

/// Enqueues the user's `fetch_trace` job for `hash`, runs its handler once
/// and settles the job so the next call starts a fresh one.
async fn run(e: &Env, hash: B256) -> Result<(), JobError> {
    let id = enqueue_fetch_trace(&e.ctx, Some(e.user), hash)
        .await
        .unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    assert_eq!(job.id, id);
    let res = FetchTraceHandler.run(&job, &e.ctx).await;
    e.ctx.store.complete_job(job.id).await.unwrap();
    res
}

fn contract(addr: Address) -> AccountRow {
    AccountRow {
        address: addr,
        kind: AccountKind::Contract,
        contract_name: None,
        is_proxy: false,
        implementation: None,
        creator: None,
        creation_tx: None,
        meta_fetched_at: Utc::now(),
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn stores_a_valid_trace_and_announces_it(pool: PgPool) {
    let e = env(pool).await;
    e.ctx.store.upsert_transaction(&ens_tx()).await.unwrap();
    e.trace.set(HASH, Some(ens_frames()));
    let mut rx = e.ctx.bus.subscribe();

    run(&e, HASH).await.unwrap();

    let row = e.ctx.store.call_trace(HASH).await.unwrap().unwrap();
    assert_eq!(row.hash, HASH);
    assert_eq!(row.frames, ens_frames());
    assert!(row.delegates.is_empty());
    assert_eq!(row.source, "fake");
    let mut ready = 0;
    while let Ok((aud, ev)) = rx.try_recv() {
        assert_eq!(aud, Audience::User(e.user));
        if let Event::TraceReady { hash } = ev {
            assert_eq!(hash, format!("{HASH:#x}"));
            ready += 1;
        }
    }
    assert_eq!(ready, 1);
    // Six distinct non-static callees with calldata, none known as a
    // contract: only the first five are probed for a 7702 designator.
    assert_eq!(e.fake.calls(), 5);

    // A cached trace is announced again without asking the source.
    run(&e, HASH).await.unwrap();
    assert_eq!(e.trace.calls(), 1);
    assert!(matches!(rx.try_recv(), Ok((_, Event::TraceReady { .. }))));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn rejects_and_stores_nothing(pool: PgPool) {
    let e = env(pool).await;
    e.ctx.store.upsert_transaction(&ens_tx()).await.unwrap();
    let edit = |f: fn(&mut Vec<CallFrame>)| {
        let mut frames = ens_frames();
        f(&mut frames);
        Some(frames)
    };
    let cases: Vec<(&str, Option<Vec<CallFrame>>, &str)> = vec![
        ("none", None, "trace not available from the source yet"),
        ("empty", Some(vec![]), "incomplete trace: no frames"),
        (
            "from",
            edit(|f| f[0].from = Address::repeat_byte(9)),
            "incomplete trace: root from",
        ),
        (
            "value",
            edit(|f| f[0].value = U256::from(1u8)),
            "incomplete trace: root value",
        ),
        (
            "subtraces",
            edit(|f| f[0].subtraces = 5),
            "incomplete trace: subtraces",
        ),
        (
            "missing frame",
            edit(|f| drop(f.remove(3))),
            "incomplete trace: frame [1, 0, 0] without its parent",
        ),
        (
            "duplicate path",
            edit(|f| {
                let dup = f[1].clone();
                f.insert(1, dup)
            }),
            "incomplete trace: duplicate frame [0]",
        ),
    ];
    for (name, frames, want) in cases {
        e.trace.set(HASH, frames);
        let err = run(&e, HASH).await.unwrap_err();
        assert!(matches!(err, JobError::Invalid(_)), "{name}: {err}");
        assert!(err.to_string().contains(want), "{name}: {err}");
        assert!(
            e.ctx.store.call_trace(HASH).await.unwrap().is_none(),
            "{name}"
        );
    }

    // The transaction itself must be stored first.
    let other = B256::repeat_byte(0x77);
    e.trace.set(other, Some(ens_frames()));
    let err = run(&e, other).await.unwrap_err();
    assert!(err.to_string().contains("transaction not fetched"), "{err}");
    assert!(e.ctx.store.call_trace(other).await.unwrap().is_none());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn records_7702_delegates_for_callees_with_code_designator(pool: PgPool) {
    let e = env(pool).await;
    e.ctx.store.upsert_transaction(&ens_tx()).await.unwrap();
    e.ctx
        .store
        .upsert_accounts(&[contract(CONTROLLER), contract(NAME_WRAPPER)])
        .await
        .unwrap();
    let mut code = vec![0xef, 0x01, 0x00];
    code.extend_from_slice(DELEGATE.as_slice());
    e.fake.set_code(SENDER, Bytes::from(code));
    // Plain bytecode is not a designator.
    e.fake
        .set_code(NAME_WRAPPER, Bytes::from(vec![0x60, 0x80, 0x60, 0x40]));
    e.trace.set(HASH, Some(ens_frames()));

    run(&e, HASH).await.unwrap();

    let row = e.ctx.store.call_trace(HASH).await.unwrap().unwrap();
    assert_eq!(row.delegates, HashMap::from([(SENDER, DELEGATE)]));
    // Known contracts are skipped: BaseRegistrar, the ENS registry, the
    // sender and the resolver are probed.
    assert_eq!(e.fake.calls(), 4);
}

async fn wait_status(ctx: &JobCtx, id: i64, want: JobStatus) -> i32 {
    for _ in 0..200 {
        let job = ctx.store.job(id).await.unwrap().unwrap();
        if job.status == want {
            return job.attempts;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("job {id} never reached {want:?}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn blockscout_rate_limit_is_retried_and_quota_pauses(pool: PgPool) {
    let e = env(pool).await;
    e.ctx.store.upsert_transaction(&ens_tx()).await.unwrap();
    e.trace.set(HASH, Some(ens_frames()));
    let mut rx = e.ctx.bus.subscribe();

    // Rate limited: back to pending, then done on the retry.
    e.trace.fail_next(SourceError::RateLimited);
    let workers = Runner::spawn(e.ctx.clone(), 1, default_handlers());
    let id = enqueue_fetch_trace(&e.ctx, Some(e.user), HASH)
        .await
        .unwrap();
    assert_eq!(wait_status(&e.ctx, id, JobStatus::Done).await, 1);
    assert_eq!(e.trace.calls(), 2);
    let mut statuses = Vec::new();
    while let Ok((_, ev)) = rx.try_recv() {
        if let Event::JobProgress { job_id, status, .. } = ev
            && job_id == id
        {
            statuses.push(status);
        }
    }
    assert!(statuses.contains(&JobStatus::Pending), "{statuses:?}");
    assert!(e.ctx.store.call_trace(HASH).await.unwrap().is_some());

    // Blockscout's own quota exhausted: the job waits for the reset.
    sqlx::query("DELETE FROM call_traces")
        .execute(e.ctx.store.pool())
        .await
        .unwrap();
    e.trace.fail_next(SourceError::QuotaExhausted);
    let id = enqueue_fetch_trace(&e.ctx, Some(e.user), HASH)
        .await
        .unwrap();
    wait_status(&e.ctx, id, JobStatus::PausedQuota).await;
    assert_eq!(e.trace.calls(), 3);
    assert!(e.ctx.store.call_trace(HASH).await.unwrap().is_none());
    for w in workers {
        w.abort();
    }
}
