mod common;

use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use common::{
    admin_cookies, anon_app, as_default_user, gated_app, get, get_as, key_address, login_as,
    new_key, post_json_as, second_user,
};
use eg_server::app::router;
use eg_server::config::Config;
use eg_server::dto::LocalDataDto;
use eg_server::import_tokens::TokenFormat;
use eg_server::local_data::SourceId;
use eg_server::local_data::sources::Urls;
use eg_server::local_data::upstream::UpstreamChecker;
use eg_server::state::AppState;
use eg_server::state::SIGNATURES_SETTING;
use k256::ecdsa::SigningKey;
use serde_json::json;
use sqlx::PgPool;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn cfg(enabled: bool) -> Config {
    let mut cfg = Config::default();
    cfg.signatures.enabled = enabled;
    cfg
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_signature_switch_prefers_the_setting_over_config(pool: PgPool) {
    // A setting of false wins over a config of true.
    let (_, state, _) = anon_app(pool.clone(), cfg(true));
    state
        .store
        .setting_set(SIGNATURES_SETTING, &json!(false))
        .await
        .unwrap();
    state.load_signatures_setting().await.unwrap();
    assert!(!state.signatures_enabled());

    // And a setting of true over a config of false.
    state
        .store
        .setting_set(SIGNATURES_SETTING, &json!(true))
        .await
        .unwrap();
    let (_, off, _) = anon_app(pool.clone(), cfg(false));
    off.load_signatures_setting().await.unwrap();
    assert!(off.signatures_enabled());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn without_a_setting_the_config_decides(pool: PgPool) {
    let (_, on, _) = anon_app(pool.clone(), cfg(true));
    on.load_signatures_setting().await.unwrap();
    assert!(on.signatures_enabled());
    let (_, off, _) = anon_app(pool, cfg(false));
    off.load_signatures_setting().await.unwrap();
    assert!(!off.signatures_enabled());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cli_token_import_records_status(pool: PgPool) {
    let (_, state, _) = anon_app(pool, Config::default());
    let list = format!(
        r#"{{"name":"x","version":{{"major":1,"minor":2,"patch":3}},"tokens":[
            {{"chainId":1,"address":"{:#x}","symbol":"AAA","name":"A"}},
            {{"chainId":1,"address":"{:#x}","symbol":"BBB","name":"B"}}]}}"#,
        alloy_primitives::Address::repeat_byte(0x11),
        alloy_primitives::Address::repeat_byte(0x22),
    );
    let path = std::env::temp_dir().join(format!("eg-local-data-{}.json", std::process::id()));
    std::fs::write(&path, &list).unwrap();
    let out = eg_server::cli::import_tokens(&state.store, TokenFormat::Uniswap, &path).await;
    std::fs::remove_file(&path).ok();
    out.unwrap();

    let rows = state.store.local_data_all().await.unwrap();
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(r.source, "tokens_uniswap");
    assert_eq!(r.version.as_deref(), Some("1.2.3"));
    assert_eq!(r.rows, Some(2));
    assert_eq!(r.state, "idle");
    assert!(r.imported_at.is_some());
    assert_eq!(r.sha256.as_ref().map(String::len), Some(64));
}

// ------------------------------------------------------------------- upstream

const LISTING: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>b</Name><IsTruncated>false</IsTruncated>
<Contents><Key>v2/signatures/s_0_1.parquet</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><ETag>&quot;aa&quot;</ETag><Size>100</Size></Contents>
<Contents><Key>v2/signatures/s_1_2.parquet</Key><LastModified>2026-01-03T03:04:05.000Z</LastModified><ETag>&quot;bb&quot;</ETag><Size>200</Size></Contents>
</ListBucketResult>"#;

fn list_json(version: (u32, u32, u32)) -> String {
    format!(
        r#"{{"name":"x","version":{{"major":{},"minor":{},"patch":{}}},"tokens":[]}}"#,
        version.0, version.1, version.2
    )
}

/// Serves every upstream: CSV heads with ETags, both token lists at
/// `version`, the Sourcify listing `listing`.
async fn serve(server: &MockServer, version: (u32, u32, u32), listing: &str) {
    for (p, etag, len) in [
        ("/labels.csv", "\"l1\"", "1000"),
        ("/tokens.csv", "\"t1\"", "50"),
    ] {
        Mock::given(method("HEAD"))
            .and(path(p))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("etag", etag)
                    .insert_header("content-length", len),
            )
            .mount(server)
            .await;
    }
    for p in ["/uniswap.json", "/coingecko.json"] {
        Mock::given(method("GET"))
            .and(path(p))
            .respond_with(ResponseTemplate::new(200).set_body_string(list_json(version)))
            .mount(server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/list"))
        .and(query_param("prefix", "v2/signatures/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(listing))
        .mount(server)
        .await;
}

fn checker(server: &MockServer) -> UpstreamChecker {
    UpstreamChecker::with_urls(Urls::with_base(&server.uri()))
}

#[tokio::test]
async fn check_reads_versions_etags_and_the_sourcify_listing() {
    let server = MockServer::start().await;
    serve(&server, (22, 27, 0), LISTING).await;
    let got = checker(&server).check(false).await;
    assert_eq!(got.len(), 5);

    let labels = got[&SourceId::EthLabels].as_ref().unwrap();
    assert_eq!(labels.etag.as_deref(), Some("\"l1\""));
    assert_eq!(labels.size, Some(1000));
    assert_eq!(labels.version, None);

    let uni = got[&SourceId::TokensUniswap].as_ref().unwrap();
    assert_eq!(uni.version.as_deref(), Some("22.27.0"));
    assert_eq!(uni.body.as_deref(), Some(list_json((22, 27, 0)).as_bytes()));
    assert_eq!(
        got[&SourceId::TokensEthLabels]
            .as_ref()
            .unwrap()
            .etag
            .as_deref(),
        Some("\"t1\"")
    );

    let sig = got[&SourceId::SignaturesSourcify].as_ref().unwrap();
    let files = sig.files.as_ref().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].key, "v2/signatures/s_0_1.parquet");
    assert_eq!(files[0].etag, "\"aa\"");
    assert_eq!(files[0].size, 100);
    assert_eq!(files[0].last_modified, "2026-01-02T03:04:05.000Z");
    assert_eq!(sig.size, Some(300));
}

#[tokio::test]
async fn a_listing_key_outside_v2_signatures_is_dropped() {
    let server = MockServer::start().await;
    let item = |k: &str| {
        format!(
            "<Contents><Key>{k}</Key><LastModified>t</LastModified><ETag>&quot;e&quot;</ETag><Size>1</Size></Contents>"
        )
    };
    let listing = format!(
        "<ListBucketResult>{}{}{}{}{}{}</ListBucketResult>",
        item("../x.parquet"),
        item("v2/other/a.parquet"),
        item("https://evil/a.parquet"),
        item("v2/signatures/../a.parquet"),
        item("v2/signatures/a.txt"),
        item("v2/signatures/s_0_1.parquet"),
    );
    serve(&server, (1, 0, 0), &listing).await;
    let got = checker(&server).check(false).await;
    let files = got[&SourceId::SignaturesSourcify]
        .as_ref()
        .unwrap()
        .files
        .clone()
        .unwrap();
    let keys: Vec<_> = files.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(keys, ["v2/signatures/s_0_1.parquet"]);
}

#[tokio::test]
async fn cached_for_ten_minutes_unless_forced() {
    let server = MockServer::start().await;
    serve(&server, (1, 0, 0), LISTING).await;
    let c = checker(&server);
    c.check(false).await;
    c.check(false).await;
    async fn hits(server: &MockServer) -> usize {
        server.received_requests().await.unwrap().len()
    }
    assert_eq!(hits(&server).await, 5);
    c.check(true).await;
    assert_eq!(hits(&server).await, 10);
    c.check(false).await;
    assert_eq!(hits(&server).await, 10);
}

#[tokio::test]
async fn a_failing_source_is_not_cached() {
    let server = MockServer::start().await;
    serve(&server, (1, 0, 0), LISTING).await;
    Mock::given(method("GET"))
        .and(path("/gone.json"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let mut urls = Urls::with_base(&server.uri());
    urls.tokens_uniswap = format!("{}/gone.json", server.uri());
    let c = UpstreamChecker::with_urls(urls);
    let first = c.check(false).await;
    assert!(first[&SourceId::TokensUniswap].is_err());
    let before = server.received_requests().await.unwrap().len();
    c.check(false).await;
    // Only the failed source is asked again.
    assert_eq!(server.received_requests().await.unwrap().len(), before + 1);
}

// --------------------------------------------------------------------- the API

async fn admin_app(pool: PgPool, server: &MockServer) -> (Router, AppState, SigningKey) {
    let key = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![key_address(&key).to_checksum(None)];
    let (_, mut state, _) = gated_app(pool, cfg).await;
    state.upstream = Arc::new(checker(server));
    let app = as_default_user(router(state.clone()), &state).await;
    (app, state, key)
}

async fn dto(app: &Router, cookie: &str) -> LocalDataDto {
    let (status, body) = get_as(app, cookie, "/api/admin/local-data").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

fn source<'a>(d: &'a LocalDataDto, id: &str) -> &'a eg_server::dto::LocalSourceDto {
    d.sources.iter().find(|s| s.source == id).unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn status_update_when_the_version_differs_and_up_to_date_when_equal(pool: PgPool) {
    let server = MockServer::start().await;
    serve(&server, (22, 27, 0), LISTING).await;
    let (app, state, key) = admin_app(pool, &server).await;
    let cookie = admin_cookies(&app, &key).await;
    let s = &state.store;
    s.local_data_succeeded("tokens_uniswap", Some("22.27.0"), None, Some("x"), None, 7)
        .await
        .unwrap();
    s.local_data_succeeded(
        "tokens_coingecko",
        Some("22.26.0"),
        None,
        Some("x"),
        None,
        9,
    )
    .await
    .unwrap();
    s.local_data_succeeded("tokens_eth_labels", None, Some("\"t1\""), None, None, 3)
        .await
        .unwrap();
    s.local_data_succeeded("eth_labels", None, Some("\"old\""), None, None, 4)
        .await
        .unwrap();

    let d = dto(&app, &cookie).await;
    assert!(d.checked_at.is_some());
    assert_eq!(d.running, None);
    assert!(!d.signatures_enabled);
    assert_eq!(d.sources.len(), 5);
    let uni = source(&d, "tokens_uniswap");
    assert_eq!(uni.upstream.status, "up_to_date");
    assert_eq!(uni.upstream.version.as_deref(), Some("22.27.0"));
    assert_eq!(
        (uni.version.as_deref(), uni.rows),
        (Some("22.27.0"), Some(7))
    );
    assert_eq!(uni.state, "idle");
    assert_eq!(source(&d, "tokens_coingecko").upstream.status, "update");
    assert_eq!(
        source(&d, "tokens_eth_labels").upstream.status,
        "up_to_date"
    );
    assert_eq!(source(&d, "eth_labels").upstream.status, "update");
    assert_eq!(source(&d, "eth_labels").upstream.bytes, Some(1000));
    let sig = source(&d, "signatures_sourcify");
    assert_eq!(sig.upstream.status, "not_imported");
    assert_eq!(
        (sig.upstream.files, sig.upstream.bytes),
        (Some(2), Some(300))
    );
    assert_eq!(sig.partial, None);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn legacy_imported_csv_counts_as_update_with_legacy_rows(pool: PgPool) {
    let server = MockServer::start().await;
    serve(&server, (1, 0, 0), LISTING).await;
    let (app, state, key) = admin_app(pool.clone(), &server).await;
    let cookie = admin_cookies(&app, &key).await;
    sqlx::query(
        "INSERT INTO labels (address, text, category, source) VALUES ($1, 'a', 'x', 'eth-labels')",
    )
    .bind([0x11u8; 20].to_vec())
    .execute(&pool)
    .await
    .unwrap();
    let _ = state;
    let d = dto(&app, &cookie).await;
    let l = source(&d, "eth_labels");
    assert_eq!(l.upstream.status, "update");
    assert_eq!(l.rows, Some(1));
    assert_eq!(l.imported_at, None);
    assert_eq!(l.version, None);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn partial_reports_done_of_total(pool: PgPool) {
    let server = MockServer::start().await;
    serve(&server, (1, 0, 0), LISTING).await;
    let (app, state, key) = admin_app(pool, &server).await;
    let cookie = admin_cookies(&app, &key).await;
    let manifest = serde_json::json!([
        {"key": "v2/signatures/s_0_1.parquet", "etag": "\"aa\"", "size": 100}
    ]);
    state
        .store
        .local_data_succeeded("signatures_sourcify", None, None, None, Some(&manifest), 5)
        .await
        .unwrap();
    let d = dto(&app, &cookie).await;
    let sig = source(&d, "signatures_sourcify");
    assert_eq!(sig.upstream.status, "update");
    let p = sig.partial.as_ref().unwrap();
    assert_eq!((p.done, p.total), (1, 2));

    // Complete: up to date, no partial.
    let full = serde_json::json!([
        {"key": "v2/signatures/s_0_1.parquet", "etag": "\"aa\"", "size": 100},
        {"key": "v2/signatures/s_1_2.parquet", "etag": "\"bb\"", "size": 200}
    ]);
    state
        .store
        .local_data_succeeded("signatures_sourcify", None, None, None, Some(&full), 9)
        .await
        .unwrap();
    let (status, body) = common::post_json_as(
        &app,
        &cookie,
        "/api/admin/local-data/check",
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sig = &body["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["source"] == "signatures_sourcify")
        .unwrap()
        .clone();
    assert_eq!(sig["upstream"]["status"], "up_to_date");
    assert!(sig["partial"].is_null());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_failing_upstream_is_unchecked_with_its_error(pool: PgPool) {
    let server = MockServer::start().await;
    serve(&server, (1, 0, 0), LISTING).await;
    Mock::given(method("GET"))
        .and(path("/gone.json"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let (_, mut state, key) = admin_app(pool, &server).await;
    let mut urls = Urls::with_base(&server.uri());
    urls.tokens_coingecko = format!("{}/gone.json", server.uri());
    state.upstream = Arc::new(UpstreamChecker::with_urls(urls));
    let app = as_default_user(router(state.clone()), &state).await;
    let cookie = admin_cookies(&app, &key).await;
    state
        .store
        .local_data_failed("tokens_coingecko", "timeout")
        .await
        .unwrap();
    let d = dto(&app, &cookie).await;
    let c = source(&d, "tokens_coingecko");
    assert_eq!(c.upstream.status, "unchecked");
    assert!(c.upstream.error.as_deref().unwrap().contains("503"));
    assert_eq!(
        (c.state.as_str(), c.error.as_deref()),
        ("failed", Some("timeout"))
    );
    assert!(c.error_at.is_some());
    // The others are unaffected.
    assert_eq!(source(&d, "tokens_uniswap").upstream.status, "not_imported");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_running_source_is_reported(pool: PgPool) {
    let server = MockServer::start().await;
    serve(&server, (1, 0, 0), LISTING).await;
    let (app, state, key) = admin_app(pool, &server).await;
    let cookie = admin_cookies(&app, &key).await;
    state
        .store
        .local_data_running("eth_labels", "0xa")
        .await
        .unwrap();
    let d = dto(&app, &cookie).await;
    assert_eq!(d.running.as_deref(), Some("eth_labels"));
    assert_eq!(source(&d, "eth_labels").state, "running");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn non_admin_mode_gets_403(pool: PgPool) {
    // As the overview: a non-admin finds no admin API (404, audited) and an
    // admin outside admin mode is refused (401); neither reaches the upstream.
    let server = MockServer::start().await;
    serve(&server, (1, 0, 0), LISTING).await;
    let (app, state, key) = admin_app(pool, &server).await;
    let (b, _) = second_user(&app, &state).await;
    let session = login_as(&app, &key).await;
    for uri in ["/api/admin/local-data", "/api/admin/local-data/check"] {
        for cookie in [&b, &session] {
            let (status, body) = if uri.ends_with("check") {
                post_json_as(&app, cookie, uri, &serde_json::json!({})).await
            } else {
                get_as(&app, cookie, uri).await
            };
            let want = if cookie == &b {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::UNAUTHORIZED
            };
            assert_eq!(status, want, "{uri}: {body}");
        }
    }
    assert_eq!(
        get(&app, "/api/admin/local-data").await.0,
        StatusCode::NOT_FOUND
    );
    assert!(server.received_requests().await.unwrap().is_empty());
}
