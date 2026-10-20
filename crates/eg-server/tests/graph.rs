mod common;

use alloy_primitives::{Address, B256, Bytes, U256, address};
use alloy_sol_types::SolValue;
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use common::{default_user_id, delete, get, post_json, test_app};
use eg_core::source::{Priority, SourceError, TokenInfo};
use eg_core::types::{AccountKind, Transfer, TransferKind, assign_sub_ids};
use eg_server::import_tokens::{TokenFormat, import_tokens};
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
        call_index: None,
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
    let (app, _, _) = test_app(pool).await;
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
        // Half-length hash.
        "0x0123456789abcdef0123456789abcdef",
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
    let (app, state, fake) = test_app(pool).await;
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
    let (app, _, fake) = test_app(pool).await;
    let (s, b) = get(&app, "/api/search?q=a..eth").await;
    assert_invalid(s, &b);
    assert_eq!(fake.calls(), 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn search_ens_unresolved_404(pool: PgPool) {
    let (app, _, fake) = test_app(pool).await;
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
async fn hide_suspicious_filters_flagged_tokens_in_the_query(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let fake = Address::repeat_byte(0xfa);
    let list = format!(
        r#"{{"tokens":[{{"chainId":1,"address":"{}","symbol":"USDT","name":"Tether USD"}}]}}"#,
        hex(USDT)
    );
    import_tokens(&state.store, TokenFormat::Uniswap, list.as_bytes())
        .await
        .unwrap();
    token(&state, fake, "USDT", Some(6)).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(5), 0),
            tr(2, B, C, Some(USDT), U256::from(9), 10),
            tr(3, B, C, Some(fake), U256::from(9), 20),
            tr(4, B, C, Some(fake), U256::from(9), 30),
        ],
    )
    .await;
    let assets = |b: &Value| -> Vec<Value> {
        let mut v: Vec<Value> = b["edges"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["asset"].clone())
            .collect();
        v.sort_by_key(|x| x.to_string());
        v
    };
    for filter in [json!({}), json!({"hide_suspicious": false})] {
        let (s, b) = post_json(
            &app,
            "/api/graph/edges",
            &json!({"addresses": [hex(C)], "filter": filter}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert_eq!(assets(&b).len(), 3, "{b}");
    }
    let (s, b) = post_json(
        &app,
        "/api/graph/edges",
        &json!({"addresses": [hex(C)], "filter": {"hide_suspicious": true}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let mut want = vec![Value::Null, json!(hex(USDT))];
    want.sort_by_key(|x| x.to_string());
    assert_eq!(assets(&b), want, "{b}");
    // Filtered before the per-center limit: the one slot goes to a kept edge
    // and nothing is counted as omitted for the excluded token.
    let (s, b) = post_json(
        &app,
        "/api/graph/edges",
        &json!({"addresses": [hex(C)], "filter": {"hide_suspicious": true},
                "limit_per_address": 1, "sort": "count"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["edges"].as_array().unwrap().len(), 1, "{b}");
    assert_eq!(b["omitted"][hex(C)], json!(1), "{b}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn nodes_endpoint_returns_summaries_in_request_order_without_jobs(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(&state, vec![tr(1, C, A, None, U256::from(5), 0)]).await;
    let before = state.store.active_jobs().await.unwrap().len();
    let (s, b) = post_json(
        &app,
        "/api/nodes",
        &json!({"addresses": [hex(B), hex(C), hex(A)]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let got: Vec<&str> = b
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["address"].as_str().unwrap())
        .collect();
    assert_eq!(got, [hex(B), hex(C), hex(A)]);
    assert_eq!(state.store.active_jobs().await.unwrap().len(), before);
    for n in [0usize, 2001] {
        let addrs: Vec<String> = (0..n).map(|_| hex(A)).collect();
        let (s, _) = post_json(&app, "/api/nodes", &json!({"addresses": addrs})).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{n} addresses");
    }
    let (s, _) = post_json(&app, "/api/nodes", &json!({"addresses": ["0x12"]})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

fn contract(address: Address, implementation: Option<Address>) -> AccountRow {
    AccountRow {
        address,
        kind: AccountKind::Contract,
        contract_name: None,
        is_proxy: implementation.is_some(),
        implementation,
        creator: None,
        creation_tx: None,
        meta_fetched_at: Utc::now(),
    }
}

/// The node with `addr` in a `/api/nodes` response.
fn node_of(b: &Value, addr: Address) -> &Value {
    b.as_array()
        .unwrap()
        .iter()
        .find(|n| n["address"] == hex(addr))
        .unwrap_or_else(|| panic!("{} missing from {b}", hex(addr)))
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn nodes_say_when_they_are_tokens_or_proxies(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    // USDC as Etherscan records it: the proxy's implementation FiatTokenV2_2
    // is itself flagged a proxy of the SignatureChecker library.
    let usdc = address!("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    let fiat = address!("43506849d7c04f9138d1a2050bbf3a0c054402dd");
    let checker = address!("800c32eaa2a6c93cf4cb51794450ed77fbfbb172");
    // A genuine proxy whose implementation implements no one else.
    let (vault, vault_impl) = (Address::repeat_byte(0x71), Address::repeat_byte(0x72));
    let nft = Address::repeat_byte(0x73);
    state
        .store
        .upsert_accounts(&[
            contract(usdc, Some(fiat)),
            contract(fiat, Some(checker)),
            contract(checker, None),
            contract(vault, Some(vault_impl)),
            contract(vault_impl, None),
        ])
        .await
        .unwrap();
    let info = |address, kind, symbol: &str, decimals| TokenInfo {
        address,
        kind,
        name: None,
        symbol: Some(symbol.into()),
        decimals,
    };
    state
        .store
        .upsert_tokens(&[
            info(usdc, TransferKind::Erc20, "USDC", Some(6)),
            info(nft, TransferKind::Erc721, "PNK", None),
        ])
        .await
        .unwrap();

    // Many nodes, one response: the token rows come from one batched query.
    let mut addrs: Vec<String> = (0..1990u32)
        .map(|i| {
            let mut b = [0x10u8; 20];
            b[16..].copy_from_slice(&i.to_be_bytes());
            hex(Address::from(b))
        })
        .collect();
    addrs.extend([usdc, fiat, checker, vault, vault_impl, nft, A].map(hex));
    let (s, b) = post_json(&app, "/api/nodes", &json!({ "addresses": addrs })).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let n = node_of(&b, usdc);
    assert_eq!(n["is_proxy"], true, "{n}");
    assert_eq!(
        n["token"],
        json!({"standard": "erc20", "symbol": "USDC", "decimals": 6}),
        "{n}"
    );
    let n = node_of(&b, nft);
    assert_eq!(
        n["token"],
        json!({"standard": "erc721", "symbol": "PNK", "decimals": null}),
        "{n}"
    );
    assert_eq!(node_of(&b, vault)["is_proxy"], true, "{b}");
    for a in [fiat, checker, vault_impl, nft, A] {
        assert_eq!(node_of(&b, a)["is_proxy"], false, "{}", node_of(&b, a));
    }
    assert!(node_of(&b, A)["token"].is_null(), "{b}");

    // Asked for alone, the implementation is still no proxy: the proxies it
    // implements are looked up even when they are not among the nodes.
    let (s, b) = post_json(&app, "/api/nodes", &json!({ "addresses": [hex(fiat)] })).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(node_of(&b, fiat)["is_proxy"], false, "{b}");
    let (s, b) = get(&app, &format!("/api/address/{}", hex(usdc))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["node"]["is_proxy"], true, "{b}");
    assert_eq!(b["node"]["token"]["decimals"], 6, "{b}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_edges_carry_each_assets_trust(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let fake = Address::repeat_byte(0xfa);
    let spam = Address::repeat_byte(0x5a);
    let labeled = Address::repeat_byte(0x5b);
    let plain = Address::repeat_byte(0x5c);
    let list = format!(
        r#"{{"tokens":[{{"chainId":1,"address":"{}","symbol":"USDT","name":"Tether USD"}}]}}"#,
        hex(USDT)
    );
    import_tokens(&state.store, TokenFormat::Uniswap, list.as_bytes())
        .await
        .unwrap();
    let csv = format!(
        "address,chainId,label,name,symbol,website,image\n{},1,spam-token,Spam,SPM,,x\n",
        hex(spam)
    );
    import_tokens(&state.store, TokenFormat::EthLabels, csv.as_bytes())
        .await
        .unwrap();
    state
        .store
        .replace_import("d", &[(labeled, "Fake airdrop".into(), "scam".into())])
        .await
        .unwrap();
    token(&state, fake, "USDT", Some(6)).await;
    token(&state, plain, "PLN", Some(18)).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(5), 0),
            tr(2, B, C, Some(USDT), U256::from(9), 10),
            tr(3, B, C, Some(fake), U256::from(9), 20),
            tr(4, B, C, Some(spam), U256::from(9), 30),
            tr(5, B, C, Some(labeled), U256::from(9), 40),
            tr(6, B, C, Some(plain), U256::from(9), 50),
        ],
    )
    .await;
    let (s, b) = post_json(&app, "/api/graph/edges", &json!({"addresses": [hex(C)]})).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let trust = |asset: Value| {
        b["edges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["asset"] == asset)
            .unwrap()["trust"]
            .clone()
    };
    let level = |l: &str| json!({"level": l, "impersonates": null, "reason": null});
    assert_eq!(trust(Value::Null), level("listed"));
    assert_eq!(trust(json!(hex(USDT))), level("listed"));
    assert_eq!(
        trust(json!(hex(fake))),
        json!({
            "level": "suspicious",
            "impersonates": {"address": hex(USDT), "symbol": "USDT", "name": "Tether USD"},
            "reason": null,
        })
    );
    assert_eq!(
        trust(json!(hex(spam))),
        json!({"level": "scam", "impersonates": null, "reason": "spam-token"})
    );
    assert_eq!(
        trust(json!(hex(labeled))),
        json!({"level": "scam", "impersonates": null, "reason": "scam-label"})
    );
    assert_eq!(trust(json!(hex(plain))), level("unknown"));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_dry_run_enqueues_nothing_and_matches_the_real_response(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(5), 0),
            tr(2, C, A, None, U256::from(7), 10),
            tr(3, B, C, Some(USDT), U256::from(9), 20),
        ],
    )
    .await;
    let before = state.store.active_jobs().await.unwrap().len();
    let body = json!({"addresses": [hex(C)], "limit_per_address": 1});
    let mut dry = body.clone();
    dry["dry_run"] = json!(true);
    let (s, d) = post_json(&app, "/api/graph/edges", &dry).await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(state.store.active_jobs().await.unwrap().len(), before);

    let (s, r) = post_json(&app, "/api/graph/edges", &body).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert!(
        state.store.active_jobs().await.unwrap().len() > before,
        "the real call must enqueue"
    );
    for f in ["nodes", "edges", "omitted"] {
        assert_eq!(d[f], r[f], "{f}");
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_edges_returns_nodes_and_enqueues_meta(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
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
            "from": hex(C), "to": hex(A), "asset": null, "asset_kind": "native",
            "count": 2, "sum": "12",
            "first_ts": "2023-11-14T22:13:20.000Z", "last_ts": "2023-11-14T22:13:30.000Z",
            "decimals": 18, "symbol": "ETH",
            "trust": {"level": "listed", "impersonates": null, "reason": null},
        })
    );
    let usdt = edges.iter().find(|e| e["asset"] == hex(USDT)).unwrap();
    assert_eq!(usdt["decimals"], Value::Null);
    assert_eq!(usdt["asset_kind"], "erc20");
    assert_eq!(b["omitted"], json!({}));
    let coverage = b["coverage"].as_object().unwrap();
    assert_eq!(coverage.len(), 3);
    assert_eq!(coverage[&hex(C)], json!([]));

    let meta = jobs_of(&state, JobKind::ContractMeta).await;
    let names = jobs_of(&state, JobKind::ResolveNames).await;
    let tokens = jobs_of(&state, JobKind::TokenMeta).await;
    // Only the center is identified automatically.
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].params["addresses"], json!([hex(C)]));
    assert!(!names.is_empty());
    assert_eq!(tokens.len(), 1);
    assert_eq!(tokens[0].params["tokens"], json!([hex(USDT)]));
    for j in meta.iter().chain(&names).chain(&tokens) {
        assert_eq!(j.priority, Priority::Low);
    }
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_auto_meta_only_for_the_center(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let others = [A, B, USDT, Address::repeat_byte(0x77)];
    seed(
        &state,
        others
            .iter()
            .enumerate()
            .map(|(i, o)| tr(i as u8 + 1, C, *o, None, U256::from(1), 0))
            .collect(),
    )
    .await;
    let (s, b) = post_json(&app, "/api/graph/edges", &json!({"addresses": [hex(C)]})).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["nodes"].as_array().unwrap().len(), 5);
    let meta = jobs_of(&state, JobKind::ContractMeta).await;
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].params["addresses"], json!([hex(C)]));
    // Names are still resolved for every node.
    let names = jobs_of(&state, JobKind::ResolveNames).await;
    let listed: usize = names
        .iter()
        .map(|j| j.params["addresses"].as_array().unwrap().len())
        .sum();
    assert_eq!(listed, 5);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_node_flags_and_names(pool: PgPool) {
    let (app, state, _) = test_app(pool.clone()).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, B, C, None, U256::from(1), 0),
        ],
    )
    .await;
    let me = default_user_id(&state).await;
    state
        .store
        .add_user_label(me, A, "Binance 14", "cex")
        .await
        .unwrap();
    state
        .store
        .add_user_label(me, A, "second", "other")
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
    // The viewer's own sync of C is under way (another user's would not show).
    let (s, v) = post_json(&app, "/api/sync", &json!({"addresses": [hex(C)]})).await;
    assert_eq!(s, StatusCode::OK, "{v}");

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
    assert_eq!(labels[0]["category"], "cex");
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
            "oldest_ts": "2023-11-14T22:13:20.000Z",
        })
    );
    assert!(cov[0]["last_synced_at"].is_string());
    // The center has fresh metadata; neighbours are never auto-identified.
    assert!(jobs_of(&state, JobKind::ContractMeta).await.is_empty());
    assert_eq!(c["identified"], true);
    assert_eq!(a["identified"], false);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_hot_by_neighbour_count(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
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
    let (app, state, _) = test_app(pool).await;
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
    let (app, state, _) = test_app(pool).await;
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
    let (app, state, _) = test_app(pool).await;
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
    let (app, state, _) = test_app(pool).await;
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
        json!({"addresses": [hex(C)], "limits": {hex(A): 3}}),
        json!({"addresses": [hex(C)], "limits": {"0x12": 3}}),
        json!({"addresses": [hex(C)], "prefer": ["0x12"]}),
        json!({"addresses": [hex(C)], "prefer": vec![hex(A); 2001]}),
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

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_limits_and_prefer(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, C, A, None, U256::from(1), 10),
            tr(3, C, B, None, U256::from(1), 20),
        ],
    )
    .await;
    // Upper-case hex keys are accepted; `limits` and `prefer` apply.
    let body = json!({
        "addresses": [hex(C)],
        "limits": {hex(C).to_uppercase().replace("0X", "0x"): 1},
        "prefer": [hex(B).to_uppercase().replace("0X", "0x"), hex(Address::repeat_byte(0x77))],
    });
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let edges = b["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 1, "{b}");
    assert_eq!(edges[0]["to"], hex(B));
    assert_eq!(b["omitted"][hex(C)], 1);

    // A limits value above the maximum is clamped, not rejected.
    let body = json!({"addresses": [hex(C)], "limits": {hex(C): 5000}});
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["edges"].as_array().unwrap().len(), 2);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_edges_picks_show_only_the_chosen_neighbours(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, C, A, None, U256::from(1), 10),
            tr(3, C, B, None, U256::from(1), 20),
        ],
    )
    .await;
    // Upper-case hex is accepted; B is shown though A ranks first.
    let body = json!({
        "addresses": [hex(C)],
        "picks": {hex(C).to_uppercase().replace("0X", "0x"): [hex(B).to_uppercase().replace("0X", "0x")]},
    });
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    let edges = b["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 1, "{b}");
    assert_eq!(edges[0]["to"], hex(B));
    assert_eq!(b["omitted"][hex(C)], 1);

    // An empty list shows no neighbour at all.
    let body = json!({"addresses": [hex(C)], "picks": {hex(C): []}});
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["edges"], json!([]));
    assert_eq!(b["omitted"][hex(C)], 2);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_edges_rejects_picks_for_unknown_center(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let body = json!({"addresses": [hex(C)], "picks": {hex(A): [hex(B)]}});
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_invalid(s, &b);
    assert_eq!(
        b["error"]["message"],
        format!("picks key {} is not in addresses", hex(A))
    );
    for body in [
        json!({"addresses": [hex(C)], "picks": {"0x12": []}}),
        json!({"addresses": [hex(C)], "picks": {hex(C): ["0x12"]}}),
        json!({"addresses": [hex(C)], "picks": {hex(C): "nope"}}),
    ] {
        let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
        assert_invalid(s, &b);
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn graph_edges_rejects_too_many_picks(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    // The limit counts listed addresses across all centers: 50 centers × 1000 neighbours each.
    let body = json!({
        "addresses": [hex(C), hex(A)],
        "picks": {hex(C): vec![hex(B); 30000], hex(A): vec![hex(B); 20001]},
    });
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_invalid(s, &b);
    assert_eq!(
        b["error"]["message"],
        "at most 50000 picked addresses, got 50001"
    );
    let body = json!({
        "addresses": [hex(C), hex(A)],
        "picks": {hex(C): vec![hex(B); 30000], hex(A): vec![hex(B); 20000]},
    });
    let (s, b) = post_json(&app, "/api/graph/edges", &body).await;
    assert_eq!(s, StatusCode::OK, "{b}");
}

// ---------------------------------------------------------------- sync

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_dry_run_estimates(pool: PgPool) {
    let (app, state, _) = test_app(pool.clone()).await;
    mark_synced(&pool, B, 0, true).await;
    let (s, b) = post_json(
        &app,
        "/api/sync",
        &json!({"addresses": [hex(A), hex(B), hex(C)], "dry_run": true}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    // eth_blockNumber + 5 first pages for each never-synced address.
    assert_eq!(b["estimated_calls"], 12);
    let secs = b["estimated_seconds"].as_f64().unwrap();
    assert!((secs - 12.0 / 2.5).abs() < 1e-9, "{secs}");
    assert_eq!(b["per_address"], json!({hex(A): 6, hex(B): 0, hex(C): 6}));
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
    assert_eq!(b["per_address"], json!({hex(B): 5}));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn sync_enqueues_background_jobs(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let (s, b) = post_json(
        &app,
        "/api/sync",
        &json!({"addresses": [hex(A), hex(B)], "direction": "older"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["estimated_calls"], Value::Null);
    assert_eq!(b["per_address"], Value::Null);
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
    let (app, _, _) = test_app(pool).await;
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
    let (app, state, _) = test_app(pool).await;
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
            "trust": {"level": "listed", "impersonates": null, "reason": null},
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
async fn transfers_direction_for_address_scope(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 0),
            tr(2, C, B, None, U256::from(2), 10),
            tr(3, A, C, None, U256::from(3), 20),
        ],
    )
    .await;
    let c = hex(C);
    let amounts = |b: &Value| -> Vec<String> {
        b["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["amount"].as_str().unwrap().to_owned())
            .collect()
    };
    for (dir, want) in [
        ("in", vec!["3"]),
        ("out", vec!["2", "1"]),
        ("both", vec!["3", "2", "1"]),
    ] {
        let (s, b) = get(&app, &format!("/api/transfers?address={c}&direction={dir}")).await;
        assert_eq!(s, StatusCode::OK, "{dir}: {b}");
        assert_eq!(amounts(&b), want, "{dir}");
    }
    // Only meaningful for the address scope; unknown values are rejected.
    for q in [
        format!("from={c}&to={}&direction=in", hex(A)),
        format!("address={c}&direction=sideways"),
    ] {
        let (s, b) = get(&app, &format!("/api/transfers?{q}")).await;
        assert_invalid(s, &b);
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn amounts_are_decimal_strings(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
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
    let (app, state, _) = test_app(pool).await;
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
    // Viewing a profile never starts a first sync on its own.
    let (s, b) = get(&app, &format!("/api/address/{}", hex(C))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());
    let (s, _) = get(&app, &format!("/api/address/{}?sync=none", hex(C))).await;
    assert_eq!(s, StatusCode::OK);
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());

    let (s, b) = get(&app, &format!("/api/address/{}?sync=auto", hex(C))).await;
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
    let (s, b) = get(&app, &format!("/api/address/{}?sync=always", hex(C))).await;
    assert_invalid(s, &b);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn address_profile_failed_kind_does_not_resync(pool: PgPool) {
    let (app, state, _) = test_app(pool.clone()).await;
    mark_synced(&pool, A, 0, false).await;
    // ERC-1155 failed permanently: never covered, never synced.
    sqlx::query(
        "UPDATE address_sync SET from_block = NULL, to_block = NULL, state = 'failed', \
         last_synced_at = NULL WHERE address = $1 AND kind = $2",
    )
    .bind(A.as_slice().to_vec())
    .bind(TransferKind::Erc1155.as_i16())
    .execute(&pool)
    .await
    .unwrap();
    let (s, b) = get(&app, &format!("/api/address/{}", hex(A))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["node"]["synced"], false);
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());

    // From search the user asked for it: a full Interactive sync.
    let (s, _) = get(&app, &format!("/api/address/{}?sync=auto", hex(A))).await;
    assert_eq!(s, StatusCode::OK);
    let jobs = jobs_of(&state, JobKind::SyncAddress).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].priority, Priority::Interactive);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn profile_of_a_stale_synced_address_queues_nothing(pool: PgPool) {
    let (app, state, _) = test_app(pool.clone()).await;
    mark_synced(&pool, A, 0, false).await;
    let (s, b) = get(&app, &format!("/api/address/{}", hex(A))).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["node"]["synced"], true);
    assert_eq!(b["coverage"].as_array().unwrap().len(), 5);
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());

    // Coverage older than `stale_after`: refreshing is the user's click.
    mark_synced(&pool, B, 3600, false).await;
    for q in ["", "?sync=none", "?sync=auto"] {
        let (s, b) = get(&app, &format!("/api/address/{}{q}", hex(B))).await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert_eq!(b["node"]["synced"], true);
    }
    assert!(jobs_of(&state, JobKind::SyncAddress).await.is_empty());
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
        "NodeTokenDto",
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

// ---------------------------------------------------------------- rejections

const BAD_CHECKSUM: &str = "0xd8Da6BF26964aF9D7eEd9e03E53415D37aA96045";

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn extractor_rejections_are_json_invalid_input(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let a = hex(A);
    for uri in [
        "/api/search?q=a&q=b".to_owned(),
        format!("/api/transfers?address={a}&limit=1&limit=2"),
        format!("/api/transfers?address={a}&kinds=native&kinds=erc20"),
        "/api/address/%FF".to_owned(),
        "/api/jobs?active=true&active=true".to_owned(),
    ] {
        let (s, b) = get(&app, &uri).await;
        assert_invalid(s, &b);
    }
    let (s, b) = delete(&app, "/api/jobs/%FF").await;
    assert_invalid(s, &b);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn wrong_method_is_json_405(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let (s, b) = get(&app, "/api/graph/edges").await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED, "{b}");
    assert_eq!(
        b,
        json!({"error": {"code": "invalid_input", "message": "method not allowed"}})
    );
    let (s, b) = post_json(&app, "/api/search?q=x", &json!({})).await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED, "{b}");
    assert_eq!(b["error"]["code"], "invalid_input");
    let (s, b) = delete(&app, "/api/sync").await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED, "{b}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn search_emoji_ens_revert_is_404(pool: PgPool) {
    let (app, _, fake) = test_app(pool).await;
    fake.on_eth_call(|_, _| {
        Err(SourceError::Rpc {
            code: 3,
            message: "execution reverted".into(),
        })
    });
    let (s, b) = get(&app, "/api/search?q=%F0%9F%A6%8A.eth").await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{b}");
    assert_eq!(b["error"]["code"], "not_found");
    assert_eq!(fake.calls(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn search_ens_undecodable_response_is_502(pool: PgPool) {
    let (app, _, fake) = test_app(pool).await;
    fake.on_eth_call(|_, _| Ok(Bytes::from(vec![1, 2, 3])));
    let (s, b) = get(&app, "/api/search?q=vitalik.eth").await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{b}");
    assert_eq!(b["error"]["code"], "upstream_error");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn bad_checksum_rejected_on_transfers_and_address(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let a = hex(A);
    for uri in [
        format!("/api/transfers?address={BAD_CHECKSUM}"),
        format!("/api/transfers?from={BAD_CHECKSUM}&to={a}"),
        format!("/api/transfers?from={a}&to={BAD_CHECKSUM}"),
        format!("/api/address/{BAD_CHECKSUM}"),
    ] {
        let (s, b) = get(&app, &uri).await;
        assert_invalid(s, &b);
        assert!(
            b["error"]["message"].as_str().unwrap().contains("checksum"),
            "{uri}: {b}"
        );
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn tokens_without_decimals_are_not_requeued(pool: PgPool) {
    use eg_ingest::JobHandler;
    use eg_ingest::handlers::TokenMetaHandler;
    let (app, state, fake) = test_app(pool).await;
    const NFT: Address = Address::repeat_byte(0x77);
    let mut punk = tr(1, C, A, Some(NFT), U256::from(1), 0);
    punk.kind = TransferKind::Erc721;
    punk.token_id = Some(U256::from(9));
    seed(&state, vec![punk]).await;
    state
        .store
        .upsert_tokens(&[TokenInfo {
            address: NFT,
            kind: TransferKind::Erc721,
            name: Some("Punk".into()),
            symbol: Some("PNK".into()),
            decimals: None,
        }])
        .await
        .unwrap();
    // Every sub-call reverts, as decimals() does on an NFT contract.
    fake.on_eth_call(|_, _| Ok(vec![(false, Bytes::new()); 3].abi_encode().into()));

    let req = json!({"addresses": [hex(C)]});
    let (s, b) = post_json(&app, "/api/graph/edges", &req).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["edges"][0]["asset_kind"], "erc721", "{b}");
    let jobs = jobs_of(&state, JobKind::TokenMeta).await;
    assert_eq!(jobs.len(), 1);
    let job = &jobs[0];
    assert_eq!(job.params["tokens"], json!([hex(NFT)]));
    TokenMetaHandler.run(job, &state.ctx).await.unwrap();
    state.store.complete_job(job.id).await.unwrap();
    let t = state.store.tokens(&[NFT]).await.unwrap();
    assert_eq!(t[0].kind, TransferKind::Erc721);
    assert_eq!(t[0].decimals, None);

    let (s, b) = post_json(&app, "/api/graph/edges", &req).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert!(jobs_of(&state, JobKind::TokenMeta).await.is_empty());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn transfers_min_amount_matches_edge_threshold(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let unknown = Address::repeat_byte(0x66);
    token(&state, USDT, "USDT", Some(6)).await;
    token(&state, unknown, "UNK", None).await;
    seed(
        &state,
        vec![
            tr(1, C, A, Some(USDT), U256::from(1_500_000), 0),
            tr(2, C, A, Some(USDT), U256::from(3_000_000), 10),
            tr(3, C, A, Some(USDT), U256::from(10_000_000), 20),
            tr(4, C, B, None, U256::from(10u64.pow(18)), 30),
            tr(5, C, B, None, U256::from(10u64.pow(17)), 40),
        ],
    )
    .await;
    let c = hex(C);
    for (asset, min, want) in [(hex(USDT), "2", 2), ("eth".to_owned(), "0.5", 1)] {
        let filter = json!({"assets": [{"asset": asset, "min_amount": min}]});
        let (s, b) = post_json(&app, "/api/graph/edges", &graph_req(filter)).await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert_eq!(b["edges"].as_array().unwrap().len(), 1, "{b}");
        assert_eq!(b["edges"][0]["count"], want, "{b}");
        let (s, b) = get(
            &app,
            &format!("/api/transfers?address={c}&asset={asset}&min_amount={min}"),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{b}");
        assert_eq!(b["items"].as_array().unwrap().len(), want, "{b}");
    }
    for q in [
        "min_amount=1".to_owned(),
        format!("asset={}&min_amount=1", hex(unknown)),
        format!("asset={}&min_amount=-1", hex(USDT)),
        format!("asset={}&min_amount=0.0000001", hex(USDT)),
    ] {
        let (s, b) = get(&app, &format!("/api/transfers?address={c}&{q}")).await;
        assert_invalid(s, &b);
    }
}

// ------------------------------------------------------- counterparties

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn counterparties_sort_page_kind_and_limits(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    let d = Address::repeat_byte(0xd1);
    token(&state, USDT, "USDT", Some(6)).await;
    // A: 3 transfers (latest at 30), B: 1 (at 40), D: 2 (at 20, a contract).
    seed(
        &state,
        vec![
            tr(1, C, A, None, U256::from(1), 10),
            tr(2, A, C, Some(USDT), U256::from(2), 20),
            tr(3, C, A, None, U256::from(3), 30),
            tr(4, C, B, None, U256::from(4), 40),
            tr(5, C, d, None, U256::from(5), 15),
            tr(6, d, C, None, U256::from(6), 20),
        ],
    )
    .await;
    state
        .store
        .upsert_accounts(&[AccountRow {
            address: d,
            kind: AccountKind::Contract,
            contract_name: None,
            is_proxy: false,
            implementation: None,
            creator: None,
            creation_tx: None,
            meta_fetched_at: Utc::now(),
        }])
        .await
        .unwrap();
    let base = format!("/api/address/{}/counterparties", hex(C));
    let order = |b: &Value| -> Vec<String> {
        b["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["node"]["address"].as_str().unwrap().to_owned())
            .collect()
    };

    let (s, b) = get(&app, &format!("{base}?sort=count_desc")).await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["total"], 3);
    assert_eq!(order(&b), vec![hex(A), hex(d), hex(B)]);
    assert_eq!(b["items"][0]["count"], 3);
    assert_eq!(b["items"][0]["node"]["kind"], "unknown");
    assert_eq!(b["items"][1]["node"]["kind"], "contract");
    assert!(b["items"][0]["last_ts"].as_str().unwrap().ends_with('Z'));
    let assets = b["items"][0]["assets"].as_array().unwrap();
    let listed = json!({"level": "listed", "impersonates": null, "reason": null});
    let unknown = json!({"level": "unknown", "impersonates": null, "reason": null});
    assert!(assets.contains(&json!({"asset": null, "symbol": "ETH", "trust": listed})));
    assert!(assets.contains(&json!({"asset": hex(USDT), "symbol": "USDT", "trust": unknown})));

    let (_, b) = get(&app, &format!("{base}?sort=count_asc&limit=2&offset=1")).await;
    assert_eq!(b["total"], 3);
    assert_eq!(order(&b), vec![hex(d), hex(A)]);
    let (_, b) = get(&app, &format!("{base}?sort=recent")).await;
    assert_eq!(order(&b), vec![hex(B), hex(A), hex(d)]);

    // Default sort and kind=all work; kind narrows; unknown counts as eoa.
    let (s, b) = get(&app, &format!("{base}?kind=all")).await;
    assert_eq!((s, b["total"].clone()), (StatusCode::OK, json!(3)));
    let (_, b) = get(&app, &format!("{base}?kind=contract")).await;
    assert_eq!((order(&b), b["total"].clone()), (vec![hex(d)], json!(1)));
    let (_, b) = get(&app, &format!("{base}?kind=eoa&sort=count_desc")).await;
    assert_eq!(order(&b), vec![hex(A), hex(B)]);

    // Time window.
    let from = at(25).to_rfc3339();
    let (_, b) = get(
        &app,
        &format!("{base}?sort=count_desc&from={}", from.replace('+', "%2B")),
    )
    .await;
    assert_eq!(order(&b), vec![hex(A), hex(B)]);
    assert_eq!(b["items"][0]["count"], 1);

    // Validation.
    for q in [
        "limit=1001",
        "limit=abc",
        "limit=0",
        "sort=bogus",
        "kind=bogus",
        "from=yesterday",
        "offset=-1",
    ] {
        let (s, b) = get(&app, &format!("{base}?{q}")).await;
        assert_invalid(s, &b);
    }
    let (s, _) = get(&app, &format!("{base}?limit=1000")).await;
    assert_eq!(s, StatusCode::OK);
    let (s, b) = get(&app, "/api/address/0x12/counterparties").await;
    assert_invalid(s, &b);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn counterparties_enqueue_only_bounded_name_jobs(pool: PgPool) {
    let (app, state, _) = test_app(pool).await;
    token(&state, USDT, "USDT", Some(6)).await;
    let mut v = Vec::new();
    for i in 0..150u8 {
        let mut peer = Address::repeat_byte(0x10);
        peer.0[19] = i;
        let asset = (i % 2 == 0).then_some(USDT);
        v.push(tr(i, C, peer, asset, U256::from(1), i64::from(i)));
    }
    seed(&state, v).await;
    let (s, b) = get(
        &app,
        &format!("/api/address/{}/counterparties?limit=1000", hex(C)),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(b["items"].as_array().unwrap().len(), 150);
    assert!(jobs_of(&state, JobKind::ContractMeta).await.is_empty());
    assert!(jobs_of(&state, JobKind::TokenMeta).await.is_empty());
    let named: usize = jobs_of(&state, JobKind::ResolveNames)
        .await
        .iter()
        .map(|j| j.params["addresses"].as_array().unwrap().len())
        .sum();
    assert!((1..=100).contains(&named), "named {named}");
}
