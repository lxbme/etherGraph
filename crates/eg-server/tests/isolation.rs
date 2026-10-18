//! Per-user data isolation (Review Focus 1): user A is the default test user,
//! user B a second logged-in user. Another user's resource answers exactly
//! like a missing one.

mod common;

use alloy_primitives::{Address, B256, Bytes, U256};
use axum::http::StatusCode;
use chrono::{TimeZone, Utc};
use common::{
    delete, delete_as, get, get_as, post_json, post_json_as, put_json_as, second_user, test_app,
};
use eg_core::source::{RawLog, RawReceipt, RawTx};
use eg_core::testing::FakeSource;
use eg_ingest::JobHandler;
use eg_ingest::handlers::FetchTxHandler;
use eg_store::JobStatus;
use serde_json::{Value, json};
use sqlx::PgPool;

const X: Address = Address::repeat_byte(0x71);
const Y: Address = Address::repeat_byte(0x72);
const TOKEN: Address = Address::repeat_byte(0x73);
const LISTED_SCAM: Address = Address::repeat_byte(0x74);
const HASH: B256 = B256::repeat_byte(0x75);
const FROM: Address = Address::repeat_byte(0x76);
const ERC20: Address = Address::repeat_byte(0x77);
const TRANSFER_TOPIC: B256 = B256::new(alloy_primitives::hex!(
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
));

/// A mined ERC-20 transfer from `FROM` to `X` in block 100.
fn seed_tx(fake: &FakeSource) {
    let log = RawLog {
        address: ERC20,
        topics: vec![TRANSFER_TOPIC, FROM.into_word(), X.into_word()],
        data: Bytes::from(U256::from(100u8).to_be_bytes::<32>().to_vec()),
        log_index: 0,
    };
    fake.add_tx(
        RawTx {
            hash: HASH,
            from: FROM,
            to: Some(ERC20),
            value: U256::ZERO,
            input: Bytes::from(vec![0xa9, 0x05, 0x9c, 0xbb]),
            block_number: Some(100),
            json: json!({"hash": format!("{HASH:#x}"), "input": "0xa9059cbb"}),
        },
        RawReceipt {
            success: true,
            gas_used: U256::from(21000u32),
            effective_gas_price: U256::from(1u8),
            contract_address: None,
            logs: vec![log],
            json: json!({"status": "0x1"}),
        },
        vec![],
        Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
    );
}

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or("")
}

fn assert_not_found(st: StatusCode, v: &Value) {
    assert_eq!((st, code(v)), (StatusCode::NOT_FOUND, "not_found"), "{v}");
}

fn ids(v: &Value) -> Vec<i64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|j| j["id"].as_i64().unwrap())
        .collect()
}

// ------------------------------------------------------------------ workspaces

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn another_users_workspace_is_not_found_and_unchanged(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    let (st, w) = post_json(
        &app,
        "/api/workspaces",
        &json!({"name": "A's case", "state": {"secret": 1}}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{w}");
    let uri = format!("/api/workspaces/{}", w["id"]);

    let (st, v) = get_as(&app, &b, &uri).await;
    assert_not_found(st, &v);
    let put = json!({
        "name": "taken",
        "state": {},
        "expected_updated_at": w["updated_at"],
    });
    let (st, v) = put_json_as(&app, &b, &uri, &put).await;
    assert_not_found(st, &v);
    let (st, v) = delete_as(&app, &b, &uri).await;
    assert_not_found(st, &v);
    let (st, list) = get_as(&app, &b, "/api/workspaces").await;
    assert_eq!((st, list), (StatusCode::OK, json!([])));

    // A still has it, unchanged.
    let (st, mine) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK, "{mine}");
    assert_eq!(mine["name"], "A's case");
    assert_eq!(mine["state"], json!({"secret": 1}));
    assert_eq!(mine["updated_at"], w["updated_at"]);
    let (_, list) = get(&app, "/api/workspaces").await;
    assert_eq!(ids(&list), [w["id"].as_i64().unwrap()]);

    // B's own workspace is invisible to A.
    let (st, bw) = post_json_as(
        &app,
        &b,
        "/api/workspaces",
        &json!({"name": "B's", "state": {}}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{bw}");
    let (st, v) = get(&app, &format!("/api/workspaces/{}", bw["id"])).await;
    assert_not_found(st, &v);
    let (_, list) = get(&app, "/api/workspaces").await;
    assert_eq!(ids(&list), [w["id"].as_i64().unwrap()]);
}

// ------------------------------------------------------------------ labels

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn labels_are_imports_plus_the_viewers_own(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    state
        .store
        .replace_import("d", &[(X, "Public".into(), "defi".into())])
        .await
        .unwrap();
    let (st, a_label) = post_json(
        &app,
        "/api/labels",
        &json!({"address": hex(X), "text": "Alice secret", "category": "cex"}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{a_label}");
    let (st, b_label) = post_json_as(
        &app,
        &b,
        "/api/labels",
        &json!({"address": hex(X), "text": "Bob note", "category": "other"}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{b_label}");

    let texts = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|l| l["text"].as_str().unwrap().to_owned())
            .collect()
    };
    let uri = format!("/api/labels?addr={}", hex(X));
    let (_, mine) = get(&app, &uri).await;
    assert_eq!(texts(&mine), ["Alice secret", "Public"]);
    let (_, theirs) = get_as(&app, &b, &uri).await;
    assert_eq!(texts(&theirs), ["Bob note", "Public"]);

    // B cannot delete A's label (nor an import); A's label stays.
    let a_uri = format!("/api/labels/{}", a_label["id"]);
    let (st, v) = delete_as(&app, &b, &a_uri).await;
    assert_not_found(st, &v);
    let (_, mine) = get(&app, &uri).await;
    assert_eq!(texts(&mine), ["Alice secret", "Public"]);
    // A deletes its own.
    let (st, _) = delete(&app, &a_uri).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (_, theirs) = get_as(&app, &b, &uri).await;
    assert_eq!(texts(&theirs), ["Bob note", "Public"]);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn node_summaries_never_show_another_users_labels(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    let (st, v) = post_json(
        &app,
        "/api/labels",
        &json!({"address": hex(X), "text": "Alice secret", "category": "cex"}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");

    let body = json!({"addresses": [hex(X)]});
    let (st, mine) = post_json(&app, "/api/nodes", &body).await;
    assert_eq!(st, StatusCode::OK, "{mine}");
    assert_eq!(mine[0]["display_name"], "Alice secret");
    assert_eq!(mine[0]["hot"], true);

    let (st, theirs) = post_json_as(&app, &b, "/api/nodes", &body).await;
    assert_eq!(st, StatusCode::OK, "{theirs}");
    assert_eq!(theirs[0]["display_name"], Value::Null);
    assert_eq!(theirs[0]["labels"], json!([]));
    assert_eq!(theirs[0]["hot"], false);

    let uri = format!("/api/address/{}", hex(X));
    let (st, profile) = get_as(&app, &b, &uri).await;
    assert_eq!(st, StatusCode::OK, "{profile}");
    assert_eq!(profile["node"]["display_name"], Value::Null);
    assert_eq!(profile["node"]["labels"], json!([]));
    let (_, profile) = get(&app, &uri).await;
    assert_eq!(profile["node"]["display_name"], "Alice secret");

    let edges = json!({"addresses": [hex(X)]});
    let (st, graph) = post_json_as(&app, &b, "/api/graph/edges", &edges).await;
    assert_eq!(st, StatusCode::OK, "{graph}");
    assert!(!graph.to_string().contains("Alice secret"), "{graph}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_private_scam_label_does_not_change_trust_levels(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    state
        .store
        .replace_import("d", &[(LISTED_SCAM, "Fake".into(), "scam".into())])
        .await
        .unwrap();
    let (st, v) = post_json(
        &app,
        "/api/labels",
        &json!({"address": hex(TOKEN), "text": "I think this is fake", "category": "scam"}),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");

    let level = |v: &Value| v["trust"]["level"].as_str().unwrap().to_owned();
    let uri = format!("/api/token/{}", hex(TOKEN));
    let (st, theirs) = get_as(&app, &b, &uri).await;
    assert_eq!(st, StatusCode::OK, "{theirs}");
    assert_eq!(level(&theirs), "unknown");
    // Imports only (D4): the author's own view is not changed either.
    let (_, mine) = get(&app, &uri).await;
    assert_eq!(level(&mine), "unknown");
    // An imported scam label still counts.
    let (_, imported) = get_as(&app, &b, &format!("/api/token/{}", hex(LISTED_SCAM))).await;
    assert_eq!(level(&imported), "scam");
}

// ------------------------------------------------------------------ jobs

async fn sync_job(app: &axum::Router, body: Value) -> i64 {
    let (st, b) = post_json(app, "/api/sync", &body).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    b["jobs"][0].as_i64().unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn another_users_jobs_are_not_found_and_not_cancelled(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    let id = sync_job(&app, json!({"addresses": [hex(X)]})).await;

    for uri in [
        "/api/jobs",
        "/api/jobs?active=true",
        "/api/jobs?active=false",
    ] {
        let (st, v) = get_as(&app, &b, uri).await;
        assert_eq!((st, v), (StatusCode::OK, json!([])), "{uri}");
        let (st, v) = get(&app, uri).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(ids(&v), [id], "{uri}");
    }
    let uri = format!("/api/jobs/{id}");
    let (st, v) = get_as(&app, &b, &uri).await;
    assert_not_found(st, &v);
    let (st, v) = delete_as(&app, &b, &uri).await;
    assert_not_found(st, &v);
    let (st, v) = delete_as(&app, &b, "/api/jobs?scope=background").await;
    assert_eq!((st, v), (StatusCode::OK, json!({"cancelled": []})));
    let job = state.store.job(id).await.unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Pending);

    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["id"], id);
    let (st, _) = delete(&app, &uri).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn releasing_a_batch_only_affects_the_viewers_jobs(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    let id = sync_job(&app, json!({"addresses": [hex(X)], "batch": "shared-name"})).await;
    let (st, theirs) = post_json_as(
        &app,
        &b,
        "/api/sync",
        &json!({"addresses": [hex(Y)], "batch": "shared-name"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{theirs}");
    let their_id = theirs["jobs"][0].as_i64().unwrap();

    let (st, v) = delete_as(&app, &b, "/api/batches/shared-name").await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v, json!({"cancelled": [their_id]}));
    let job = state.store.job(id).await.unwrap().unwrap();
    assert_eq!(job.status, JobStatus::Pending);
    let (_, mine) = get(&app, &format!("/api/jobs/{id}")).await;
    assert_eq!(mine["batches"], json!(["shared-name"]));

    let (st, v) = delete(&app, "/api/batches/shared-name").await;
    assert_eq!((st, v), (StatusCode::OK, json!({"cancelled": [id]})));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn status_counts_only_the_viewers_jobs(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    sync_job(&app, json!({"addresses": [hex(X)]})).await;

    let (st, mine) = get(&app, "/api/status").await;
    assert_eq!(st, StatusCode::OK, "{mine}");
    assert_eq!(mine["jobs_active"], 1);
    assert!(mine["queued_calls"].as_u64().unwrap() > 0, "{mine}");
    let (st, theirs) = get_as(&app, &b, "/api/status").await;
    assert_eq!(st, StatusCode::OK, "{theirs}");
    assert_eq!(theirs["jobs_active"], 0);
    assert_eq!(theirs["queued_calls"], 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn jobs_started_by_viewing_belong_to_the_viewer(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, b_id) = second_user(&app, &state).await;
    // A token page queues its metadata; an identify queues contract metadata.
    let (st, v) = get_as(&app, &b, &format!("/api/token/{}", hex(TOKEN))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (st, v) = post_json_as(&app, &b, "/api/identify", &json!({"addresses": [hex(Y)]})).await;
    assert_eq!(st, StatusCode::OK, "{v}");

    let owners: Vec<Option<i64>> = sqlx::query_scalar("SELECT user_id FROM jobs")
        .fetch_all(state.store.pool())
        .await
        .unwrap();
    assert_eq!(owners, [Some(b_id), Some(b_id)]);
    let (_, theirs) = get_as(&app, &b, "/api/jobs").await;
    assert_eq!(ids(&theirs).len(), 2);
    let (_, mine) = get(&app, "/api/jobs").await;
    assert_eq!(mine, json!([]));
}

// ------------------------------------------------------------------ job keys

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_same_request_by_two_users_makes_two_jobs(pool: PgPool) {
    let (app, state, fake) = test_app(pool).await;
    let (b, b_id) = second_user(&app, &state).await;
    seed_tx(&fake);
    let uri = format!("/api/tx/{HASH:#x}");
    let (_, mine) = get(&app, &uri).await;
    let (_, theirs) = get_as(&app, &b, &uri).await;
    let (ja, jb) = (
        mine["job_id"].as_i64().unwrap(),
        theirs["job_id"].as_i64().unwrap(),
    );
    assert_ne!(ja, jb, "B was handed A's job id");
    let (st, v) = get_as(&app, &b, &format!("/api/jobs/{jb}")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(
        state.store.job(jb).await.unwrap().unwrap().user_id,
        Some(b_id)
    );

    let sa = sync_job(&app, json!({"addresses": [hex(X)]})).await;
    let (st, v) = post_json_as(&app, &b, "/api/sync", &json!({"addresses": [hex(X)]})).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let sb = v["jobs"][0].as_i64().unwrap();
    assert_ne!(sa, sb, "B was handed A's sync job id");
    let (st, v) = get_as(&app, &b, &format!("/api/jobs/{sb}")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn another_users_batch_never_attaches_to_my_job(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (b, _) = second_user(&app, &state).await;
    let ja = sync_job(&app, json!({"addresses": [hex(X)], "batch": "a-batch"})).await;
    let (st, v) = post_json_as(
        &app,
        &b,
        "/api/sync",
        &json!({"addresses": [hex(X)], "batch": "b-secret"}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let jb = v["jobs"][0].as_i64().unwrap();

    let (_, mine) = get(&app, "/api/jobs").await;
    assert_eq!(ids(&mine), [ja]);
    assert_eq!(mine[0]["batches"], json!(["a-batch"]));
    assert!(!mine.to_string().contains("b-secret"), "{mine}");

    // Releasing A's batch ends A's job: no row of B's keeps it alive.
    let (st, v) = delete(&app, "/api/batches/a-batch").await;
    assert_eq!((st, v), (StatusCode::OK, json!({"cancelled": [ja]})));
    assert_eq!(
        state.store.job(ja).await.unwrap().unwrap().status,
        JobStatus::Cancelled
    );
    assert_eq!(
        state.store.job(jb).await.unwrap().unwrap().status,
        JobStatus::Pending
    );
    let (st, v) = delete_as(&app, &b, "/api/batches/b-secret").await;
    assert_eq!((st, v), (StatusCode::OK, json!({"cancelled": [jb]})));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn every_enqueuing_route_attributes_jobs_to_the_viewer(pool: PgPool) {
    let (app, state, fake) = test_app(pool).await;
    let (b, b_id) = second_user(&app, &state).await;
    seed_tx(&fake);
    let ok = |st: StatusCode, v: &Value| assert_eq!(st, StatusCode::OK, "{v}");

    // Transaction fetch, then its follow-up metadata and token jobs.
    let tx_uri = format!("/api/tx/{HASH:#x}");
    let (st, v) = get_as(&app, &b, &tx_uri).await;
    ok(st, &v);
    let job = state.store.claim_next().await.unwrap().unwrap();
    assert_eq!(job.id, v["job_id"].as_i64().unwrap());
    FetchTxHandler.run(&job, &state.ctx).await.unwrap();
    state.store.complete_job(job.id).await.unwrap();
    // A transaction stored without its block header: viewing it backfills
    // the block and queues the parties' metadata, names and tokens.
    sqlx::query("DELETE FROM blocks")
        .execute(state.store.pool())
        .await
        .unwrap();
    let (st, v) = get_as(&app, &b, &tx_uri).await;
    ok(st, &v);
    assert_eq!(v["status"], "ready");

    // An unsynced address with sync=auto, and one with stale coverage.
    let (st, v) = get_as(&app, &b, &format!("/api/address/{}?sync=auto", hex(X))).await;
    ok(st, &v);
    sqlx::query(
        "INSERT INTO address_sync (address, kind, from_block, to_block, state, last_synced_at) \
         SELECT $1, k, 0, 10, 'ok', now() - interval '1 day' FROM generate_series(0, 4) AS k",
    )
    .bind(Y.as_slice())
    .execute(state.store.pool())
    .await
    .unwrap();
    let (st, v) = get_as(&app, &b, &format!("/api/address/{}", hex(Y))).await;
    ok(st, &v);
    // Graph, counterparties and node summaries.
    let (st, v) = post_json_as(
        &app,
        &b,
        "/api/graph/edges",
        &json!({"addresses": [hex(FROM)]}),
    )
    .await;
    ok(st, &v);
    let (st, v) = get_as(
        &app,
        &b,
        &format!("/api/address/{}/counterparties", hex(FROM)),
    )
    .await;
    ok(st, &v);
    let (st, v) = post_json_as(&app, &b, "/api/nodes", &json!({"addresses": [hex(FROM)]})).await;
    ok(st, &v);
    // Explicit work.
    let (st, v) = post_json_as(
        &app,
        &b,
        "/api/identify",
        &json!({"addresses": [hex(TOKEN)]}),
    )
    .await;
    ok(st, &v);
    let (st, v) = post_json_as(
        &app,
        &b,
        "/api/sync",
        &json!({"addresses": [hex(LISTED_SCAM)]}),
    )
    .await;
    ok(st, &v);
    let (st, v) = get_as(&app, &b, &format!("/api/token/{}", hex(TOKEN))).await;
    ok(st, &v);

    let owners: Vec<Option<i64>> =
        sqlx::query_scalar("SELECT DISTINCT user_id FROM jobs ORDER BY user_id")
            .fetch_all(state.store.pool())
            .await
            .unwrap();
    assert_eq!(owners, [Some(b_id)]);
    let kinds: Vec<String> = sqlx::query_scalar("SELECT DISTINCT kind FROM jobs ORDER BY kind")
        .fetch_all(state.store.pool())
        .await
        .unwrap();
    assert_eq!(
        kinds,
        [
            "contract_meta",
            "fetch_block",
            "fetch_tx",
            "resolve_names",
            "sync_address",
            "token_meta"
        ]
    );
    let syncs: Vec<i16> = sqlx::query_scalar(
        "SELECT priority FROM jobs WHERE kind = 'sync_address' ORDER BY priority",
    )
    .fetch_all(state.store.pool())
    .await
    .unwrap();
    // The auto sync (Interactive) and the stale refresh and explicit sync
    // (Background).
    assert_eq!(syncs, [0, 1, 1]);
    let (_, mine) = get(&app, "/api/jobs").await;
    assert_eq!(mine, json!([]));
}
