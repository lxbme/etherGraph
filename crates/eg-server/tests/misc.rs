mod common;

use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, B256, Bytes, U256};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{DateTime, TimeZone, Utc};
use common::{default_user_id, delete, get, post_json, send, test_app, test_app_with};
use eg_core::source::{
    ChainSource, ContractCreation, ContractSource, HistoryPage, HistoryQuery, Priority, RawBlock,
    RawLog, RawReceipt, RawTx, SourceError,
};
use eg_core::testing::FakeSource;
use eg_core::types::{Transfer, TransferKind, TxHash};
use eg_ingest::handlers::FetchTxHandler;
use eg_ingest::{JobHandler, enqueue_fetch_tx};
use eg_server::eth_labels::import_eth_labels;
use eg_server::import_labels::import_labels;
use eg_server::import_tokens::{TokenFormat, import_tokens};
use eg_store::{Store, TxRow};
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

async fn put_json(app: &axum::Router, uri: &str, body: &Value) -> (StatusCode, Value) {
    let req = Request::put(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    send(app, req).await
}

fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap()
}

// ------------------------------------------------------------------ tx

fn seed_fake(fake: &eg_core::testing::FakeSource) {
    let tx = RawTx {
        hash: HASH,
        from: FROM,
        to: Some(TO),
        value: U256::from(5u8),
        input: Bytes::from(vec![0xa9, 0x05, 0x9c, 0xbb, 0x00]),
        block_number: Some(100),
        json: json!({"hash": format!("{HASH:#x}"), "input": "0xa9059cbb00"}),
    };
    let log = RawLog {
        address: TOKEN,
        topics: vec![TRANSFER_TOPIC, FROM.into_word(), TO.into_word()],
        data: Bytes::from(U256::from(100u8).to_be_bytes::<32>().to_vec()),
        log_index: 3,
    };
    let receipt = RawReceipt {
        success: true,
        gas_used: U256::from(21000u32),
        effective_gas_price: U256::from(7u8),
        contract_address: None,
        json: json!({"status": "0x1", "gasUsed": "0x5208", "logs": [{
            "address": format!("{TOKEN:#x}"),
            "topics": [format!("{TRANSFER_TOPIC:#x}"), format!("{:#x}", FROM.into_word()), format!("{:#x}", TO.into_word())],
            "data": format!("{}", log.data), "logIndex": "0x3"}]}),
        logs: vec![log],
    };
    let internal = Transfer {
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
    };
    fake.add_tx(tx, receipt, vec![internal], ts());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_pending_then_ready(pool: PgPool) {
    let (app, state, fake) = test_app(pool).await;
    seed_fake(&fake);
    let uri = format!("/api/tx/{HASH:#x}");

    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["status"], "pending");
    assert!(v["flow"].is_null());
    let job_id = v["job_id"].as_i64().unwrap();
    // A repeat request while the job is queued reports the same job.
    let (_, again) = get(&app, &uri).await;
    assert_eq!(again["job_id"].as_i64(), Some(job_id));
    let me = Some(default_user_id(&state).await);
    assert_eq!(
        enqueue_fetch_tx(&state.ctx, me, HASH).await.unwrap(),
        job_id
    );

    let job = state.store.claim_next().await.unwrap().unwrap();
    assert_eq!(job.id, job_id);
    assert_eq!(job.priority, Priority::Interactive);
    FetchTxHandler.run(&job, &state.ctx).await.unwrap();

    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["status"], "ready");
    assert!(v["job_id"].is_null());
    let f = &v["flow"];
    assert_eq!(f["completeness"], "fund_flow");
    assert_eq!(f["tx"]["hash"], format!("{HASH:#x}"));
    assert_eq!(f["tx"]["block_number"], 100);
    assert_eq!(f["tx"]["value"], "5");
    assert_eq!(f["tx"]["gas_used"], "21000");
    assert_eq!(f["tx"]["fee"], (21000u32 * 7).to_string());
    assert_eq!(f["tx"]["success"], true);
    assert!(f["tx"]["method"].is_null());
    assert_eq!(f["tx"]["selector"], "0xa9059cbb");
    assert!(f["call"].is_null());
    assert_eq!(f["detail"]["authorizations"], json!([]));
    // The fetch stored the block header, so no backfill is queued.
    assert_eq!(f["detail"]["gas_used"], "21000");
    assert!(f["detail"]["revert_reason"].is_null());
    assert_eq!(fetch_block_jobs(&app).await, 0);

    let flows = f["flows"].as_array().unwrap();
    assert_eq!(flows.len(), 3);
    assert_eq!(flows[0]["kind"], "native");
    assert_eq!(flows[0]["symbol"], "ETH");
    assert_eq!(flows[0]["decimals"], 18);
    assert_eq!(flows[0]["trust"]["level"], "listed");
    assert_eq!(flows[1]["kind"], "erc20");
    assert_eq!(flows[1]["trust"]["level"], "unknown");
    assert_eq!(flows[1]["asset"], format!("{TOKEN:#x}"));
    assert_eq!(flows[1]["amount"], "100");
    assert_eq!(flows[1]["log_index"], 3);
    assert!(flows[1]["decimals"].is_null());
    assert_eq!(flows[2]["kind"], "internal");
    assert_eq!(flows[2]["trace_path"], "0_1");

    let nodes: Vec<&str> = f["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["address"].as_str().unwrap())
        .collect();
    // The token contract only emits the log; it is still a node.
    for a in [FROM, TO, OTHER, TOKEN] {
        assert!(nodes.contains(&format!("{a:#x}").as_str()), "{a}");
    }

    // Only the tx's from and to are identified automatically; the log
    // emitter and the internal-transfer party are not.
    let (_, jobs) = get(&app, "/api/jobs").await;
    let meta: Vec<&Value> = jobs
        .as_array()
        .unwrap()
        .iter()
        .filter(|j| j["kind"] == "contract_meta")
        .collect();
    assert_eq!(meta.len(), 1, "{jobs}");
    let mut want = vec![format!("{FROM:#x}"), format!("{TO:#x}")];
    want.sort();
    assert_eq!(meta[0]["params"]["addresses"], json!(want));

    let ev = &f["events"][0];
    assert_eq!(ev["address"], format!("{TOKEN:#x}"));
    assert_eq!(ev["log_index"], 3);
    assert_eq!(ev["topics"][0], format!("{TRANSFER_TOPIC:#x}"));
    let data = ev["data"].as_str().unwrap();
    assert_eq!(data, data.to_lowercase());
    assert!(data.starts_with("0x") && data.len() == 66);
}

/// A tx stored before block headers were kept: no `blocks` row.
fn stored_row() -> TxRow {
    TxRow {
        hash: HASH,
        block_number: 100,
        ts: ts(),
        from: FROM,
        to: Some(TO),
        value: U256::from(5u8),
        selector: None,
        success: false,
        gas_used: U256::from(21000u32),
        fee: U256::from(147000u32),
        raw_tx: json!({"hash": format!("{HASH:#x}"), "nonce": "0x2a", "type": "0x2",
            "gas": "0x7530", "input": "0x", "maxFeePerGas": "0x9", "transactionIndex": "0x4"}),
        raw_receipt: json!({"status": "0x0", "gasUsed": "0x5208", "effectiveGasPrice": "0x7"}),
        revert_reason: Some("out of gas".into()),
    }
}

async fn fetch_block_jobs(app: &axum::Router) -> usize {
    let (st, jobs) = get(app, "/api/jobs").await;
    assert_eq!(st, StatusCode::OK);
    jobs.as_array()
        .unwrap()
        .iter()
        .filter(|j| j["kind"] == "fetch_block")
        .count()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_without_block_header_is_ready_and_backfills_once(pool: PgPool) {
    let (app, state, fake) = test_app(pool).await;
    state.store.upsert_transaction(&stored_row()).await.unwrap();
    fake.set_latest_block(109);
    let uri = format!("/api/tx/{HASH:#x}");

    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["status"], "ready");
    let d = &v["flow"]["detail"];
    assert_eq!(d["nonce"], 42);
    assert_eq!(d["tx_type"], 2);
    assert_eq!(d["position"], 4);
    // The chain head is fetched in the background; the first view has none.
    assert!(d["confirmations"].is_null());
    assert_eq!(d["gas_limit"], "30000");
    assert_eq!(d["gas_used"], "21000");
    assert!(d["base_fee"].is_null());
    assert!(d["burnt_fee"].is_null());
    // (9 − 7) × 21000
    assert_eq!(d["savings"], "42000");
    assert_eq!(d["revert_reason"], "out of gas");
    assert_eq!(fetch_block_jobs(&app).await, 1);

    assert_eq!(confirmations_eventually(&app, &uri).await, 10);
    assert_eq!(fetch_block_jobs(&app).await, 1);
    // The chain head is cached: one `latest_block` call for all requests.
    assert_eq!(fake.calls(), 1);
}

const SENDER: Address = alloy_primitives::address!("0xe461dd07cbf41b8020a2e9f50255bf85bf1c4905");
const DELEGATE: Address = alloy_primitives::address!("0x612373d7003d694220f7800eeaf8e3924c0951d3");

/// Modelled on mainnet tx 0x4f85…bb8c: SENDER authorizes DELEGATE (its real
/// signature) and calls itself with `foo(42)`; a second, unsigned entry
/// delegates OTHER on chain 5 and a third clears a delegation.
fn set_code_row() -> TxRow {
    let sel = &alloy_primitives::keccak256("foo(uint256)")[..4];
    let input = format!("0x{}{:064x}", alloy_primitives::hex::encode(sel), 42);
    let mut row = stored_row();
    row.from = SENDER;
    row.to = Some(SENDER);
    row.success = true;
    row.revert_reason = None;
    row.raw_tx = json!({"hash": format!("{HASH:#x}"), "type": "0x4", "nonce": "0x1", "input": input,
        "authorizationList": [
            {"chainId": "0x1", "address": format!("{DELEGATE:#x}"), "nonce": "0x2", "yParity": "0x0",
             "r": "0x6d3ecfb34878c8ad3edebf5c137af1156a68e7340093454d4386ccc7465d0571",
             "s": "0x6d80a00a79df8879470ac42c6e89fba6c951d1aaa9601dfce50499993e391300"},
            {"chainId": "0x5", "address": format!("{OTHER:#x}"), "nonce": "0x0", "yParity": "0x0",
             "r": "0x1", "s": "0x1"},
            {"chainId": "0x0", "address": format!("{:#x}", Address::ZERO), "nonce": "0x3"}]});
    row
}

const FOO_ABI: &str = r#"[{"type":"function","name":"foo","inputs":[{"name":"x","type":"uint256"}],"outputs":[],"stateMutability":"nonpayable"}]"#;

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn set_code_tx_lists_authorizations_and_decodes_with_the_delegate_abi(pool: PgPool) {
    let (app, state, _fake) = test_app(pool).await;
    state
        .store
        .upsert_transaction(&set_code_row())
        .await
        .unwrap();
    let uri = format!("/api/tx/{HASH:#x}");

    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK);
    let f = &v["flow"];
    assert_eq!(f["detail"]["tx_type"], 4);
    assert_eq!(
        f["detail"]["authorizations"],
        json!([
            {"chain_id": "1", "delegate": format!("{DELEGATE:#x}"), "nonce": "2",
             "authority": format!("{SENDER:#x}")},
            {"chain_id": "5", "delegate": format!("{OTHER:#x}"), "nonce": "0", "authority": null},
            {"chain_id": "0", "delegate": format!("{:#x}", Address::ZERO), "nonce": "3",
             "authority": null},
        ])
    );
    // Tx nonce 1, authorization nonce 2: SENDER's delegation takes effect.
    assert_eq!(
        f["detail"]["delegations"],
        json!([{"authority": format!("{SENDER:#x}"), "delegate": format!("{DELEGATE:#x}")}])
    );
    // The recovered delegate is a node; OTHER (no recovered signer) and the
    // zero address are not.
    let nodes: Vec<&str> = f["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["address"].as_str().unwrap())
        .collect();
    assert_eq!(
        nodes,
        vec![format!("{SENDER:#x}"), format!("{DELEGATE:#x}")]
    );
    // The delegate's ABI is not known yet: the method stays undecoded.
    assert!(f["call"].is_null());
    assert!(f["tx"]["method"].is_null());
    // The recovered delegate is identified automatically, like the tx's own
    // parties; OTHER is not.
    let (_, jobs) = get(&app, "/api/jobs").await;
    let meta: Vec<&Value> = jobs
        .as_array()
        .unwrap()
        .iter()
        .filter(|j| j["kind"] == "contract_meta")
        .collect();
    assert_eq!(meta.len(), 1, "{jobs}");
    let mut want = vec![format!("{SENDER:#x}"), format!("{DELEGATE:#x}")];
    want.sort();
    assert_eq!(meta[0]["params"]["addresses"], json!(want));

    // Once the delegate's ABI arrives the call decodes with it.
    state
        .store
        .upsert_abi(DELEGATE, Some(FOO_ABI))
        .await
        .unwrap();
    let (_, v) = get(&app, &uri).await;
    let f = &v["flow"];
    assert_eq!(f["tx"]["method"], "foo");
    assert_eq!(f["call"]["name"], "foo");
    assert_eq!(f["call"]["via_delegate"], format!("{DELEGATE:#x}"));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_third_party_signer_and_its_delegate_are_nodes(pool: PgPool) {
    let (app, state, _fake) = test_app(pool).await;
    // A relayer sends SENDER's authorization in a call to OTHER.
    let mut row = set_code_row();
    let relayer = Address::repeat_byte(0x5a);
    row.from = relayer;
    row.to = Some(OTHER);
    row.raw_tx["nonce"] = json!("0x9");
    state.store.upsert_transaction(&row).await.unwrap();
    let (st, v) = get(&app, &format!("/api/tx/{HASH:#x}")).await;
    assert_eq!(st, StatusCode::OK);
    let f = &v["flow"];
    let nodes: Vec<&str> = f["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["address"].as_str().unwrap())
        .collect();
    assert_eq!(
        nodes,
        vec![
            format!("{relayer:#x}"),
            format!("{OTHER:#x}"),
            format!("{SENDER:#x}"),
            format!("{DELEGATE:#x}")
        ]
    );
    assert_eq!(
        f["detail"]["delegations"],
        json!([{"authority": format!("{SENDER:#x}"), "delegate": format!("{DELEGATE:#x}")}])
    );
}

/// Repeats `GET uri` until `detail.confirmations` is set.
async fn confirmations_eventually(app: &axum::Router, uri: &str) -> u64 {
    for _ in 0..200 {
        let (st, v) = get(app, uri).await;
        assert_eq!(st, StatusCode::OK);
        if let Some(c) = v["flow"]["detail"]["confirmations"].as_u64() {
            return c;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("confirmations never became available");
}

/// A `FakeSource` whose `latest_block` waits until `release` is notified.
struct HeldHead {
    fake: Arc<FakeSource>,
    release: Arc<Notify>,
}

#[async_trait]
impl ChainSource for HeldHead {
    async fn history_page(
        &self,
        p: Priority,
        q: &HistoryQuery,
    ) -> Result<HistoryPage, SourceError> {
        self.fake.history_page(p, q).await
    }
    async fn tx(&self, p: Priority, h: TxHash) -> Result<Option<RawTx>, SourceError> {
        self.fake.tx(p, h).await
    }
    async fn receipt(&self, p: Priority, h: TxHash) -> Result<Option<RawReceipt>, SourceError> {
        self.fake.receipt(p, h).await
    }
    async fn internal_txs(&self, p: Priority, h: TxHash) -> Result<Vec<Transfer>, SourceError> {
        self.fake.internal_txs(p, h).await
    }
    async fn block(&self, p: Priority, n: u64) -> Result<RawBlock, SourceError> {
        self.fake.block(p, n).await
    }
    async fn tx_status(&self, p: Priority, h: TxHash) -> Result<Option<String>, SourceError> {
        self.fake.tx_status(p, h).await
    }
    async fn latest_block(&self, p: Priority) -> Result<u64, SourceError> {
        self.release.notified().await;
        self.fake.latest_block(p).await
    }
    async fn contract_source(
        &self,
        p: Priority,
        a: Address,
    ) -> Result<ContractSource, SourceError> {
        self.fake.contract_source(p, a).await
    }
    async fn contract_creation(
        &self,
        p: Priority,
        a: &[Address],
    ) -> Result<Vec<ContractCreation>, SourceError> {
        self.fake.contract_creation(p, a).await
    }
    async fn eth_call(&self, p: Priority, to: Address, d: Bytes) -> Result<Bytes, SourceError> {
        self.fake.eth_call(p, to, d).await
    }
    async fn tx_count(&self, p: Priority, a: Address) -> Result<u64, SourceError> {
        self.fake.tx_count(p, a).await
    }
    async fn code(&self, p: Priority, a: Address) -> Result<Bytes, SourceError> {
        self.fake.code(p, a).await
    }
    async fn balances(
        &self,
        p: Priority,
        a: &[Address],
    ) -> Result<Vec<(Address, U256)>, SourceError> {
        self.fake.balances(p, a).await
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_view_never_waits_for_the_chain_head(pool: PgPool) {
    let fake = Arc::new(FakeSource::new());
    fake.set_latest_block(109);
    let release = Arc::new(Notify::new());
    let source = Arc::new(HeldHead {
        fake: fake.clone(),
        release: release.clone(),
    });
    let (app, state) = test_app_with(pool, source).await;
    state.store.upsert_transaction(&stored_row()).await.unwrap();
    let uri = format!("/api/tx/{HASH:#x}");

    // `latest_block` is stuck, yet both views answer at once without a head.
    for _ in 0..2 {
        let (st, v) = tokio::time::timeout(Duration::from_secs(5), get(&app, &uri))
            .await
            .expect("tx view waited for latest_block");
        assert_eq!(st, StatusCode::OK);
        assert!(v["flow"]["detail"]["confirmations"].is_null());
    }
    release.notify_one();
    assert_eq!(confirmations_eventually(&app, &uri).await, 10);
    // Concurrent stale views share one refresh.
    assert_eq!(fake.calls(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_raw_returns_stored_json(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let row = stored_row();
    state.store.upsert_transaction(&row).await.unwrap();
    let (st, v) = get(&app, &format!("/api/tx/{HASH:#x}/raw")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v, json!({"tx": row.raw_tx, "receipt": row.raw_receipt}));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_raw_unknown_hash_is_404(pool: PgPool) {
    let (app, _, fake) = test_app(pool).await;
    let (st, v) = get(&app, &format!("/api/tx/{:#x}/raw", B256::repeat_byte(0x77))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(code(&v), "not_found");
    assert_eq!(fake.calls(), 0);
    let (st, v) = get(&app, "/api/tx/0x12/raw").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(code(&v), "invalid_input");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_bad_hash_is_invalid_input(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let (st, v) = get(&app, "/api/tx/0x12").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(code(&v), "invalid_input");
}

// ------------------------------------------------------------------ labels

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn label_crud_and_category_validation(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let addr = format!("{FROM:#x}");

    let (st, v) = get(&app, &format!("/api/labels?addr={addr}")).await;
    assert_eq!((st, v), (StatusCode::OK, json!([])));
    let (st, v) = get(&app, "/api/labels").await;
    assert_eq!((st, code(&v)), (StatusCode::BAD_REQUEST, "invalid_input"));
    let (st, v) = get(&app, "/api/labels?addr=nope").await;
    assert_eq!((st, code(&v)), (StatusCode::BAD_REQUEST, "invalid_input"));

    let body =
        |text: &str, category: &str| json!({"address": addr, "text": text, "category": category});
    let (st, v) = post_json(&app, "/api/labels", &body("foo", "foo")).await;
    assert_eq!((st, code(&v)), (StatusCode::BAD_REQUEST, "invalid_input"));
    for text in ["", "   ", &"x".repeat(65)] {
        let (st, v) = post_json(&app, "/api/labels", &body(text, "scam")).await;
        assert_eq!(
            (st, code(&v)),
            (StatusCode::BAD_REQUEST, "invalid_input"),
            "{text:?}"
        );
    }
    let (st, v) = post_json(
        &app,
        "/api/labels",
        &json!({"address": "0x12", "text": "t", "category": "scam"}),
    )
    .await;
    assert_eq!((st, code(&v)), (StatusCode::BAD_REQUEST, "invalid_input"));

    // 64 characters, multi-byte: counts chars, not bytes.
    let wide = "é".repeat(64);
    let (st, v) = post_json(&app, "/api/labels", &body(&wide, "other")).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (st, v) = post_json(&app, "/api/labels", &body("  Hot wallet  ", "cex")).await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(v["text"], "Hot wallet");
    assert_eq!(v["category"], "cex");
    assert_eq!(v["source"], "user");
    let id = v["id"].as_i64().unwrap();

    let (_, v) = get(&app, &format!("/api/labels?addr={addr}")).await;
    assert_eq!(v.as_array().unwrap().len(), 2);

    let (st, _) = delete(&app, &format!("/api/labels/{id}")).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, v) = delete(&app, &format!("/api/labels/{id}")).await;
    assert_eq!((st, code(&v)), (StatusCode::NOT_FOUND, "not_found"));
    let (st, v) = delete(&app, "/api/labels/abc").await;
    assert_eq!((st, code(&v)), (StatusCode::BAD_REQUEST, "invalid_input"));

    // Imported labels cannot be deleted through the API.
    state
        .store
        .replace_import("d", &[(TO, "Imp".into(), "defi".into())])
        .await
        .unwrap();
    let me = default_user_id(&state).await;
    let imp = state.store.labels(&[TO], me).await.unwrap()[0].id;
    let (st, v) = delete(&app, &format!("/api/labels/{imp}")).await;
    assert_eq!((st, code(&v)), (StatusCode::NOT_FOUND, "not_found"));
}

// ------------------------------------------------------------------ workspaces

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn workspace_conflict_409(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let (st, w) = post_json(
        &app,
        "/api/workspaces",
        &json!({"name": "  main  ", "state": {"nodes": []}}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{w}");
    assert_eq!(w["name"], "main");
    assert_eq!(w["schema_version"], 1);
    let id = w["id"].as_i64().unwrap();
    let uri = format!("/api/workspaces/{id}");
    let t0 = w["updated_at"].as_str().unwrap().to_owned();

    let put =
        |name: &str, t: &str| json!({"name": name, "state": {"v": 2}, "expected_updated_at": t});
    let (st, w2) = put_json(&app, &uri, &put("renamed", &t0)).await;
    assert_eq!(st, StatusCode::OK, "{w2}");
    assert_eq!(w2["name"], "renamed");
    assert_ne!(w2["updated_at"], w["updated_at"]);

    // The stale token now conflicts.
    let (st, v) = put_json(&app, &uri, &put("again", &t0)).await;
    assert_eq!((st, code(&v)), (StatusCode::CONFLICT, "conflict"));
    let (_, cur) = get(&app, &uri).await;
    assert_eq!(cur["name"], "renamed");

    let (st, v) = put_json(&app, "/api/workspaces/9999", &put("x", &t0)).await;
    assert_eq!((st, code(&v)), (StatusCode::NOT_FOUND, "not_found"));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn workspace_accepts_a_state_over_the_32_mib_import_cap(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    // A maximal imported file wrapped in the rest of the workspace must still save.
    let big = "x".repeat(33 * 1024 * 1024);
    let (st, w) = post_json(
        &app,
        "/api/workspaces",
        &json!({"name": "big", "state": {"blob": big}}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{w}");
    let uri = format!("/api/workspaces/{}", w["id"]);
    let (st, v) = put_json(
        &app,
        &uri,
        &json!({"name": "big", "state": {"blob": big}, "expected_updated_at": w["updated_at"]}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn workspace_get_then_put_with_returned_updated_at(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let (_, w) = post_json(&app, "/api/workspaces", &json!({"name": "a", "state": {}})).await;
    let uri = format!("/api/workspaces/{}", w["id"]);
    // Two rounds: each GET's updated_at must be accepted verbatim.
    for round in 0..2 {
        let (st, got) = get(&app, &uri).await;
        assert_eq!(st, StatusCode::OK);
        let (st, v) = put_json(
            &app,
            &uri,
            &json!({"name": format!("n{round}"), "state": {"r": round},
                "expected_updated_at": got["updated_at"]}),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "round {round}: {v}");
        assert_eq!(v["state"], json!({"r": round}));
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn workspace_validation_list_delete(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    for body in [
        json!({"name": "", "state": {}}),
        json!({"name": "   ", "state": {}}),
        json!({"name": "x".repeat(101), "state": {}}),
        json!({"name": "ok", "state": []}),
        json!({"name": "ok", "state": "s"}),
        json!({"name": "ok"}),
    ] {
        let (st, v) = post_json(&app, "/api/workspaces", &body).await;
        assert_eq!(
            (st, code(&v)),
            (StatusCode::BAD_REQUEST, "invalid_input"),
            "{body}"
        );
    }
    let (st, _) = post_json(
        &app,
        "/api/workspaces",
        &json!({"name": "é".repeat(100), "state": {}}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    let (_, a) = post_json(
        &app,
        "/api/workspaces",
        &json!({"name": "a", "state": {"k": 1}}),
    )
    .await;
    let uri = format!("/api/workspaces/{}", a["id"]);
    let ok_t = a["updated_at"].clone();
    for body in [
        json!({"name": "a", "state": {}, "expected_updated_at": "yesterday"}),
        json!({"name": "a", "state": {}}),
        json!({"name": "a", "state": 5, "expected_updated_at": ok_t}),
        json!({"name": "", "state": {}, "expected_updated_at": ok_t}),
    ] {
        let (st, v) = put_json(&app, &uri, &body).await;
        assert_eq!(
            (st, code(&v)),
            (StatusCode::BAD_REQUEST, "invalid_input"),
            "{body}"
        );
    }

    let (st, list) = get(&app, "/api/workspaces").await;
    assert_eq!(st, StatusCode::OK);
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["name"], "a");
    assert!(list[0].get("state").is_none());

    let (st, _) = delete(&app, &uri).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, v) = get(&app, &uri).await;
    assert_eq!((st, code(&v)), (StatusCode::NOT_FOUND, "not_found"));
    let (st, v) = delete(&app, &uri).await;
    assert_eq!((st, code(&v)), (StatusCode::NOT_FOUND, "not_found"));
}

// ------------------------------------------------------------------ import-labels

const SAMPLE: &str = include_str!("data/labels_sample.csv");

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn import_labels_counts_and_is_idempotent(pool: PgPool) {
    let store = Store::from_pool(pool);
    let total = |store: Store| async move {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM labels WHERE source = 'import:sample'")
            .fetch_one(store.pool())
            .await
            .unwrap()
    };
    assert_eq!(
        import_labels(&store, "sample", SAMPLE.as_bytes())
            .await
            .unwrap(),
        (3, 1)
    );
    assert_eq!(total(store.clone()).await, 3);
    assert_eq!(
        import_labels(&store, "sample", SAMPLE.as_bytes())
            .await
            .unwrap(),
        (3, 1)
    );
    assert_eq!(total(store.clone()).await, 3);

    // "Mixer" is matched case-insensitively; an unknown category becomes other.
    let csv = "address,text,category\n0x28c6c06298d514db089934071355e5743bf21d60,A,Mixer\n\
               0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be,B,whatever\n";
    assert_eq!(
        import_labels(&store, "cat", csv.as_bytes()).await.unwrap(),
        (2, 0)
    );
    let rows = store
        .labels(
            &[
                "0x28c6c06298d514db089934071355e5743bf21d60"
                    .parse()
                    .unwrap(),
                "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be"
                    .parse()
                    .unwrap(),
            ],
            0,
        )
        .await
        .unwrap();
    let cats: Vec<_> = rows
        .iter()
        .filter(|l| l.source == "import:cat")
        .map(|l| (l.text.as_str(), l.category.as_str()))
        .collect();
    assert_eq!(cats, [("A", "mixer"), ("B", "other")]);

    // The pre-v3 "exchange" category is aliased to cex.
    let csv = "address,text,category\n0x28c6c06298d514db089934071355e5743bf21d60,E,Exchange\n";
    import_labels(&store, "old", csv.as_bytes()).await.unwrap();
    let cat: String = sqlx::query_scalar("SELECT category FROM labels WHERE source = 'import:old'")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(cat, "cex");

    // Wrong header is an error, and leaves the dataset untouched.
    assert!(
        import_labels(&store, "sample", "a,b,c\n".as_bytes())
            .await
            .is_err()
    );
    assert_eq!(total(store).await, 3);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn import_eth_labels_writes_two_datasets_and_replaces(pool: PgPool) {
    let store = Store::from_pool(pool);
    let a = "0x00000000000000000000000000000000000000a1";
    let b = "0x00000000000000000000000000000000000000b2";
    let c = "0x00000000000000000000000000000000000000c3";
    let csv = format!(
        "address,chainId,label,nameTag\n\
         {a},1,okx,OKX 1\n\
         {a},8453,okx,OKX 1\n\
         {b},480,okx,OKX: Hot Wallet 3\n\
         {b},43114,okx,OKX: Hot Wallet 3\n\
         {c},1,hot-wallet,\n\
         nonsense,1,okx,bad\n"
    );
    assert_eq!(
        import_eth_labels(&store, csv.as_bytes()).await.unwrap(),
        (2, 1, 1)
    );
    // Re-importing replaces rather than duplicates.
    assert_eq!(
        import_eth_labels(&store, csv.as_bytes()).await.unwrap(),
        (2, 1, 1)
    );
    let rows = store
        // Imports are visible to every viewer; no user is needed.
        .labels(
            &[a.parse().unwrap(), b.parse().unwrap(), c.parse().unwrap()],
            0,
        )
        .await
        .unwrap();
    let got: Vec<_> = rows
        .iter()
        .map(|l| (l.source.as_str(), l.text.as_str(), l.category.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            ("import:eth-labels", "OKX 1", "cex"),
            ("import:eth-labels-xchain", "OKX: Hot Wallet 3", "cex"),
            ("import:eth-labels", "Hot Wallet", "cex"),
        ]
    );
}

// ------------------------------------------------------------------ probe

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn probe_caches_and_feeds_node_summaries(pool: PgPool) {
    let (app, _state, fake) = test_app(pool).await;
    fake.set_code(TOKEN, Bytes::from(vec![0x60, 0x80]));
    fake.set_nonce(FROM, 7);
    fake.set_balance(FROM, U256::from(10u8).pow(U256::from(18u8)));
    let body = json!({"addresses": [format!("{TOKEN:#x}"), format!("{FROM:#x}")]});

    let (st, first) = post_json(&app, "/api/probe", &body).await;
    assert_eq!(st, StatusCode::OK, "{first}");
    // code x2, tx_count x1, balances x1
    assert_eq!(first["calls"], 4);
    assert_eq!(fake.calls(), 4);
    let items = first["items"].as_array().unwrap();
    assert_eq!(items[0]["kind"], "contract");
    assert!(items[0]["nonce"].is_null());
    assert_eq!(items[1]["kind"], "eoa");
    assert_eq!(items[1]["nonce"], 7);
    assert_eq!(items[1]["balance"], "1000000000000000000");
    assert_eq!(items[1]["local_transfers"], 0);
    assert_eq!(items[1]["synced"], false);

    let (_, second) = post_json(&app, "/api/probe", &body).await;
    assert_eq!(second["calls"], 0);
    assert_eq!(fake.calls(), 4);
    assert_eq!(second["items"], first["items"]);

    let (st, g) = post_json(
        &app,
        "/api/graph/edges",
        &json!({"addresses": [format!("{FROM:#x}"), format!("{TOKEN:#x}")]}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{g}");
    let n = &g["nodes"][0];
    assert_eq!(n["nonce"], 7);
    assert_eq!(n["balance"], "1000000000000000000");
    assert_eq!(n["kind"], "eoa");
    assert_eq!(g["nodes"][1]["kind"], "contract");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn probe_rejects_more_than_20_addresses(pool: PgPool) {
    let (app, _state, _fake) = test_app(pool).await;
    let addrs: Vec<String> = (1..=21u8)
        .map(|i| format!("{:#x}", Address::repeat_byte(i)))
        .collect();
    let (st, b) = post_json(&app, "/api/probe", &json!({"addresses": addrs})).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(code(&b), "invalid_input");
    let (st, b) = post_json(&app, "/api/probe", &json!({"addresses": []})).await;
    assert_eq!((st, code(&b)), (StatusCode::BAD_REQUEST, "invalid_input"));
}

fn account_row(addr: Address, kind: eg_core::types::AccountKind) -> eg_store::AccountRow {
    eg_store::AccountRow {
        address: addr,
        kind,
        contract_name: Some("Named".into()),
        is_proxy: true,
        implementation: None,
        creator: None,
        creation_tx: None,
        meta_fetched_at: ts(),
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn probe_known_contract_skips_tx_count_and_keeps_metadata(pool: PgPool) {
    use eg_core::types::AccountKind;
    let (app, state, fake) = test_app(pool).await;
    state
        .store
        .upsert_accounts(&[
            account_row(TOKEN, AccountKind::Contract),
            account_row(OTHER, AccountKind::Unknown),
        ])
        .await
        .unwrap();
    fake.set_code(OTHER, Bytes::from(vec![0x60]));
    let (st, b) = post_json(
        &app,
        "/api/probe",
        &json!({"addresses": [format!("{TOKEN:#x}")]}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{b}");
    // Known contract: no code, no tx_count; one balances call.
    assert_eq!(b["calls"], 1);
    assert!(b["items"][0]["nonce"].is_null());
    assert_eq!(b["items"][0]["kind"], "contract");

    let (_, b) = post_json(
        &app,
        "/api/probe",
        &json!({"addresses": [format!("{OTHER:#x}")]}),
    )
    .await;
    assert_eq!(b["items"][0]["kind"], "contract");
    let rows = state.store.accounts(&[TOKEN, OTHER]).await.unwrap();
    for r in rows {
        assert_eq!(r.contract_name.as_deref(), Some("Named"));
        assert!(r.is_proxy);
        assert_eq!(r.meta_fetched_at, ts());
        assert_eq!(r.kind, AccountKind::Contract);
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn probe_upstream_failure_writes_nothing(pool: PgPool) {
    let (app, state, fake) = test_app(pool).await;
    fake.fail_next(SourceError::QuotaExhausted);
    let body = json!({"addresses": [format!("{FROM:#x}"), format!("{TO:#x}")]});
    let (st, _) = post_json(&app, "/api/probe", &body).await;
    assert_ne!(st, StatusCode::OK);
    assert!(
        state
            .store
            .account_stats(&[FROM, TO])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(state.store.accounts(&[FROM, TO]).await.unwrap().is_empty());
    let (st, b) = post_json(&app, "/api/probe", &body).await;
    assert_eq!(st, StatusCode::OK, "{b}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn probe_failure_keeps_what_was_already_fetched(pool: PgPool) {
    use eg_core::types::AccountKind;
    let (app, state, fake) = test_app(pool).await;
    fake.set_nonce(FROM, 7);
    fake.set_nonce(TO, 3);
    // code(FROM), tx_count(FROM), code(TO), then tx_count(TO) fails.
    fake.fail_at(4, SourceError::QuotaExhausted);
    let body = json!({"addresses": [format!("{FROM:#x}"), format!("{TO:#x}")]});
    let (st, _) = post_json(&app, "/api/probe", &body).await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(fake.calls(), 4);
    let stats = state.store.account_stats(&[FROM, TO]).await.unwrap();
    assert_eq!(stats.len(), 1);
    assert_eq!(stats[0].address, FROM);
    assert_eq!(stats[0].nonce, Some(7));
    assert_eq!(stats[0].balance, None);
    let kinds: Vec<_> = state
        .store
        .accounts(&[FROM, TO])
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.kind)
        .collect();
    assert_eq!(kinds, [AccountKind::Eoa, AccountKind::Eoa]);

    // The retry only spends what is missing: TO's nonce and the balances.
    let (st, b) = post_json(&app, "/api/probe", &body).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b["calls"], 2);
    assert_eq!(b["items"][0]["nonce"], 7);
    assert_eq!(b["items"][0]["balance"], "0");
    assert_eq!(b["items"][1]["nonce"], 3);
}

// ------------------------------------------------------------------ batches

async fn active_job(app: &axum::Router, id: i64) -> Option<Value> {
    let (st, jobs) = get(app, "/api/jobs").await;
    assert_eq!(st, StatusCode::OK, "{jobs}");
    jobs.as_array()
        .unwrap()
        .iter()
        .find(|j| j["id"] == id)
        .cloned()
}

async fn sync_job(app: &axum::Router, body: Value) -> i64 {
    let (st, b) = post_json(app, "/api/sync", &body).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    b["jobs"][0].as_i64().unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn batches_own_jobs_until_the_last_one_is_cancelled(pool: PgPool) {
    use eg_ingest::{Audience, Event};
    use eg_store::JobStatus;
    let (app, state, _) = test_app(pool).await;
    let from = format!("{FROM:#x}");
    let id = sync_job(&app, json!({"addresses": [from], "batch": "b1"})).await;
    let job = active_job(&app, id).await.unwrap();
    assert_eq!(job["batches"], json!(["b1"]));
    // Shallow by default: up to five pages per kind.
    assert_eq!(job["params"]["cap"], 5000);

    let again = sync_job(&app, json!({"addresses": [from], "batch": "b2"})).await;
    assert_eq!(again, id);
    let job = active_job(&app, id).await.unwrap();
    assert_eq!(job["batches"], json!(["b1", "b2"]));
    let (st, status) = get(&app, "/api/status").await;
    assert_eq!(st, StatusCode::OK, "{status}");
    // eth_blockNumber + five pages for each of the five kinds.
    assert_eq!(status["queued_calls"], 26);

    let mut rx = state.ctx.bus.subscribe();
    let (st, b) = delete(&app, "/api/batches/b1").await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b, json!({"cancelled": []}));
    let job = active_job(&app, id).await.unwrap();
    assert_eq!(job["batches"], json!(["b2"]));
    assert!(rx.try_recv().is_err());

    let (st, b) = delete(&app, "/api/batches/b2").await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b, json!({"cancelled": [id]}));
    assert!(active_job(&app, id).await.is_none());
    assert_eq!(
        state.store.job(id).await.unwrap().unwrap().status,
        JobStatus::Cancelled
    );
    match rx.try_recv().unwrap() {
        (Audience::User(u), Event::JobProgress { job_id, status, .. }) => {
            assert_eq!(u, default_user_id(&state).await);
            assert_eq!(job_id, id);
            assert_eq!(status, JobStatus::Cancelled);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn manual_sync_keeps_a_job_alive_after_its_batches_go(pool: PgPool) {
    let (app, _state, _) = test_app(pool).await;
    let to = format!("{TO:#x}");
    let id = sync_job(&app, json!({"addresses": [to], "batch": "b3"})).await;
    assert_eq!(sync_job(&app, json!({"addresses": [to]})).await, id);
    let (st, b) = delete(&app, "/api/batches/b3").await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b, json!({"cancelled": []}));
    let job = active_job(&app, id).await.unwrap();
    assert_eq!(job["batches"], json!([]));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_background_scope_spares_interactive_jobs(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (interactive, _) = state
        .store
        .enqueue(&eg_store::NewJob {
            key: "tx:x".into(),
            kind: eg_store::JobKind::FetchTx,
            params: json!({"hash": format!("{HASH:#x}")}),
            priority: Priority::Interactive,
            user_id: Some(default_user_id(&state).await),
        })
        .await
        .unwrap();
    let bg = sync_job(&app, json!({"addresses": [format!("{FROM:#x}")]})).await;
    let (st, b) = delete(&app, "/api/jobs?scope=background").await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b, json!({"cancelled": [bg]}));
    assert!(active_job(&app, bg).await.is_none());
    assert!(active_job(&app, interactive).await.is_some());
    for uri in ["/api/jobs", "/api/jobs?scope=all"] {
        let (st, b) = delete(&app, uri).await;
        assert_eq!((st, code(&b)), (StatusCode::BAD_REQUEST, "invalid_input"));
    }
    assert!(active_job(&app, interactive).await.is_some());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_depth_and_batch_validation(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let a = |b: u8| format!("{:#x}", Address::repeat_byte(b));
    let full = sync_job(&app, json!({"addresses": [a(1)], "depth": "full"})).await;
    let older = sync_job(
        &app,
        json!({"addresses": [a(2)], "direction": "older", "depth": "shallow"}),
    )
    .await;
    for id in [full, older] {
        let job = state.store.job(id).await.unwrap().unwrap();
        assert!(job.params["cap"].is_null(), "{}", job.params);
    }
    let long = "x".repeat(65);
    for body in [
        json!({"addresses": [a(3)], "batch": "a b"}),
        json!({"addresses": [a(3)], "batch": ""}),
        json!({"addresses": [a(3)], "batch": long}),
        json!({"addresses": [a(3)], "depth": "deep"}),
    ] {
        let (st, b) = post_json(&app, "/api/sync", &body).await;
        assert_eq!(
            (st, code(&b)),
            (StatusCode::BAD_REQUEST, "invalid_input"),
            "{body}"
        );
    }
    let ok = "A-z0-9".repeat(10) + "abcd";
    assert_eq!(ok.len(), 64);
    sync_job(&app, json!({"addresses": [a(3)], "batch": ok})).await;
    let (st, b) = delete(&app, "/api/batches/a%20b").await;
    assert_eq!((st, code(&b)), (StatusCode::BAD_REQUEST, "invalid_input"));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancelling_a_running_job_lists_it_but_leaves_the_event_to_the_runner(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let a = |b: u8| format!("{:#x}", Address::repeat_byte(b));
    let by_batch = sync_job(&app, json!({"addresses": [a(1)], "batch": "b1"})).await;
    assert_eq!(
        state.store.claim_next().await.unwrap().unwrap().id,
        by_batch
    );
    let mut rx = state.ctx.bus.subscribe();
    let (st, b) = delete(&app, "/api/batches/b1").await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b, json!({"cancelled": [by_batch]}));
    assert!(state.store.cancel_requested(by_batch).await.unwrap());

    let background = sync_job(&app, json!({"addresses": [a(2)]})).await;
    assert_eq!(
        state.store.claim_next().await.unwrap().unwrap().id,
        background
    );
    let (st, b) = delete(&app, "/api/jobs?scope=background").await;
    assert_eq!(st, StatusCode::OK, "{b}");
    // The first job is still running (flagged), so it is listed again.
    assert_eq!(b, json!({"cancelled": [by_batch, background]}));
    assert!(state.store.cancel_requested(background).await.unwrap());
    assert!(rx.try_recv().is_err(), "no JobProgress for running jobs");
}

// ------------------------------------------------------------------ identify

fn fresh_account(addr: Address) -> eg_store::AccountRow {
    let mut r = account_row(addr, eg_core::types::AccountKind::Eoa);
    r.meta_fetched_at = Utc::now();
    r
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn identify_rejects_bad_sizes_and_batches(pool: PgPool) {
    let (app, _state, _) = test_app(pool).await;
    let (st, b) = post_json(&app, "/api/identify", &json!({"addresses": []})).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{b}");
    assert_eq!(code(&b), "invalid_input");
    let many: Vec<String> = (0..501u32)
        .map(|i| format!("{:#x}", Address::from_word(B256::from(U256::from(i + 1)))))
        .collect();
    let (st, b) = post_json(&app, "/api/identify", &json!({"addresses": many})).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{b}");
    assert_eq!(code(&b), "invalid_input");
    let body = json!({"addresses": [format!("{FROM:#x}")], "batch": "bad batch!"});
    let (st, b) = post_json(&app, "/api/identify", &body).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{b}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn identify_queues_only_addresses_needing_meta(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    state
        .store
        .upsert_accounts(&[fresh_account(OTHER)])
        .await
        .unwrap();
    let body = json!({
        "addresses": [format!("{FROM:#x}"), format!("{OTHER:#x}"), format!("{TO:#x}")],
        "batch": "idf-1",
    });
    let (st, b) = post_json(&app, "/api/identify", &body).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b["queued"], 2);
    let jobs = b["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 1);
    let id = jobs[0].as_i64().unwrap();
    let job = state.store.job(id).await.unwrap().unwrap();
    assert_eq!(job.priority, Priority::Interactive);
    let mut want = vec![format!("{FROM:#x}"), format!("{TO:#x}")];
    want.sort();
    assert_eq!(job.params["addresses"], json!(want));
    let listed = active_job(&app, id).await.unwrap();
    assert_eq!(listed["batches"], json!(["idf-1"]));

    let (st, b) = delete(&app, "/api/batches/idf-1").await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b, json!({"cancelled": [id]}));
    assert!(active_job(&app, id).await.is_none());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn identify_with_nothing_to_do_queues_nothing(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    state
        .store
        .upsert_accounts(&[fresh_account(OTHER)])
        .await
        .unwrap();
    let body = json!({"addresses": [format!("{OTHER:#x}")]});
    let (st, b) = post_json(&app, "/api/identify", &body).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(b, json!({"queued": 0, "jobs": []}));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn node_identified_follows_real_metadata(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let identified = |g: &Value| g["nodes"][0]["identified"].clone();
    let req = json!({"addresses": [format!("{TOKEN:#x}")]});
    let (_, g) = post_json(&app, "/api/graph/edges", &req).await;
    assert_eq!(identified(&g), false);
    state
        .store
        .set_kind_if_unknown(&[(TOKEN, eg_core::types::AccountKind::Contract)])
        .await
        .unwrap();
    let (_, g) = post_json(&app, "/api/graph/edges", &req).await;
    assert_eq!(g["nodes"][0]["kind"], "contract");
    assert_eq!(identified(&g), false);
    let mut row = account_row(TOKEN, eg_core::types::AccountKind::Contract);
    row.meta_fetched_at = Utc::now();
    state.store.upsert_accounts(&[row]).await.unwrap();
    let (_, g) = post_json(&app, "/api/graph/edges", &req).await;
    assert_eq!(identified(&g), true);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn import_tokens_replaces_only_its_source(pool: PgPool) {
    let store = Store::from_pool(pool);
    let a = "0x00000000000000000000000000000000000000a1";
    let list = format!(
        r#"{{"tokens":[{{"chainId":1,"address":"{a}"}},{{"chainId":56,"address":"{a}"}}]}}"#
    );
    let csv = format!(
        "address,chainId,label,name,symbol,website,image\n{a},1,stablecoin,N,S,https://a.io,x\n"
    );
    assert_eq!(
        import_tokens(&store, TokenFormat::EthLabels, csv.as_bytes())
            .await
            .unwrap(),
        (1, 0)
    );
    for _ in 0..2 {
        assert_eq!(
            import_tokens(&store, TokenFormat::Uniswap, list.as_bytes())
                .await
                .unwrap(),
            (1, 1)
        );
    }
    let rows = store.token_tags(&[a.parse().unwrap()]).await.unwrap();
    let got: Vec<_> = rows
        .iter()
        .map(|r| (r.source.as_str(), r.tag.as_str()))
        .collect();
    assert_eq!(
        got,
        [("eth-labels", "stablecoin"), ("uniswap", "default-list")]
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn import_tokens_refuses_an_empty_parse_and_keeps_the_source(pool: PgPool) {
    let store = Store::from_pool(pool);
    let a = "0x00000000000000000000000000000000000000a1";
    let list = format!(r#"{{"tokens":[{{"chainId":1,"address":"{a}"}}]}}"#);
    import_tokens(&store, TokenFormat::Uniswap, list.as_bytes())
        .await
        .unwrap();
    // Only another chain: zero rows parse, the existing tags must survive.
    let other = format!(r#"{{"tokens":[{{"chainId":10,"address":"{a}"}}]}}"#);
    let err = import_tokens(&store, TokenFormat::Uniswap, other.as_bytes())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("uniswap"), "{err}");
    assert!(
        import_tokens(&store, TokenFormat::Uniswap, r#"{"tokens":[]}"#.as_bytes())
            .await
            .is_err()
    );
    let rows = store.token_tags(&[a.parse().unwrap()]).await.unwrap();
    assert_eq!(rows.len(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn workspace_stores_the_schema_version_it_is_given(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    // Absent: version 1 (clients that predate the field).
    let (st, w) = post_json(&app, "/api/workspaces", &json!({"name": "a", "state": {}})).await;
    assert_eq!(st, StatusCode::CREATED, "{w}");
    assert_eq!(w["schema_version"], 1);

    let (st, w) = post_json(
        &app,
        "/api/workspaces",
        &json!({"name": "b", "schema_version": 2, "state": {}}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{w}");
    assert_eq!(w["schema_version"], 2);
    let uri = format!("/api/workspaces/{}", w["id"]);

    // An update without a version keeps the stored one; with one, replaces it.
    let (st, w) = put_json(
        &app,
        &uri,
        &json!({"name": "b", "state": {}, "expected_updated_at": w["updated_at"]}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{w}");
    assert_eq!(w["schema_version"], 2);
    let (st, w) = put_json(
        &app,
        &uri,
        &json!({"name": "b", "schema_version": 3, "state": {}, "expected_updated_at": w["updated_at"]}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{w}");
    let (_, cur) = get(&app, &uri).await;
    assert_eq!(cur["schema_version"], 3);

    let (st, v) = post_json(
        &app,
        "/api/workspaces",
        &json!({"name": "c", "schema_version": 0, "state": {}}),
    )
    .await;
    assert_eq!((st, code(&v)), (StatusCode::BAD_REQUEST, "invalid_input"));
}
