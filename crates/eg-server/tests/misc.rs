mod common;

use alloy_primitives::{Address, B256, Bytes, U256};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{DateTime, TimeZone, Utc};
use common::{delete, get, post_json, send, test_app};
use eg_core::source::{Priority, RawLog, RawReceipt, RawTx};
use eg_core::types::{Transfer, TransferKind};
use eg_ingest::handlers::FetchTxHandler;
use eg_ingest::{JobHandler, enqueue_fetch_tx};
use eg_server::import_labels::import_labels;
use eg_store::Store;
use serde_json::{Value, json};
use sqlx::PgPool;

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
    };
    fake.add_tx(tx, receipt, vec![internal], ts());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_pending_then_ready(pool: PgPool) {
    let (app, state, fake) = test_app(pool);
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
    assert_eq!(enqueue_fetch_tx(&state.ctx, HASH).await.unwrap(), job_id);

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

    let flows = f["flows"].as_array().unwrap();
    assert_eq!(flows.len(), 3);
    assert_eq!(flows[0]["kind"], "native");
    assert_eq!(flows[0]["symbol"], "ETH");
    assert_eq!(flows[0]["decimals"], 18);
    assert_eq!(flows[1]["kind"], "erc20");
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

    let ev = &f["events"][0];
    assert_eq!(ev["address"], format!("{TOKEN:#x}"));
    assert_eq!(ev["log_index"], 3);
    assert_eq!(ev["topics"][0], format!("{TRANSFER_TOPIC:#x}"));
    let data = ev["data"].as_str().unwrap();
    assert_eq!(data, data.to_lowercase());
    assert!(data.starts_with("0x") && data.len() == 66);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tx_bad_hash_is_invalid_input(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let (st, v) = get(&app, "/api/tx/0x12").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(code(&v), "invalid_input");
}

// ------------------------------------------------------------------ labels

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn label_crud_and_category_validation(pool: PgPool) {
    let (app, state, _) = test_app(pool);
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
    let (st, v) = post_json(&app, "/api/labels", &body("  Hot wallet  ", "exchange")).await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(v["text"], "Hot wallet");
    assert_eq!(v["category"], "exchange");
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
    let imp = state.store.labels(&[TO]).await.unwrap()[0].id;
    let (st, v) = delete(&app, &format!("/api/labels/{imp}")).await;
    assert_eq!((st, code(&v)), (StatusCode::NOT_FOUND, "not_found"));
}

// ------------------------------------------------------------------ workspaces

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn workspace_conflict_409(pool: PgPool) {
    let (app, _, _) = test_app(pool);
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
async fn workspace_get_then_put_with_returned_updated_at(pool: PgPool) {
    let (app, _, _) = test_app(pool);
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
    let (app, _, _) = test_app(pool);
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
        .labels(&[
            "0x28c6c06298d514db089934071355e5743bf21d60"
                .parse()
                .unwrap(),
            "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be"
                .parse()
                .unwrap(),
        ])
        .await
        .unwrap();
    let cats: Vec<_> = rows
        .iter()
        .filter(|l| l.source == "import:cat")
        .map(|l| (l.text.as_str(), l.category.as_str()))
        .collect();
    assert_eq!(cats, [("A", "mixer"), ("B", "other")]);

    // Wrong header is an error, and leaves the dataset untouched.
    assert!(
        import_labels(&store, "sample", "a,b,c\n".as_bytes())
            .await
            .is_err()
    );
    assert_eq!(total(store).await, 3);
}
