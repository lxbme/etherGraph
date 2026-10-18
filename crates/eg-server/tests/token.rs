mod common;

use alloy_primitives::Address;
use axum::http::StatusCode;
use chrono::Utc;
use common::{get, test_app};
use eg_core::source::TokenInfo;
use eg_core::types::{AccountKind, TransferKind};
use eg_server::import_tokens::{TokenFormat, import_tokens};
use eg_server::trust::TrustCache;
use eg_store::{AccountRow, JobKind};
use serde_json::json;
use sqlx::PgPool;

const USDT: Address = Address::repeat_byte(0x55);
const UNKNOWN: Address = Address::repeat_byte(0x66);

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

fn account(addr: Address) -> AccountRow {
    AccountRow {
        address: addr,
        kind: AccountKind::Contract,
        contract_name: Some("TetherToken".into()),
        is_proxy: false,
        implementation: None,
        creator: None,
        creation_tx: None,
        meta_fetched_at: Utc::now(),
    }
}

async fn jobs_of(state: &eg_server::state::AppState, kind: JobKind) -> usize {
    state
        .store
        .active_jobs()
        .await
        .unwrap()
        .into_iter()
        .filter(|j| j.kind == kind)
        .count()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn usdt_like_token_returns_the_full_detail(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let a = hex(USDT);
    state
        .store
        .upsert_tokens(&[TokenInfo {
            address: USDT,
            kind: TransferKind::Erc20,
            name: Some("Tether USD".into()),
            symbol: Some("USDT".into()),
            decimals: Some(6),
        }])
        .await
        .unwrap();
    let list = format!(r#"{{"tokens":[{{"chainId":1,"address":"{a}"}}]}}"#);
    for f in [TokenFormat::Uniswap, TokenFormat::Coingecko] {
        import_tokens(&state.store, f, list.as_bytes())
            .await
            .unwrap();
    }
    let csv = format!(
        "address,chainId,label,name,symbol,website,image\n\
         {a},1,Stablecoin,N,S,https://tether.to,x\n\
         {a},1,defi,N,S,null,x\n"
    );
    import_tokens(&state.store, TokenFormat::EthLabels, csv.as_bytes())
        .await
        .unwrap();
    state.store.upsert_accounts(&[account(USDT)]).await.unwrap();
    state
        .store
        .upsert_abi(USDT, Some(r#"[{"type":"function","name":"transfer"}]"#))
        .await
        .unwrap();

    let (status, body) = get(&app, &format!("/api/token/{a}")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "address": a,
            "standard": "erc20",
            "name": "Tether USD",
            "symbol": "USDT",
            "decimals": 6,
            "contract_name": "TetherToken",
            "identified": true,
            "source_verified": true,
            "lists": {"uniswap": true, "coingecko": true},
            "tags": ["defi", "stablecoin"],
            "website": "https://tether.to",
            "trust": {"level": "listed", "impersonates": null, "reason": null},
        })
    );
    assert_eq!(jobs_of(&state, JobKind::TokenMeta).await, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn unknown_address_is_an_empty_detail_with_one_token_meta_job(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    for _ in 0..2 {
        let (status, body) = get(&app, &format!("/api/token/{}", hex(UNKNOWN))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body,
            json!({
                "address": hex(UNKNOWN),
                "standard": "unknown",
                "name": null,
                "symbol": null,
                "decimals": null,
                "contract_name": null,
                "identified": false,
                "source_verified": null,
                "lists": {"uniswap": false, "coingecko": false},
                "tags": [],
                "website": null,
                "trust": {"level": "unknown", "impersonates": null, "reason": null},
            })
        );
    }
    assert_eq!(jobs_of(&state, JobKind::TokenMeta).await, 1);
    assert_eq!(jobs_of(&state, JobKind::ContractMeta).await, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn identified_without_abi_is_not_source_verified(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    state.store.upsert_accounts(&[account(USDT)]).await.unwrap();
    let (_, body) = get(&app, &format!("/api/token/{}", hex(USDT))).await;
    assert_eq!(body["identified"], true);
    assert_eq!(body["source_verified"], false);
    state.store.upsert_abi(USDT, None).await.unwrap();
    let (_, body) = get(&app, &format!("/api/token/{}", hex(USDT))).await;
    assert_eq!(body["source_verified"], false);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn invalid_address_is_a_400(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let (status, body) = get(&app, "/api/token/0x12").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "invalid_input");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn kind_hint_without_a_tokens_row_sets_the_standard_and_queues_nothing_for_an_nft(
    pool: PgPool,
) {
    let (app, state, _) = test_app(pool);
    for (kind, standard) in [("erc721", "erc721"), ("erc1155", "erc1155")] {
        let (status, body) = get(&app, &format!("/api/token/{}?kind={kind}", hex(UNKNOWN))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["standard"], standard);
    }
    assert_eq!(jobs_of(&state, JobKind::TokenMeta).await, 0);
    assert_eq!(jobs_of(&state, JobKind::ContractMeta).await, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn erc20_hint_follows_the_hint_and_still_queues_token_meta(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let (_, body) = get(&app, &format!("/api/token/{}?kind=erc20", hex(UNKNOWN))).await;
    assert_eq!(body["standard"], "erc20");
    assert_eq!(jobs_of(&state, JobKind::TokenMeta).await, 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_stored_kind_wins_over_the_hint(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    state
        .store
        .upsert_tokens(&[TokenInfo {
            address: USDT,
            kind: TransferKind::Erc721,
            name: None,
            symbol: None,
            decimals: None,
        }])
        .await
        .unwrap();
    let (_, body) = get(&app, &format!("/api/token/{}?kind=erc20", hex(USDT))).await;
    assert_eq!(body["standard"], "erc721");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_unknown_kind_hint_is_a_400(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let (status, _) = get(&app, &format!("/api/token/{}?kind=bogus", hex(USDT))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn import_round_trip_stores_symbol_and_name(pool: PgPool) {
    let (_, state, _) = test_app(pool);
    let a = hex(USDT);
    let list = format!(
        r#"{{"tokens":[{{"chainId":1,"address":"{a}","symbol":"USDT","name":"Tether USD"}}]}}"#
    );
    import_tokens(&state.store, TokenFormat::Uniswap, list.as_bytes())
        .await
        .unwrap();
    let csv = format!(
        "address,chainId,label,name,symbol,website,image\n{a},1,stablecoin,Tether,USDT,,x\n"
    );
    import_tokens(&state.store, TokenFormat::EthLabels, csv.as_bytes())
        .await
        .unwrap();
    let got: Vec<_> = state
        .store
        .token_tags(&[USDT])
        .await
        .unwrap()
        .into_iter()
        .map(|t| (t.source, t.symbol, t.name))
        .collect();
    assert_eq!(
        got,
        [
            (
                "eth-labels".into(),
                Some("USDT".into()),
                Some("Tether".into())
            ),
            (
                "uniswap".into(),
                Some("USDT".into()),
                Some("Tether USD".into())
            ),
        ]
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn token_detail_flags_a_copy_of_a_listed_token(pool: PgPool) {
    let (app, state, _) = test_app(pool);
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
            address: UNKNOWN,
            kind: TransferKind::Erc20,
            name: Some("Tether USD".into()),
            symbol: Some("USD\u{0422}".into()),
            decimals: Some(6),
        }])
        .await
        .unwrap();
    let (status, body) = get(&app, &format!("/api/token/{}", hex(UNKNOWN))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["trust"],
        json!({
            "level": "suspicious",
            "impersonates": {"address": hex(USDT), "symbol": "USDT", "name": "Tether USD"},
            "reason": null,
        })
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_trust_cache_reloads_once_stale_and_keeps_the_last_index_on_error(pool: PgPool) {
    let (_, state, _) = test_app(pool.clone());
    let cached = TrustCache::new(std::time::Duration::from_secs(3600));
    let fresh = TrustCache::new(std::time::Duration::ZERO);
    assert!(cached.get(&state.store).await.listed.is_empty());
    assert!(fresh.get(&state.store).await.listed.is_empty());
    let list = format!(
        r#"{{"tokens":[{{"chainId":1,"address":"{}"}}]}}"#,
        hex(USDT)
    );
    import_tokens(&state.store, TokenFormat::Coingecko, list.as_bytes())
        .await
        .unwrap();
    assert!(cached.get(&state.store).await.listed.is_empty());
    assert!(fresh.get(&state.store).await.listed.contains_key(&USDT));
    pool.close().await;
    assert!(fresh.get(&state.store).await.listed.contains_key(&USDT));
}
