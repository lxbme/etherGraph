mod common;

use alloy_primitives::Address;
use axum::http::StatusCode;
use chrono::Utc;
use common::{get, test_app};
use eg_core::source::TokenInfo;
use eg_core::types::{AccountKind, TransferKind};
use eg_server::import_tokens::{TokenFormat, import_tokens};
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
