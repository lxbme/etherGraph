mod common;

use std::net::SocketAddr;
use std::sync::Arc;

use alloy_primitives::{Address, B256, Bytes, eip191_hash_message};
use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use axum::routing::get;
use chrono::Duration;
use common::{
    ORIGIN, anon_app, get_as, key_address, login_as, message_for, new_key, nonce_for,
    personal_sign, post_json, post_login, send, send_full, session_cookie, test_app,
    whitelisted_key,
};
use eg_core::source::SourceError;
use eg_server::app::router;
use eg_server::auth::extract::{AdminMode, CurrentUser};
use eg_server::auth::ratelimit::AuditCap;
use eg_server::auth::siwe::canonical_message;
use eg_server::auth::{AuthState, flush_suppressed_audit};
use eg_server::config::Config;
use eg_server::dto::SiweFieldsDto;
use eg_server::state::AppState;
use eg_store::{
    AuditEntry, AuditFilter, AuditOutcome, AuditRow, SETTING_OPEN_REGISTRATION, SessionKind, Store,
};
use serde_json::{Value, json};
use sqlx::PgPool;

fn reason(body: &Value) -> &str {
    assert_eq!(body["error"]["code"], "unauthorized", "{body}");
    body["error"]["message"].as_str().unwrap()
}

async fn audit(store: &Store, action: &str) -> Vec<AuditRow> {
    let filter = AuditFilter {
        action: Some(action.into()),
        ..AuditFilter::default()
    };
    store.audit_page(&filter, None, 100).await.unwrap()
}

async fn count(pool: &PgPool, table: &str) -> i64 {
    let sql = match table {
        "users" => "SELECT count(*) FROM users",
        "sessions" => "SELECT count(*) FROM sessions",
        _ => unreachable!("{table}"),
    };
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

fn get_req(uri: &str, cookie: Option<&str>) -> Request<Body> {
    let mut r = Request::get(uri);
    if let Some(c) = cookie {
        r = r.header(header::COOKIE, c);
    }
    r.body(Body::empty()).unwrap()
}

// ------------------------------------------------------------- canonical message

#[derive(serde::Deserialize)]
struct CanonicalCase {
    fields: SiweFieldsDto,
    address: String,
    expected: String,
}

/// The same file is checked against viem's `createSiweMessage` by the
/// frontend tests, so both sides print byte-identical messages.
#[test]
fn canonical_message_matches_the_shared_fixture() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/data/siwe_canonical.json"
    ))
    .unwrap();
    let cases: Vec<CanonicalCase> = serde_json::from_str(&text).unwrap();
    assert!(cases.len() >= 3);
    // A lower-case input address is printed EIP-55 checksummed.
    assert!(cases.iter().any(|c| {
        let a: Address = c.address.parse().unwrap();
        let checksummed = a.to_checksum(None);
        c.address == format!("{a:#x}")
            && c.address != checksummed
            && c.expected.contains(&checksummed)
    }));
    for c in cases {
        let addr: Address = c.address.parse().unwrap();
        assert_eq!(canonical_message(&c.fields.siwe_fields(), addr), c.expected);
    }
}

// ------------------------------------------------------------------ nonce

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn nonce_returns_the_message_fields(pool: PgPool) {
    let (app, _, _) = anon_app(pool, Config::default());
    let key = new_key();
    let addr = key_address(&key);
    let (status, body) = send(
        &app,
        get_req(&format!("/api/auth/nonce?address={addr:#x}"), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let keys: Vec<&str> = body
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    let mut keys = keys;
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "address",
            "chain_id",
            "domain",
            "expiration_time",
            "issued_at",
            "nonce",
            "statement",
            "uri",
            "version"
        ]
    );
    assert_eq!(body["domain"], "127.0.0.1:8080");
    assert_eq!(body["uri"], ORIGIN);
    assert_eq!(body["address"], format!("{addr:#x}"));
    assert_eq!(body["statement"], "Sign in to etherGraph");
    assert_eq!(body["version"], "1");
    assert_eq!(body["chain_id"], 1);
    let nonce = body["nonce"].as_str().unwrap();
    assert!(nonce.len() >= 8 && nonce.chars().all(|c| c.is_ascii_alphanumeric()));
    // Millisecond ISO strings, as JavaScript's `toISOString` prints them.
    let parse = |k: &str| {
        let s = body[k].as_str().unwrap();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z'), "{s}");
        chrono::DateTime::parse_from_rfc3339(s).unwrap()
    };
    assert_eq!(
        parse("expiration_time") - parse("issued_at"),
        Duration::minutes(5)
    );

    let (status, _) = send(&app, get_req("/api/auth/nonce?address=0x12", None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(&app, get_req("/api/auth/nonce", None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn nonce_and_login_are_rate_limited_per_ip(pool: PgPool) {
    let (app, _, _) = anon_app(pool, Config::default());
    let addr = key_address(&new_key());
    let uri = format!("/api/auth/nonce?address={addr:#x}");
    for _ in 0..10 {
        let (status, _) = send(&app, get_req(&uri, None)).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, body) = send(&app, get_req(&uri, None)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");
    // Another client IP has its own budget.
    let req = Request::get(&uri)
        .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [10, 0, 0, 2],
            5000,
        ))))
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, req).await.0, StatusCode::OK);

    for _ in 0..10 {
        let (status, _, _) = post_login(&app, "garbage", "0x00").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _, body) = post_login(&app, "garbage", "0x00").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");
}

// ------------------------------------------------------------------ login

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn login_happy_path_sets_a_session_cookie(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    let addr = key_address(&key);
    let fields = nonce_for(&app, addr).await;
    let message = message_for(&fields);
    let signature = personal_sign(&key, &message);
    let (status, cookies, body) = post_login(&app, &message, &signature).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["address"], format!("{addr:#x}"));
    assert_eq!(body["is_admin"], false);
    // Admin mode is `GET /api/admin/session` (the cookie only reaches /api/admin).
    assert!(body.get("admin_mode").is_none(), "{body}");
    assert_eq!(body["quota"]["used"], 0);
    assert_eq!(body["quota"]["limit"], 5000);
    assert!(body["quota"]["reset_at"].is_string());

    assert_eq!(cookies.len(), 1);
    let c = &cookies[0];
    let token = session_cookie(&cookies).unwrap();
    assert_eq!(token.len(), "eg_session=".len() + 64);
    for attr in ["Path=/", "Max-Age=604800", "HttpOnly", "SameSite=Lax"] {
        assert!(c.split("; ").any(|a| a == attr), "{attr} missing in {c}");
    }
    // http://127.0.0.1 is local development: no Secure flag.
    assert!(!c.contains("Secure"), "{c}");

    let (status, me) = get_as(&app, &token, "/api/auth/me").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["address"], format!("{addr:#x}"));
    let (status, _) = get_as(&app, &token, "/api/status").await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(count(&pool, "users").await, 1);
    assert_eq!(count(&pool, "sessions").await, 1);
    let rows = audit(&state.store, "login").await;
    assert_eq!(rows.len(), 1);
    let e = &rows[0].entry;
    assert_eq!(e.actor, format!("{addr:#x}"));
    assert_eq!(e.outcome, AuditOutcome::Ok);
    assert_eq!(e.message.as_deref(), Some(message.as_str()));
    // The audit row never holds the session token.
    let raw = token.strip_prefix("eg_session=").unwrap();
    let dump: String = sqlx::query_scalar("SELECT string_agg(audit_log::text, '') FROM audit_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!dump.contains(raw));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn https_origin_sets_secure_cookies(pool: PgPool) {
    let mut cfg = Config::default();
    cfg.auth.public_origin = "https://graph.example.org".into();
    let (app, state, _) = anon_app(pool, cfg);
    let key = whitelisted_key(&state).await;
    let fields = nonce_for(&app, key_address(&key)).await;
    assert_eq!(fields.domain, "graph.example.org");
    assert_eq!(fields.uri, "https://graph.example.org");
    let message = message_for(&fields);
    let body = json!({"message": message, "signature": personal_sign(&key, &message)});
    let req = Request::post("/api/auth/login")
        .header("content-type", "application/json")
        .header(header::ORIGIN, "https://graph.example.org")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, cookies, body) = send_full(&app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let c = &cookies[0];
    // `__Host-`: the browser takes it only from this host, Secure, Path=/
    // and without Domain, so a sibling subdomain cannot plant a session.
    assert!(c.starts_with("__Host-eg_session="), "{c}");
    for attr in ["Secure", "Path=/", "HttpOnly"] {
        assert!(c.split("; ").any(|a| a == attr), "{attr} missing in {c}");
    }
    assert!(!c.contains("Domain"), "{c}");
    let pair = c.split(';').next().unwrap().to_owned();
    let token = pair.strip_prefix("__Host-eg_session=").unwrap();
    let (status, me) = get_as(&app, &pair, "/api/auth/me").await;
    assert_eq!(status, StatusCode::OK, "{me}");
    // The unprefixed name is not read over https (it could be tossed).
    let (status, _) = get_as(&app, &format!("eg_session={token}"), "/api/auth/me").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Logout ends it and clears the prefixed cookie.
    let req = Request::post("/api/auth/logout")
        .header(header::ORIGIN, "https://graph.example.org")
        .header(header::COOKIE, &pair)
        .body(Body::empty())
        .unwrap();
    let (status, cleared, _) = send_full(&app, req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(
        cleared
            .iter()
            .any(|c| c.starts_with("__Host-eg_session=;") && c.contains("Max-Age=0")),
        "{cleared:?}"
    );
    assert_eq!(
        get_as(&app, &pair, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_nonce_is_single_use(pool: PgPool) {
    let (app, state, _) = anon_app(pool, Config::default());
    let key = whitelisted_key(&state).await;
    let fields = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&fields);
    let sig = personal_sign(&key, &message);
    assert_eq!(post_login(&app, &message, &sig).await.0, StatusCode::OK);
    let (status, cookies, body) = post_login(&app, &message, &sig).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "bad_nonce");
    assert!(session_cookie(&cookies).is_none());
    let rows = audit(&state.store, "login").await;
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
    assert_eq!(rows[0].entry.after, Some(json!({"reason": "bad_nonce"})));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_expired_or_unknown_nonce_is_rejected(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    let fields = nonce_for(&app, key_address(&key)).await;
    sqlx::query("UPDATE auth_nonces SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    let message = message_for(&fields);
    let (status, _, body) = post_login(&app, &message, &personal_sign(&key, &message)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "bad_nonce");

    // A nonce the server never issued.
    let mut forged = fields.clone();
    forged.nonce = "0123456789abcdef0123456789abcdef".into();
    let message = message_for(&forged);
    let (_, _, body) = post_login(&app, &message, &personal_sign(&key, &message)).await;
    assert_eq!(reason(&body), "bad_nonce");
    assert_eq!(count(&pool, "sessions").await, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_edited_message_is_rejected(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    let other = whitelisted_key(&state).await;
    type Edit = fn(&mut SiweFieldsDto, Address);
    let edits: [(&str, Edit); 6] = [
        ("domain", |f, _| f.domain = "evil.example.org".into()),
        ("uri", |f, _| f.uri = "https://evil.example.org".into()),
        ("chain", |f, _| f.chain_id = 5),
        ("statement", |f, _| {
            f.statement = "Sign in to something else".into()
        }),
        ("expiry", |f, _| {
            f.expiration_time = "2099-01-01T00:00:00.000Z".into()
        }),
        // Someone else's nonce, signed by their own whitelisted key.
        ("address", |f, a| f.address = format!("{a:#x}")),
    ];
    for (what, edit) in edits {
        let mut fields = nonce_for(&app, key_address(&key)).await;
        edit(&mut fields, key_address(&other));
        let message = message_for(&fields);
        let signer = if what == "address" { &other } else { &key };
        let (status, _, body) = post_login(&app, &message, &personal_sign(signer, &message)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{what}");
        assert_eq!(reason(&body), "bad_message", "{what}");
    }
    // Text the server would not have built (here: a lower-case address line).
    let fields = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&fields).replace(
        &key_address(&key).to_checksum(None),
        &format!("{:#x}", key_address(&key)),
    );
    let (_, _, body) = post_login(&app, &message, &personal_sign(&key, &message)).await;
    assert_eq!(reason(&body), "bad_message");
    // Not a SIWE message at all.
    let (_, _, body) = post_login(&app, "hello", &personal_sign(&key, "hello")).await;
    assert_eq!(reason(&body), "bad_message");
    assert_eq!(count(&pool, "sessions").await, 0);
    assert_eq!(count(&pool, "users").await, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_signature_from_another_key_is_rejected(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    let fields = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&fields);
    let (status, _, body) = post_login(&app, &message, &personal_sign(&new_key(), &message)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "bad_signature");
    // A malformed signature.
    let fields = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&fields);
    let (_, _, body) = post_login(&app, &message, "0xzz").await;
    assert_eq!(reason(&body), "bad_signature");
    assert_eq!(count(&pool, "sessions").await, 0);
    let rows = audit(&state.store, "login").await;
    assert!(rows.iter().all(|r| r.entry.outcome == AuditOutcome::Denied));
    assert_eq!(rows[0].entry.actor, format!("{:#x}", key_address(&key)));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_valid_signature_from_a_non_whitelisted_address_is_denied(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = new_key();
    let addr = key_address(&key);
    let fields = nonce_for(&app, addr).await;
    let message = message_for(&fields);
    let (status, cookies, body) = post_login(&app, &message, &personal_sign(&key, &message)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "not_whitelisted");
    assert!(cookies.is_empty());
    assert_eq!(count(&pool, "users").await, 0);
    assert_eq!(count(&pool, "sessions").await, 0);
    let rows = audit(&state.store, "login").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.actor, format!("{addr:#x}"));
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
    assert_eq!(
        rows[0].entry.after,
        Some(json!({"reason": "not_whitelisted"}))
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn open_registration_logs_in_and_whitelists_new_addresses(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    state
        .store
        .setting_set(SETTING_OPEN_REGISTRATION, &json!(true))
        .await
        .unwrap();
    let key = new_key();
    let cookie = login_as(&app, &key).await;
    assert_eq!(
        get_as(&app, &cookie, "/api/auth/me").await.0,
        StatusCode::OK
    );
    let list = state.store.whitelist_list().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].address, key_address(&key));
    assert_eq!(list[0].added_by, "open-registration");

    // Closing registration keeps them in.
    state
        .store
        .setting_set(SETTING_OPEN_REGISTRATION, &json!(false))
        .await
        .unwrap();
    login_as(&app, &key).await;
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn admins_log_in_without_being_whitelisted(pool: PgPool) {
    let key = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![key_address(&key).to_checksum(None)];
    let (app, state, _) = anon_app(pool, cfg);
    let cookie = login_as(&app, &key).await;
    let (_, me) = get_as(&app, &cookie, "/api/auth/me").await;
    assert_eq!(me["is_admin"], true);
    // Not added to the whitelist: admin status comes from the config.
    assert!(state.store.whitelist_list().await.unwrap().is_empty());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn me_and_logout(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let (status, body) = send(&app, get_req("/api/auth/me", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "no_session");

    let key = whitelisted_key(&state).await;
    let cookie = login_as(&app, &key).await;
    let req = Request::post("/api/auth/logout")
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    let (status, cookies, _) = send_full(&app, req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(cookies.len(), 2, "{cookies:?}");
    assert!(cookies[0].starts_with("eg_session=;"), "{}", cookies[0]);
    assert!(cookies[0].contains("Path=/;"), "{}", cookies[0]);
    assert!(cookies[0].contains("Max-Age=0"), "{}", cookies[0]);
    assert!(cookies[1].starts_with("eg_admin=;"), "{}", cookies[1]);
    assert!(cookies[1].contains("Path=/api/admin;"), "{}", cookies[1]);
    assert!(cookies[1].contains("Max-Age=0"), "{}", cookies[1]);
    assert_eq!(count(&pool, "sessions").await, 0);
    assert_eq!(
        get_as(&app, &cookie, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED
    );
    let rows = audit(&state.store, "logout").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.actor, format!("{:#x}", key_address(&key)));
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Ok);

    // Without a session logout still clears the cookie.
    let req = Request::post("/api/auth/logout")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    let (status, cookies, _) = send_full(&app, req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(cookies[0].starts_with("eg_session=;"));
    assert_eq!(audit(&state.store, "logout").await.len(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_new_login_ends_the_session_it_replaces(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    let other = whitelisted_key(&state).await;
    let first = login_as(&app, &key).await;
    let admin = admin_session_for(&state.store, &first).await;
    let bystander = login_as(&app, &other).await;

    // The browser still holds the first session's cookie when it signs in
    // again (here as another wallet).
    let fields = nonce_for(&app, key_address(&other)).await;
    let message = message_for(&fields);
    let body = json!({"message": message, "signature": personal_sign(&other, &message)});
    let req = Request::post("/api/auth/login")
        .header("content-type", "application/json")
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, &first)
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, cookies, body) = send_full(&app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let second = session_cookie(&cookies).unwrap();

    assert_eq!(
        get_as(&app, &first, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert!(
        state
            .store
            .session_lookup(&admin, SessionKind::Admin)
            .await
            .unwrap()
            .is_none()
    );
    for live in [&second, &bystander] {
        assert_eq!(get_as(&app, live, "/api/auth/me").await.0, StatusCode::OK);
    }
    assert_eq!(count(&pool, "sessions").await, 2);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn logout_ends_admin_mode_and_a_new_login_does_not_resume_it(pool: PgPool) {
    let key = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![format!("{:#x}", key_address(&key))];
    let (app, state, _) = anon_app(pool, cfg);
    let cookie = login_as(&app, &key).await;
    let user = state
        .store
        .upsert_user_on_login(key_address(&key))
        .await
        .unwrap();
    let admin = admin_session_for(&state.store, &cookie).await;
    assert_eq!(user.address, key_address(&key));
    let both = |session: &str| format!("{session}; eg_admin={admin}");
    let (status, _) = get_as(&app, &both(&cookie), "/api/admin/session").await;
    assert_eq!(status, StatusCode::OK);

    let req = Request::post("/api/auth/logout")
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, req).await.0, StatusCode::NO_CONTENT);
    assert!(
        state
            .store
            .session_lookup(&admin, SessionKind::Admin)
            .await
            .unwrap()
            .is_none()
    );
    // The browser may still hold the old eg_admin cookie.
    let again = login_as(&app, &key).await;
    let (status, body) = get_as(&app, &both(&again), "/api/admin/session").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "no_admin_session");
}

/// An admin-mode session started from the login session of `cookie`
/// (`eg_session=…`), as `POST /api/admin/session` creates it.
async fn admin_session_for(store: &Store, cookie: &str) -> String {
    let login = cookie.strip_prefix("eg_session=").unwrap_or(cookie);
    let entry = AuditEntry {
        actor: "test".into(),
        action: "admin_mode_enter".into(),
        target: None,
        before: None,
        after: None,
        outcome: AuditOutcome::Ok,
        ip: None,
        user_agent: None,
        message: None,
        signature: None,
    };
    store
        .admin_session_create_audited(login, Duration::hours(1), None, None, &entry)
        .await
        .unwrap()
        .expect("a live login session")
        .0
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_login_whose_audit_row_fails_leaves_no_session(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    sqlx::query(
        "CREATE FUNCTION reject_ok_audit() RETURNS trigger LANGUAGE plpgsql AS \
         $$ BEGIN RAISE EXCEPTION 'audit down'; END; $$",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_ok_audit BEFORE INSERT ON audit_log FOR EACH ROW \
         WHEN (NEW.outcome = 'ok') EXECUTE FUNCTION reject_ok_audit()",
    )
    .execute(&pool)
    .await
    .unwrap();
    let fields = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&fields);
    let (status, cookies, body) = post_login(&app, &message, &personal_sign(&key, &message)).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(cookies.is_empty(), "{cookies:?}");
    assert_eq!(count(&pool, "sessions").await, 0);
    // The attempt is still on record, as failed.
    let rows = audit(&state.store, "login").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Failed);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn login_audit_rows_hold_the_payload_only_once_a_nonce_was_taken(pool: PgPool) {
    let (app, state, _) = anon_app(pool, Config::default());
    let key = whitelisted_key(&state).await;
    let addr = format!("{:#x}", key_address(&key));
    let latest = || async {
        let rows = audit(&state.store, "login").await;
        rows.into_iter().next().unwrap().entry
    };

    // Not a SIWE message: nothing of it is kept.
    post_login(&app, "hello", &personal_sign(&key, "hello")).await;
    let e = latest().await;
    assert_eq!(e.after, Some(json!({"reason": "bad_message"})));
    assert_eq!(
        (e.actor.as_str(), &e.message, &e.signature),
        ("unknown", &None, &None)
    );

    // A nonce the server never issued.
    let mut forged = nonce_for(&app, key_address(&key)).await;
    forged.nonce = "0123456789abcdef0123456789abcdef".into();
    let message = message_for(&forged);
    post_login(&app, &message, &personal_sign(&key, &message)).await;
    let e = latest().await;
    assert_eq!(e.after, Some(json!({"reason": "bad_nonce"})));
    assert_eq!(
        (e.actor.as_str(), &e.message, &e.signature),
        (addr.as_str(), &None, &None)
    );

    // Cross-origin: refused before anything else, still audited.
    let fields = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&fields);
    let signature = personal_sign(&key, &message);
    let body = json!({"message": message, "signature": signature});
    let req = Request::post("/api/auth/login")
        .header("content-type", "application/json")
        .header(header::ORIGIN, "https://evil.example.org")
        .body(Body::from(body.to_string()))
        .unwrap();
    assert_eq!(send(&app, req).await.0, StatusCode::UNAUTHORIZED);
    let e = latest().await;
    assert_eq!(e.after, Some(json!({"reason": "bad_origin"})));
    assert_eq!(e.outcome, AuditOutcome::Denied);
    assert_eq!((&e.message, &e.signature), (&None, &None));

    // A body that is not a login request, from the right origin.
    let req = Request::post("/api/auth/login")
        .header("content-type", "application/json")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from("not json"))
        .unwrap();
    let (status, body) = send(&app, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "invalid_input");

    // A taken nonce with a wrong signature: the payload is kept.
    let (_, _, body) = post_login(&app, &message, &personal_sign(&new_key(), &message)).await;
    assert_eq!(reason(&body), "bad_signature");
    let e = latest().await;
    assert_eq!(e.message.as_deref(), Some(message.as_str()));
    assert!(e.signature.is_some());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_expired_session_is_unauthorized(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    let cookie = login_as(&app, &key).await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = get_as(&app, &cookie, "/api/status").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "no_session");
}

// ------------------------------------------------------------------- EIP-1271

const MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// A contract wallet whose `isValidSignature` accepts exactly `sig` for the
/// EIP-191 hash of `message`.
fn contract_wallet(
    fake: &eg_core::testing::FakeSource,
    wallet: Address,
    sig: Vec<u8>,
    message: &str,
) {
    let want = eip191_hash_message(message);
    fake.on_eth_call(move |to, data: &Bytes| {
        assert_eq!(to, wallet);
        assert_eq!(&data[..4], &MAGIC);
        let hash = B256::from_slice(&data[4..36]);
        let offset = usize::from_be_bytes(data[36 + 24..68].try_into().unwrap());
        assert_eq!(offset, 64);
        let len = usize::from_be_bytes(data[68 + 24..100].try_into().unwrap());
        let got = &data[100..100 + len];
        let mut out = [0u8; 32];
        if got == sig.as_slice() && hash == want {
            out[..4].copy_from_slice(&MAGIC);
        }
        Ok(Bytes::copy_from_slice(&out))
    });
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn contract_wallets_sign_in_through_eip_1271(pool: PgPool) {
    let (app, state, fake) = anon_app(pool, Config::default());
    let wallet = Address::repeat_byte(0x5a);
    state.store.whitelist_add(wallet, "test").await.unwrap();
    // A Safe-style signature: not a 65-byte ECDSA signature.
    let sig = vec![0xab; 130];
    let fields = nonce_for(&app, wallet).await;
    let message = message_for(&fields);
    contract_wallet(&fake, wallet, sig.clone(), &message);
    let sig_hex = format!("0x{}", hex(&sig));
    let (status, cookies, body) = post_login(&app, &message, &sig_hex).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(session_cookie(&cookies).is_some());
    assert_eq!(fake.calls(), 1);

    // The contract rejects another signature.
    let fields = nonce_for(&app, wallet).await;
    let message = message_for(&fields);
    contract_wallet(&fake, wallet, sig.clone(), &message);
    let (_, _, body) = post_login(&app, &message, &format!("0x{}", hex(&[0xcd; 130]))).await;
    assert_eq!(reason(&body), "bad_signature");

    // An upstream failure is a bad signature, not a server error.
    let fields = nonce_for(&app, wallet).await;
    let message = message_for(&fields);
    fake.fail_next(SourceError::Timeout);
    let (status, _, body) = post_login(&app, &message, &sig_hex).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "bad_signature");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn eip_1271_is_not_tried_for_addresses_that_may_not_log_in(pool: PgPool) {
    let (app, _, fake) = anon_app(pool, Config::default());
    let wallet = Address::repeat_byte(0x5b);
    let fields = nonce_for(&app, wallet).await;
    let message = message_for(&fields);
    contract_wallet(&fake, wallet, vec![0xab; 130], &message);
    let (status, _, body) = post_login(&app, &message, &format!("0x{}", hex(&[0xab; 130]))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "bad_signature");
    assert_eq!(fake.calls(), 0);
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// -------------------------------------------------------------------- the gate

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn api_routes_need_a_session(pool: PgPool) {
    let (app, _, _) = anon_app(pool, Config::default());
    let (status, body) = send(&app, get_req("/api/events", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "no_session");
    let req = Request::post("/api/graph/edges")
        .header("content-type", "application/json")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(
            json!({"addresses": ["0x0000000000000000000000000000000000000001"]}).to_string(),
        ))
        .unwrap();
    let (status, body) = send(&app, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "no_session");
    for uri in ["/api/status", "/api/jobs", "/api/labels", "/api/workspaces"] {
        assert_eq!(
            send(&app, get_req(uri, None)).await.0,
            StatusCode::UNAUTHORIZED,
            "{uri}"
        );
    }
    // A garbage cookie is no session either.
    let (status, _) = send(
        &app,
        get_req("/api/status", Some("eg_session=nope; other=1")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = send(&app, get_req("/api/health", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"ok": true}));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn state_changing_requests_need_the_configured_origin(pool: PgPool) {
    let (app, _, _) = test_app(pool).await;
    let label = json!({
        "address": "0x0000000000000000000000000000000000000001",
        "text": "x",
        "category": "other"
    });
    for origin in [
        Some("https://evil.example.org"),
        Some("http://127.0.0.1:8081"),
        Some("null"),
    ] {
        let mut req = Request::post("/api/labels").header("content-type", "application/json");
        if let Some(o) = origin {
            req = req.header(header::ORIGIN, o);
        }
        let (status, body) = send(&app, req.body(Body::from(label.to_string())).unwrap()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{origin:?}");
        assert_eq!(reason(&body), "bad_origin");
    }
    // GET needs no Origin; the default harness sends the configured one.
    let (status, _) = post_json(&app, "/api/labels", &label).await;
    assert_eq!(status, StatusCode::CREATED);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_post_without_origin_is_rejected(pool: PgPool) {
    let (app, state, _) = anon_app(pool, Config::default());
    let key = whitelisted_key(&state).await;
    let cookie = login_as(&app, &key).await;
    let req = Request::delete("/api/labels/1")
        .header(header::COOKIE, &cookie)
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(&app, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "bad_origin");
    // Login itself is state-changing.
    let fields = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&fields);
    let body = json!({"message": message, "signature": personal_sign(&key, &message)});
    let req = Request::post("/api/auth/login")
        .header("content-type", "application/json")
        .header(header::ORIGIN, "https://evil.example.org")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, body) = send(&app, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "bad_origin");
}

// ------------------------------------------------------------------ AdminMode

async fn whoami(AdminMode(u): AdminMode) -> axum::Json<Value> {
    axum::Json(json!({"address": format!("{:#x}", u.address)}))
}

async fn me(u: CurrentUser) -> axum::Json<Value> {
    axum::Json(json!({"id": u.id, "is_admin": u.is_admin}))
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn admin_mode_needs_both_sessions_of_a_configured_admin(pool: PgPool) {
    let admin = new_key();
    let other_admin = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![
        format!("{:#x}", key_address(&admin)),
        format!("{:#x}", key_address(&other_admin)),
    ];
    let (_, state, _) = anon_app(pool, cfg);
    let app: Router = Router::new()
        .route("/api/admin/whoami", get(whoami))
        .route("/api/me", get(me))
        .with_state(state.clone());
    let store = &state.store;
    let session = |id, kind| async move {
        store
            .session_create(id, kind, Duration::hours(1), None, None)
            .await
            .unwrap()
    };
    let a = store
        .upsert_user_on_login(key_address(&admin))
        .await
        .unwrap();
    let b = store
        .upsert_user_on_login(key_address(&other_admin))
        .await
        .unwrap();
    let plain = store
        .upsert_user_on_login(Address::repeat_byte(9))
        .await
        .unwrap();
    let a_user = session(a.id, SessionKind::User).await;
    let a_admin = admin_session_for(store, &a_user).await;
    let b_user = session(b.id, SessionKind::User).await;
    let b_admin = admin_session_for(store, &b_user).await;
    let plain_user = session(plain.id, SessionKind::User).await;
    let plain_admin = admin_session_for(store, &plain_user).await;
    // An admin-kind session not started from a login session.
    let unbound = session(a.id, SessionKind::Admin).await;

    let call = |cookie: String| {
        let app = app.clone();
        async move {
            let req = Request::get("/api/admin/whoami")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap();
            send(&app, req).await
        }
    };
    let (status, body) = call(format!("eg_session={a_user}; eg_admin={a_admin}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["address"], format!("{:#x}", key_address(&admin)));
    // Admin cookie alone, user session alone, the admin cookie of another
    // admin, a user session in the admin slot.
    for cookie in [
        format!("eg_admin={a_admin}"),
        format!("eg_session={a_user}"),
        format!("eg_session={a_user}; eg_admin={b_admin}"),
        format!("eg_session={a_user}; eg_admin={a_user}"),
        format!("eg_session={a_user}; eg_admin={unbound}"),
        format!("eg_session={b_user}; eg_admin={a_admin}"),
    ] {
        let (status, body) = call(cookie.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{cookie}");
        assert_eq!(body["error"]["code"], "unauthorized");
    }
    // Not a configured admin: answered like a missing route.
    let (status, body) = call(format!("eg_session={plain_user}; eg_admin={plain_admin}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");

    // CurrentUser outside the gate reads the cookie itself.
    let (status, body) = send(
        &app,
        get_req("/api/me", Some(&format!("eg_session={a_user}"))),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"id": a.id, "is_admin": true}));
    let (status, _) = send(&app, get_req("/api/me", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn client_ip_comes_from_x_forwarded_for_only_when_trusted(pool: PgPool) {
    // The trusted proxy appended the right-most hop; the client wrote the
    // leading one.
    for (trust, want) in [(false, "10.0.0.9"), (true, "203.0.113.7")] {
        let mut cfg = Config::default();
        cfg.auth.trust_forwarded_for = trust;
        let (app, state, _) = anon_app(pool.clone(), cfg);
        let key = whitelisted_key(&state).await;
        let fields = nonce_for(&app, key_address(&key)).await;
        let message = message_for(&fields);
        let body = json!({"message": message, "signature": personal_sign(&key, &message)});
        let req = Request::post("/api/auth/login")
            .header("content-type", "application/json")
            .header(header::ORIGIN, ORIGIN)
            .header(header::USER_AGENT, "test-agent")
            .header("x-forwarded-for", "6.6.6.6, 203.0.113.7")
            .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [10, 0, 0, 9],
                4000,
            ))))
            .body(Body::from(body.to_string()))
            .unwrap();
        let (status, _) = send(&app, req).await;
        assert_eq!(status, StatusCode::OK);
        let ip: String = sqlx::query_scalar(
            "SELECT ip FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.address = $1",
        )
        .bind(key_address(&key).as_slice())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ip, want, "trust={trust}");
        let rows = audit(&state.store, "login").await;
        assert_eq!(rows[0].entry.ip.as_deref(), Some(want));
        assert_eq!(rows[0].entry.user_agent.as_deref(), Some("test-agent"));
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_background_purge_drops_spent_nonces_and_expired_sessions(pool: PgPool) {
    let (app, state, _) = anon_app(pool.clone(), Config::default());
    let key = whitelisted_key(&state).await;
    let cookie = login_as(&app, &key).await;
    nonce_for(&app, key_address(&key)).await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    eg_server::background::purge_auth(&state).await;
    let nonces: Vec<Option<chrono::DateTime<chrono::Utc>>> =
        sqlx::query_scalar("SELECT used_at FROM auth_nonces")
            .fetch_all(&pool)
            .await
            .unwrap();
    // The used login nonce is gone; the unused one stays.
    assert_eq!(nonces, [None]);
    assert_eq!(count(&pool, "sessions").await, 0);
    assert_eq!(
        get_as(&app, &cookie, "/api/auth/me").await.0,
        StatusCode::UNAUTHORIZED
    );
}

// ------------------------------------------------------- server-wide caps

/// The app without a default session whose refusals before login are
/// audited at most `rows` times per `window` server-wide, and which keeps at
/// most `nonces` unused login nonces outstanding.
fn capped_app(
    pool: PgPool,
    rows: u32,
    window: std::time::Duration,
    nonces: u32,
) -> (Router, AppState) {
    let (_, mut state, _) = anon_app(pool, Config::default());
    state.auth = Arc::new(AuthState {
        pre_auth_audit: AuditCap::new(rows, window),
        max_login_nonces: nonces,
        ..AuthState::new(&state.cfg)
    });
    (router(state.clone()), state)
}

/// `req` as sent from client IP 198.51.100.`last`.
fn from_ip(mut req: Request<Body>, last: u8) -> Request<Body> {
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([198, 51, 100, last], 4000))));
    req
}

fn cross_site_login() -> Request<Body> {
    Request::post("/api/auth/login")
        .header("content-type", "application/json")
        .header(header::ORIGIN, "https://evil.example.org")
        .body(Body::from(
            json!({"message": "x", "signature": "0x"}).to_string(),
        ))
        .unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn refusals_before_login_are_audited_within_a_server_wide_cap(pool: PgPool) {
    let window = std::time::Duration::from_millis(300);
    let (app, state) = capped_app(pool, 3, window, 1000);
    let junk = format!("eg_admin={}", "ab".repeat(32));
    // Denied logins and junk admin cookies from many client IPs (each well
    // within its own per-IP allowance) share one allowance.
    for i in 0..4u8 {
        let (status, _) = send(&app, from_ip(cross_site_login(), i)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let req = from_ip(get_req("/api/admin/users", Some(&junk)), 100 + i);
        assert_eq!(send(&app, req).await.0, StatusCode::UNAUTHORIZED);
    }
    let logins = audit(&state.store, "login").await;
    let admin = audit(&state.store, "admin_access").await;
    assert_eq!((logins.len(), admin.len()), (2, 1));
    assert!(audit(&state.store, "audit_suppressed").await.is_empty());

    // The next window's first refusal first records what was left out.
    tokio::time::sleep(window + std::time::Duration::from_millis(50)).await;
    let (status, _, _) = post_login(&app, "garbage", "0x00").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(audit(&state.store, "login").await.len(), 3);
    let summary = audit(&state.store, "audit_suppressed").await;
    assert_eq!(summary.len(), 1);
    let e = &summary[0].entry;
    assert_eq!(
        (e.actor.as_str(), e.outcome),
        ("unknown", AuditOutcome::Denied)
    );
    let after = e.after.clone().unwrap();
    assert_eq!(after["suppressed"], 5, "{after}");
    assert_eq!(after["by_action"], json!({"login": 2, "admin_access": 3}));
    let buckets = after["top_buckets"].as_array().unwrap();
    assert_eq!(buckets.len(), 5, "{after}");
    assert!(buckets.iter().all(|b| b["count"] == 1), "{after}");
    assert!(
        buckets.iter().any(|b| b["bucket"] == "198.51.100.103"),
        "{after}"
    );
    assert!(
        after["from"].is_string() && after["to"].is_string(),
        "{after}"
    );

    // Without further traffic, the background flush writes a window's
    // summary once it ended; a window that left nothing out writes none.
    for _ in 0..3 {
        post_login(&app, "garbage", "0x00").await;
    }
    assert_eq!(audit(&state.store, "login").await.len(), 5);
    flush_suppressed_audit(&state).await.unwrap();
    assert_eq!(audit(&state.store, "audit_suppressed").await.len(), 1);
    tokio::time::sleep(window + std::time::Duration::from_millis(50)).await;
    flush_suppressed_audit(&state).await.unwrap();
    flush_suppressed_audit(&state).await.unwrap();
    let summary = audit(&state.store, "audit_suppressed").await;
    assert_eq!(summary.len(), 2);
    let after = summary[0].entry.after.clone().unwrap();
    assert_eq!(after["by_action"], json!({"login": 1}), "{after}");
    tokio::time::sleep(window + std::time::Duration::from_millis(50)).await;
    flush_suppressed_audit(&state).await.unwrap();
    assert_eq!(audit(&state.store, "audit_suppressed").await.len(), 2);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn outstanding_login_nonces_are_capped_server_wide(pool: PgPool) {
    let (app, state) = capped_app(pool.clone(), 300, std::time::Duration::from_secs(60), 3);
    let key = whitelisted_key(&state).await;
    let addr = key_address(&key);
    let uri = format!("/api/auth/nonce?address={addr:#x}");
    let mut issued = Vec::new();
    for i in 0..3u8 {
        let (status, body) = send(&app, from_ip(get_req(&uri, None), i)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        issued.push(serde_json::from_value::<SiweFieldsDto>(body).unwrap());
    }
    let full = || async { send(&app, from_ip(get_req(&uri, None), 50)).await };
    let (status, body) = full().await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");

    // Used and expired nonces no longer count.
    let message = message_for(&issued[0]);
    let (status, _, body) = post_login(&app, &message, &personal_sign(&key, &message)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(full().await.0, StatusCode::OK);
    assert_eq!(full().await.0, StatusCode::TOO_MANY_REQUESTS);
    sqlx::query("UPDATE auth_nonces SET expires_at = now() - interval '1 second' WHERE nonce = $1")
        .bind(&issued[1].nonce)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(full().await.0, StatusCode::OK);
}

#[test]
fn server_wide_caps_default_to_their_constants() {
    let auth = AuthState::new(&Config::default());
    assert_eq!(auth.max_login_nonces, eg_server::auth::MAX_LOGIN_NONCES);
    assert_eq!(
        auth.pre_auth_audit.limit(),
        eg_server::auth::PRE_AUTH_AUDIT_PER_MINUTE
    );
}
