mod common;

use std::path::Path;
use std::time::Duration;

use alloy_primitives::Address;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::{NaiveDate, TimeZone, Utc};
use common::{delete, get, test_app};
use eg_core::source::{CallGate, Priority};
use eg_ingest::Event;
use eg_server::background::{next_utc_midnight, rollover, spawn_background};
use eg_server::config::{Config, SourceMode};
use eg_server::dto::{ErrorBody, JobDto, StatusDto};
use eg_store::{JobKind, NewJob};
use http_body_util::BodyExt;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;

fn job(key: &str) -> NewJob {
    NewJob {
        key: key.into(),
        kind: JobKind::SyncAddress,
        params: json!({"address": "0x01"}),
        priority: Priority::Interactive,
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn status_ok(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    state.store.enqueue(&job("a")).await.unwrap();
    let (status, body) = get(&app, "/api/status").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["quota_limit"], 100_000);
    assert_eq!(body["quota_used"], 0);
    assert_eq!(body["paused"], false);
    assert_eq!(body["jobs_active"], 1);
    assert_eq!(body["queue_len"], 0);
    assert_eq!(body["calls"], 0);
    assert_eq!(body["retries"], 0);
    assert_eq!(body["errors"], json!({}));
    assert_eq!(body["degraded"], serde_json::Value::Null);
    assert_eq!(body["rate"], 1000.0);
    let reset_at = chrono::DateTime::parse_from_rfc3339(body["reset_at"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(reset_at, next_utc_midnight(Utc::now()));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_unknown_job_404(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let (status, body) = delete(&app, "/api/jobs/999").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
    assert!(body["error"]["message"].is_string());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_pending_job_204_then_404(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let (id, _) = state.store.enqueue(&job("a")).await.unwrap();
    let (status, body) = delete(&app, &format!("/api/jobs/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, serde_json::Value::Null);
    assert!(state.store.active_jobs().await.unwrap().is_empty());
    let (status, body) = delete(&app, &format!("/api/jobs/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_paused_job_204(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let (id, _) = state.store.enqueue(&job("a")).await.unwrap();
    state.store.claim_next().await.unwrap().unwrap();
    state.store.pause_job_quota(id).await.unwrap();
    let (status, _) = get(&app, "/api/jobs?active=true").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = delete(&app, &format!("/api/jobs/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(state.store.active_jobs().await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_publishes_cancelled_progress(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let mut rx = state.ctx.bus.subscribe();
    let (pending, _) = state.store.enqueue(&job("a")).await.unwrap();
    let (status, _) = delete(&app, &format!("/api/jobs/{pending}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    match rx.try_recv().unwrap() {
        Event::JobProgress {
            job_id,
            kind,
            status,
            ..
        } => {
            assert_eq!(job_id, pending);
            assert_eq!(kind, JobKind::SyncAddress);
            assert_eq!(status, eg_store::JobStatus::Cancelled);
        }
        other => panic!("unexpected {other:?}"),
    }
    // A running job is only flagged; the runner reports the cancellation.
    let (running, _) = state.store.enqueue(&job("b")).await.unwrap();
    state.store.claim_next().await.unwrap().unwrap();
    let (status, _) = delete(&app, &format!("/api/jobs/{running}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(rx.try_recv().is_err());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_bad_id_is_invalid_input(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let (status, body) = delete(&app, "/api/jobs/abc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_input");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn active_jobs_listed(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let (a, _) = state.store.enqueue(&job("a")).await.unwrap();
    let (b, _) = state.store.enqueue(&job("b")).await.unwrap();
    state.store.cancel_job(b).await.unwrap();
    let (status, body) = get(&app, "/api/jobs?active=true").await;
    assert_eq!(status, StatusCode::OK);
    let jobs = body.as_array().unwrap();
    assert_eq!(jobs.len(), 1);
    let j = &jobs[0];
    assert_eq!(j["id"], a);
    assert_eq!(j["key"], "a");
    assert_eq!(j["kind"], "sync_address");
    assert_eq!(j["status"], "pending");
    assert_eq!(j["priority"], "interactive");
    assert_eq!(j["params"], json!({"address": "0x01"}));
    assert_eq!(j["progress"], serde_json::Value::Null);
    assert_eq!(j["attempts"], 0);
    assert_eq!(j["error"], serde_json::Value::Null);
    chrono::DateTime::parse_from_rfc3339(j["created_at"].as_str().unwrap()).unwrap();
    chrono::DateTime::parse_from_rfc3339(j["updated_at"].as_str().unwrap()).unwrap();

    let (status, body) = get(&app, "/api/jobs").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);
    for bad in ["no", "yes"] {
        let (status, body) = get(&app, &format!("/api/jobs?active={bad}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_input");
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn unknown_api_route_is_json_404(pool: PgPool) {
    let (app, _, _) = test_app(pool);
    let (status, body) = get(&app, "/api/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

/// Reads SSE body frames until the accumulated text contains `needle`.
async fn read_until(body: &mut Body, needle: &str) -> String {
    let mut text = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !text.contains(needle) {
            let frame = body.frame().await.expect("stream ended").unwrap();
            if let Ok(data) = frame.into_data() {
                text.push_str(std::str::from_utf8(&data).unwrap());
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never saw {needle:?}"));
    text
}

async fn open_events(app: &axum::Router) -> Body {
    let resp = app
        .clone()
        .oneshot(Request::get("/api/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["content-type"], "text/event-stream");
    resp.into_body()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn events_stream_delivers_published_event(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let mut body = open_events(&app).await;
    state.ctx.bus.publish(Event::AddressDataChanged {
        address: Address::repeat_byte(0xab),
    });
    let text = read_until(&mut body, "AddressDataChanged").await;
    assert!(text.contains("event: AddressDataChanged\n"), "{text}");
    let data = text
        .lines()
        .find_map(|l| l.strip_prefix("data: "))
        .expect("data line");
    let v: serde_json::Value = serde_json::from_str(data).unwrap();
    assert_eq!(
        v,
        json!({"type": "AddressDataChanged", "address": format!("0x{}", "ab".repeat(20))})
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn events_stream_reports_lag(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let mut body = open_events(&app).await;
    for _ in 0..1100 {
        state.ctx.bus.publish(Event::AddressDataChanged {
            address: Address::ZERO,
        });
    }
    let text = read_until(&mut body, "\n\n").await;
    assert!(text.starts_with("event: Lagged\n"), "{text}");
    assert!(text.contains(r#"data: {"type":"Lagged"}"#), "{text}");
    // The stream keeps going after the lag notice.
    read_until(&mut body, "AddressDataChanged").await;
}

#[test]
fn next_midnight_is_strictly_after_now() {
    let t = |h, m| Utc.with_ymd_and_hms(2026, 10, 17, h, m, 0).unwrap();
    let midnight = Utc.with_ymd_and_hms(2026, 10, 18, 0, 0, 0).unwrap();
    assert_eq!(next_utc_midnight(t(13, 5)), midnight);
    assert_eq!(next_utc_midnight(t(0, 0)), midnight);
    assert_eq!(next_utc_midnight(t(23, 59)), midnight);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn rollover_persists_resets_and_resumes(pool: PgPool) {
    let (_, state, _) = test_app(pool);
    for _ in 0..3 {
        state.gate.acquire(Priority::Interactive).await.unwrap();
    }
    let (id, _) = state.store.enqueue(&job("a")).await.unwrap();
    state.store.claim_next().await.unwrap().unwrap();
    state.store.pause_job_quota(id).await.unwrap();

    let wake = state.ctx.wake.clone();
    let notified = wake.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();

    let day = NaiveDate::from_ymd_opt(2026, 10, 16).unwrap();
    rollover(&state, day).await;

    assert_eq!(state.store.quota_get(day).await.unwrap(), 3);
    assert_eq!(state.gate.used(), 0);
    let active = state.store.active_jobs().await.unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].status, eg_store::JobStatus::Pending);
    tokio::time::timeout(Duration::from_secs(1), notified)
        .await
        .expect("workers were not woken");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn background_publishes_quota_status(pool: PgPool) {
    let (_, state, _) = test_app(pool);
    let mut rx = state.ctx.bus.subscribe();
    spawn_background(&state);
    state.gate.acquire(Priority::Interactive).await.unwrap();
    let ev = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Event::QuotaStatus {
                used,
                limit,
                paused,
                reset_at,
            } = rx.recv().await.unwrap()
                && used == 1
            {
                return (used, limit, paused, reset_at);
            }
        }
    })
    .await
    .expect("no QuotaStatus with used == 1");
    assert_eq!(ev.1, 100_000);
    assert!(!ev.2);
    assert_eq!(ev.3, next_utc_midnight(Utc::now()));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn background_primes_the_chain_head(pool: PgPool) {
    let (_, state, fake) = test_app(pool);
    fake.set_latest_block(500);
    spawn_background(&state);
    // Nothing has viewed a transaction yet: the head is fetched on start.
    tokio::time::timeout(Duration::from_secs(5), async {
        while fake.calls() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        while state.head.get(&state).is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("chain head was not primed");
    assert_eq!(state.head.get(&state), Some(500));
    assert_eq!(fake.calls(), 1);
}

#[test]
fn config_example_parses() {
    let cfg = Config::load(Path::new("../../config.example.toml")).unwrap();
    assert_eq!(cfg.etherscan.rate_per_sec, 2.5);
    assert_eq!(cfg.etherscan.daily_limit, 100_000);
    assert_eq!(cfg.etherscan.base_url, "https://api.etherscan.io/v2/api");
    assert_eq!(cfg.sync.workers, 4);
    assert_eq!(cfg.source.mode, SourceMode::Etherscan);
    assert_eq!(cfg.server.listen.to_string(), "127.0.0.1:8080");
    let ing = cfg.ingest();
    assert_eq!(ing.max_records_per_category, 10_000);
    assert_eq!(ing.stale_after, Duration::from_secs(600));
    assert_eq!(ing.reorg_window_blocks, 64);
    assert_eq!(ing.hot_neighbor_threshold, 500);
    assert_eq!(ing.multicall_batch_size, 100);
    assert_eq!(ing.rate_per_sec, 2.5);
    assert_eq!(
        ing.universal_resolver.to_string(),
        "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe"
    );
    assert_eq!(
        ing.multicall3.to_string(),
        "0xcA11bde05977b3631167028862bE2a173976CA11"
    );
    assert_eq!(cfg.auth.public_origin, "http://127.0.0.1:8080");
    assert!(cfg.auth.admins.is_empty());
    assert_eq!(cfg.auth.default_daily_quota, 5000);
    assert_eq!(cfg.auth.session_days, 7);
    assert_eq!(cfg.auth.admin_session_minutes, 60);
    assert!(!cfg.auth.trust_forwarded_for);
}

const AUTH_BASE: &str = "[etherscan]\napi_key = \"k\"\n[server]\ndatabase_url = \"x\"\n";

#[test]
fn config_auth_defaults_and_admins() {
    let cfg = Config::parse(AUTH_BASE, env(&[])).unwrap();
    assert_eq!(cfg.auth.public_origin, "http://127.0.0.1:8080");
    assert!(cfg.auth.admins.is_empty());
    assert!(cfg.auth.admin_addresses().is_empty());
    assert_eq!(cfg.auth.default_daily_quota, 5000);
    assert_eq!(cfg.auth.session_days, 7);
    assert_eq!(cfg.auth.admin_session_minutes, 60);
    assert!(!cfg.auth.trust_forwarded_for);

    let text = format!(
        "{AUTH_BASE}[auth]\npublic_origin = \"https://graph.example.org\"\n\
         admins = [\"0xcA11bde05977b3631167028862bE2a173976CA11\", \
         \"0x0000000000000000000000000000000000000001\"]\n\
         default_daily_quota = 100\nsession_days = 1\nadmin_session_minutes = 5\n\
         trust_forwarded_for = true\n"
    );
    let cfg = Config::parse(&text, env(&[])).unwrap();
    assert_eq!(cfg.auth.public_origin, "https://graph.example.org");
    assert_eq!(
        cfg.auth.admin_addresses(),
        [
            "0xcA11bde05977b3631167028862bE2a173976CA11"
                .parse::<alloy_primitives::Address>()
                .unwrap(),
            alloy_primitives::Address::with_last_byte(1),
        ]
    );
    assert_eq!(cfg.auth.default_daily_quota, 100);
    assert_eq!(cfg.auth.session_days, 1);
    assert_eq!(cfg.auth.admin_session_minutes, 5);
    assert!(cfg.auth.trust_forwarded_for);
}

#[test]
fn config_rejects_bad_auth_values() {
    for bad in [
        "admins = [\"0x12\"]",
        "admins = [\"not an address\"]",
        // Mixed case with a wrong checksum is a typo, not a lower-case address.
        "admins = [\"0xCA11bde05977b3631167028862bE2a173976CA11\"]",
        "public_origin = \"127.0.0.1:8080\"",
        "public_origin = \"http://127.0.0.1:8080/\"",
        "session_days = 0",
        "admin_session_minutes = 0",
        "unknown_key = 1",
    ] {
        let text = format!("{AUTH_BASE}[auth]\n{bad}\n");
        assert!(Config::parse(&text, env(&[])).is_err(), "{bad}");
    }
}

fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |k| {
        vars.iter()
            .find(|(n, _)| *n == k)
            .map(|(_, v)| v.to_string())
    }
}

#[test]
fn config_env_overrides_file() {
    let text = r#"
        [etherscan]
        api_key = "from-file"
        [server]
        database_url = "postgres://file"
    "#;
    let cfg = Config::parse(text, env(&[])).unwrap();
    assert_eq!(cfg.etherscan.api_key.as_deref(), Some("from-file"));
    assert_eq!(cfg.server.database_url, "postgres://file");
    let cfg = Config::parse(
        text,
        env(&[
            ("ETHERSCAN_API_KEY", "from-env"),
            ("DATABASE_URL", "postgres://env"),
        ]),
    )
    .unwrap();
    assert_eq!(cfg.etherscan.api_key.as_deref(), Some("from-env"));
    assert_eq!(cfg.server.database_url, "postgres://env");
}

#[test]
fn config_defaults_follow_spec() {
    let cfg = Config::parse(
        "[etherscan]\napi_key = \"k\"\n[server]\ndatabase_url = \"postgres://x\"\n",
        env(&[]),
    )
    .unwrap();
    assert_eq!(cfg.etherscan.base_url, "https://api.etherscan.io/v2/api");
    assert_eq!(cfg.etherscan.rate_per_sec, 2.5);
    assert_eq!(cfg.etherscan.daily_limit, 100_000);
    assert_eq!(cfg.sync.workers, 4);
    assert_eq!(cfg.server.listen.to_string(), "127.0.0.1:8080");
    assert_eq!(cfg.source.mode, SourceMode::Etherscan);
    assert!(cfg.server.static_dir.is_none());
    let ing = cfg.ingest();
    let def = eg_ingest::config::IngestConfig::default();
    assert_eq!(ing.universal_resolver, def.universal_resolver);
    assert_eq!(ing.multicall3, def.multicall3);
    assert_eq!(ing.max_attempts, def.max_attempts);
}

#[test]
fn config_api_key_required_unless_fixture() {
    let db = "[server]\ndatabase_url = \"postgres://x\"\n";
    let err = Config::parse(db, env(&[])).unwrap_err();
    assert!(err.to_string().contains("api_key"), "{err}");
    let empty = format!("[etherscan]\napi_key = \"\"\n{db}");
    assert!(Config::parse(&empty, env(&[])).is_err());
    let record = format!("[source]\nmode = \"record\"\n{db}");
    assert!(Config::parse(&record, env(&[])).is_err());
    let fixture = format!("[source]\nmode = \"fixture\"\n{db}");
    let cfg = Config::parse(&fixture, env(&[])).unwrap();
    assert_eq!(cfg.source.mode, SourceMode::Fixture);
    assert!(cfg.etherscan.api_key.is_none());
}

#[test]
fn config_rejects_missing_database_url_and_bad_values() {
    assert!(Config::parse("[etherscan]\napi_key = \"k\"\n", env(&[])).is_err());
    let bad_addr = "[etherscan]\napi_key = \"k\"\n[server]\ndatabase_url = \"x\"\n\
                    [ens]\nmulticall3 = \"0x12\"\n";
    assert!(Config::parse(bad_addr, env(&[])).is_err());
    let bad_rate = "[etherscan]\napi_key = \"k\"\nrate_per_sec = 0\n\
                    [server]\ndatabase_url = \"x\"\n";
    assert!(Config::parse(bad_rate, env(&[])).is_err());
}

#[test]
fn export_bindings_compile() {
    use ts_rs::TS;
    let cfg = ts_rs::Config::from_env();
    StatusDto::export_all(&cfg).unwrap();
    JobDto::export_all(&cfg).unwrap();
    ErrorBody::export_all(&cfg).unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/api/generated");
    for f in ["StatusDto.ts", "JobDto.ts", "ErrorBody.ts"] {
        assert!(dir.join(f).is_file(), "missing {f}");
    }
    let status = std::fs::read_to_string(dir.join("StatusDto.ts")).unwrap();
    assert!(!status.contains("bigint"), "{status}");
}

#[test]
fn config_debug_redacts_api_key() {
    let cfg = Config::parse(
        "[etherscan]\napi_key = \"SECRETKEY123\"\n[server]\ndatabase_url = \"postgres://x\"\n",
        env(&[]),
    )
    .unwrap();
    for s in [format!("{cfg:?}"), format!("{:#?}", cfg.etherscan)] {
        assert!(!s.contains("SECRETKEY123"), "{s}");
        assert!(s.contains("***"), "{s}");
        assert!(s.contains("rate_per_sec"), "{s}");
    }
    let none = Config::default();
    assert!(format!("{none:?}").contains("api_key: None"));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_pending_sync_settles_syncing_kinds(pool: PgPool) {
    use eg_core::types::TransferKind;
    use eg_ingest::{SyncDirection, enqueue_sync};
    use eg_store::SyncState;
    let (app, state, _) = test_app(pool.clone());
    let (addr, other) = (Address::repeat_byte(0xaa), Address::repeat_byte(0xbb));
    for (a, kind, to_block) in [
        (addr, TransferKind::Native, Some(20i64)),
        (addr, TransferKind::Erc20, None),
        (other, TransferKind::Native, None),
    ] {
        sqlx::query(
            "INSERT INTO address_sync (address, kind, from_block, to_block, state) \
             VALUES ($1, $2, $3, $3, 'syncing')",
        )
        .bind(a.as_slice().to_vec())
        .bind(kind.as_i16())
        .bind(to_block)
        .execute(&pool)
        .await
        .unwrap();
    }
    // The job ran, was paused by the quota and left its kinds `syncing`.
    let id = enqueue_sync(
        &state.ctx,
        addr,
        SyncDirection::Latest,
        Priority::Background,
        None,
        None,
    )
    .await
    .unwrap();
    state.store.claim_next().await.unwrap().unwrap();
    state.store.pause_job_quota(id).await.unwrap();
    let (status, _) = delete(&app, &format!("/api/jobs/{id}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let rows = state.store.sync_rows(&[addr, other]).await.unwrap();
    let st = |a, k| {
        rows.iter()
            .find(|r| r.address == a && r.kind == k)
            .unwrap()
            .state
    };
    assert_eq!(st(addr, TransferKind::Native), SyncState::Ok);
    assert_eq!(st(addr, TransferKind::Erc20), SyncState::Failed);
    assert_eq!(st(other, TransferKind::Native), SyncState::Syncing);

    // While another sync of the same address is still active, its `syncing`
    // kinds are left alone.
    let running = enqueue_sync(
        &state.ctx,
        other,
        SyncDirection::Older,
        Priority::Background,
        None,
        None,
    )
    .await
    .unwrap();
    state.store.claim_next().await.unwrap().unwrap();
    let pending = enqueue_sync(
        &state.ctx,
        other,
        SyncDirection::Latest,
        Priority::Background,
        None,
        None,
    )
    .await
    .unwrap();
    assert_ne!(running, pending);
    let (status, _) = delete(&app, &format!("/api/jobs/{pending}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let rows = state.store.sync_rows(&[other]).await.unwrap();
    assert_eq!(rows[0].state, SyncState::Syncing);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn recent_jobs_and_single_job_expose_errors(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let (failed, _) = state.store.enqueue(&job("failed")).await.unwrap();
    state.store.claim_next().await.unwrap().unwrap();
    state
        .store
        .fail_job(failed, "invalid api key", false)
        .await
        .unwrap();
    for i in 0..55 {
        state.store.enqueue(&job(&format!("j{i}"))).await.unwrap();
    }
    let (status, body) = get(&app, "/api/jobs?active=false").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let jobs = body.as_array().unwrap();
    assert_eq!(jobs.len(), 50);
    assert_eq!(jobs[0]["key"], "j54", "newest first");

    let (status, body) = get(&app, &format!("/api/jobs/{failed}")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let dto: JobDto = serde_json::from_value(body).unwrap();
    assert_eq!(dto.id, failed);
    assert_eq!(dto.status, "failed");
    assert_eq!(dto.error.as_deref(), Some("invalid api key"));

    let (status, body) = get(&app, "/api/jobs/999999").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = get(&app, "/api/jobs/abc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "invalid_input");
}

/// Answers every request with Etherscan's invalid-key error.
struct BadKeyTransport;

#[async_trait::async_trait]
impl eg_etherscan::Transport for BadKeyTransport {
    async fn get(
        &self,
        _params: &[(String, String)],
    ) -> Result<String, eg_core::source::SourceError> {
        Ok(r#"{"status":"0","message":"NOTOK","result":"Invalid API Key (#err2)"}"#.into())
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn status_reports_invalid_key_as_degraded(pool: PgPool) {
    let (app, state, _) = test_app(pool);
    let client = eg_etherscan::EtherscanClient::new(
        std::sync::Arc::new(BadKeyTransport),
        state.gate.clone(),
        "bad".into(),
        state.stats.clone(),
    );
    let err = client.call(Priority::Interactive, &[]).await.unwrap_err();
    assert_eq!(err, eg_core::source::SourceError::InvalidKey);
    let (status, body) = get(&app, "/api/status").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["degraded"], "invalid_key");
    assert_eq!(body["errors"]["invalid_key"], 1);
}
