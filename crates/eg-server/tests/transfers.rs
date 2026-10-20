mod common;

use alloy_primitives::{Address, B256, U256};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use common::{post_json, test_app};
use eg_core::source::TokenInfo;
use eg_core::types::{Transfer, TransferKind, assign_sub_ids};
use eg_server::import_tokens::{TokenFormat, import_tokens};
use eg_server::state::AppState;
use serde_json::{Value, json};
use sqlx::PgPool;

const C: Address = Address::repeat_byte(0xc0);
const A: Address = Address::repeat_byte(0xa1);
const B: Address = Address::repeat_byte(0xb1);
const D: Address = Address::repeat_byte(0xd1);
const USDT: Address = Address::repeat_byte(0x55);
const T0: i64 = 1_700_000_000;

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

fn at(off: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(T0 + off, 0).unwrap()
}

fn tr(tx: u8, from: Address, to: Address, asset: Option<Address>, off: i64) -> Transfer {
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
        amount: U256::from(5),
        token_id: None,
        trace_id: None,
        log_index: None,
        call_index: None,
    }
}

async fn seed(state: &AppState, mut v: Vec<Transfer>) {
    assign_sub_ids(&mut v);
    state.store.upsert_transfers(&v).await.unwrap();
}

fn pair(from: Address, to: Address, asset: Option<Address>) -> Value {
    json!({"from": hex(from), "to": hex(to), "asset": asset.map(hex)})
}

fn hashes(b: &Value) -> Vec<String> {
    b["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["tx_hash"].as_str().unwrap().to_string())
        .collect()
}

fn h(tx: u8) -> String {
    format!("0x{}", format!("{tx:02x}").repeat(32))
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn batch_returns_transfers_of_the_listed_pairs_only(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, 0),
            tr(2, C, A, None, 30),
            tr(3, A, B, None, 20),
            tr(4, B, D, None, 10),
            tr(5, C, A, Some(USDT), 40), // same addresses, other asset
        ],
    )
    .await;
    let (s, b) = post_json(
        &app,
        "/api/transfers/batch",
        &json!({"pairs": [pair(C, A, None), pair(A, B, None), pair(C, A, None)], "filter": {}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(hashes(&b), vec![h(2), h(3), h(1)], "{b}");
    assert!(b["next_cursor"].is_null());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn batch_matches_edge_counts_under_the_same_filter(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(
        &state,
        vec![
            tr(1, C, A, Some(USDT), 0),
            tr(2, C, A, Some(USDT), 100),
            tr(3, C, A, Some(USDT), 5000),
            tr(4, B, C, Some(USDT), 200),
            tr(5, B, C, None, 200),
            tr(6, C, A, None, 200),
        ],
    )
    .await;
    let filter = json!({
        "time": {"from": at(50).to_rfc3339(), "to": at(1000).to_rfc3339()},
        "kinds": ["erc20"],
    });
    let (s, g) = post_json(
        &app,
        "/api/graph/edges",
        &json!({"addresses": [hex(C)], "filter": filter}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{g}");
    let edges = g["edges"].as_array().unwrap();
    assert!(!edges.is_empty());
    for e in edges {
        let asset = e["asset"].as_str().map(|a| a.parse::<Address>().unwrap());
        let p = pair(
            e["from"].as_str().unwrap().parse().unwrap(),
            e["to"].as_str().unwrap().parse().unwrap(),
            asset,
        );
        let (s, b) = post_json(
            &app,
            "/api/transfers/batch",
            &json!({"pairs": [p], "filter": filter}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert_eq!(
            b["items"].as_array().unwrap().len() as u64,
            e["count"].as_u64().unwrap(),
            "{e} vs {b}"
        );
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn batch_pages_with_a_cursor(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(
        &state,
        (1..=5).map(|i| tr(i, C, A, None, i as i64 * 10)).collect(),
    )
    .await;
    let mut seen = Vec::new();
    let mut cursor = Value::Null;
    let mut pages = 0;
    loop {
        let (s, b) = post_json(
            &app,
            "/api/transfers/batch",
            &json!({"pairs": [pair(C, A, None)], "filter": {}, "limit": 2, "cursor": cursor}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        pages += 1;
        seen.extend(hashes(&b));
        cursor = b["next_cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(pages, 3);
    assert_eq!(seen, vec![h(5), h(4), h(3), h(2), h(1)]);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn batch_rejects_empty_and_oversized_pair_lists(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let (s, b) = post_json(
        &app,
        "/api/transfers/batch",
        &json!({"pairs": [], "filter": {}}),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
    assert_eq!(b["error"]["code"], "invalid_input", "{b}");
    let many: Vec<Value> = (0..5001u32)
        .map(|i| {
            let mut a = [0u8; 20];
            a[16..].copy_from_slice(&i.to_be_bytes());
            pair(Address::from(a), A, None)
        })
        .collect();
    let (s, b) = post_json(
        &app,
        "/api/transfers/batch",
        &json!({"pairs": many, "filter": {}}),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
    assert_eq!(b["error"]["code"], "invalid_input", "{b}");
    let (s, b) = post_json(
        &app,
        "/api/transfers/batch",
        &json!({"pairs": [{"from": "nope", "to": hex(A), "asset": null}], "filter": {}}),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{b}");
    assert_eq!(b["error"]["code"], "invalid_input", "{b}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn batch_hide_suspicious_drops_flagged_tokens(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let fake = Address::repeat_byte(0xfa);
    let list = format!(
        r#"{{"tokens":[{{"chainId":1,"address":"{}","symbol":"USDT","name":"Tether USD"}}]}}"#,
        hex(USDT)
    );
    import_tokens(&state.store, TokenFormat::Uniswap, list.as_bytes())
        .await
        .unwrap();
    state
        .store
        .upsert_tokens(&[TokenInfo {
            address: fake,
            kind: TransferKind::Erc20,
            name: None,
            symbol: Some("USDT".into()),
            decimals: Some(6),
        }])
        .await
        .unwrap();
    seed(
        &state,
        vec![
            tr(1, B, C, Some(USDT), 10),
            tr(2, B, C, Some(fake), 20),
            tr(3, B, C, Some(fake), 30),
        ],
    )
    .await;
    let pairs = json!([pair(B, C, Some(USDT)), pair(B, C, Some(fake))]);
    let (s, b) = post_json(
        &app,
        "/api/transfers/batch",
        &json!({"pairs": pairs, "filter": {}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(hashes(&b).len(), 3);
    let (s, b) = post_json(
        &app,
        "/api/transfers/batch",
        &json!({"pairs": pairs, "filter": {"hide_suspicious": true}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(hashes(&b), vec![h(1)], "{b}");
}
