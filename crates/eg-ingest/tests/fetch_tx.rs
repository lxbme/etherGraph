use std::sync::Arc;

use alloy_primitives::{Address, B256, Bytes, U256, address};
use chrono::{DateTime, TimeZone, Utc};
use eg_core::source::{Priority, RawBlock, RawLog, RawReceipt, RawTx, SourceError};
use eg_core::testing::FakeSource;
use eg_core::types::{Transfer, TransferKind};
use eg_ingest::config::IngestConfig;
use eg_ingest::handlers::FetchTxHandler;
use eg_ingest::{Event, EventBus, JobCtx, JobError, JobHandler, enqueue_fetch_block, load_tx_flow};
use eg_store::{JobKind, NewJob, Store, TxRow};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::Notify;

const HASH: B256 = B256::repeat_byte(0x11);
const FROM: Address = Address::repeat_byte(0xaa);
const TO: Address = Address::repeat_byte(0xbb);
const TOKEN: Address = Address::repeat_byte(0xcc);
const OTHER: Address = Address::repeat_byte(0xdd);
const TRANSFER_TOPIC: B256 = B256::new(alloy_primitives::hex!(
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
));

fn ts() -> DateTime<Utc> {
    Utc.timestamp_opt(1_700_000_000, 0).unwrap()
}

fn word(a: Address) -> B256 {
    a.into_word()
}

fn raw_tx(gas_price: Option<&str>) -> RawTx {
    let mut json = json!({"hash": format!("{HASH:#x}"), "input": "0xa9059cbb00"});
    if let Some(g) = gas_price {
        json["gasPrice"] = json!(g);
    }
    RawTx {
        hash: HASH,
        from: FROM,
        to: Some(TO),
        value: U256::from(5u8),
        input: Bytes::from(vec![0xa9, 0x05, 0x9c, 0xbb, 0x00]),
        block_number: Some(100),
        json,
    }
}

fn receipt(success: bool, price: u64, logs: Vec<RawLog>) -> RawReceipt {
    let jl: Vec<Value> = logs
        .iter()
        .map(|l| {
            json!({"address": format!("{:#x}", l.address),
                "topics": l.topics.iter().map(|t| format!("{t:#x}")).collect::<Vec<_>>(),
                "data": format!("{}", l.data), "logIndex": format!("0x{:x}", l.log_index)})
        })
        .collect();
    RawReceipt {
        success,
        gas_used: U256::from(21000u32),
        effective_gas_price: U256::from(price),
        contract_address: None,
        logs,
        json: json!({"status": if success {"0x1"} else {"0x0"}, "gasUsed": "0x5208", "logs": jl}),
    }
}

fn erc20_log() -> RawLog {
    RawLog {
        address: TOKEN,
        topics: vec![TRANSFER_TOPIC, word(FROM), word(TO)],
        data: Bytes::from(U256::from(100u8).to_be_bytes::<32>().to_vec()),
        log_index: 3,
    }
}

fn internal() -> Transfer {
    Transfer {
        tx_hash: HASH,
        sub_id: String::new(),
        kind: TransferKind::Internal,
        block_number: 100,
        ts: ts(),
        from: TO,
        to: OTHER,
        asset: None,
        amount: U256::from(2u8),
        trace_id: Some("0_1".into()),
        token_id: None,
        log_index: None,
        call_index: None,
    }
}

struct Env {
    ctx: JobCtx,
    fake: Arc<FakeSource>,
}

fn env(pool: PgPool) -> Env {
    let fake = Arc::new(FakeSource::new());
    let ctx = JobCtx {
        store: Store::from_pool(pool),
        source: fake.clone(),
        bus: EventBus::new(),
        cfg: Arc::new(IngestConfig::default()),
        wake: Arc::new(Notify::new()),
    };
    Env { ctx, fake }
}

async fn run(e: &Env, hash: &str) -> Result<(), JobError> {
    e.ctx
        .store
        .enqueue(&NewJob {
            key: format!("tx:{hash}"),
            kind: JobKind::FetchTx,
            params: json!({"hash": hash}),
            priority: Priority::Interactive,
        })
        .await
        .unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    FetchTxHandler.run(&job, &e.ctx).await
}

async fn count(e: &Env, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(e.ctx.store.pool())
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn fetch_tx_persists_and_enqueues_meta(pool: PgPool) {
    let e = env(pool);
    e.fake.add_tx(
        raw_tx(None),
        receipt(true, 7, vec![erc20_log()]),
        vec![internal()],
        ts(),
    );
    let mut rx = e.ctx.bus.subscribe();
    run(&e, &format!("{HASH:#x}")).await.unwrap();

    let row = e.ctx.store.transaction(HASH).await.unwrap().unwrap();
    assert_eq!(row.block_number, 100);
    assert_eq!(row.fee, U256::from(21000u32 * 7));
    assert_eq!(row.selector, Some([0xa9, 0x05, 0x9c, 0xbb]));
    assert!(row.success);
    let transfers = e.ctx.store.transfers_of_tx(HASH).await.unwrap();
    let kinds: Vec<_> = transfers.iter().map(|t| t.kind).collect();
    assert_eq!(transfers.len(), 3);
    assert!(kinds.contains(&TransferKind::Native));
    assert!(kinds.contains(&TransferKind::Erc20));
    assert!(kinds.contains(&TransferKind::Internal));
    assert!(transfers.iter().any(|t| t.sub_id == "top"));
    assert!(count(&e, "SELECT count(*) FROM jobs WHERE kind = 'contract_meta'").await >= 1);
    assert_eq!(
        count(&e, "SELECT count(*) FROM jobs WHERE kind = 'token_meta'").await,
        1
    );

    let mut progress = None;
    let mut ready_after_progress = false;
    while let Ok(ev) = rx.try_recv() {
        match ev {
            Event::JobProgress { fetched, .. } => progress = Some(fetched),
            Event::TxReady { hash } => {
                assert_eq!(hash, HASH);
                ready_after_progress = progress.is_some();
            }
            _ => {}
        }
    }
    assert_eq!(progress, Some(3));
    assert!(ready_after_progress);

    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert_eq!(flow.flows.len(), 3);
    assert_eq!(flow.events.len(), 1);
    assert!(
        load_tx_flow(&e.ctx.store, B256::ZERO)
            .await
            .unwrap()
            .is_none()
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn pre_london_fee_falls_back_to_tx_gas_price(pool: PgPool) {
    let e = env(pool);
    e.fake.add_tx(
        raw_tx(Some("0x3b9aca00")),
        receipt(true, 0, vec![]),
        vec![],
        ts(),
    );
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let row = e.ctx.store.transaction(HASH).await.unwrap().unwrap();
    assert_eq!(row.fee, U256::from(21000u64 * 1_000_000_000));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn failed_tx_has_no_native_flows(pool: PgPool) {
    let e = env(pool);
    e.fake.add_tx(
        raw_tx(None),
        receipt(false, 7, vec![]),
        vec![internal()],
        ts(),
    );
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let row = e.ctx.store.transaction(HASH).await.unwrap().unwrap();
    assert!(!row.success);
    assert_eq!(count(&e, "SELECT count(*) FROM transfers").await, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn contract_creation_uses_created_address(pool: PgPool) {
    let e = env(pool);
    let created = address!("0x1111111111111111111111111111111111111111");
    let mut tx = raw_tx(None);
    tx.to = None;
    let mut r = receipt(true, 7, vec![]);
    r.contract_address = Some(created);
    e.fake.add_tx(tx, r, vec![], ts());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let transfers = e.ctx.store.transfers_of_tx(HASH).await.unwrap();
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0].to, created);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn unknown_tx_fails_job(pool: PgPool) {
    let e = env(pool);
    let err = run(&e, &format!("{HASH:#x}")).await.unwrap_err();
    assert!(matches!(err, JobError::Invalid(m) if m == "tx not found"));
    let err = run(&e, "nonsense").await.unwrap_err();
    assert!(matches!(err, JobError::Invalid(_)));
}

fn header() -> RawBlock {
    RawBlock {
        number: 100,
        ts: ts(),
        base_fee: Some(U256::from(1_000_000_007u64)),
        gas_limit: U256::from(30_000_000u64),
        gas_used: U256::from(12_345_678u64),
        fee_recipient: OTHER,
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn fetch_tx_stores_block(pool: PgPool) {
    let e = env(pool);
    e.fake
        .add_tx(raw_tx(None), receipt(true, 7, vec![]), vec![], ts());
    e.fake.add_block(header());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let b = e.ctx.store.block(100).await.unwrap().unwrap();
    assert_eq!(b, header());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn failed_tx_stores_revert_reason(pool: PgPool) {
    let e = env(pool);
    e.fake
        .add_tx(raw_tx(None), receipt(false, 7, vec![]), vec![], ts());
    e.fake.set_tx_status(HASH, Some("Reverted".into()));
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let row = e.ctx.store.transaction(HASH).await.unwrap().unwrap();
    assert_eq!(row.revert_reason.as_deref(), Some("Reverted"));
    assert_eq!(e.fake.tx_status_calls(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn successful_tx_skips_status_call(pool: PgPool) {
    let e = env(pool);
    e.fake
        .add_tx(raw_tx(None), receipt(true, 7, vec![]), vec![], ts());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    assert_eq!(e.fake.tx_status_calls(), 0);
    let row = e.ctx.store.transaction(HASH).await.unwrap().unwrap();
    assert_eq!(row.revert_reason, None);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn fetch_block_job_is_deduplicated(pool: PgPool) {
    let e = env(pool);
    let a = enqueue_fetch_block(&e.ctx, 100, HASH).await.unwrap();
    let b = enqueue_fetch_block(&e.ctx, 100, HASH).await.unwrap();
    assert_eq!(a, b);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn fetch_block_handler_stores_header_and_announces(pool: PgPool) {
    let e = env(pool);
    e.fake.add_block(header());
    let mut rx = e.ctx.bus.subscribe();
    enqueue_fetch_block(&e.ctx, 100, HASH).await.unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    assert_eq!(job.kind, JobKind::FetchBlock);
    eg_ingest::handlers::FetchBlockHandler
        .run(&job, &e.ctx)
        .await
        .unwrap();
    assert_eq!(e.ctx.store.block(100).await.unwrap().unwrap(), header());
    assert!(matches!(rx.try_recv(), Ok(Event::TxReady { hash }) if hash == HASH));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_status_error_degrades_to_no_reason(pool: PgPool) {
    let e = env(pool);
    e.fake
        .add_tx(raw_tx(None), receipt(false, 7, vec![]), vec![], ts());
    e.fake.set_tx_status(HASH, Some("Reverted".into()));
    e.fake
        .fail_next_tx_status(SourceError::Upstream("getstatus failed".into()));
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    assert_eq!(e.fake.tx_status_calls(), 1);
    let row = e.ctx.store.transaction(HASH).await.unwrap().unwrap();
    assert!(!row.success);
    assert_eq!(row.revert_reason, None);
}

async fn tx_status_error_propagates(pool: PgPool, err: SourceError) {
    let e = env(pool);
    e.fake
        .add_tx(raw_tx(None), receipt(false, 7, vec![]), vec![], ts());
    e.fake.fail_next_tx_status(err.clone());
    let got = run(&e, &format!("{HASH:#x}")).await.unwrap_err();
    assert!(
        matches!(got, JobError::Source(ref s) if *s == err),
        "{got:?}"
    );
    assert!(e.ctx.store.transaction(HASH).await.unwrap().is_none());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_status_quota_exhausted_propagates(pool: PgPool) {
    tx_status_error_propagates(pool, SourceError::QuotaExhausted).await;
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_status_invalid_key_propagates(pool: PgPool) {
    tx_status_error_propagates(pool, SourceError::InvalidKey).await;
}

fn stored_tx(hash: B256, block: u64) -> TxRow {
    TxRow {
        hash,
        block_number: block,
        ts: ts(),
        from: FROM,
        to: Some(TO),
        value: U256::ZERO,
        selector: None,
        success: true,
        gas_used: U256::from(21000u32),
        fee: U256::ZERO,
        raw_tx: json!({}),
        raw_receipt: json!({}),
        revert_reason: None,
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn fetch_block_announces_every_stored_tx_of_the_block(pool: PgPool) {
    let e = env(pool);
    let other = B256::repeat_byte(0x22);
    let elsewhere = B256::repeat_byte(0x33);
    for row in [
        stored_tx(HASH, 100),
        stored_tx(other, 100),
        stored_tx(elsewhere, 101),
    ] {
        e.ctx.store.upsert_transaction(&row).await.unwrap();
    }
    e.fake.add_block(header());
    let mut rx = e.ctx.bus.subscribe();
    enqueue_fetch_block(&e.ctx, 100, HASH).await.unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    eg_ingest::handlers::FetchBlockHandler
        .run(&job, &e.ctx)
        .await
        .unwrap();
    let mut announced = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let Event::TxReady { hash } = ev {
            announced.push(hash);
        }
    }
    announced.sort();
    assert_eq!(announced, vec![HASH, other]);
}
