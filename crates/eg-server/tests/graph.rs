mod common;

use alloy_primitives::{Address, B256, Bytes, U256, address};
use alloy_sol_types::SolValue;
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use common::{get, post_json, test_app};
use eg_core::source::{Priority, SourceError, TokenInfo};
use eg_core::types::{AccountKind, Transfer, TransferKind, assign_sub_ids};
use eg_server::state::AppState;
use eg_store::{AccountRow, EnsRow, EnsStatus, JobKind};
use serde_json::{Value, json};
use sqlx::PgPool;

const C: Address = Address::repeat_byte(0xc0);
const A: Address = Address::repeat_byte(0xa1);
const B: Address = Address::repeat_byte(0xb1);
const USDT: Address = Address::repeat_byte(0x55);
const T0: i64 = 1_700_000_000;

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

fn at(off: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(T0 + off, 0).unwrap()
}

fn tr(
    tx: u8,
    from: Address,
    to: Address,
    asset: Option<Address>,
    amount: U256,
    off: i64,
) -> Transfer {
    Transfer {
        tx_hash: B256::repeat_byte(tx),
        sub_id: String::new(),
        kind: if asset.is_some() {
            TransferKind::Erc20
        } else {
            TransferKind::Native
        },
        block_number: 100 + tx as u64,
        ts: at(off),
        from,
        to,
        asset,
        amount,
        token_id: None,
        trace_id: None,
        log_index: None,
    }
}

async fn seed(state: &AppState, mut v: Vec<Transfer>) {
    assign_sub_ids(&mut v);
    state.store.upsert_transfers(&v).await.unwrap();
}

async fn token(state: &AppState, addr: Address, symbol: &str, decimals: Option<u8>) {
    state
        .store
        .upsert_tokens(&[TokenInfo {
            address: addr,
            kind: TransferKind::Erc20,
            name: None,
            symbol: Some(symbol.into()),
            decimals,
        }])
        .await
        .unwrap();
}

/// Writes coverage rows for all five kinds, synced `age_secs` ago.
async fn mark_synced(pool: &PgPool, addr: Address, age_secs: i64, truncated: bool) {
    for k in TransferKind::ALL {
        sqlx::query(
            "INSERT INTO address_sync (address, kind, from_block, to_block, truncated, state, \
             last_synced_at) VALUES ($1, $2, 10, 20, $3, 'ok', now() - make_interval(secs => $4))",
        )
        .bind(addr.as_slice().to_vec())
        .bind(k.as_i16())
        .bind(truncated)
        .bind(age_secs as f64)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn jobs_of(state: &AppState, kind: JobKind) -> Vec<eg_store::JobRow> {
    state
        .store
        .active_jobs()
        .await
        .unwrap()
        .into_iter()
        .filter(|j| j.kind == kind)
        .collect()
}

fn graph_req(filter: Value) -> Value {
    json!({"addresses": [hex(C)], "filter": filter})
}

fn assert_invalid(status: StatusCode, body: &Value) {
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "invalid_input", "{body}");
}

// ---------------------------------------------------------------- search

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn search_classifies_inputs(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let lower = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    let (s, b) = get(&app, &format!("/api/search?q=%20{lower}%20")).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(
        b,
        json!({"kind": "address", "value": lower, "resolved_address": null})
    );

    // A correctly checksummed mixed-case address is accepted and lowercased.
    let (s, b) = get(
        &app,
        "/api/search?q=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["value"], lower);

    let hash = format!("0x{}", "ab".repeat(32));
    let (s, b) = get(
        &app,
        &format!(
            "/api/search?q={}",
            hash.to_uppercase().replacen("0X", "0x", 1)
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(
        b,
        json!({"kind": "tx", "value": hash, "resolved_address": null})
    );

    for bad in [
        "0x12",
        // Mixed case with a broken checksum.
        "0xd8Da6BF26964aF9D7eEd9e03E53415D37aA96045",
        "foo",
        "0xzz8da6bf26964af9d7eed9e03e53415d37aa9604",
        "",
    ] {
        let (s, b) = get(&app, &format!("/api/search?q={bad}")).await;
        assert_invalid(s, &b);
    }
    let (s, b) = get(&app, "/api/search").await;
    assert_invalid(s, &b);
}

fn resolve_ret(a: Address) -> Bytes {
    let mut inner = vec![0u8; 12];
    inner.extend_from_slice(a.as_slice());
    (Bytes::from(inner), Address::ZERO)
        .abi_encode_params()
        .into()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn search_ens_resolves_via_eth_call(pool: PgPool) {
    let (app, state, fake) = test_app(pool);
    let target = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    let ur = state.cfg.ens.universal_resolver;
    let want = eg_decode::encode_resolve_addr("vitalik.eth").unwrap();
    fake.on_eth_call(move |to, data| {
        assert_eq!(to, ur);
        assert_eq!(*data, want);
        Ok(resolve_ret(target))
    });
    let (s, b) = get(&app, "/api/search?q=Vitalik.ETH").await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(
        b,
        json!({"kind": "ens", "value": "vitalik.eth", "resolved_address": hex(target)})
    );
    assert_eq!(fake.calls(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn search_ens_invalid_name_400(pool: PgPool) {
    let (app, _, fake) = test_app(pool);
    let (s, b) = get(&app, "/api/search?q=a..eth").await;
    assert_invalid(s, &b);
    assert_eq!(fake.calls(), 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn search_ens_unresolved_404(pool: PgPool) {
    let (app, _, fake) = test_app(pool);
    // No handler: the fake answers with an RPC error (a revert).
    let (s, b) = get(&app, "/api/search?q=nobody.eth").await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{b}");
    assert_eq!(b["error"]["code"], "not_found");

    fake.on_eth_call(|_, _| Ok(resolve_ret(Address::ZERO)));
    let (s, b) = get(&app, "/api/search?q=nobody.eth").await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{b}");

    fake.fail_next(SourceError::Timeout);
    let (s, b) = get(&app, "/api/search?q=nobody.eth").await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{b}");
    assert_eq!(b["error"]["code"], "upstream_error");
}

// ---------------------------------------------------------------- graph

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_edges_returns_nodes_and_enqueues_meta(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(5), 0),
            tr(2, C, A, None, U256::from(7), 10),
            tr(3, B, C, Some(USDT), U256::from(9), 20),
        ],
    )
    .await;
    let (s, b) = post_json(&app, "/api/graph/edges", &json!({"addresses": [hex(C)]})).await;
    assert_eq!(s, StatusCode::OK, "{b}");

    let nodes: Vec<&str> = b["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["address"].as_str().unwrap())
        .collect();
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[0], hex(C), "center first");
    for a in [A, B] {
        assert!(nodes.contains(&hex(a).as_str()), "{nodes:?}");
    }
    let n0 = &b["nodes"][0];
    assert_eq!(n0["kind"], "unknown");
    assert_eq!(n0["display_name"], Value::Null);
    assert_eq!(n0["labels"], json!([]));
    for f in ["partial", "syncing", "synced", "hot"] {
        assert_eq!(n0[f], false, "{f}");
    }

    let edges = b["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 2, "{b}");
    let eth = edges.iter().find(|e| e["asset"].is_null()).unwrap();
    assert_eq!(
        *eth,
        json!({
            "from": hex(C), "to": hex(A), "asset": null, "count": 2, "sum": "12",
            "first_ts": "2023-11-14T22:13:20.000Z", "last_ts": "2023-11-14T22:13:30.000Z",
            "decimals": 18, "symbol": "ETH",
        })
    );
    let usdt = edges.iter().find(|e| e["asset"] == hex(USDT)).unwrap();
    assert_eq!(usdt["decimals"], Value::Null);
    assert_eq!(b["omitted"], json!({}));
    let coverage = b["coverage"].as_object().unwrap();
    assert_eq!(coverage.len(), 3);
    assert_eq!(coverage[&hex(C)], json!([]));

    let meta = jobs_of(&state, JobKind::ContractMeta).await;
    let names = jobs_of(&state, JobKind::ResolveNames).await;
    let tokens = jobs_of(&state, JobKind::TokenMeta).await;
    assert!(!meta.is_empty());
    assert!(!names.is_empty());
    assert_eq!(tokens.len(), 1);
    assert_eq!(tokens[0].params["tokens"], json!([hex(USDT)]));
    for j in meta.iter().chain(&names).chain(&tokens) {
        assert_eq!(j.priority, Priority::Low);
    }
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_node_flags_and_names(pool: PgPool) {
    let (app, state, _) = test_app(pool.clone());
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, B, C, None, U256::from(1), 0),
        ],
    )
    .await;
    state
        .store
        .add_user_label(A, "Binance 14", "exchange")
        .await
        .unwrap();
    state
        .store
        .add_user_label(A, "second", "other")
        .await
        .unwrap();
    state
        .store
        .upsert_ens(&[EnsRow {
            address: B,
            name: Some("bob.eth".into()),
            status: EnsStatus::Ok,
            resolved_at: Utc::now(),
        }])
        .await
        .unwrap();
    state
        .store
        .upsert_accounts(&[AccountRow {
            address: C,
            kind: AccountKind::Contract,
            contract_name: Some("Router".into()),
            is_proxy: false,
            implementation: None,
            creator: None,
            creation_tx: None,
            meta_fetched_at: Utc::now(),
        }])
        .await
        .unwrap();
    mark_synced(&pool, C, 0, true).await;
    sqlx::query("UPDATE address_sync SET state = 'syncing' WHERE kind = 0")
        .execute(&pool)
        .await
        .unwrap();

    let (s, b) = post_json(&app, "/api/graph/edges", &graph_req(json!(null))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let node = |a: Address| {
        b["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["address"] == hex(a))
            .unwrap()
            .clone()
    };
    let (c, a, bb) = (node(C), node(A), node(B));
    assert_eq!(c["kind"], "contract");
    assert_eq!(c["contract_name"], "Router");
    assert_eq!(c["display_name"], "Router");
    assert_eq!(
        (&c["synced"], &c["partial"], &c["syncing"], &c["hot"]),
        (&json!(true), &json!(true), &json!(true), &json!(false))
    );
    assert_eq!(a["display_name"], "Binance 14");
    assert_eq!(a["hot"], true);
    let labels = a["labels"].as_array().unwrap();
    assert_eq!(labels.len(), 2);
    assert_eq!(labels[0]["text"], "Binance 14");
    assert_eq!(labels[0]["category"], "exchange");
    assert_eq!(labels[0]["source"], "user");
    assert!(labels[0]["id"].is_number());
    assert_eq!(bb["display_name"], "bob.eth");
    assert_eq!(bb["ens"], "bob.eth");
    assert_eq!(bb["hot"], false);

    let cov = b["coverage"][hex(C)].as_array().unwrap();
    assert_eq!(cov.len(), 5);
    assert_eq!(
        cov[0],
        json!({
            "kind": "native", "from_block": 10, "to_block": 20, "truncated": true,
            "state": "syncing", "last_synced_at": cov[0]["last_synced_at"].clone(),
        })
    );
    assert!(cov[0]["last_synced_at"].is_string());
    // Fresh metadata / ENS rows are not re-enqueued.
    let meta = jobs_of(&state, JobKind::ContractMeta).await;
    assert_eq!(meta.len(), 1);
    let mut want = vec![hex(A), hex(B)];
    want.sort();
    assert_eq!(meta[0].params["addresses"], json!(want));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_hot_by_neighbour_count(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    // limit 1 with 501 neighbours: omitted 500 + 1 returned = 501 > threshold 500.
    let mut v = Vec::new();
    for i in 0..501u32 {
        let mut n = [0u8; 20];
        n[16..].copy_from_slice(&(i + 1).to_be_bytes());
        let mut t = tr(1, C, Address::from(n), None, U256::from(1), 0);
        t.tx_hash = B256::left_padding_from(&(i + 1).to_be_bytes());
        v.push(t);
    }
    seed(&state, v).await;
    let (s, b) = post_json(
        &app,
        "/api/graph/edges",
        &json!({"addresses": [hex(C)], "limit_per_address": 1}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["omitted"], json!({ hex(C): 500 }));
    assert_eq!(b["edges"].as_array().unwrap().len(), 1);
    assert_eq!(b["nodes"][0]["hot"], true);
    assert_eq!(b["nodes"][1]["hot"], false);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_min_amount_unknown_decimals_400(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let filter = json!({"assets": [{"asset": hex(USDT), "min_amount": "1"}]});
    let (s, b) = post_json(&app, "/api/graph/edges", &graph_req(filter.clone())).await;
    assert_invalid(s, &b);
    assert_eq!(
        b["error"]["message"],
        format!("unknown decimals for {}", hex(USDT))
    );
    // A token row without decimals is just as unknown.
    token(&state, USDT, "USDT", None).await;
    let (s, b) = post_json(&app, "/api/graph/edges", &graph_req(filter)).await;
    assert_invalid(s, &b);
    // Without a threshold no decimals are needed.
    let ok = json!({"assets": [{"asset": hex(USDT)}]});
    let (s, b) = post_json(&app, "/api/graph/edges", &graph_req(ok)).await;
    assert_eq!(s, StatusCode::OK, "{b}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_min_amount_decimal_conversion(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    token(&state, USDT, "USDT", Some(6)).await;
    seed(
        &state,
        vec![
            tr(1, C, A, Some(USDT), U256::from(1_000_500_000u64), 0),
            tr(2, C, B, Some(USDT), U256::from(1_000_499_999u64), 0),
            tr(3, C, B, None, U256::from(10).pow(U256::from(18)), 0),
            tr(
                4,
                C,
                A,
                None,
                U256::from(10).pow(U256::from(18)) - U256::from(1),
                0,
            ),
        ],
    )
    .await;
    let filter = json!({"assets": [
        {"asset": hex(USDT), "min_amount": "1000.5"},
        {"asset": null, "min_amount": "1"},
    ]});
    let (s, b) = post_json(&app, "/api/graph/edges", &graph_req(filter)).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let edges = b["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 2, "{b}");
    assert!(edges.iter().any(|e| e["to"] == hex(A)
        && e["asset"] == hex(USDT)
        && e["sum"] == "1000500000"
        && e["decimals"] == 6
        && e["symbol"] == "USDT"));
    assert!(
        edges
            .iter()
            .any(|e| e["to"] == hex(B) && e["asset"].is_null())
    );

    let (s, b) = post_json(
        &app,
        "/api/graph/edges",
        &graph_req(json!({"assets": [{"asset": "ETH", "min_amount": "0.0000000000000000001"}]})),
    )
    .await;
    assert_invalid(s, &b);
    for bad in ["-1", "1e6", "abc", "1.", ".5", ""] {
        let (s, b) = post_json(
            &app,
            "/api/graph/edges",
            &graph_req(json!({"assets": [{"asset": "eth", "min_amount": bad}]})),
        )
        .await;
        assert_invalid(s, &b);
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_sort_amount_requires_single_asset(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    seed(&state, vec![tr(1, C, A, None, U256::from(5), 0)]).await;
    let req = |assets: Value| json!({"addresses": [hex(C)], "sort": "amount", "filter": {"assets": assets}});
    for assets in [
        json!(null),
        json!([]),
        json!([{"asset": "eth"}, {"asset": hex(USDT)}]),
    ] {
        let (s, b) = post_json(&app, "/api/graph/edges", &req(assets)).await;
        assert_invalid(s, &b);
    }
    let (s, b) = post_json(&app, "/api/graph/edges", &req(json!([{"asset": "eth"}]))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["edges"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_rejects_bad_input(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let many: Vec<String> = (1..=51u8).map(|i| hex(Address::repeat_byte(i))).collect();
    let cases = [
        json!({"addresses": []}),
        json!({"addresses": many}),
        json!({"addresses": ["0x12"]}),
        json!({"addresses": [hex(C)], "sort": "size"}),
        json!({"addresses": [hex(C)], "filter": {"direction": "up"}}),
        json!({"addresses": [hex(C)], "filter": {"kinds": ["erc20", "erc999"]}}),
        json!({"addresses": [hex(C)], "filter": {"time": {"from": "yesterday"}}}),
        json!({"addresses": [hex(C)], "filter": {"assets": [{"asset": "btc"}]}}),
        json!({"addresses": "nope"}),
    ];
    for body in cases {
        let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
        assert_invalid(s, &b);
    }

    // Valid filter values are applied; an oversized limit is clamped, not rejected.
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, B, C, Some(USDT), U256::from(1), 100),
        ],
    )
    .await;
    let body = json!({
        "addresses": [hex(C)], "limit_per_address": 5000, "sort": "recent",
        "filter": {"direction": "in", "kinds": ["erc20"],
                   "time": {"from": "2023-11-14T22:13:20Z", "to": null}},
    });
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let edges = b["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0]["from"], hex(B));
}

// ---------------------------------------------------------------- sync

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_dry_run_estimates(pool: PgPool) {
    let (app, state, _) = test_app(pool.clone());
    mark_synced(&pool, B, 0, true).await;
    let (s, b) = post_json(
        &app,
        "/api/sync",
        &json!({"addresses": [hex(A), hex(B), hex(C)], "dry_run": true}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["estimated_calls"], 10);
    let secs = b["estimated_seconds"].as_f64().unwrap();
    assert!((secs - 10.0 / 2.8).abs() < 1e-9, "{secs}");
    assert_eq!(b["jobs"], Value::Null);
    assert!(state.store.active_jobs().await.unwrap().is_empty());

    let (s, b) = post_json(
        &app,
        "/api/sync",
        &json!({"addresses": [hex(B)], "direction": "older", "dry_run": true}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["estimated_calls"], 5);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_enqueues_background_jobs(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let (s, b) = post_json(
        &app,
        "/api/sync",
        &json!({"addresses": [hex(A), hex(B)], "direction": "older"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["estimated_calls"], Value::Null);
    let ids = b["jobs"].as_array().unwrap();
    assert_eq!(ids.len(), 2);
    let jobs = jobs_of(&state, JobKind::SyncAddress).await;
    assert_eq!(jobs.len(), 2);
    for j in &jobs {
        assert_eq!(j.priority, Priority::Background);
        assert_eq!(j.params["direction"], "older");
        assert!(ids.contains(&json!(j.id)));
    }

    let (s, _) = post_json(&app, "/api/sync", &json!({"addresses": [hex(C)]})).await;
    assert_eq!(s, StatusCode::OK);
    let latest = jobs_of(&state, JobKind::SyncAddress).await;
    assert!(latest.iter().any(|j| j.params["direction"] == "latest"));

    let many: Vec<String> = (1..=51u8).map(|i| hex(Address::repeat_byte(i))).collect();
    for body in [
        json!({"addresses": many}),
        json!({"addresses": []}),
        json!({"addresses": [hex(A)], "direction": "sideways"}),
        json!({"addresses": ["0xnope"]}),
    ] {
        let (s, b) = post_json(&app, "/api/sync", &body).await;
        assert_invalid(s, &b);
    }
}

// ---------------------------------------------------------------- transfers

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn transfers_requires_exactly_one_scope(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let (a, c) = (hex(A), hex(C));
    for q in [
        String::new(),
        format!("address={a}&from={a}&to={c}"),
        format!("from={a}"),
        format!("to={a}"),
        format!("address={a}&to={c}"),
    ] {
        let (s, b) = get(&app, &format!("/api/transfers?{q}")).await;
        assert_invalid(s, &b);
    }
    for q in [format!("address={a}"), format!("from={a}&to={c}")] {
        let (s, b) = get(&app, &format!("/api/transfers?{q}")).await;
        assert_eq!(s, StatusCode::OK, "{q}: {b}");
        assert_eq!(b, json!({"items": [], "next_cursor": null}));
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn transfers_paginate_and_filter(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    token(&state, USDT, "USDT", Some(6)).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, C, A, Some(USDT), U256::from(2), 10),
            tr(3, A, C, None, U256::from(3), 20),
            tr(4, B, C, None, U256::from(4), 30),
        ],
    )
    .await;
    let c = hex(C);
    let (s, b) = get(&app, &format!("/api/transfers?address={c}&limit=2")).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let items = b["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["amount"], "4");
    assert_eq!(
        items[0],
        json!({
            "tx_hash": format!("{:#x}", B256::repeat_byte(4)), "sub_id": "top",
            "kind": "native", "block_number": 104, "ts": "2023-11-14T22:13:50.000Z",
            "from": hex(B), "to": c, "asset": null, "amount": "4", "token_id": null,
            "decimals": 18, "symbol": "ETH",
        })
    );
    let cursor = b["next_cursor"].as_str().unwrap().to_owned();
    let (s, b) = get(
        &app,
        &format!("/api/transfers?address={c}&limit=2&cursor={cursor}"),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let items = b["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["asset"], hex(USDT));
    assert_eq!(items[0]["decimals"], 6);
    assert_eq!(items[0]["symbol"], "USDT");
    assert_eq!(b["next_cursor"], Value::Null);

    // Pair scope, ETH only, time and kind filters.
    let (s, b) = get(
        &app,
        &format!("/api/transfers?from={c}&to={}&asset=ETH", hex(A)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["items"].as_array().unwrap().len(), 1);
    assert_eq!(b["items"][0]["amount"], "1");
    let (s, b) = get(
        &app,
        &format!(
            "/api/transfers?address={c}&kinds=native,erc20&time_from=2023-11-14T22:13:35Z&time_to=2023-11-14T22:13:45Z"
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["items"].as_array().unwrap().len(), 1);
    assert_eq!(b["items"][0]["amount"], "3");
    let (s, b) = get(
        &app,
        &format!("/api/transfers?address={c}&asset={}", hex(USDT)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["items"].as_array().unwrap().len(), 1);

    // Limit is clamped to [1, 200].
    let (s, b) = get(&app, &format!("/api/transfers?address={c}&limit=0")).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["items"].as_array().unwrap().len(), 1);

    for q in [
        "cursor=notacursor",
        "limit=ten",
        "kinds=native,bogus",
        "time_from=yesterday",
        "asset=btc",
    ] {
        let (s, b) = get(&app, &format!("/api/transfers?address={c}&{q}")).await;
        assert_invalid(s, &b);
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn amounts_are_decimal_strings(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    seed(&state, vec![tr(1, C, A, None, U256::MAX, 0)]).await;
    let max = U256::MAX.to_string();
    let (s, b) = post_json(&app, "/api/graph/edges", &graph_req(json!(null))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["edges"][0]["sum"], json!(max));
    let (s, b) = get(&app, &format!("/api/transfers?address={}", hex(C))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["items"][0]["amount"], json!(max));
}

// ---------------------------------------------------------------- address

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn address_profile_never_synced_enqueues_interactive(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, B, C, None, U256::from(1), 50),
            tr(3, A, B, None, U256::from(1), 99),
        ],
    )
    .await;
    let creator = Address::repeat_byte(0xee);
    state
        .store
        .upsert_accounts(&[AccountRow {
            address: C,
            kind: AccountKind::Contract,
            contract_name: Some("Proxy".into()),
            is_proxy: true,
            implementation: Some(A),
            creator: Some(creator),
            creation_tx: Some(B256::repeat_byte(9)),
            meta_fetched_at: Utc::now(),
        }])
        .await
        .unwrap();
    let (s, b) = get(&app, &format!("/api/address/{}", hex(C))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["node"]["address"], hex(C));
    assert_eq!(b["node"]["kind"], "contract");
    assert_eq!(b["is_proxy"], true);
    assert_eq!(b["implementation"], hex(A));
    assert_eq!(b["creator"], hex(creator));
    assert_eq!(b["creation_tx"], format!("{:#x}", B256::repeat_byte(9)));
    assert_eq!(b["coverage"], json!([]));
    assert_eq!(b["first_seen"], "2023-11-14T22:13:20.000Z");
    assert_eq!(b["last_seen"], "2023-11-14T22:14:10.000Z");

    let jobs = jobs_of(&state, JobKind::SyncAddress).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].priority, Priority::Interactive);
    assert_eq!(jobs[0].params["address"], hex(C));
    assert_eq!(jobs[0].params["direction"], "latest");

    // Unknown address: empty profile, still 200.
    let (s, b) = get(
        &app,
        &format!("/api/address/{}", hex(Address::repeat_byte(7))),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["node"]["kind"], "unknown");
    assert_eq!(b["is_proxy"], false);
    assert_eq!(b["first_seen"], Value::Null);

    let (s, b) = get(&app, "/api/address/0x1234").await;
    assert_invalid(s, &b);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn address_profile_stale_enqueues_background(pool: PgPool) {
    let (app, state, _) = test_app(pool.clone());
    mark_synced(&pool, A, 0, false).await;
    let (s, b) = get(&app, &format!("/api/address/{}", hex(A))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["node"]["synced"], true);
    assert_eq!(b["coverage"].as_array().unwrap().len(), 5);
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());

    mark_synced(&pool, B, 3600, false).await;
    let (s, _) = get(&app, &format!("/api/address/{}", hex(B))).await;
    assert_eq!(s, StatusCode::OK);
    let jobs = jobs_of(&state, JobKind::SyncAddress).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].priority, Priority::Background);
    assert_eq!(jobs[0].params["address"], hex(B));
}

#[test]
fn export_bindings_task19() {
    use eg_server::dto::*;
    use ts_rs::TS;
    let cfg = ts_rs::Config::from_env();
    SearchResultDto::export_all(&cfg).unwrap();
    GraphRequestDto::export_all(&cfg).unwrap();
    GraphResponseDto::export_all(&cfg).unwrap();
    AddressProfileDto::export_all(&cfg).unwrap();
    SyncRequestDto::export_all(&cfg).unwrap();
    SyncResponseDto::export_all(&cfg).unwrap();
    TransferPageDto::export_all(&cfg).unwrap();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/api/generated");
    for f in [
        "SearchResultDto",
        "EdgeFilterDto",
        "TimeRangeDto",
        "AssetFilterDto",
        "GraphRequestDto",
        "GraphResponseDto",
        "NodeSummaryDto",
        "EdgeDto",
        "SyncStatusDto",
        "LabelDto",
        "AddressProfileDto",
        "SyncRequestDto",
        "SyncResponseDto",
        "TransferDto",
        "TransferPageDto",
    ] {
        let text = std::fs::read_to_string(dir.join(format!("{f}.ts")))
            .unwrap_or_else(|e| panic!("{f}.ts: {e}"));
        assert!(!text.contains("bigint"), "{f}: {text}");
    }
}
