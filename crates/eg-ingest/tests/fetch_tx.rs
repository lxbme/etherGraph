use std::sync::Arc;

use alloy_primitives::{Address, B256, Bytes, U256, address};
use chrono::{DateTime, TimeZone, Utc};
use eg_core::source::{Priority, RawBlock, RawLog, RawReceipt, RawTx, SourceError};
use eg_core::testing::{FakeSource, FakeTraceSource};
use eg_core::types::{Transfer, TransferKind};
use eg_ingest::config::IngestConfig;
use eg_ingest::gate::{GateConfig, PriorityGate};
use eg_ingest::handlers::FetchTxHandler;
use eg_ingest::{
    Audience, Event, EventBus, JobCtx, JobError, JobHandler, enqueue_fetch_block, load_tx_flow,
};
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
        gate: PriorityGate::spawn(GateConfig {
            rate_per_sec: 1000.0,
            daily_limit: u32::MAX,
            initial_used: 0,
            default_user_limit: u32::MAX,
            user_limits: Default::default(),
            initial_user_used: Default::default(),
        }),
        trace_source: Arc::new(FakeTraceSource::new()),
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
            user_id: None,
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
    assert_eq!(
        count(&e, "SELECT count(*) FROM jobs WHERE kind = 'contract_meta'").await,
        1
    );
    assert_eq!(
        count(&e, "SELECT count(*) FROM jobs WHERE kind = 'token_meta'").await,
        1
    );

    let mut progress = None;
    let mut ready_after_progress = false;
    while let Ok((aud, ev)) = rx.try_recv() {
        assert_eq!(aud, Audience::Nobody);
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
async fn follow_up_jobs_belong_to_the_parent_jobs_user(pool: PgPool) {
    let e = env(pool);
    e.fake.add_tx(
        raw_tx(None),
        receipt(true, 7, vec![erc20_log()]),
        vec![internal()],
        ts(),
    );
    let user = e
        .ctx
        .store
        .upsert_user_on_login(Address::repeat_byte(0xe0))
        .await
        .unwrap()
        .id;
    let hash = format!("{HASH:#x}");
    e.ctx
        .store
        .enqueue(&NewJob {
            key: format!("tx:{hash}"),
            kind: JobKind::FetchTx,
            params: json!({"hash": hash}),
            priority: Priority::Interactive,
            user_id: Some(user),
        })
        .await
        .unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    FetchTxHandler.run(&job, &e.ctx).await.unwrap();
    let owners: Vec<(String, Option<i64>)> =
        sqlx::query_as("SELECT kind, user_id FROM jobs WHERE kind <> 'fetch_tx' ORDER BY kind")
            .fetch_all(e.ctx.store.pool())
            .await
            .unwrap();
    assert_eq!(
        owners,
        [
            ("contract_meta".to_string(), Some(user)),
            ("token_meta".to_string(), Some(user)),
        ]
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
async fn second_tx_in_a_stored_block_skips_the_block_call(pool: PgPool) {
    let e = env(pool);
    e.fake
        .add_tx(raw_tx(None), receipt(true, 7, vec![]), vec![], ts());
    e.fake.add_block(header());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    // tx, receipt, block, internal transfers, and TO's code (its call does
    // not decode: TO may have delegated before the tx).
    assert_eq!(e.fake.calls(), 5);

    let other = B256::repeat_byte(0x22);
    let mut tx = raw_tx(None);
    tx.hash = other;
    tx.json["hash"] = json!(format!("{other:#x}"));
    e.fake.add_tx(tx, receipt(true, 7, vec![]), vec![], ts());
    run(&e, &format!("{other:#x}")).await.unwrap();
    // Same block 100: tx, receipt, internal transfers and TO's code only.
    assert_eq!(e.fake.calls(), 5 + 4);
    let row = e.ctx.store.transaction(other).await.unwrap().unwrap();
    assert_eq!(row.ts, header().ts);
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
    let a = enqueue_fetch_block(&e.ctx, None, 100, HASH).await.unwrap();
    let b = enqueue_fetch_block(&e.ctx, None, 100, HASH).await.unwrap();
    assert_eq!(a, b);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn fetch_block_handler_stores_header_and_announces(pool: PgPool) {
    let e = env(pool);
    e.fake.add_block(header());
    let mut rx = e.ctx.bus.subscribe();
    enqueue_fetch_block(&e.ctx, None, 100, HASH).await.unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    assert_eq!(job.kind, JobKind::FetchBlock);
    eg_ingest::handlers::FetchBlockHandler
        .run(&job, &e.ctx)
        .await
        .unwrap();
    assert_eq!(e.ctx.store.block(100).await.unwrap().unwrap(), header());
    assert!(
        matches!(rx.try_recv(), Ok((Audience::Nobody, Event::TxReady { hash })) if hash == HASH)
    );
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
async fn tx_status_retryable_error_propagates(pool: PgPool) {
    tx_status_error_propagates(pool, SourceError::Timeout).await;
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
    enqueue_fetch_block(&e.ctx, None, 100, HASH).await.unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    eg_ingest::handlers::FetchBlockHandler
        .run(&job, &e.ctx)
        .await
        .unwrap();
    let mut announced = Vec::new();
    while let Ok((aud, ev)) = rx.try_recv() {
        assert_eq!(aud, Audience::Nobody);
        if let Event::TxReady { hash } = ev {
            announced.push(hash);
        }
    }
    announced.sort();
    assert_eq!(announced, vec![HASH, other]);
}

async fn meta_params(e: &Env) -> Vec<serde_json::Value> {
    sqlx::query_scalar("SELECT params FROM jobs WHERE kind = 'contract_meta'")
        .fetch_all(e.ctx.store.pool())
        .await
        .unwrap()
}

fn sorted_hex(addrs: &[Address]) -> serde_json::Value {
    let mut v: Vec<String> = addrs.iter().map(|a| format!("{a:#x}")).collect();
    v.sort();
    json!(v)
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn auto_meta_covers_only_tx_from_and_to(pool: PgPool) {
    let e = env(pool);
    let tx = raw_tx(None);
    let (from, to) = (tx.from, tx.to.unwrap());
    // Log emitters and internal-transfer parties are not identified.
    let mut logs = vec![erc20_log()];
    for b in [0x31u8, 0x32, 0x33] {
        let mut l = erc20_log();
        l.address = Address::repeat_byte(b);
        logs.push(l);
    }
    e.fake
        .add_tx(tx, receipt(true, 7, logs), vec![internal()], ts());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let jobs = meta_params(&e).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["addresses"], sorted_hex(&[from, to]));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn auto_meta_for_creation_is_from_and_created_contract(pool: PgPool) {
    let e = env(pool);
    let created = address!("0x1111111111111111111111111111111111111111");
    let mut tx = raw_tx(None);
    tx.to = None;
    let from = tx.from;
    let mut r = receipt(true, 7, vec![erc20_log()]);
    r.contract_address = Some(created);
    e.fake.add_tx(tx, r, vec![], ts());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let jobs = meta_params(&e).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["addresses"], sorted_hex(&[from, created]));
}

fn unsigned_auth(delegate: Address) -> Value {
    json!({"chainId": "0x1", "address": format!("{delegate:#x}"), "nonce": "0x0"})
}

/// An authorization signed by the key `[byte; 32]`.
fn signed_auth(byte: u8, delegate: Address) -> Value {
    let key = k256::ecdsa::SigningKey::from_slice(&[byte; 32]).unwrap();
    let hash = eg_ingest::authorization::authorization_hash(U256::from(1), delegate, U256::ZERO);
    let (sig, recid) = key.sign_prehash_recoverable(hash.as_slice()).unwrap();
    let sig = alloy_primitives::Signature::from_signature_and_parity(sig, recid.is_y_odd());
    json!({"chainId": "0x1", "address": format!("{delegate:#x}"), "nonce": "0x0",
        "yParity": if sig.v() { "0x1" } else { "0x0" },
        "r": format!("{:#x}", sig.r()), "s": format!("{:#x}", sig.s())})
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn auto_meta_adds_up_to_eight_delegates(pool: PgPool) {
    let e = env(pool);
    let mut tx = raw_tx(None);
    let (from, to) = (tx.from, tx.to.unwrap());
    let delegates: Vec<Address> = (1u8..=10).map(|b| Address::repeat_byte(0x40 + b)).collect();
    let mut list: Vec<Value> = delegates
        .iter()
        .zip(1u8..)
        .map(|(d, k)| signed_auth(k, *d))
        .collect();
    // A revocation, a repeated delegate and an entry whose signer does not
    // recover do not use up the cap.
    list.insert(1, signed_auth(20, Address::ZERO));
    list.insert(2, signed_auth(21, delegates[0]));
    list.insert(3, unsigned_auth(Address::repeat_byte(0x99)));
    tx.json["type"] = json!("0x4");
    tx.json["authorizationList"] = json!(list);
    e.fake.add_tx(tx, receipt(true, 7, vec![]), vec![], ts());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let jobs = meta_params(&e).await;
    assert_eq!(jobs.len(), 1);
    let mut want = vec![from, to];
    want.extend(&delegates[..8]);
    assert_eq!(jobs[0]["addresses"], sorted_hex(&want));
}

const SENDER: Address = address!("0xe461dd07cbf41b8020a2e9f50255bf85bf1c4905");
const DELEGATE: Address = address!("0x612373d7003d694220f7800eeaf8e3924c0951d3");

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn unrecovered_delegate_is_no_participant_and_not_identified(pool: PgPool) {
    let e = env(pool);
    let mut tx = raw_tx(None);
    let (from, to) = (tx.from, tx.to.unwrap());
    let stray = Address::repeat_byte(0x99);
    tx.json["type"] = json!("0x4");
    tx.json["authorizationList"] = json!([unsigned_auth(stray)]);
    e.fake.add_tx(tx, receipt(true, 7, vec![]), vec![], ts());
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    let jobs = meta_params(&e).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["addresses"], sorted_hex(&[from, to]));
    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert_eq!(flow.authorizations.len(), 1);
    assert_eq!(flow.authorizations[0].delegate, stray);
    assert_eq!(flow.authorizations[0].authority, None);
    assert!(!flow.participants.contains(&stray));
}

/// The real authorization of mainnet tx 0x4f85…bb8c: SENDER → DELEGATE, nonce 2.
fn real_auth() -> Value {
    json!({"chainId": "0x1", "address": format!("{DELEGATE:#x}"), "nonce": "0x2", "yParity": "0x0",
        "r": "0x6d3ecfb34878c8ad3edebf5c137af1156a68e7340093454d4386ccc7465d0571",
        "s": "0x6d80a00a79df8879470ac42c6e89fba6c951d1aaa9601dfce50499993e391300"})
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_third_party_signer_is_a_participant_with_its_delegate(pool: PgPool) {
    let e = env(pool);
    // A relayer (FROM) submits SENDER's authorization in a call to TO.
    let mut row = stored_tx(HASH, 100);
    row.raw_tx =
        json!({"type": "0x4", "nonce": "0x7", "input": "0x", "authorizationList": [real_auth()]});
    e.ctx.store.upsert_transaction(&row).await.unwrap();
    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert_eq!(flow.participants, vec![FROM, TO, SENDER, DELEGATE]);
    assert_eq!(flow.delegations.len(), 1);
    assert_eq!(
        (flow.delegations[0].authority, flow.delegations[0].delegate),
        (SENDER, DELEGATE)
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn delegate_abi_decodes_the_call_once_stored(pool: PgPool) {
    let e = env(pool);
    let abi = alloy_json_abi::JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
    let sel = abi.functions().next().unwrap().selector();
    let input = format!("0x{}{:064x}", alloy_primitives::hex::encode(sel), 42);
    // Mainnet tx 0x4f85…bb8c: SENDER authorizes DELEGATE and calls itself.
    let mut row = stored_tx(HASH, 100);
    row.from = SENDER;
    row.to = Some(SENDER);
    // Tx nonce 1, authorization nonce 2: the sender's authorization applies.
    row.raw_tx = json!({"type": "0x4", "nonce": "0x1", "input": input,
        "authorizationList": [real_auth()]});
    e.ctx.store.upsert_transaction(&row).await.unwrap();

    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert_eq!(flow.participants, vec![SENDER, DELEGATE]);
    assert_eq!(flow.authorizations[0].authority, Some(SENDER));
    assert!(flow.call.is_none());

    let json = serde_json::to_string(&abi).unwrap();
    e.ctx.store.upsert_abi(DELEGATE, Some(&json)).await.unwrap();
    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert_eq!(flow.call.unwrap().name, "foo");
    assert_eq!(flow.call_via_delegate, Some(DELEGATE));
}

/// A call of `foo(42)` from FROM to TO, with no authorization list.
fn foo_call() -> (RawTx, String) {
    let abi = alloy_json_abi::JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
    let sel = abi.functions().next().unwrap().selector();
    let input = format!("0x{}{:064x}", alloy_primitives::hex::encode(sel), 42);
    let mut tx = raw_tx(None);
    tx.json["type"] = json!("0x2");
    tx.json["input"] = json!(input);
    tx.input = input.parse().unwrap();
    (tx, serde_json::to_string(&abi).unwrap())
}

/// The code of an account delegating to `d` (EIP-7702 designator).
fn designator(d: Address) -> Bytes {
    let mut code = vec![0xef, 0x01, 0x00];
    code.extend_from_slice(d.as_slice());
    Bytes::from(code)
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_fetched_call_that_does_not_decode_uses_the_recipients_current_delegate(pool: PgPool) {
    let e = env(pool);
    let current = Address::repeat_byte(0x7c);
    let (tx, abi) = foo_call();
    e.fake.add_tx(tx, receipt(true, 7, vec![]), vec![], ts());
    e.fake.add_block(header());
    e.fake.set_code(TO, designator(current));
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    // tx, receipt, block, internal transfers, then TO's code.
    assert_eq!(e.fake.calls(), 5);
    assert_eq!(
        e.ctx.store.to_current_delegate(HASH).await.unwrap(),
        Some(Some(current))
    );
    // The current delegate is identified like the tx's own delegates.
    let jobs = meta_params(&e).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["addresses"], sorted_hex(&[FROM, TO, current]));

    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert!(flow.call.is_none());
    assert!(!flow.delegate_lookup_due);
    e.ctx.store.upsert_abi(current, Some(&abi)).await.unwrap();
    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert_eq!(flow.call.unwrap().name, "foo");
    assert_eq!(flow.call_via_delegate, Some(current));
    assert!(flow.call_via_delegate_current);
    assert!(!flow.participants.contains(&current));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_call_that_decodes_with_the_recipients_abi_looks_nothing_up(pool: PgPool) {
    let e = env(pool);
    let (tx, abi) = foo_call();
    e.fake.add_tx(tx, receipt(true, 7, vec![]), vec![], ts());
    e.fake.add_block(header());
    e.ctx.store.upsert_abi(TO, Some(&abi)).await.unwrap();
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    // tx, receipt, block, internal transfers: no code lookup.
    assert_eq!(e.fake.calls(), 4);
    assert_eq!(e.ctx.store.to_current_delegate(HASH).await.unwrap(), None);
}

/// The current-delegate lookup is best-effort in a full fetch: when TO's code
/// lookup fails, the tx is still announced and its parties identified, and
/// nothing is recorded, so the lookup stays due for the lazy path.
async fn a_failed_delegate_lookup_still_completes_the_fetch(pool: PgPool, err: SourceError) {
    let e = env(pool);
    let (tx, _) = foo_call();
    e.fake.add_tx(tx, receipt(true, 7, vec![]), vec![], ts());
    e.fake.add_block(header());
    // tx, receipt, block, internal transfers, then TO's code (the 5th call).
    e.fake.fail_at(5, err);
    let mut rx = e.ctx.bus.subscribe();
    run(&e, &format!("{HASH:#x}")).await.unwrap();
    assert_eq!(e.fake.calls(), 5);
    let mut ready = false;
    while let Ok((_, ev)) = rx.try_recv() {
        ready |= matches!(ev, Event::TxReady { hash } if hash == HASH);
    }
    assert!(ready);
    let jobs = meta_params(&e).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["addresses"], sorted_hex(&[FROM, TO]));
    assert_eq!(e.ctx.store.to_current_delegate(HASH).await.unwrap(), None);
    let flow = load_tx_flow(&e.ctx.store, HASH).await.unwrap().unwrap();
    assert!(flow.delegate_lookup_due);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_retryable_delegate_lookup_error_still_completes_the_fetch(pool: PgPool) {
    a_failed_delegate_lookup_still_completes_the_fetch(pool, SourceError::Timeout).await;
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_exhausted_quota_on_the_delegate_lookup_still_completes_the_fetch(pool: PgPool) {
    a_failed_delegate_lookup_still_completes_the_fetch(pool, SourceError::QuotaExhausted).await;
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_rejected_key_on_the_delegate_lookup_still_completes_the_fetch(pool: PgPool) {
    a_failed_delegate_lookup_still_completes_the_fetch(pool, SourceError::InvalidKey).await;
}
