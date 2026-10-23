//! The background update runner of the list datasets: a failed or cancelled
//! update keeps the old rows and leaves no `.part` file (Review Focus 1), a
//! restart marks a running task interrupted (Review Focus 2), redirects stay
//! on the allowlist (Review Focus 4); and the incremental, cancel-aware
//! Sourcify download and import (Review Focus 5). Upstreams are wiremock
//! servers or a raw TCP server for broken responses; the data dir is a temp
//! dir.

mod common;
#[path = "../src/import_signatures/parquet_fixture.rs"]
mod parquet_fixture;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, address};
use axum::http::StatusCode;
use common::{
    TempDir, admin_cookies, anon_app, as_default_user, gated_app, get_as, key_address, new_key,
};
use eg_ingest::Event;
use eg_ingest::events::{Audience, LocalDataOutcome, LocalDataPhase};
use eg_server::app::router;
use eg_server::config::Config;
use eg_server::local_data::SourceId;
use eg_server::local_data::download::{self, SOURCIFY_LIMITS};
use eg_server::local_data::runner::{Runner, StartError, interrupt_running};
use eg_server::local_data::sources::Urls;
use eg_server::local_data::upstream::UpstreamChecker;
use eg_server::state::AppState;
use eg_store::{AuditFilter, AuditOutcome, LocalDataRow, TokenTagRow};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const ADMIN: Address = address!("0x00000000000000000000000000000000000000ad");

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

/// Every file under `dir`, relative and sorted.
fn files(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                out.push(p.strip_prefix(base).unwrap().display().to_string());
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

fn no_part_file(dir: &Path) {
    let all = files(dir);
    assert!(!all.iter().any(|f| f.ends_with(".part")), "{all:?}");
}

/// A token list (mainnet tokens at `bytes`) at `version`.
fn list(version: (u32, u32, u32), bytes: &[u8]) -> String {
    let tokens: Vec<String> = bytes
        .iter()
        .map(|&b| {
            format!(
                r#"{{"chainId":1,"address":"{}","symbol":"T{b}","name":"Token {b}"}}"#,
                hex(Address::repeat_byte(b))
            )
        })
        .collect();
    format!(
        r#"{{"name":"x","version":{{"major":{},"minor":{},"patch":{}}},"tokens":[{}]}}"#,
        version.0,
        version.1,
        version.2,
        tokens.join(",")
    )
}

/// An eth-labels accounts CSV: one mainnet label per address byte.
fn labels_csv(bytes: &[u8]) -> String {
    let mut s = "address,chainId,label,nameTag\n".to_owned();
    for &b in bytes {
        s.push_str(&format!(
            "{},1,okx,Wallet {b}\n",
            hex(Address::repeat_byte(b))
        ));
    }
    s
}

const HTML: &str = "<!DOCTYPE html><html><head><title>Rate limited</title></head>\
                    <body>Please try again later.</body></html>";

struct Env {
    state: AppState,
    server: MockServer,
    dir: TempDir,
}

impl Env {
    async fn new(pool: PgPool) -> Self {
        Self::with_limits(pool, None).await
    }

    /// `limits`: the list sources' (cap, timeout) instead of the defaults.
    async fn with_limits(pool: PgPool, limits: Option<(u64, Duration)>) -> Self {
        let server = MockServer::start().await;
        let dir = TempDir::new();
        let (_, mut state, _) = anon_app(pool, Config::default());
        state.upstream = Arc::new(UpstreamChecker::with_urls(Urls::with_base(&server.uri())));
        let mut runner = Runner::new(dir.0.clone());
        if let Some((cap, timeout)) = limits {
            runner = runner.with_list_limits(cap, timeout);
        }
        state.runner = Arc::new(runner);
        Self { state, server, dir }
    }

    /// Imports signatures in batches of `rows`.
    fn signature_batches(&mut self, rows: usize) {
        let runner = Runner::new(self.dir.0.clone()).with_signature_batch_rows(rows);
        self.state.runner = Arc::new(runner);
    }

    /// Serves the Sourcify listing of `files` and each file under its key.
    async fn serve_sourcify(&self, files: &[&SigFile]) {
        Mock::given(method("GET"))
            .and(path("/list"))
            .respond_with(ResponseTemplate::new(200).set_body_string(listing(files)))
            .mount(&self.server)
            .await;
        for f in files {
            self.serve(
                &format!("/{}", f.key),
                ResponseTemplate::new(200)
                    .insert_header("etag", f.etag.as_str())
                    .set_body_bytes(f.body.clone()),
            )
            .await;
        }
    }

    /// The paths of the Sourcify files fetched, sorted.
    async fn file_gets(&self) -> Vec<String> {
        let mut got: Vec<String> = self
            .server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|r| r.url.path().to_owned())
            .filter(|p| p.starts_with("/v2/signatures/"))
            .collect();
        got.sort();
        got
    }

    async fn signature_count(&self) -> i64 {
        eg_store::signature_count(self.state.store.pool())
            .await
            .unwrap()
    }

    /// Points the list source `id` at `url`.
    fn point(&mut self, id: SourceId, url: String) {
        let mut urls = self.state.upstream.urls().clone();
        match id {
            SourceId::EthLabels => urls.eth_labels = url,
            SourceId::TokensUniswap => urls.tokens_uniswap = url,
            SourceId::TokensCoingecko => urls.tokens_coingecko = url,
            SourceId::TokensEthLabels => urls.tokens_eth_labels = url,
            SourceId::SignaturesSourcify => unreachable!(),
        }
        self.state.upstream = Arc::new(UpstreamChecker::with_urls(urls));
    }

    async fn serve(&self, p: &str, resp: ResponseTemplate) {
        Mock::given(method("GET"))
            .and(path(p))
            .respond_with(resp)
            .mount(&self.server)
            .await;
    }

    async fn gets(&self, p: &str) -> usize {
        self.server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path() == p)
            .count()
    }

    /// Starts `id` and waits for its end.
    async fn run(&self, id: SourceId) -> (LocalDataOutcome, Option<String>) {
        let mut rx = self.state.ctx.bus.subscribe();
        self.state
            .runner
            .start(&self.state, id, ADMIN)
            .await
            .unwrap();
        done(&mut rx).await
    }

    async fn row(&self, id: SourceId) -> LocalDataRow {
        self.state
            .store
            .local_data_all()
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.source == id.as_str())
            .unwrap()
    }

    /// The previous successful imports of both eth-labels datasets, the
    /// Uniswap list and their status rows.
    async fn seed_old(&self) {
        let s = &self.state.store;
        s.replace_imports(&[
            (
                "eth-labels",
                &[(Address::repeat_byte(0x71), "Old".into(), "other".into())],
            ),
            (
                "eth-labels-xchain",
                &[(Address::repeat_byte(0x72), "Old x".into(), "other".into())],
            ),
        ])
        .await
        .unwrap();
        s.replace_token_tags(
            "uniswap",
            &[TokenTagRow {
                address: Address::repeat_byte(0x73),
                source: "uniswap".into(),
                tag: "default-list".into(),
                website: None,
                symbol: Some("OLD".into()),
                name: Some("Old".into()),
            }],
        )
        .await
        .unwrap();
        s.local_data_succeeded("eth_labels", None, Some("\"old\""), Some("aa"), None, 2)
            .await
            .unwrap();
        s.local_data_succeeded("tokens_uniswap", Some("1.0.0"), None, Some("bb"), None, 1)
            .await
            .unwrap();
    }

    async fn tables(&self) -> Tables {
        let pool = self.state.store.pool();
        Tables {
            labels: sqlx::query_as(
                "SELECT address, text, category, source FROM labels ORDER BY 1, 2, 4",
            )
            .fetch_all(pool)
            .await
            .unwrap(),
            tags: sqlx::query_as(
                "SELECT address, source, tag, website, symbol, name FROM token_tags \
                 ORDER BY 1, 2, 3",
            )
            .fetch_all(pool)
            .await
            .unwrap(),
        }
    }

    async fn done_audits(&self) -> Vec<eg_store::AuditRow> {
        let filter = AuditFilter {
            action: Some("local_data_update_done".into()),
            ..AuditFilter::default()
        };
        self.state
            .store
            .audit_page(&filter, None, 50)
            .await
            .unwrap()
    }
}

type TagRow = (
    Vec<u8>,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Debug, PartialEq)]
struct Tables {
    labels: Vec<(Vec<u8>, String, String, String)>,
    tags: Vec<TagRow>,
}

/// The next `LocalDataDone` on `rx`.
async fn done(
    rx: &mut broadcast::Receiver<(Audience, Event)>,
) -> (LocalDataOutcome, Option<String>) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let (_, Event::LocalDataDone { outcome, error, .. }) = rx.recv().await.unwrap() {
                return (outcome, error);
            }
        }
    })
    .await
    .expect("the task ends")
}

/// A server that answers every connection with `response` (raw bytes), then
/// closes it, or keeps it open when `hold`. Returns its base URL.
async fn raw_server(response: Vec<u8>, hold: bool) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let response = response.clone();
            tokio::spawn(async move {
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => req.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = sock.write_all(&response).await;
                let _ = sock.flush().await;
                if hold {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            });
        }
    });
    format!("http://{addr}")
}

/// Response headers announcing `len` bytes, then `body` (possibly fewer).
fn http_head(len: Option<usize>, body: &[u8]) -> Vec<u8> {
    let mut r = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n".to_vec();
    match len {
        Some(n) => r.extend_from_slice(format!("Content-Length: {n}\r\n").as_bytes()),
        None => r.extend_from_slice(b"Connection: close\r\n"),
    }
    r.extend_from_slice(b"\r\n");
    r.extend_from_slice(body);
    r
}

// --------------------------------------------------------------------- success

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn update_replaces_tokens_records_status_and_audits(pool: PgPool) {
    let env = Env::new(pool).await;
    env.seed_old().await;
    let body = list((22, 27, 0), &[0x11, 0x22]);
    env.serve(
        "/uniswap.json",
        ResponseTemplate::new(200).set_body_string(&body),
    )
    .await;

    let (outcome, error) = env.run(SourceId::TokensUniswap).await;
    assert_eq!((outcome, error), (LocalDataOutcome::Succeeded, None));

    // The old tag is gone, the list's two are in.
    let tags = env.tables().await.tags;
    let uni: Vec<&TagRow> = tags.iter().filter(|t| t.1 == "uniswap").collect();
    assert_eq!(uni.len(), 2);
    assert_eq!(uni[0].0, Address::repeat_byte(0x11).to_vec());
    assert_eq!(uni[1].4.as_deref(), Some("T34"));

    let r = env.row(SourceId::TokensUniswap).await;
    assert_eq!(r.state, "idle");
    assert_eq!(r.version.as_deref(), Some("22.27.0"));
    assert_eq!(r.rows, Some(2));
    assert_eq!(r.error, None);
    assert_eq!(r.started_by.as_deref(), Some(hex(ADMIN).as_str()));
    let sha = format!("{:x}", Sha256::digest(body.as_bytes()));
    assert_eq!(r.sha256.as_deref(), Some(sha.as_str()));

    // The file is in place under its final name.
    assert_eq!(files(&env.dir.0), ["tokens/uniswap-default.json"]);
    let on_disk = std::fs::read_to_string(env.dir.0.join("tokens/uniswap-default.json")).unwrap();
    assert_eq!(on_disk, body);

    let audits = env.done_audits().await;
    assert_eq!(audits.len(), 1);
    let a = &audits[0].entry;
    assert_eq!(a.actor, hex(ADMIN));
    assert_eq!(a.target.as_deref(), Some("tokens_uniswap"));
    assert_eq!(a.outcome, AuditOutcome::Ok);
    assert_eq!(
        a.after,
        Some(serde_json::json!({"outcome": "succeeded", "rows": 2, "error": null}))
    );
    assert_eq!(env.state.runner.running(), None);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn eth_labels_update_replaces_both_datasets_and_keeps_the_etag_verbatim(pool: PgPool) {
    let env = Env::new(pool).await;
    env.seed_old().await;
    env.serve(
        "/labels.csv",
        ResponseTemplate::new(200)
            .insert_header("etag", "\"e2\"")
            .set_body_string(labels_csv(&[0x11, 0x22, 0x33])),
    )
    .await;
    let (outcome, error) = env.run(SourceId::EthLabels).await;
    assert_eq!((outcome, error), (LocalDataOutcome::Succeeded, None));
    let labels = env.tables().await.labels;
    assert_eq!(labels.len(), 3, "{labels:?}");
    assert!(labels.iter().all(|l| l.3 == "import:eth-labels"));
    let r = env.row(SourceId::EthLabels).await;
    assert_eq!(r.etag.as_deref(), Some("\"e2\""));
    assert_eq!(r.version, None);
    assert_eq!(r.rows, Some(3));
    assert_eq!(files(&env.dir.0), ["eth-labels/accounts.csv"]);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_csv_update_refreshes_the_cached_upstream(pool: PgPool) {
    // Checked at "e1"; the file changed before the update downloaded "e2".
    let env = Env::new(pool).await;
    Mock::given(method("HEAD"))
        .and(path("/labels.csv"))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"e1\""))
        .mount(&env.server)
        .await;
    env.serve(
        "/labels.csv",
        ResponseTemplate::new(200)
            .insert_header("etag", "\"e2\"")
            .set_body_string(labels_csv(&[0x11])),
    )
    .await;
    let checked = env.state.upstream.check(false).await;
    assert_eq!(
        checked[&SourceId::EthLabels]
            .as_ref()
            .unwrap()
            .etag
            .as_deref(),
        Some("\"e1\"")
    );
    assert_eq!(
        env.run(SourceId::EthLabels).await.0,
        LocalDataOutcome::Succeeded
    );
    assert_eq!(
        env.row(SourceId::EthLabels).await.etag.as_deref(),
        Some("\"e2\"")
    );

    // The next status compares against what was imported, without asking again.
    let heads = || async {
        env.server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method.as_str() == "HEAD" && r.url.path() == "/labels.csv")
            .count()
    };
    assert_eq!(heads().await, 1);
    let checked = env.state.upstream.check(false).await;
    assert_eq!(
        checked[&SourceId::EthLabels]
            .as_ref()
            .unwrap()
            .etag
            .as_deref(),
        Some("\"e2\"")
    );
    assert_eq!(heads().await, 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_list_body_fetched_by_a_fresh_check_is_reused(pool: PgPool) {
    let env = Env::new(pool).await;
    env.serve(
        "/uniswap.json",
        ResponseTemplate::new(200).set_body_string(list((3, 1, 4), &[0x11])),
    )
    .await;
    let checked = env.state.upstream.check(false).await;
    assert!(checked[&SourceId::TokensUniswap].is_ok());
    assert_eq!(env.gets("/uniswap.json").await, 1);

    let (outcome, _) = env.run(SourceId::TokensUniswap).await;
    assert_eq!(outcome, LocalDataOutcome::Succeeded);
    assert_eq!(
        env.gets("/uniswap.json").await,
        1,
        "the cached body is used"
    );
    let r = env.row(SourceId::TokensUniswap).await;
    assert_eq!((r.version.as_deref(), r.rows), (Some("3.1.4"), Some(1)));
    assert_eq!(files(&env.dir.0), ["tokens/uniswap-default.json"]);
}

// ---------------------------------------------------------------- failures

/// The status row after a failure: failed with an error, last success kept.
async fn assert_failed_keeping_last_success(env: &Env, id: SourceId, old_version: Option<&str>) {
    let r = env.row(id).await;
    assert_eq!(r.state, "failed");
    assert!(r.error.is_some());
    assert_eq!(r.version.as_deref(), old_version);
    assert!(r.imported_at.is_some());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_timeout_or_a_truncated_body_leaves_tables_unchanged_and_no_part_file(pool: PgPool) {
    let mut env =
        Env::with_limits(pool, Some((50 * 1024 * 1024, Duration::from_millis(300)))).await;
    env.seed_old().await;
    let before = env.tables().await;

    // Too slow.
    env.serve(
        "/uniswap.json",
        ResponseTemplate::new(200)
            .set_body_string(list((9, 0, 0), &[0x11]))
            .set_delay(Duration::from_secs(5)),
    )
    .await;
    let (outcome, error) = env.run(SourceId::TokensUniswap).await;
    assert_eq!(outcome, LocalDataOutcome::Failed);
    assert!(error.is_some());
    assert_eq!(env.tables().await, before);
    no_part_file(&env.dir.0);
    assert_failed_keeping_last_success(&env, SourceId::TokensUniswap, Some("1.0.0")).await;

    // Cut off: the body is shorter than its Content-Length.
    let body = list((9, 0, 0), &[0x11]);
    let base = raw_server(http_head(Some(body.len() + 500), body.as_bytes()), false).await;
    env.point(SourceId::TokensUniswap, format!("{base}/uniswap.json"));
    let (outcome, error) = env.run(SourceId::TokensUniswap).await;
    assert_eq!(outcome, LocalDataOutcome::Failed, "{error:?}");
    assert_eq!(env.tables().await, before);
    no_part_file(&env.dir.0);
    assert!(files(&env.dir.0).is_empty());
    assert_failed_keeping_last_success(&env, SourceId::TokensUniswap, Some("1.0.0")).await;
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_html_200_is_refused_and_tables_unchanged(pool: PgPool) {
    let env = Env::new(pool).await;
    env.seed_old().await;
    let before = env.tables().await;
    for p in ["/uniswap.json", "/labels.csv"] {
        env.serve(p, ResponseTemplate::new(200).set_body_string(HTML))
            .await;
    }
    // A CSV with the right header but no rows must not empty the dataset either.
    env.serve(
        "/tokens.csv",
        ResponseTemplate::new(200)
            .set_body_string("address,chainId,label,name,symbol,website,image\n"),
    )
    .await;
    for id in [
        SourceId::TokensUniswap,
        SourceId::EthLabels,
        SourceId::TokensEthLabels,
    ] {
        let (outcome, error) = env.run(id).await;
        assert_eq!(outcome, LocalDataOutcome::Failed, "{id:?}");
        assert!(error.is_some());
        assert_eq!(env.tables().await, before, "{id:?}");
    }
    assert_failed_keeping_last_success(&env, SourceId::TokensUniswap, Some("1.0.0")).await;
    assert_failed_keeping_last_success(&env, SourceId::EthLabels, None).await;
    assert!(files(&env.dir.0).is_empty(), "{:?}", files(&env.dir.0));

    let audits = env.done_audits().await;
    assert_eq!(audits.len(), 3);
    assert!(
        audits
            .iter()
            .all(|a| a.entry.outcome == AuditOutcome::Failed
                && a.entry.after.as_ref().unwrap()["outcome"] == "failed"
                && a.entry.after.as_ref().unwrap()["rows"].is_null()
                && a.entry.after.as_ref().unwrap()["error"].is_string())
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_eth_labels_csv_without_rows_is_refused(pool: PgPool) {
    let env = Env::new(pool).await;
    env.seed_old().await;
    let before = env.tables().await;
    env.serve(
        "/labels.csv",
        ResponseTemplate::new(200).set_body_string("address,chainId,label,nameTag\n"),
    )
    .await;
    let (outcome, _) = env.run(SourceId::EthLabels).await;
    assert_eq!(outcome, LocalDataOutcome::Failed);
    assert_eq!(env.tables().await, before);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn over_the_cap_is_refused(pool: PgPool) {
    let mut env = Env::with_limits(pool, Some((1024, Duration::from_secs(10)))).await;
    env.seed_old().await;
    let before = env.tables().await;
    let big = list((9, 0, 0), &(1..=60).collect::<Vec<u8>>());
    assert!(big.len() > 2048);

    // Announced by Content-Length.
    env.serve(
        "/uniswap.json",
        ResponseTemplate::new(200).set_body_string(&big),
    )
    .await;
    let (outcome, error) = env.run(SourceId::TokensUniswap).await;
    assert_eq!(outcome, LocalDataOutcome::Failed);
    assert!(error.unwrap().contains("too large"));
    assert_eq!(env.tables().await, before);
    no_part_file(&env.dir.0);

    // Without a Content-Length: the stream is cut at the cap.
    let base = raw_server(http_head(None, big.as_bytes()), false).await;
    env.point(SourceId::TokensUniswap, format!("{base}/uniswap.json"));
    let (outcome, error) = env.run(SourceId::TokensUniswap).await;
    assert_eq!(outcome, LocalDataOutcome::Failed);
    assert!(error.unwrap().contains("too large"));
    assert_eq!(env.tables().await, before);
    no_part_file(&env.dir.0);
    assert!(files(&env.dir.0).is_empty());
}

// ----------------------------------------------------------------- cancel, slot

/// A server sending the start of a 100 kB body, then nothing.
async fn stalled_server() -> String {
    raw_server(http_head(Some(100_000), br#"{"name":"x","tokens":["#), true).await
}

/// Waits for the first download progress of `id` on `rx`.
async fn downloading(rx: &mut broadcast::Receiver<(Audience, Event)>, id: SourceId) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let (
                _,
                Event::LocalDataProgress {
                    source,
                    phase: LocalDataPhase::Download,
                    bytes,
                    ..
                },
            ) = rx.recv().await.unwrap()
                && source == id.as_str()
                && bytes > 0
            {
                return;
            }
        }
    })
    .await
    .expect("download progress");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_during_download_keeps_the_last_success_and_idle_state(pool: PgPool) {
    let mut env = Env::new(pool).await;
    env.seed_old().await;
    env.state
        .store
        .local_data_failed("tokens_uniswap", "earlier")
        .await
        .unwrap();
    let before = env.tables().await;
    let base = stalled_server().await;
    env.point(SourceId::TokensUniswap, format!("{base}/uniswap.json"));

    let mut rx = env.state.ctx.bus.subscribe();
    env.state
        .runner
        .start(&env.state, SourceId::TokensUniswap, ADMIN)
        .await
        .unwrap();
    assert_eq!(env.row(SourceId::TokensUniswap).await.state, "running");
    downloading(&mut rx, SourceId::TokensUniswap).await;
    assert!(env.dir.0.join("tokens/uniswap-default.json.part").exists());

    assert!(!env.state.runner.cancel(SourceId::EthLabels));
    assert!(env.state.runner.cancel(SourceId::TokensUniswap));
    let (outcome, error) = done(&mut rx).await;
    assert_eq!((outcome, error), (LocalDataOutcome::Cancelled, None));

    assert_eq!(env.tables().await, before);
    no_part_file(&env.dir.0);
    let r = env.row(SourceId::TokensUniswap).await;
    assert_eq!(r.state, "idle");
    assert_eq!(r.version.as_deref(), Some("1.0.0"));
    assert_eq!(r.rows, Some(1));
    assert_eq!(r.error.as_deref(), Some("earlier"));
    assert_eq!(env.state.runner.running(), None);

    let audits = env.done_audits().await;
    assert_eq!(audits.len(), 1);
    assert_eq!(
        audits[0].entry.after,
        Some(serde_json::json!({"outcome": "cancelled", "rows": null, "error": null}))
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_second_start_is_busy(pool: PgPool) {
    let mut env = Env::new(pool).await;
    let base = stalled_server().await;
    env.point(SourceId::TokensUniswap, format!("{base}/uniswap.json"));
    env.serve(
        "/labels.csv",
        ResponseTemplate::new(200).set_body_string(labels_csv(&[0x11])),
    )
    .await;

    let mut rx = env.state.ctx.bus.subscribe();
    let r = &env.state.runner;
    r.start(&env.state, SourceId::TokensUniswap, ADMIN)
        .await
        .unwrap();
    assert_eq!(r.running(), Some(SourceId::TokensUniswap));
    for id in [SourceId::TokensUniswap, SourceId::EthLabels] {
        assert!(matches!(
            r.start(&env.state, id, ADMIN).await,
            Err(StartError::Busy)
        ));
    }
    // A refused start leaves the other source's row alone.
    assert!(
        env.state
            .store
            .local_data_all()
            .await
            .unwrap()
            .iter()
            .all(|row| row.source == "tokens_uniswap")
    );

    assert!(r.cancel(SourceId::TokensUniswap));
    assert_eq!(done(&mut rx).await.0, LocalDataOutcome::Cancelled);
    assert_eq!(r.running(), None);
    // The slot is free again.
    let (outcome, _) = env.run(SourceId::EthLabels).await;
    assert_eq!(outcome, LocalDataOutcome::Succeeded);
}

// -------------------------------------------------------------------- redirects

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_redirect_off_the_allowlist_is_an_error(pool: PgPool) {
    let env = Env::new(pool).await;
    let evil = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(list((1, 0, 0), &[0x11])))
        .mount(&evil)
        .await;
    env.serve(
        "/uniswap.json",
        ResponseTemplate::new(302).insert_header(
            "location",
            format!("http://localhost:{}/uniswap.json", evil.address().port()),
        ),
    )
    .await;
    // Another port on the same host is another origin.
    env.serve(
        "/coingecko.json",
        ResponseTemplate::new(302)
            .insert_header("location", format!("{}/coingecko.json", evil.uri())),
    )
    .await;
    for id in [SourceId::TokensUniswap, SourceId::TokensCoingecko] {
        let (outcome, error) = env.run(id).await;
        assert_eq!(outcome, LocalDataOutcome::Failed, "{id:?}");
        assert!(error.unwrap().contains("redirect"));
    }
    assert!(evil.received_requests().await.unwrap().is_empty());
    assert!(env.tables().await.tags.is_empty());
    no_part_file(&env.dir.0);

    // A redirect within the allowed origins is followed.
    env.serve(
        "/labels.csv",
        ResponseTemplate::new(302)
            .insert_header("location", format!("{}/moved.csv", env.server.uri())),
    )
    .await;
    env.serve(
        "/moved.csv",
        ResponseTemplate::new(200).set_body_string(labels_csv(&[0x11])),
    )
    .await;
    assert_eq!(
        env.run(SourceId::EthLabels).await.0,
        LocalDataOutcome::Succeeded
    );
}

// ---------------------------------------------------------------------- startup

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn startup_marks_running_as_interrupted(pool: PgPool) {
    let env = Env::new(pool).await;
    env.seed_old().await;
    // A task was running when the previous process stopped.
    env.state
        .store
        .local_data_running("tokens_uniswap", &hex(ADMIN))
        .await
        .unwrap();

    let hit = interrupt_running(&env.state.store).await.unwrap();
    assert_eq!(hit, ["tokens_uniswap"]);
    let r = env.row(SourceId::TokensUniswap).await;
    assert_eq!(r.state, "failed");
    assert_eq!(r.error.as_deref(), Some("interrupted"));
    assert_eq!(r.version.as_deref(), Some("1.0.0"));

    // The slot is free.
    assert_eq!(env.state.runner.running(), None);
    env.serve(
        "/uniswap.json",
        ResponseTemplate::new(200).set_body_string(list((2, 0, 0), &[0x11])),
    )
    .await;
    assert_eq!(
        env.run(SourceId::TokensUniswap).await.0,
        LocalDataOutcome::Succeeded
    );
}

#[tokio::test]
async fn startup_removes_leftover_part_files() {
    let dir = TempDir::new();
    for f in [
        "eth-labels/accounts.csv",
        "eth-labels/accounts.csv.part",
        "tokens/coingecko.json.part",
        "tokens/uniswap-default.json",
        "signatures/s_0_1.parquet",
        "signatures/s_0_1.parquet.etag",
        "signatures/s_1_2.parquet.part",
        "elsewhere/keep.part",
        "keep.part",
    ] {
        let p = dir.0.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
    }
    let removed = Runner::new(dir.0.clone()).remove_parts().await;
    assert_eq!(removed, 3);
    assert_eq!(
        files(&dir.0),
        [
            "elsewhere/keep.part",
            "eth-labels/accounts.csv",
            "keep.part",
            "signatures/s_0_1.parquet",
            "signatures/s_0_1.parquet.etag",
            "tokens/uniswap-default.json",
        ]
    );
    // A data dir with none of the directories is fine.
    let empty = TempDir::new();
    assert_eq!(Runner::new(empty.0.clone()).remove_parts().await, 0);
}

// ----------------------------------------------------------------------- events

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn progress_and_done_reach_admins_only(pool: PgPool) {
    let env = Env::new(pool).await;
    env.serve(
        "/uniswap.json",
        ResponseTemplate::new(200).set_body_string(list((1, 2, 3), &[0x11, 0x22])),
    )
    .await;
    let mut admin = env.state.ctx.bus.subscribe_user(1, true);
    let mut user = env.state.ctx.bus.subscribe_user(2, false);
    assert_eq!(
        env.run(SourceId::TokensUniswap).await.0,
        LocalDataOutcome::Succeeded
    );

    let mut seen = Vec::new();
    loop {
        let e = tokio::time::timeout(Duration::from_secs(5), admin.recv())
            .await
            .unwrap()
            .unwrap();
        let last = matches!(e, Event::LocalDataDone { .. });
        seen.push(e);
        if last {
            break;
        }
    }
    let download = seen.iter().find_map(|e| match e {
        Event::LocalDataProgress {
            source,
            phase: LocalDataPhase::Download,
            bytes,
            total_bytes,
            ..
        } => Some((source.clone(), *bytes, *total_bytes)),
        _ => None,
    });
    let (source, bytes, total) = download.expect("download progress");
    assert_eq!(source, "tokens_uniswap");
    assert!(bytes > 0);
    assert_eq!(total, Some(bytes));
    assert!(seen.iter().any(|e| matches!(
        e,
        Event::LocalDataProgress {
            phase: LocalDataPhase::Import,
            rows: 2,
            files_done: None,
            files_total: None,
            ..
        }
    )));
    assert!(matches!(
        seen.last(),
        Some(Event::LocalDataDone {
            source,
            outcome: LocalDataOutcome::Succeeded,
            error: None,
        }) if source == "tokens_uniswap"
    ));

    let quiet = tokio::time::timeout(Duration::from_millis(200), user.recv()).await;
    assert!(quiet.is_err(), "a non-admin received {quiet:?}");
}

// --------------------------------------------------------------------- sourcify

/// A Sourcify file: its key, ETag (quotes included) and Parquet body.
struct SigFile {
    key: String,
    etag: String,
    body: Vec<u8>,
}

impl SigFile {
    /// `v2/signatures/<name>.parquet` holding `rows` signatures
    /// `<name>_<etag>_<i>(uint256)`, distinct across files and versions.
    fn new(name: &str, etag: &str, rows: usize) -> Self {
        let dir = TempDir::new();
        let p = dir.0.join("f.parquet");
        let tag: String = etag.chars().filter(char::is_ascii_alphanumeric).collect();
        let texts: Vec<String> = (0..rows)
            .map(|i| format!("{name}_{tag}_{i}(uint256)"))
            .collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        parquet_fixture::write_file(&p, &refs, parquet::basic::Compression::SNAPPY, true);
        Self {
            key: format!("v2/signatures/{name}.parquet"),
            etag: etag.into(),
            body: std::fs::read(&p).unwrap(),
        }
    }

    fn name(&self) -> &str {
        self.key.strip_prefix("v2/signatures/").unwrap()
    }

    fn entry(&self) -> serde_json::Value {
        serde_json::json!({"key": self.key, "etag": self.etag, "size": self.body.len()})
    }
}

/// An S3 listing of `files`.
fn listing(files: &[&SigFile]) -> String {
    let contents: String = files
        .iter()
        .map(|f| {
            format!(
                "<Contents><Key>{}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified>\
                 <ETag>{}</ETag><Size>{}</Size></Contents>",
                f.key,
                f.etag.replace('"', "&quot;"),
                f.body.len()
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>b</Name>\
         <IsTruncated>false</IsTruncated>{contents}</ListBucketResult>"
    )
}

/// Every event on `rx` so far.
fn drain(rx: &mut broadcast::Receiver<(Audience, Event)>) -> Vec<Event> {
    let mut out = Vec::new();
    while let Ok((_, e)) = rx.try_recv() {
        out.push(e);
    }
    out
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn first_run_downloads_and_imports_all_files_and_records_the_manifest(pool: PgPool) {
    let env = Env::new(pool).await;
    let (a, b, c) = (
        SigFile::new("s_0", "\"e0\"", 3),
        SigFile::new("s_1", "\"e1\"", 2),
        SigFile::new("s_2", "\"e2-3\"", 4),
    );
    env.serve_sourcify(&[&a, &b, &c]).await;
    let mut rx = env.state.ctx.bus.subscribe();

    let (outcome, error) = env.run(SourceId::SignaturesSourcify).await;
    assert_eq!((outcome, error), (LocalDataOutcome::Succeeded, None));
    assert_eq!(env.signature_count().await, 9);

    let r = env.row(SourceId::SignaturesSourcify).await;
    assert_eq!(r.state, "idle");
    assert_eq!(r.rows, Some(9));
    assert!(r.imported_at.is_some());
    assert_eq!((r.version, r.etag, r.error), (None, None, None));
    assert_eq!(
        r.manifest,
        Some(serde_json::json!([a.entry(), b.entry(), c.entry()]))
    );

    // Each file once, kept on disk with its ETag beside it.
    assert_eq!(
        env.file_gets().await,
        [
            "/v2/signatures/s_0.parquet",
            "/v2/signatures/s_1.parquet",
            "/v2/signatures/s_2.parquet"
        ]
    );
    for f in [&a, &b, &c] {
        let p = env.dir.0.join("signatures").join(f.name());
        assert_eq!(std::fs::read(&p).unwrap(), f.body);
    }
    no_part_file(&env.dir.0);

    // Progress counts files and bytes over the whole run.
    let events = drain(&mut rx);
    let total: u64 = [&a, &b, &c].iter().map(|f| f.body.len() as u64).sum();
    assert!(events.iter().any(|e| matches!(
        e,
        Event::LocalDataProgress {
            phase: LocalDataPhase::Download,
            total_bytes: Some(t),
            files_total: Some(3),
            ..
        } if *t == total
    )));
    assert!(events.iter().any(|e| matches!(
        e,
        Event::LocalDataProgress {
            phase: LocalDataPhase::Import,
            files_done: Some(2),
            files_total: Some(3),
            ..
        }
    )));

    let audits = env.done_audits().await;
    assert_eq!(
        audits[0].entry.after,
        Some(serde_json::json!({"outcome": "succeeded", "rows": 9, "error": null}))
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn second_run_fetches_only_new_or_changed_files(pool: PgPool) {
    let env = Env::new(pool).await;
    let (a, b, c) = (
        SigFile::new("s_0", "\"e0\"", 3),
        SigFile::new("s_1", "\"e1\"", 2),
        SigFile::new("s_2", "\"e2\"", 4),
    );
    env.serve_sourcify(&[&a, &b, &c]).await;
    assert_eq!(
        env.run(SourceId::SignaturesSourcify).await.0,
        LocalDataOutcome::Succeeded
    );

    // `s_1` changed (new ETag, new rows) and `s_3` is new.
    env.server.reset().await;
    let b2 = SigFile::new("s_1", "\"e1b\"", 5);
    let d = SigFile::new("s_3", "\"e3\"", 1);
    env.serve_sourcify(&[&a, &b2, &c, &d]).await;
    let (outcome, error) = env.run(SourceId::SignaturesSourcify).await;
    assert_eq!((outcome, error), (LocalDataOutcome::Succeeded, None));

    assert_eq!(
        env.file_gets().await,
        ["/v2/signatures/s_1.parquet", "/v2/signatures/s_3.parquet"]
    );
    // Only adds: the old `s_1` rows stay.
    assert_eq!(env.signature_count().await, 3 + 2 + 4 + 5 + 1);
    let r = env.row(SourceId::SignaturesSourcify).await;
    assert_eq!(
        r.manifest,
        Some(serde_json::json!([
            a.entry(),
            b2.entry(),
            c.entry(),
            d.entry()
        ]))
    );
    assert_eq!(r.rows, Some(15));
    let on_disk = std::fs::read(env.dir.0.join("signatures/s_1.parquet")).unwrap();
    assert_eq!(on_disk, b2.body);
}

/// Serves three Sourcify files (3, 6 and 2 rows, imported 2 rows a batch),
/// starts an update and cancels it once the second file's import begins: it
/// stops after that file's first batch. Returns the files.
async fn cancelled_in_the_second_file(env: &mut Env) -> (SigFile, SigFile, SigFile) {
    env.signature_batches(2);
    let (a, b, c) = (
        SigFile::new("s_0", "\"e0\"", 3),
        SigFile::new("s_1", "\"e1\"", 6),
        SigFile::new("s_2", "\"e2\"", 2),
    );
    env.serve_sourcify(&[&a, &b, &c]).await;

    let mut rx = env.state.ctx.bus.subscribe();
    env.state
        .runner
        .start(&env.state, SourceId::SignaturesSourcify, ADMIN)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let (
                _,
                Event::LocalDataProgress {
                    phase: LocalDataPhase::Import,
                    files_done: Some(1),
                    ..
                },
            ) = rx.recv().await.unwrap()
            {
                return;
            }
        }
    })
    .await
    .expect("the second file's import");
    assert!(env.state.runner.cancel(SourceId::SignaturesSourcify));
    let (outcome, error) = done(&mut rx).await;
    assert_eq!((outcome, error), (LocalDataOutcome::Cancelled, None));
    (a, b, c)
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_between_batches_keeps_inserted_rows_and_reports_partial(pool: PgPool) {
    let mut env = Env::new(pool).await;
    let (a, b, c) = cancelled_in_the_second_file(&mut env).await;

    // The first file and the first batch of the second stay.
    assert_eq!(env.signature_count().await, 3 + 2);
    let r = env.row(SourceId::SignaturesSourcify).await;
    assert_eq!(r.state, "idle");
    assert!(r.imported_at.is_some());
    assert_eq!(r.rows, Some(3));
    // Partial 1/3: only the fully imported file is in the manifest.
    assert_eq!(r.manifest, Some(serde_json::json!([a.entry()])));
    no_part_file(&env.dir.0);
    assert_eq!(
        env.done_audits().await[0].entry.after,
        Some(serde_json::json!({"outcome": "cancelled", "rows": null, "error": null}))
    );

    // The next update picks up where it stopped; the downloaded second file
    // is not fetched again.
    env.server.reset().await;
    env.serve_sourcify(&[&a, &b, &c]).await;
    let (outcome, error) = env.run(SourceId::SignaturesSourcify).await;
    assert_eq!((outcome, error), (LocalDataOutcome::Succeeded, None));
    assert_eq!(env.file_gets().await, ["/v2/signatures/s_2.parquet"]);
    assert_eq!(env.signature_count().await, 3 + 6 + 2);
    let r = env.row(SourceId::SignaturesSourcify).await;
    assert_eq!(
        r.manifest,
        Some(serde_json::json!([a.entry(), b.entry(), c.entry()]))
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_cancelled_sourcify_update_reports_partial_through_the_api(pool: PgPool) {
    let mut env = Env::new(pool).await;
    cancelled_in_the_second_file(&mut env).await;

    // An admin-mode client of the same database and upstreams.
    let key = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![key_address(&key).to_checksum(None)];
    let (_, mut state, _) = gated_app(env.state.store.pool().clone(), cfg).await;
    state.upstream = env.state.upstream.clone();
    let app = as_default_user(router(state.clone()), &state).await;
    let cookie = admin_cookies(&app, &key).await;

    let (status, body) = get_as(&app, &cookie, "/api/admin/local-data").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sig = body["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["source"] == "signatures_sourcify")
        .unwrap();
    assert_eq!(sig["partial"], serde_json::json!({"done": 1, "total": 3}));
    assert_eq!(sig["upstream"]["status"], "update");
    assert_eq!(sig["state"], "idle");
    assert_eq!(sig["rows"], 3);
    assert!(body["running"].is_null());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_failure_partway_keeps_earlier_files_in_the_manifest(pool: PgPool) {
    let env = Env::new(pool).await;
    let a = SigFile::new("s_0", "\"e0\"", 3);
    let bad = SigFile {
        key: "v2/signatures/s_1.parquet".into(),
        etag: "\"e1\"".into(),
        body: HTML.as_bytes().to_vec(),
    };
    env.serve_sourcify(&[&a, &bad]).await;

    let (outcome, error) = env.run(SourceId::SignaturesSourcify).await;
    assert_eq!(outcome, LocalDataOutcome::Failed);
    let error = error.unwrap();
    assert!(error.contains("s_1.parquet"), "{error}");
    let r = env.row(SourceId::SignaturesSourcify).await;
    assert_eq!(r.state, "failed");
    assert_eq!(r.error.as_deref(), Some(error.as_str()));
    assert_eq!(r.manifest, Some(serde_json::json!([a.entry()])));
    assert_eq!(env.signature_count().await, 3);
    // The unreadable file is not kept, so the next update fetches it again.
    assert_eq!(
        files(&env.dir.0),
        ["signatures/s_0.parquet", "signatures/s_0.parquet.etag"]
    );

    // A listing without files is an error, not an empty success.
    env.server.reset().await;
    env.serve_sourcify(&[]).await;
    let (outcome, error) = env.run(SourceId::SignaturesSourcify).await;
    assert_eq!(outcome, LocalDataOutcome::Failed);
    assert!(error.unwrap().contains("no signature files"));
}

/// The downloader streams: an 8 MB body arrives whole on disk while no more
/// than a 1 MB buffer is ever held in memory.
#[sqlx::test(migrations = "../eg-store/migrations")]
async fn memory_is_bounded(pool: PgPool) {
    const BODY: usize = 8 * 1024 * 1024;
    const BUFFER_CAP: usize = 1024 * 1024;
    let env = Env::new(pool).await;
    env.serve(
        "/big.parquet",
        ResponseTemplate::new(200).set_body_bytes(vec![0x5a; BODY]),
    )
    .await;
    let client = download::client_builder(env.state.upstream.urls())
        .build()
        .unwrap();
    let part = env.dir.0.join("big.parquet.part");
    let got = download::download(
        &client,
        &format!("{}/big.parquet", env.server.uri()),
        &part,
        SOURCIFY_LIMITS,
        &CancellationToken::new(),
        |_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(got.bytes, BODY as u64);
    assert!(
        got.peak_buffered <= BUFFER_CAP,
        "{} bytes held at once",
        got.peak_buffered
    );
    assert_eq!(std::fs::metadata(&part).unwrap().len(), BODY as u64);
}
