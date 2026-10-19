//! `GET /api/tx/{hash}/trace`: the cached call trace, decoded, and the jobs a
//! view starts (the trace fetch, then a capped set of contract metadata).

mod common;

use std::collections::HashMap;

use alloy_primitives::{Address, B256, Bytes, U256, address, b256};
use alloy_sol_types::{Revert, SolError};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{TimeZone, Utc};
use common::{default_user_id, gated_app_traced, get, get_as, second_user, send, test_app_traced};
use eg_blockscout::parse_raw_trace;
use eg_core::source::{CallFrame, CallKind, Priority};
use eg_core::types::AccountKind;
use eg_ingest::JobHandler;
use eg_ingest::billing::billed;
use eg_ingest::handlers::FetchTraceHandler;
use eg_server::config::Config;
use eg_server::state::AppState;
use eg_store::{AccountRow, CallTraceRow, TxRow};
use serde_json::{Value, json};
use sqlx::PgPool;

/// Raw trace of the ENS ".eth" registration
/// 0x461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3.
const ENS: &str = include_str!("../../eg-blockscout/tests/data/ens_register.json");
const HASH: B256 = b256!("461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3");
/// The EIP-7702 delegated sender.
const SENDER: Address = address!("82eb45562f991329ed2867f43fc60f0ba52c3dab");
const CONTROLLER: Address = address!("253553366da8546fc250f225fe3d25d0c782303b");
const BASE_REGISTRAR: Address = address!("57f1887a8bf19b14fc0df6fd9b2acc9af147ea85");
const DELEGATE: Address = Address::repeat_byte(0xde);
/// A synthetic transaction (no stored tx row needed for a cached trace).
const SYNTH: B256 = B256::repeat_byte(0x5e);

const REGISTER_ABI: &str = r#"[{"type":"function","name":"register","stateMutability":"nonpayable",
  "inputs":[{"name":"id","type":"uint256"},{"name":"owner","type":"address"},
            {"name":"duration","type":"uint256"}],
  "outputs":[{"name":"","type":"uint256"}]}]"#;

const RECEIVER_ABI: &str = r#"[{"type":"function","name":"onERC1155Received","stateMutability":"nonpayable",
  "inputs":[{"name":"operator","type":"address"},{"name":"from","type":"address"},
            {"name":"id","type":"uint256"},{"name":"value","type":"uint256"},
            {"name":"data","type":"bytes"}],
  "outputs":[{"name":"","type":"bytes4"}]}]"#;

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
        value: root.value,
        selector: Some([0x74, 0x69, 0x4a, 0x2b]),
        success: true,
        gas_used: U256::from(0x3498du64),
        fee: U256::ZERO,
        raw_tx: json!({"hash": format!("{HASH:#x}"), "input": format!("{}", root.input)}),
        raw_receipt: json!({"status": "0x1"}),
        revert_reason: None,
    }
}

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

fn frame(path: &[u32], kind: CallKind, to: Address, subtraces: u32) -> CallFrame {
    CallFrame {
        path: path.to_vec(),
        kind,
        from: Address::repeat_byte(0x01),
        to: Some(to),
        value: U256::ZERO,
        input: Bytes::from(vec![0x12, 0x34, 0x56, 0x78]),
        output: None,
        gas: 100_000,
        gas_used: Some(21_000),
        error: None,
        subtraces,
    }
}

async fn cache(
    state: &AppState,
    hash: B256,
    frames: Vec<CallFrame>,
    delegates: &[(Address, Address)],
) {
    state
        .store
        .upsert_call_trace(&CallTraceRow {
            hash,
            frames,
            delegates: delegates.iter().copied().collect::<HashMap<_, _>>(),
            source: "fake".into(),
            fetched_at: Utc::now(),
        })
        .await
        .unwrap();
}

/// The frame at `path` in a `ready` response.
fn frame_at<'a>(v: &'a Value, path: &[u32]) -> &'a Value {
    v["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == json!(path))
        .unwrap_or_else(|| panic!("no frame {path:?} in {v}"))
}

async fn jobs_of_kind(state: &AppState, kind: &str) -> Vec<(Option<i64>, i16, Value)> {
    sqlx::query_as("SELECT user_id, priority, params FROM jobs WHERE kind = $1 ORDER BY id")
        .bind(kind)
        .fetch_all(state.store.pool())
        .await
        .unwrap()
}

async fn job_count(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs")
        .fetch_one(state.store.pool())
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn trace_pending_then_ready(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    state.store.upsert_transaction(&ens_tx()).await.unwrap();
    trace.set(HASH, Some(ens_frames()));
    let uri = format!("/api/tx/{HASH:#x}/trace");

    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "pending");
    assert!(v["frames"].is_null());
    let job_id = v["job_id"].as_i64().unwrap();
    let job = state.store.claim_next().await.unwrap().unwrap();
    assert_eq!(job.id, job_id);
    assert_eq!(job.kind.as_str(), "fetch_trace");
    assert_eq!(job.user_id, Some(default_user_id(&state).await));
    FetchTraceHandler.run(&job, &state.ctx).await.unwrap();
    state.store.complete_job(job.id).await.unwrap();

    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "ready");
    assert!(v["job_id"].is_null());
    assert_eq!(v["frames"].as_array().unwrap().len(), 17);
    let root = frame_at(&v, &[]);
    assert_eq!(root["kind"], "call");
    assert_eq!(root["from"], hex(SENDER));
    assert_eq!(root["to"], hex(CONTROLLER));
    assert_eq!(root["value"], ens_tx().value.to_string());
    assert!(root["input"].as_str().unwrap().starts_with("0x74694a2b"));
    assert!(root["gas"].is_u64() && root["gas_used"].is_u64(), "{root}");
    assert_eq!(frame_at(&v, &[0])["kind"], "staticcall");
    assert_eq!(frame_at(&v, &[4, 0])["kind"], "delegatecall");
    // No ABI stored: the raw selector stays, no name is made up.
    let reg = frame_at(&v, &[3, 0]);
    assert_eq!(reg["to"], hex(BASE_REGISTRAR));
    assert!(reg["call"].is_null(), "{reg}");
    assert!(reg["input"].as_str().unwrap().starts_with("0xfca247ac"));
    assert!(reg["revert"].is_null() && reg["error"].is_null());

    state
        .store
        .upsert_abi(BASE_REGISTRAR, Some(REGISTER_ABI))
        .await
        .unwrap();
    let (_, v) = get(&app, &uri).await;
    let call = &frame_at(&v, &[3, 0])["call"];
    assert_eq!(call["name"], "register", "{call}");
    assert_eq!(call["signature"], "register(uint256,address,uint256)");
    assert_eq!(call["args"][1]["name"], "owner");
    assert!(call["via_delegate"].is_null());
    assert!(frame_at(&v, &[3, 0])["via_delegate"].is_null());
    assert_eq!(frame_at(&v, &[3, 0])["via_delegate_current"], false);
}

/// Root → T0, its first 29 children → T1..T29 (30 distinct non-static
/// callees), then static calls to S0..S4, one of which (S0) makes a CALL to
/// S1: hidden by default, so S1 is static-only too.
fn wide_trace() -> (Vec<CallFrame>, Vec<Address>, Vec<Address>) {
    let t = |i: u8| Address::left_padding_from(&[0x10, i]);
    let s = |i: u8| Address::left_padding_from(&[0x20, i]);
    let mut frames = vec![frame(&[], CallKind::Call, t(0), 33)];
    for i in 0..29u8 {
        frames.push(frame(&[u32::from(i)], CallKind::Call, t(i + 1), 0));
    }
    frames.push(frame(&[29], CallKind::StaticCall, s(0), 1));
    frames.push(frame(&[29, 0], CallKind::Call, s(1), 0));
    for (i, p) in [(2u8, 30u32), (3, 31), (4, 32)] {
        frames.push(frame(&[p], CallKind::StaticCall, s(i), 0));
    }
    (frames, (0..30).map(t).collect(), (0..5).map(s).collect())
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn auto_meta_is_capped_at_20_and_skips_static_only_callees(pool: PgPool) {
    let (app, state, _, _) = test_app_traced(pool).await;
    let (frames, callees, statics) = wide_trace();
    cache(&state, SYNTH, frames, &[]).await;

    let (st, v) = get(&app, &format!("/api/tx/{SYNTH:#x}/trace")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "ready");
    assert_eq!(v["frames"].as_array().unwrap().len(), 35);
    let meta = jobs_of_kind(&state, "contract_meta").await;
    assert_eq!(meta.len(), 1, "{meta:?}");
    let (user, priority, params) = &meta[0];
    assert_eq!(*user, Some(default_user_id(&state).await));
    assert_eq!(*priority, Priority::Interactive.as_i16());
    let mut want: Vec<String> = callees[..20].iter().map(|a| hex(*a)).collect();
    want.sort();
    assert_eq!(params["addresses"], json!(want));
    let rest: Vec<String> = callees[20..].iter().map(|a| hex(*a)).collect();
    assert_eq!(v["undecoded"], json!(rest));
    for s in statics {
        let s = hex(s);
        assert!(!params.to_string().contains(&s), "{s} enqueued");
        assert!(!v["undecoded"].to_string().contains(&s), "{s} undecoded");
    }

    // A repeat view joins the same job; it never moves on to the rest.
    let (_, again) = get(&app, &format!("/api/tx/{SYNTH:#x}/trace")).await;
    assert_eq!(again["undecoded"], v["undecoded"]);
    assert_eq!(jobs_of_kind(&state, "contract_meta").await.len(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cross_site_get_starts_nothing(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    let uri = format!("/api/tx/{HASH:#x}/trace");
    let cross = || {
        Request::get(&uri)
            .header("sec-fetch-site", "cross-site")
            .body(Body::empty())
            .unwrap()
    };
    // Not even the transaction is stored.
    let (st, v) = get(&app, &uri).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
    assert_eq!(v["error"]["message"], "transaction not fetched");

    state.store.upsert_transaction(&ens_tx()).await.unwrap();
    trace.set(HASH, Some(ens_frames()));
    let (st, v) = send(&app, cross()).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
    assert_eq!(v["error"]["code"], "not_found");
    assert_eq!(v["error"]["message"], "trace not fetched");
    assert_eq!(job_count(&state).await, 0);
    assert_eq!(trace.calls(), 0);

    // A cached trace is served, still without queueing metadata.
    cache(&state, HASH, ens_frames(), &[]).await;
    let (st, v) = send(&app, cross()).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "ready");
    assert_eq!(job_count(&state).await, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cached_trace_costs_nothing(pool: PgPool) {
    let (app, state, _, trace) = gated_app_traced(pool, Config::default()).await;
    let a = default_user_id(&state).await;
    let (b, b_id) = second_user(&app, &state).await;
    state.store.upsert_transaction(&ens_tx()).await.unwrap();
    trace.set(HASH, Some(ens_frames()));
    let uri = format!("/api/tx/{HASH:#x}/trace");

    // A pays for the fetch.
    let (_, v) = get(&app, &uri).await;
    assert_eq!(v["status"], "pending", "{v}");
    let job = state.store.claim_next().await.unwrap().unwrap();
    billed(Some(a), FetchTraceHandler.run(&job, &state.ctx))
        .await
        .unwrap();
    state.store.complete_job(job.id).await.unwrap();
    assert_eq!(trace.calls(), 1);
    let paid = state.gate.user_quota(a).used;
    assert!(paid >= 1);

    // B reads it from the shared cache.
    let (st, v) = get_as(&app, &b, &uri).await;
    assert_eq!((st, &v["status"]), (StatusCode::OK, &json!("ready")), "{v}");
    assert_eq!(v["frames"].as_array().unwrap().len(), 17);
    assert_eq!(trace.calls(), 1);
    let fetches: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE user_id = $1 AND kind = 'fetch_trace'")
            .bind(b_id)
            .fetch_one(state.store.pool())
            .await
            .unwrap();
    assert_eq!(fetches, 0);
    assert_eq!(state.gate.user_quota(b_id).used, 0);
    assert_eq!(state.gate.user_quota(a).used, paid);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn delegate_abi_is_used_for_7702_callee(pool: PgPool) {
    let (app, state, _, _) = test_app_traced(pool).await;
    cache(&state, HASH, ens_frames(), &[(SENDER, DELEGATE)]).await;
    state
        .store
        .upsert_abi(DELEGATE, Some(RECEIVER_ABI))
        .await
        .unwrap();

    let (st, v) = get(&app, &format!("/api/tx/{HASH:#x}/trace")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let f = frame_at(&v, &[3, 1]);
    assert_eq!(f["to"], hex(SENDER));
    assert_eq!(f["call"]["name"], "onERC1155Received", "{f}");
    assert_eq!(f["call"]["via_delegate"], hex(DELEGATE));
    assert_eq!(f["via_delegate"], hex(DELEGATE));
    // Looked up from the sender's code when the trace was fetched (the tx
    // has no authorization list): today's delegation, said to be so.
    assert_eq!(f["via_delegate_current"], true);
    // The refund to the sender carries no calldata: nothing to decode, the
    // delegate's ABI is not used.
    let refund = frame_at(&v, &[5]);
    assert!(refund["call"].is_null());
    assert!(refund["via_delegate"].is_null(), "{refund}");
    assert_eq!(refund["via_delegate_current"], false);
    // The delegate is queued for metadata along with the sender.
    let meta = jobs_of_kind(&state, "contract_meta").await;
    let queued = meta[0].2["addresses"].as_array().unwrap();
    assert!(queued.contains(&json!(hex(SENDER))), "{queued:?}");
    assert!(queued.contains(&json!(hex(DELEGATE))), "{queued:?}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn revert_reason_is_decoded(pool: PgPool) {
    let (app, state, _, _) = test_app_traced(pool).await;
    let mut failed = frame(&[0], CallKind::Call, Address::repeat_byte(0x33), 0);
    failed.error = Some("Reverted".into());
    failed.output = Some(Bytes::from(Revert::from("nope").abi_encode()));
    let frames = vec![
        frame(&[], CallKind::Call, Address::repeat_byte(0x32), 1),
        failed,
    ];
    cache(&state, SYNTH, frames, &[]).await;

    let (st, v) = get(&app, &format!("/api/tx/{SYNTH:#x}/trace")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let f = frame_at(&v, &[0]);
    assert_eq!(f["error"], "Reverted");
    assert_eq!(f["revert"]["name"], "Error", "{f}");
    assert_eq!(f["revert"]["args"][0]["value"], "nope");
    assert!(f["output"].as_str().unwrap().starts_with("0x08c379a0"));
    assert!(frame_at(&v, &[])["revert"].is_null());
}

/// USDC's proxy, its implementation (FiatTokenV2_2) and the library Etherscan
/// records as that implementation's own "implementation" (SignatureChecker).
const USDC: Address = address!("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const FIAT_TOKEN: Address = address!("43506849d7c04f9138d1a2050bbf3a0c054402dd");
const SIGNATURE_CHECKER: Address = address!("800c32eaa2a6c93cf4cb51794450ed77fbfbb172");

const FIAT_TOKEN_PROXY_ABI: &str = r#"[{"type":"function","name":"admin","stateMutability":"view",
  "inputs":[],"outputs":[{"name":"","type":"address"}]}]"#;
const FIAT_TOKEN_ABI: &str = r#"[{"type":"function","name":"transfer","stateMutability":"nonpayable",
  "inputs":[{"name":"to","type":"address"},{"name":"value","type":"uint256"}],
  "outputs":[{"name":"","type":"bool"}]}]"#;
/// SignatureChecker's real ABI plus a same-selector `transfer` under other
/// argument names: decoding FiatToken's frames with it must not happen.
const SIGNATURE_CHECKER_ABI: &str = r#"[{"type":"function","name":"isValidSignatureNow","stateMutability":"view",
  "inputs":[{"name":"signer","type":"address"},{"name":"digest","type":"bytes32"},
            {"name":"signature","type":"bytes"}],
  "outputs":[{"name":"","type":"bool"}]},
  {"type":"function","name":"transfer","stateMutability":"nonpayable",
  "inputs":[{"name":"dst","type":"address"},{"name":"wad","type":"uint256"}],
  "outputs":[{"name":"","type":"bool"}]}]"#;

fn proxy_account(address: Address, implementation: Address) -> AccountRow {
    AccountRow {
        address,
        kind: AccountKind::Contract,
        contract_name: None,
        is_proxy: true,
        implementation: Some(implementation),
        creator: None,
        creation_tx: None,
        meta_fetched_at: Utc::now(),
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn delegatecall_into_usdcs_implementation_decodes_as_transfer(pool: PgPool) {
    let (app, state, _, _) = test_app_traced(pool).await;
    // transfer(0x77…77, 1_000_000)
    let mut input = vec![0xa9, 0x05, 0x9c, 0xbb];
    input.extend_from_slice(&[0; 12]);
    input.extend_from_slice(Address::repeat_byte(0x77).as_slice());
    input.extend_from_slice(&U256::from(1_000_000u64).to_be_bytes::<32>());
    let mut root = frame(&[], CallKind::Call, USDC, 1);
    root.input = Bytes::from(input.clone());
    let mut inner = frame(&[0], CallKind::DelegateCall, FIAT_TOKEN, 0);
    inner.from = USDC;
    inner.input = Bytes::from(input);
    cache(&state, SYNTH, vec![root, inner], &[]).await;
    state
        .store
        .upsert_accounts(&[
            proxy_account(USDC, FIAT_TOKEN),
            proxy_account(FIAT_TOKEN, SIGNATURE_CHECKER),
        ])
        .await
        .unwrap();
    for (addr, abi) in [
        (USDC, FIAT_TOKEN_PROXY_ABI),
        (FIAT_TOKEN, FIAT_TOKEN_ABI),
        (SIGNATURE_CHECKER, SIGNATURE_CHECKER_ABI),
    ] {
        state.store.upsert_abi(addr, Some(abi)).await.unwrap();
    }

    let (st, v) = get(&app, &format!("/api/tx/{SYNTH:#x}/trace")).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    for path in [&[][..], &[0]] {
        let f = frame_at(&v, path);
        assert_eq!(f["call"]["name"], "transfer", "{f}");
        assert_eq!(f["call"]["args"][1]["value"], "1000000", "{f}");
        assert_eq!(f["call"]["args"][0]["name"], "to", "{f}");
        assert!(f["via_delegate"].is_null(), "{f}");
    }
}
