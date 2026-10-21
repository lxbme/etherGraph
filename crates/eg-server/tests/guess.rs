//! Calls and events no ABI covers, named from the local signature database
//! and marked guessed, only while `[signatures] enabled` is on (a switch in
//! shared state, flipped at runtime).

mod common;

use alloy_primitives::{Address, B256, Bytes, U256, keccak256};
use axum::http::StatusCode;
use chrono::{TimeZone, Utc};
use common::{gated_app_traced, get, test_app_traced};
use eg_core::source::{CallFrame, CallKind};
use eg_server::config::{Config, SignaturesCfg};
use eg_server::state::AppState;
use eg_store::{CallTraceRow, TxRow, upsert_signatures};
use serde_json::{Value, json};
use sqlx::PgPool;

const HASH: B256 = B256::repeat_byte(0x7a);
const SENDER: Address = Address::repeat_byte(0x51);
const CONTRACT: Address = Address::repeat_byte(0x52);
const EMITTER: Address = Address::repeat_byte(0x53);

/// `transfer(0x11…11, 1000)` calldata.
fn calldata() -> Bytes {
    let mut input = vec![0xa9, 0x05, 0x9c, 0xbb];
    input.extend_from_slice(Address::repeat_byte(0x11).into_word().as_slice());
    input.extend_from_slice(&U256::from(1000u32).to_be_bytes::<32>());
    Bytes::from(input)
}

/// A call into CONTRACT (no ABI) emitting one `Ping(uint256)` log, stored
/// with its trace (one root frame).
async fn store_tx(state: &AppState) {
    let ping = keccak256("Ping(uint256)");
    let receipt = json!({"status": "0x1", "gasUsed": "0x5208", "logs": [{
        "address": format!("{EMITTER:#x}"),
        "topics": [format!("{ping:#x}")],
        "data": format!("0x{:064x}", 9), "logIndex": "0x0"
    }]});
    let tx = TxRow {
        hash: HASH,
        block_number: 1,
        ts: Utc.timestamp_opt(1_760_000_000, 0).unwrap(),
        from: SENDER,
        to: Some(CONTRACT),
        value: U256::ZERO,
        selector: Some([0xa9, 0x05, 0x9c, 0xbb]),
        success: true,
        gas_used: U256::from(21_000u32),
        fee: U256::ZERO,
        raw_tx: json!({"hash": format!("{HASH:#x}"), "input": format!("{}", calldata())}),
        raw_receipt: receipt,
        revert_reason: None,
    };
    state.store.upsert_transaction(&tx).await.unwrap();
    let root = CallFrame {
        path: vec![],
        kind: CallKind::Call,
        from: SENDER,
        to: Some(CONTRACT),
        value: U256::ZERO,
        input: calldata(),
        output: None,
        gas: 50_000,
        gas_used: Some(21_000),
        error: None,
        subtraces: 0,
    };
    state
        .store
        .upsert_call_trace(&CallTraceRow {
            hash: HASH,
            frames: vec![root],
            delegates: Default::default(),
            source: "fake".into(),
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
}

async fn add_signatures(state: &AppState) {
    let texts = [
        "transfer(address,uint256)",
        "many_msg_babbage(bytes1)",
        "Ping(uint256)",
    ]
    .map(String::from);
    upsert_signatures(state.store.pool(), &texts).await.unwrap();
}

/// The tx view and the trace view.
async fn views(app: &axum::Router) -> (Value, Value) {
    let (st, tx) = get(app, &format!("/api/tx/{HASH:#x}")).await;
    assert_eq!(st, StatusCode::OK, "{tx}");
    assert_eq!(tx["status"], "ready", "{tx}");
    let (st, trace) = get(app, &format!("/api/tx/{HASH:#x}/trace")).await;
    assert_eq!(st, StatusCode::OK, "{trace}");
    assert_eq!(trace["status"], "ready", "{trace}");
    (tx["flow"].clone(), trace["frames"][0].clone())
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn guesses_follow_the_runtime_switch(pool: PgPool) {
    let (app, state, _, _) = test_app_traced(pool).await;
    store_tx(&state).await;
    add_signatures(&state).await;

    // Off by default: rows exist, yet nothing is looked up or marked.
    assert!(!state.signatures_enabled());
    let (flow, frame) = views(&app).await;
    assert!(flow["call"].is_null(), "{flow}");
    assert!(flow["events"][0]["name"].is_null());
    assert_eq!(flow["events"][0]["guessed"], false);
    assert!(flow["events"][0]["signature"].is_null());
    assert!(frame["call"].is_null(), "{frame}");

    // Switched on at runtime.
    state.set_signatures_enabled(true);
    let (flow, frame) = views(&app).await;
    let call = &flow["call"];
    assert_eq!(call["name"], "transfer", "{flow}");
    assert_eq!(call["signature"], "transfer(address,uint256)");
    assert_eq!(call["guessed"], true);
    assert_eq!(call["alternatives"], json!([]));
    assert_eq!(call["args"][0]["name"], "");
    assert_eq!(call["args"][1]["value"], "1000");
    assert!(call["via_delegate"].is_null());
    // `method` stays the ABI-decoded name only.
    assert!(flow["tx"]["method"].is_null());
    let ev = &flow["events"][0];
    assert_eq!(ev["name"], "Ping");
    assert_eq!(ev["signature"], "Ping(uint256)");
    assert_eq!(ev["guessed"], true);
    assert_eq!(ev["args"], json!([]));
    assert_eq!(frame["call"]["name"], "transfer", "{frame}");
    assert_eq!(frame["call"]["guessed"], true);
    assert!(frame["via_delegate"].is_null());

    state.set_signatures_enabled(false);
    let (flow, _) = views(&app).await;
    assert!(flow["call"].is_null());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn without_signature_rows_nothing_changes(pool: PgPool) {
    let (app, state, _, _) = test_app_traced(pool).await;
    store_tx(&state).await;
    let off = views(&app).await;
    state.set_signatures_enabled(true);
    let on = views(&app).await;
    assert_eq!(on, off);
    assert!(on.0["call"].is_null() && on.1["call"].is_null());
    assert_eq!(on.0["events"][0]["guessed"], false);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_switch_starts_from_the_config(pool: PgPool) {
    let cfg = Config {
        signatures: SignaturesCfg { enabled: true },
        ..Config::default()
    };
    let (_, state, _, _) = gated_app_traced(pool, cfg).await;
    assert!(state.signatures_enabled());
}
