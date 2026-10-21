//! `GET /api/token/{addr}/nft/{id}`: an NFT's cached metadata, else the job
//! fetching it.

mod common;

use alloy_primitives::{Address, U256};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{Duration, Utc};
use common::{default_user_id, get, send, test_app_traced};
use eg_core::source::{NftAttribute, NftMetadata, SourceError};
use eg_ingest::JobHandler;
use eg_ingest::events::{Audience, Event};
use eg_ingest::handlers::FetchNftHandler;
use eg_server::state::AppState;
use eg_store::NftMetaRow;
use serde_json::{Value, json};
use sqlx::PgPool;

/// A synthetic NFT contract.
const TOKEN: Address = Address::repeat_byte(0xa7);
const ID: &str = "123456789012345678901234567890";

fn id() -> U256 {
    ID.parse().unwrap()
}

fn uri(id: &str) -> String {
    format!("/api/token/{TOKEN:#x}/nft/{id}")
}

fn meta() -> NftMetadata {
    NftMetadata {
        name: Some("Synthetic #1".into()),
        description: Some("A <b>bold</b>\nclaim".into()),
        image: Some("ipfs://QmSynthetic/1.png".into()),
        attributes: vec![
            NftAttribute {
                trait_type: Some("Level".into()),
                value: "5".into(),
            },
            NftAttribute {
                trait_type: None,
                value: "untyped".into(),
            },
        ],
    }
}

async fn job_count(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind = 'fetch_nft'")
        .fetch_one(state.store.pool())
        .await
        .unwrap()
}

/// Claims the next job, checks it is `job_id`'s fetch_nft, and runs it.
async fn run_fetch(state: &AppState, job_id: i64) -> Result<(), eg_ingest::JobError> {
    let job = state.store.claim_next().await.unwrap().unwrap();
    assert_eq!(job.id, job_id);
    assert_eq!(job.kind.as_str(), "fetch_nft");
    let res = FetchNftHandler.run(&job, &state.ctx).await;
    if res.is_ok() {
        state.store.complete_job(job.id).await.unwrap();
    }
    res
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn first_call_is_pending_then_ready_from_cache(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    trace.set_nft(TOKEN, id(), meta());
    let mut rx = state.ctx.bus.subscribe();

    let (st, v) = get(&app, &uri(ID)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "pending");
    assert!(v["name"].is_null());
    assert_eq!(v["attributes"], json!([]));
    let job_id = v["job_id"].as_i64().unwrap();
    let job = state.store.job(job_id).await.unwrap().unwrap();
    assert_eq!(job.user_id, Some(default_user_id(&state).await));
    assert_eq!(
        job.params,
        json!({"token": format!("{TOKEN:#x}"), "token_id": ID})
    );
    // A second view while it runs joins the same job.
    let (_, again) = get(&app, &uri(ID)).await;
    assert_eq!(again["job_id"].as_i64(), Some(job_id));

    run_fetch(&state, job_id).await.unwrap();
    assert_eq!(trace.calls(), 1);
    let user = default_user_id(&state).await;
    let ready = std::iter::from_fn(|| rx.try_recv().ok()).find_map(|(aud, e)| match e {
        Event::NftReady { token, token_id } => Some((aud, token, token_id)),
        _ => None,
    });
    assert_eq!(
        ready,
        Some((Audience::User(user), format!("{TOKEN:#x}"), ID.to_string()))
    );

    let (st, v) = get(&app, &uri(ID)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(
        v,
        json!({
            "status": "ready",
            "name": "Synthetic #1",
            "description": "A <b>bold</b>\nclaim",
            "image": "ipfs://QmSynthetic/1.png",
            "attributes": [
                {"trait_type": "Level", "value": "5"},
                {"trait_type": null, "value": "untyped"},
            ],
            "job_id": null,
        })
    );
    // Served from the cache: no new job, no new upstream call. Leading
    // zeros name the same token id.
    let (_, v) = get(&app, &uri(&format!("000{ID}"))).await;
    assert_eq!(v["status"], "ready");
    assert_eq!(job_count(&state).await, 1);
    assert_eq!(trace.calls(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_bad_id_is_400(pool: PgPool) {
    let (app, state, _, _) = test_app_traced(pool).await;
    let too_big = format!("{}0", U256::MAX);
    for bad in ["abc", "-1", "0x10", "1.5", "1e3", "%20", too_big.as_str()] {
        let (st, v) = get(&app, &uri(bad)).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bad}: {v}");
        assert_eq!(v["error"]["code"], "invalid_input", "{bad}");
    }
    let (st, v) = get(&app, "/api/token/0x1234/nft/1").await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    // The largest uint256 is fine.
    let (st, v) = get(&app, &uri(&U256::MAX.to_string())).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(job_count(&state).await, 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn capped_fields(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    let long = |c: char, n: usize| c.to_string().repeat(n);
    let attr = NftAttribute {
        trait_type: Some("t".into()),
        value: "v".into(),
    };
    trace.set_nft(
        TOKEN,
        id(),
        NftMetadata {
            name: Some(long('n', 500)),
            description: Some(long('d', 5_000)),
            image: Some(format!("https://example.org/{}", long('i', 5_000))),
            attributes: vec![attr; 80],
        },
    );
    let (_, v) = get(&app, &uri(ID)).await;
    run_fetch(&state, v["job_id"].as_i64().unwrap())
        .await
        .unwrap();

    let (st, v) = get(&app, &uri(ID)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let len = |f: &str| v[f].as_str().unwrap().chars().count();
    assert_eq!(len("name"), 200);
    assert_eq!(len("description"), 2_000);
    // A cut URL would be broken: one over the cap is not stored.
    assert!(v["image"].is_null(), "{v}");
    assert_eq!(v["attributes"].as_array().unwrap().len(), 50);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_unknown_instance_is_cached_as_not_found(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    // The fake has no metadata for it: the provider's 404.
    let (_, v) = get(&app, &uri(ID)).await;
    run_fetch(&state, v["job_id"].as_i64().unwrap())
        .await
        .unwrap();

    let (st, v) = get(&app, &uri(ID)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(
        v,
        json!({"status": "not_found", "name": null, "description": null, "image": null,
               "attributes": [], "job_id": null})
    );
    assert_eq!(trace.calls(), 1);
    assert_eq!(job_count(&state).await, 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_failed_fetch_caches_nothing_and_a_later_view_retries(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    trace.set_nft(TOKEN, id(), meta());
    trace.fail_next(SourceError::Upstream("http 400".into()));
    let (_, v) = get(&app, &uri(ID)).await;
    let first = v["job_id"].as_i64().unwrap();
    assert!(run_fetch(&state, first).await.is_err());
    state
        .store
        .fail_job(first, "http 400", false)
        .await
        .unwrap();
    assert_eq!(state.store.nft_meta(TOKEN, id()).await.unwrap(), None);

    let (st, v) = get(&app, &uri(ID)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "pending");
    let second = v["job_id"].as_i64().unwrap();
    assert_ne!(second, first);
    run_fetch(&state, second).await.unwrap();
    let (_, v) = get(&app, &uri(ID)).await;
    assert_eq!(v["status"], "ready");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cross_site_get_starts_nothing(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    trace.set_nft(TOKEN, id(), meta());
    let cross = || {
        Request::get(uri(ID))
            .header("sec-fetch-site", "cross-site")
            .body(Body::empty())
            .unwrap()
    };
    let (st, v): (StatusCode, Value) = send(&app, cross()).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
    assert_eq!(v["error"]["message"], "nft metadata not fetched");
    assert_eq!(job_count(&state).await, 0);

    // A cached row is served cross-site too.
    let (_, v) = get(&app, &uri(ID)).await;
    run_fetch(&state, v["job_id"].as_i64().unwrap())
        .await
        .unwrap();
    let (st, v) = send(&app, cross()).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "ready");
}

/// Caches `meta` for TOKEN #ID as fetched `hours` ago.
async fn cache(state: &AppState, meta: Option<NftMetadata>, hours: i64) {
    state
        .store
        .upsert_nft_meta(&NftMetaRow {
            token: TOKEN,
            token_id: id(),
            meta,
            fetched_at: Utc::now() - Duration::hours(hours),
        })
        .await
        .unwrap();
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn empty_results_younger_than_a_day_are_served(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    cache(&state, None, 23).await;
    let (st, v) = get(&app, &uri(ID)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "not_found");

    cache(&state, Some(NftMetadata::default()), 23).await;
    let (_, v) = get(&app, &uri(ID)).await;
    assert_eq!(v["status"], "ready");
    assert_eq!(v["name"], Value::Null);
    assert_eq!(job_count(&state).await, 0);
    assert_eq!(trace.calls(), 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn empty_results_older_than_a_day_are_fetched_again(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    for (n, empty) in [None, Some(NftMetadata::default())].into_iter().enumerate() {
        cache(&state, empty, 25).await;
        let (st, v) = get(&app, &uri(ID)).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["status"], "pending", "{v}");
        // The job fetches again although a row is cached.
        trace.set_nft(TOKEN, id(), meta());
        run_fetch(&state, v["job_id"].as_i64().unwrap())
            .await
            .unwrap();
        assert_eq!(trace.calls(), n + 1);
        let (_, v) = get(&app, &uri(ID)).await;
        assert_eq!(v["status"], "ready");
        assert_eq!(v["name"], "Synthetic #1");
    }
    // A cross-site view is served the stale row and starts nothing.
    cache(&state, None, 25).await;
    let req = Request::get(uri(ID))
        .header("sec-fetch-site", "cross-site")
        .body(Body::empty())
        .unwrap();
    let (st, v) = send(&app, req).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "not_found");
    assert_eq!(job_count(&state).await, 2);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_non_empty_old_row_is_served(pool: PgPool) {
    let (app, state, _, trace) = test_app_traced(pool).await;
    cache(&state, Some(meta()), 24 * 365).await;
    let (st, v) = get(&app, &uri(ID)).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "ready");
    assert_eq!(v["name"], "Synthetic #1");
    assert_eq!(job_count(&state).await, 0);
    assert_eq!(trace.calls(), 0);
}
