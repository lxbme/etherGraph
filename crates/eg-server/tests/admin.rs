//! The admin API (spec §7–§8): admin mode, per-action wallet signatures and
//! the audit log (Review Focus 2 and 3, admin side). The configured admin is
//! a fresh key; user A is the default test user.

mod common;

use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::Address;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::TempDir;
use common::{
    DEFAULT_USER, ORIGIN, as_default_user, default_user_id, gated_app, get, get_as, key_address,
    login_as, message_for, new_key, nonce_for, personal_sign, post_json, post_json_as, post_login,
    second_user, send, send_full, whitelisted_key,
};
use eg_core::testing::FakeSource;
use eg_ingest::{Audience, Event, LocalDataOutcome};
use eg_server::app::router;
use eg_server::auth::AuthState;
use eg_server::config::Config;
use eg_server::dto::SiweFieldsDto;
use eg_server::local_data::SourceId;
use eg_server::local_data::runner::Runner;
use eg_server::local_data::sources::Urls;
use eg_server::local_data::upstream::UpstreamChecker;
use eg_server::state::{AppState, SIGNATURES_SETTING};
use eg_store::{AuditFilter, AuditOutcome, AuditRow, Store};
use http_body_util::BodyExt;
use k256::ecdsa::SigningKey;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tower::ServiceExt;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

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

/// The app of [`gated_app`] with one configured admin (returned) whose
/// event streams re-check their session every 100 ms.
async fn admin_app(pool: PgPool) -> (Router, AppState, Arc<FakeSource>, SigningKey) {
    let key = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![key_address(&key).to_checksum(None)];
    let (_, mut state, fake) = gated_app(pool, cfg).await;
    state.auth = Arc::new(AuthState {
        session_recheck: Duration::from_millis(100),
        ..AuthState::new(&state.cfg)
    });
    let app = as_default_user(router(state.clone()), &state).await;
    (app, state, fake, key)
}

/// `POST uri` with a JSON body and `cookie`, returning the `Set-Cookie`
/// headers too.
async fn post_full(
    app: &Router,
    cookie: &str,
    uri: &str,
    body: &Value,
) -> (StatusCode, Vec<String>, Value) {
    let req = Request::post(uri)
        .header("content-type", "application/json")
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(body.to_string()))
        .unwrap();
    send_full(app, req).await
}

/// The admin-mode message fields issued to the user of `session`.
async fn admin_nonce(app: &Router, session: &str) -> SiweFieldsDto {
    let (status, body) = get_as(app, session, "/api/admin/session/nonce").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

/// Enters admin mode from the login session `session` (`eg_session=…`) and
/// returns both cookies for a `Cookie` header.
async fn enter_admin(app: &Router, key: &SigningKey, session: &str) -> String {
    let fields = admin_nonce(app, session).await;
    let message = message_for(&fields);
    let body = json!({"message": message, "signature": personal_sign(key, &message)});
    let (status, cookies, body) = post_full(app, session, "/api/admin/session", &body).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let admin = admin_cookie(&cookies).expect("entering admin mode sets eg_admin");
    format!("{session}; {admin}")
}

fn admin_cookie(set_cookies: &[String]) -> Option<String> {
    set_cookies.iter().find_map(|c| {
        let pair = c.split(';').next()?.trim();
        let value = pair.strip_prefix("eg_admin=")?;
        (!value.is_empty()).then(|| pair.to_owned())
    })
}

/// Logs the admin in and enters admin mode.
async fn admin_cookies(app: &Router, key: &SigningKey) -> String {
    let session = login_as(app, key).await;
    enter_admin(app, key, &session).await
}

async fn action_nonce(app: &Router, cookie: &str, action: &Value) -> (StatusCode, Value) {
    post_json_as(
        app,
        cookie,
        "/api/admin/actions/nonce",
        &json!({ "action": action }),
    )
    .await
}

async fn submit(
    app: &Router,
    cookie: &str,
    action: &Value,
    nonce: &str,
    signature: &str,
) -> (StatusCode, Value) {
    let body = json!({"action": action, "nonce": nonce, "signature": signature});
    post_json_as(app, cookie, "/api/admin/actions", &body).await
}

/// The nonce and message issued for `action`.
async fn issued(app: &Router, cookie: &str, action: &Value) -> (String, String) {
    let (status, body) = action_nonce(app, cookie, action).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["nonce"].as_str().unwrap().to_owned(),
        body["message"].as_str().unwrap().to_owned(),
    )
}

/// Requests a nonce for `action`, signs its message with `key` and submits it.
async fn act(app: &Router, key: &SigningKey, cookie: &str, action: &Value) -> (StatusCode, Value) {
    let (nonce, message) = issued(app, cookie, action).await;
    submit(app, cookie, action, &nonce, &personal_sign(key, &message)).await
}

async fn act_ok(app: &Router, key: &SigningKey, cookie: &str, action: &Value) -> Value {
    let (status, body) = act(app, key, cookie, action).await;
    assert_eq!(status, StatusCode::OK, "{action}: {body}");
    body
}

// ------------------------------------------------------------------ admin mode

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn entering_and_leaving_admin_mode(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let session = login_as(&app, &key).await;
    let fields = admin_nonce(&app, &session).await;
    assert_eq!(fields.statement, "Enter etherGraph admin mode");
    assert_eq!(fields.address, hex(key_address(&key)));
    assert_eq!(fields.uri, ORIGIN);
    // Only the login session: not in admin mode yet.
    let (status, body) = get_as(&app, &session, "/api/admin/session").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(reason(&body), "no_admin_session");

    let message = message_for(&fields);
    let signature = personal_sign(&key, &message);
    let body = json!({"message": message, "signature": signature});
    let (status, cookies, me) = post_full(&app, &session, "/api/admin/session", &body).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["address"], hex(key_address(&key)));
    assert!(me["expires_at"].is_string());
    let set = cookies.iter().find(|c| c.starts_with("eg_admin=")).unwrap();
    assert!(set.contains("Path=/api/admin;"), "{set}");
    assert!(set.contains("Max-Age=3600"), "{set}");
    assert!(
        set.contains("HttpOnly") && set.contains("SameSite=Lax"),
        "{set}"
    );
    let both = format!("{session}; {}", admin_cookie(&cookies).unwrap());
    let (status, body) = get_as(&app, &both, "/api/admin/session").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["address"], hex(key_address(&key)));
    let rows = audit(&state.store, "admin_mode_enter").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Ok);
    assert_eq!(rows[0].entry.actor, hex(key_address(&key)));
    assert_eq!(rows[0].entry.message.as_deref(), Some(message.as_str()));
    assert_eq!(rows[0].entry.signature.as_deref(), Some(signature.as_str()));
    // `/api/auth/me` no longer claims to know the admin mode.
    let (_, me) = get_as(&app, &both, "/api/auth/me").await;
    assert!(me.get("admin_mode").is_none(), "{me}");

    let req = Request::delete("/api/admin/session")
        .header(header::COOKIE, &both)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    let (status, cookies, _) = send_full(&app, req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(
        cookies
            .iter()
            .any(|c| c.starts_with("eg_admin=;") && c.contains("Max-Age=0")),
        "{cookies:?}"
    );
    assert_eq!(
        get_as(&app, &both, "/api/admin/session").await.0,
        StatusCode::UNAUTHORIZED
    );
    // The login session is untouched.
    assert_eq!(
        get_as(&app, &session, "/api/auth/me").await.0,
        StatusCode::OK
    );
    assert_eq!(audit(&state.store, "admin_mode_exit").await.len(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn admin_mode_needs_a_valid_fresh_signature(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let session = login_as(&app, &key).await;
    let post = |body: Value| {
        let (app, session) = (app.clone(), session.clone());
        async move { post_full(&app, &session, "/api/admin/session", &body).await }
    };

    // A signature from another key.
    let message = message_for(&admin_nonce(&app, &session).await);
    let (status, _, body) = post(json!({
        "message": message, "signature": personal_sign(&new_key(), &message)
    }))
    .await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_signature")
    );
    // That nonce is spent: the right signature no longer helps.
    let (status, _, body) = post(json!({
        "message": message, "signature": personal_sign(&key, &message)
    }))
    .await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_nonce")
    );
    // A login nonce is not an admin-mode nonce.
    let login = nonce_for(&app, key_address(&key)).await;
    let message = message_for(&login);
    let (status, _, body) = post(json!({
        "message": message, "signature": personal_sign(&key, &message)
    }))
    .await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_nonce")
    );
    // An edited message.
    let fields = admin_nonce(&app, &session).await;
    let message = message_for(&fields).replace("Enter etherGraph admin mode", "Hello");
    let (status, _, body) = post(json!({
        "message": message, "signature": personal_sign(&key, &message)
    }))
    .await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_message")
    );

    let rows = audit(&state.store, "admin_mode_enter").await;
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|r| r.entry.outcome == AuditOutcome::Denied));
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE kind = 'admin'")
        .fetch_one(state.store.pool())
        .await
        .unwrap();
    assert_eq!(sessions, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn entering_admin_mode_after_the_login_ended_is_refused_and_audited(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let session = login_as(&app, &key).await;
    let message = message_for(&admin_nonce(&app, &session).await);
    // The login session ends while the request is under way: right after
    // the admin-mode nonce is taken.
    sqlx::query(
        "CREATE FUNCTION end_logins() RETURNS trigger LANGUAGE plpgsql AS \
         $$ BEGIN UPDATE sessions SET expires_at = now() - interval '1 second' \
         WHERE kind = 'user'; RETURN NEW; END; $$",
    )
    .execute(state.store.pool())
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER end_logins AFTER UPDATE ON auth_nonces \
         FOR EACH ROW EXECUTE FUNCTION end_logins()",
    )
    .execute(state.store.pool())
    .await
    .unwrap();
    let signature = personal_sign(&key, &message);
    let body = json!({"message": message, "signature": signature});
    let (status, cookies, body) = post_full(&app, &session, "/api/admin/session", &body).await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "no_session")
    );
    assert!(admin_cookie(&cookies).is_none(), "{cookies:?}");
    let rows = audit(&state.store, "admin_mode_enter").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
    assert_eq!(rows[0].entry.after, Some(json!({"reason": "no_session"})));
    assert_eq!(rows[0].entry.message.as_deref(), Some(message.as_str()));
    assert_eq!(rows[0].entry.signature.as_deref(), Some(signature.as_str()));
    let admins: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE kind = 'admin'")
        .fetch_one(state.store.pool())
        .await
        .unwrap();
    assert_eq!(admins, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_new_login_does_not_resume_an_old_admin_cookie(pool: PgPool) {
    let (app, _, _, key) = admin_app(pool).await;
    let first = login_as(&app, &key).await;
    let both = enter_admin(&app, &key, &first).await;
    let old_admin = both.split("; ").nth(1).unwrap().to_owned();
    // A second login while the first session and its admin cookie still live.
    let second = login_as(&app, &key).await;
    let mixed = format!("{second}; {old_admin}");
    for uri in ["/api/admin/session", "/api/admin/overview"] {
        let (status, body) = get_as(&app, &mixed, uri).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        assert_eq!(reason(&body), "no_admin_session");
    }
    // The original pair still works.
    assert_eq!(
        get_as(&app, &both, "/api/admin/overview").await.0,
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_admin_cookie_without_a_login_session_is_rejected(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let admin_only = both.split("; ").nth(1).unwrap().to_owned();
    let action = json!({"type": "SetOpenRegistration", "open": true});
    let (nonce, message) = issued(&app, &both, &action).await;
    for uri in [
        "/api/admin/session",
        "/api/admin/overview",
        "/api/admin/users",
    ] {
        let (status, body) = get_as(&app, &admin_only, uri).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        assert_eq!(reason(&body), "no_session");
    }
    let (status, body) = submit(
        &app,
        &admin_only,
        &action,
        &nonce,
        &personal_sign(&key, &message),
    )
    .await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "no_session")
    );
    assert!(!eg_server::auth::open_registration(&state).await.unwrap());
    // Each attempt is on record under the admin session's owner.
    let rows = audit(&state.store, "admin_access").await;
    assert_eq!(rows.len(), 4);
    for r in &rows {
        assert_eq!(r.entry.outcome, AuditOutcome::Denied);
        assert_eq!(r.entry.actor, hex(key_address(&key)));
        assert_eq!(r.entry.after, Some(json!({"reason": "no_session"})));
    }
    assert_eq!(
        rows[0].entry.target.as_deref(),
        Some("POST /api/admin/actions")
    );
    // An admin cookie that names no admin session: actor unknown.
    let junk = format!("eg_admin={}", "ab".repeat(32));
    assert_eq!(
        get_as(&app, &junk, "/api/admin/overview").await.0,
        StatusCode::UNAUTHORIZED
    );
    let rows = audit(&state.store, "admin_access").await;
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[0].entry.actor, "unknown");
    assert_eq!(
        rows[0].entry.target.as_deref(),
        Some("GET /api/admin/overview")
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn denied_admin_access_rows_are_rate_limited(pool: PgPool) {
    let (app, state, _, _) = admin_app(pool).await;
    let limit = eg_server::auth::ADMIN_DENIALS_PER_MINUTE as usize;
    let (b, _) = second_user(&app, &state).await;
    for _ in 0..limit + 5 {
        let (status, _) = get_as(&app, &b, "/api/admin/overview").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let junk = format!("eg_admin={}", "ab".repeat(32));
    for _ in 0..limit + 5 {
        let (status, _) = get_as(&app, &junk, "/api/admin/users").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // Another user has its own allowance.
    assert_eq!(
        get(&app, "/api/admin/overview").await.0,
        StatusCode::NOT_FOUND
    );
    let rows = audit(&state.store, "admin_access").await;
    let by = |actor: &str| rows.iter().filter(|r| r.entry.actor == actor).count();
    let b_addr = rows
        .iter()
        .map(|r| r.entry.actor.clone())
        .find(|a| a != "unknown" && *a != hex(DEFAULT_USER))
        .unwrap();
    assert_eq!(by(&b_addr), limit);
    assert_eq!(by("unknown"), limit);
    assert_eq!(by(&hex(DEFAULT_USER)), 1);
}

// ------------------------------------------------------------ non-admin access

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn non_admins_find_no_admin_api_and_are_audited(pool: PgPool) {
    let (app, state, _, _) = admin_app(pool).await;
    let action = json!({"type": "SetOpenRegistration", "open": true});
    let calls: Vec<(&str, &str, Option<Value>)> = vec![
        ("GET", "/api/admin/session/nonce", None),
        (
            "POST",
            "/api/admin/session",
            Some(json!({"message": "m", "signature": "0x"})),
        ),
        ("GET", "/api/admin/session", None),
        ("DELETE", "/api/admin/session", None),
        (
            "POST",
            "/api/admin/actions/nonce",
            Some(json!({ "action": action })),
        ),
        (
            "POST",
            "/api/admin/actions",
            Some(json!({"action": action, "nonce": "00", "signature": "0x"})),
        ),
        ("GET", "/api/admin/overview", None),
        ("GET", "/api/admin/users", None),
        ("GET", "/api/admin/whitelist", None),
        ("GET", "/api/admin/audit", None),
        ("GET", "/api/admin/no-such-thing", None),
    ];
    let request = |method: &str, uri: &str, body: &Option<Value>, cookie: Option<&str>| {
        let mut r = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::ORIGIN, ORIGIN)
            .header("content-type", "application/json");
        // An empty Cookie header keeps the default user's session off.
        r = r.header(header::COOKIE, cookie.unwrap_or(""));
        r.body(
            body.as_ref()
                .map_or_else(Body::empty, |b| Body::from(b.to_string())),
        )
        .unwrap()
    };
    // Not logged in: 401 like the rest of the API, nothing audited.
    for (method, uri, body) in &calls {
        let (status, _) = send(&app, request(method, uri, body, None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
    assert!(audit(&state.store, "admin_access").await.is_empty());

    // A logged-in user who is not an admin: answered like a missing route.
    let (cookie, _) = second_user(&app, &state).await;
    for (method, uri, body) in &calls {
        let (status, body) = send(&app, request(method, uri, body, Some(&cookie))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}: {body}");
        assert_eq!(body["error"]["code"], "not_found");
    }
    // The default user too (through the test app's own cookie).
    assert_eq!(
        get(&app, "/api/admin/overview").await.0,
        StatusCode::NOT_FOUND
    );
    let rows = audit(&state.store, "admin_access").await;
    assert_eq!(rows.len(), calls.len() + 1);
    assert!(rows.iter().all(|r| r.entry.outcome == AuditOutcome::Denied));
    let mut targets: Vec<String> = rows
        .iter()
        .skip(1)
        .map(|r| r.entry.target.clone().unwrap())
        .collect();
    targets.reverse();
    let want: Vec<String> = calls.iter().map(|(m, u, _)| format!("{m} {u}")).collect();
    assert_eq!(targets, want);
    assert_eq!(rows[0].entry.actor, hex(DEFAULT_USER));
    assert_eq!(rows[0].entry.after, Some(json!({"reason": "not_admin"})));
    assert!(!eg_server::auth::open_registration(&state).await.unwrap());
}

// ------------------------------------------------------------- signed actions

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_action_without_admin_mode_is_refused_and_audited(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let session = both.split("; ").next().unwrap().to_owned();
    let action = json!({"type": "SetOpenRegistration", "open": true});
    let (nonce, message) = issued(&app, &both, &action).await;
    // A valid signature, but the request carries only the login session.
    let (status, body) = submit(
        &app,
        &session,
        &action,
        &nonce,
        &personal_sign(&key, &message),
    )
    .await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "no_admin_session")
    );
    let (status, body) = action_nonce(&app, &session, &action).await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "no_admin_session")
    );
    assert!(!eg_server::auth::open_registration(&state).await.unwrap());
    let rows = audit(&state.store, "admin_access").await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.entry.outcome == AuditOutcome::Denied
        && r.entry.after == Some(json!({"reason": "no_admin_session"}))));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_action_message_names_the_change_and_is_audited(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let a = default_user_id(&state).await;
    let action = json!({"type": "SetUserQuota", "address": hex(DEFAULT_USER), "calls": 1000});
    let (nonce, message) = issued(&app, &both, &action).await;
    let mut lines = message.lines();
    // The wallet shows which app and origin the signature is for.
    assert_eq!(
        lines.next().unwrap(),
        "etherGraph admin action on 127.0.0.1:8080"
    );
    assert_eq!(
        lines.next().unwrap(),
        format!(
            "Set the daily quota of {} from the default (5000) to 1000",
            DEFAULT_USER.to_checksum(None)
        )
    );
    assert_eq!(lines.next().unwrap(), "");
    assert_eq!(lines.next().unwrap(), format!("Nonce: {nonce}"));
    assert!(lines.next().unwrap().starts_with("Issued At: 20"));
    assert!(lines.next().is_none());

    let signature = personal_sign(&key, &message);
    let (status, body) = submit(&app, &both, &action, &nonce, &signature).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(state.gate.user_quota(a).limit, 1000);
    let rows = audit(&state.store, "set_user_quota").await;
    assert_eq!(rows.len(), 1);
    let e = &rows[0].entry;
    assert_eq!(e.outcome, AuditOutcome::Ok);
    assert_eq!(e.actor, hex(key_address(&key)));
    assert_eq!(e.target.as_deref(), Some(hex(DEFAULT_USER).as_str()));
    assert_eq!(e.before, Some(json!({"calls": null, "effective": 5000})));
    assert_eq!(e.after, Some(json!({"calls": 1000, "effective": 1000})));
    assert_eq!(e.message.as_deref(), Some(message.as_str()));
    assert_eq!(e.signature.as_deref(), Some(signature.as_str()));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_payload_altered_after_signing_is_refused(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let a = default_user_id(&state).await;
    let signed = json!({"type": "SetUserQuota", "address": hex(DEFAULT_USER), "calls": 5000});
    let (nonce, message) = issued(&app, &both, &signed).await;
    let signature = personal_sign(&key, &message);
    // The first attempt spends the nonce.
    for (altered, why) in [
        (
            json!({"type": "SetUserQuota", "address": hex(DEFAULT_USER), "calls": 0}),
            "payload_mismatch",
        ),
        (
            json!({"type": "RevokeSessions", "address": hex(DEFAULT_USER)}),
            "bad_nonce",
        ),
    ] {
        let (status, body) = submit(&app, &both, &altered, &nonce, &signature).await;
        assert_eq!(
            (status, reason(&body)),
            (StatusCode::UNAUTHORIZED, why),
            "{altered}"
        );
    }
    assert_eq!(state.gate.user_quota(a).limit, 5000);
    assert_eq!(
        state
            .store
            .user_by_id(a)
            .await
            .unwrap()
            .unwrap()
            .daily_quota,
        None
    );
    assert_eq!(get(&app, "/api/auth/me").await.0, StatusCode::OK);
    let rows = audit(&state.store, "set_user_quota").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
    assert_eq!(
        rows[0].entry.after,
        Some(json!({"reason": "payload_mismatch"}))
    );
    assert_eq!(audit(&state.store, "revoke_sessions").await.len(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_action_nonce_is_single_use(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let target = Address::repeat_byte(0x42);
    let add = json!({"type": "WhitelistAdd", "address": hex(target)});
    let (nonce, message) = issued(&app, &both, &add).await;
    let signature = personal_sign(&key, &message);
    assert_eq!(
        submit(&app, &both, &add, &nonce, &signature).await.0,
        StatusCode::OK
    );
    assert!(state.store.whitelist_contains(target).await.unwrap());
    // Removed in between; replaying the signed add must not bring it back.
    act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "WhitelistRemove", "address": hex(target)}),
    )
    .await;
    let (status, body) = submit(&app, &both, &add, &nonce, &signature).await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_nonce")
    );
    assert!(!state.store.whitelist_contains(target).await.unwrap());
    let rows = audit(&state.store, "whitelist_add").await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
    assert_eq!(rows[0].entry.after, Some(json!({"reason": "bad_nonce"})));
    // A refused nonce leaves no message or signature in the log.
    assert_eq!(rows[0].entry.message, None);
    assert_eq!(rows[0].entry.signature, None);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_expired_action_nonce_is_refused_and_audited(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let open = json!({"type": "SetOpenRegistration", "open": true});
    let (nonce, message) = issued(&app, &both, &open).await;
    sqlx::query("UPDATE auth_nonces SET expires_at = now() - interval '1 second' WHERE nonce = $1")
        .bind(&nonce)
        .execute(state.store.pool())
        .await
        .unwrap();
    let (status, body) = submit(&app, &both, &open, &nonce, &personal_sign(&key, &message)).await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_nonce")
    );
    assert!(!eg_server::auth::open_registration(&state).await.unwrap());
    let rows = audit(&state.store, "set_open_registration").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
    assert_eq!(rows[0].entry.after, Some(json!({"reason": "bad_nonce"})));
}

/// From now on every `ok` audit row fails to insert (`denied` and `failed`
/// rows still go through).
async fn reject_ok_audit_rows(pool: &PgPool) {
    sqlx::query(
        "CREATE FUNCTION reject_ok_audit() RETURNS trigger LANGUAGE plpgsql AS \
         $$ BEGIN RAISE EXCEPTION 'audit down'; END; $$",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_ok_audit BEFORE INSERT ON audit_log FOR EACH ROW \
         WHEN (NEW.outcome = 'ok') EXECUTE FUNCTION reject_ok_audit()",
    )
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn no_action_takes_effect_without_its_audit_row(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool.clone()).await;
    let both = admin_cookies(&app, &key).await;
    let a = default_user_id(&state).await;
    let (b_cookie, b) = second_user(&app, &state).await;
    let b_addr = state.store.user_by_id(b).await.unwrap().unwrap().address;
    reject_ok_audit_rows(&pool).await;

    let remove = json!({"type": "WhitelistRemove", "address": hex(b_addr)});
    let (status, body) = act(&app, &key, &both, &remove).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    // Still listed, still logged in.
    assert!(state.store.whitelist_contains(b_addr).await.unwrap());
    assert_eq!(
        get_as(&app, &b_cookie, "/api/status").await.0,
        StatusCode::OK
    );

    let quota = json!({"type": "SetUserQuota", "address": hex(DEFAULT_USER), "calls": 1});
    let (status, body) = act(&app, &key, &both, &quota).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(
        state
            .store
            .user_by_id(a)
            .await
            .unwrap()
            .unwrap()
            .daily_quota,
        None
    );
    assert_eq!(state.gate.user_quota(a).limit, 5000);

    let default = json!({"type": "SetDefaultQuota", "calls": 1});
    let (status, _) = act(&app, &key, &both, &default).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (_, overview) = get_as(&app, &both, "/api/admin/overview").await;
    assert_eq!(overview["default_quota"], 5000);

    // The attempts are on record as failed, nothing as done.
    for action in ["whitelist_remove", "set_user_quota", "set_default_quota"] {
        let rows = audit(&state.store, action).await;
        assert_eq!(rows.len(), 1, "{action}");
        assert_eq!(rows[0].entry.outcome, AuditOutcome::Failed, "{action}");
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn no_cli_import_takes_effect_without_its_audit_row(pool: PgPool) {
    let store = Store::from_pool(pool.clone());
    reject_ok_audit_rows(&pool).await;
    let data = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
    let res =
        eg_server::cli::import_labels(&store, Some("sample"), &data.join("labels_sample.csv"))
            .await;
    assert!(res.is_err(), "{res:?}");
    let labels: i64 =
        sqlx::query_scalar("SELECT count(*) FROM labels WHERE source = 'import:sample'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(labels, 0);
    let rows = audit(&store, "import_labels").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Failed);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_action_needs_the_admins_own_signature(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let open = json!({"type": "SetOpenRegistration", "open": true});
    // Unsigned, junk, and signed by another key.
    for bad in ["", "0x", "0x1234", "other key"] {
        let (nonce, message) = issued(&app, &both, &open).await;
        let signature = match bad {
            "other key" => personal_sign(&new_key(), &message),
            junk => junk.to_owned(),
        };
        let (status, body) = submit(&app, &both, &open, &nonce, &signature).await;
        assert_eq!(
            (status, reason(&body)),
            (StatusCode::UNAUTHORIZED, "bad_signature")
        );
    }
    // The signature over another nonce's message.
    let (_, other_message) = issued(&app, &both, &open).await;
    let (nonce, _) = issued(&app, &both, &open).await;
    let (status, body) = submit(
        &app,
        &both,
        &open,
        &nonce,
        &personal_sign(&key, &other_message),
    )
    .await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_signature")
    );
    // An unknown nonce.
    let (status, body) = submit(&app, &both, &open, &"0".repeat(32), "0x").await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_nonce")
    );
    assert!(!eg_server::auth::open_registration(&state).await.unwrap());
    let rows = audit(&state.store, "set_open_registration").await;
    assert_eq!(rows.len(), 6);
    assert!(rows.iter().all(|r| r.entry.outcome == AuditOutcome::Denied));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_nonce_issued_to_another_admin_is_refused(pool: PgPool) {
    let key = new_key();
    let other = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![hex(key_address(&key)), hex(key_address(&other))];
    let (app, state, _) = gated_app(pool, cfg).await;
    let mine = admin_cookies(&app, &key).await;
    let theirs = admin_cookies(&app, &other).await;
    let open = json!({"type": "SetOpenRegistration", "open": true});
    let (nonce, message) = issued(&app, &theirs, &open).await;
    // Signed correctly by the other admin, submitted from my admin session.
    let (status, body) = submit(&app, &mine, &open, &nonce, &personal_sign(&other, &message)).await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "bad_nonce")
    );
    assert!(!eg_server::auth::open_registration(&state).await.unwrap());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_action_signed_against_a_changed_value_is_refused(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let to_100 = json!({"type": "SetDefaultQuota", "calls": 100});
    let (nonce, message) = issued(&app, &both, &to_100).await;
    assert!(message.starts_with(
        "etherGraph admin action on 127.0.0.1:8080\nSet the default daily quota from 5000 to 100\n"
    ));
    act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "SetDefaultQuota", "calls": 200}),
    )
    .await;
    // The signed text says "from 5000", but the value is 200 now.
    let (status, body) = submit(&app, &both, &to_100, &nonce, &personal_sign(&key, &message)).await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "stale_action")
    );
    let (_, overview) = get_as(&app, &both, "/api/admin/overview").await;
    assert_eq!(overview["default_quota"], 200);
    let rows = audit(&state.store, "set_default_quota").await;
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn invalid_actions_get_no_nonce(pool: PgPool) {
    let (app, _, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    for (action, status) in [
        (
            json!({"type": "WhitelistAdd", "address": "nope"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"type": "SetDefaultQuota", "calls": -1}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"type": "SetUserQuota", "address": hex(DEFAULT_USER), "calls": -5}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"type": "ExportAudit", "from": "yesterday"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"type": "MakeAdmin", "address": hex(DEFAULT_USER)}),
            StatusCode::BAD_REQUEST,
        ),
        // Never logged in: no such user.
        (
            json!({"type": "SetUserQuota", "address": hex(Address::repeat_byte(7)), "calls": 1}),
            StatusCode::NOT_FOUND,
        ),
        (
            json!({"type": "RevokeSessions", "address": hex(Address::repeat_byte(7))}),
            StatusCode::NOT_FOUND,
        ),
    ] {
        let (got, body) = action_nonce(&app, &both, &action).await;
        assert_eq!(got, status, "{action}: {body}");
    }
}

// ------------------------------------------------------------ action effects

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn whitelist_removal_ends_the_users_sessions_and_stream(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let b_key = whitelisted_key(&state).await;
    let b_cookie = login_as(&app, &b_key).await;
    let b = hex(key_address(&b_key));
    let mut stream = open_stream(&app, &b_cookie).await;
    assert!(!ends_within(&mut stream, Duration::from_millis(400)).await);

    let (_, list) = get_as(&app, &both, "/api/admin/whitelist").await;
    assert!(list.as_array().unwrap().iter().any(|e| e["address"] == b));
    let body = act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "WhitelistRemove", "address": b}),
    )
    .await;
    assert_eq!(
        body["after"],
        json!({"listed": false, "sessions_revoked": 1})
    );
    // B's next request is refused and the open stream ends.
    let (status, body) = get_as(&app, &b_cookie, "/api/status").await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "no_session")
    );
    assert!(
        ends_within(&mut stream, Duration::from_secs(3)).await,
        "B's stream still open"
    );
    // B cannot log back in, and the default user is unaffected.
    let fields = nonce_for(&app, key_address(&b_key)).await;
    let message = message_for(&fields);
    let (status, _, body) = post_login(&app, &message, &personal_sign(&b_key, &message)).await;
    assert_eq!(
        (status, reason(&body)),
        (StatusCode::UNAUTHORIZED, "not_whitelisted")
    );
    assert_eq!(get(&app, "/api/status").await.0, StatusCode::OK);
    let (_, list) = get_as(&app, &both, "/api/admin/whitelist").await;
    assert!(!list.as_array().unwrap().iter().any(|e| e["address"] == b));
    let rows = audit(&state.store, "whitelist_remove").await;
    assert_eq!(rows[0].entry.before, Some(json!({"listed": true})));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn whitelist_add_and_open_registration(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let c_key = new_key();
    let c = hex(key_address(&c_key));
    let body = act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "WhitelistAdd", "address": c}),
    )
    .await;
    assert_eq!(body["before"], json!({"listed": false}));
    let (_, list) = get_as(&app, &both, "/api/admin/whitelist").await;
    let entry = list
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["address"] == c)
        .unwrap();
    assert_eq!(entry["added_by"], hex(key_address(&key)));
    assert!(entry["added_at"].is_string());
    login_as(&app, &c_key).await;

    act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "SetOpenRegistration", "open": true}),
    )
    .await;
    assert!(eg_server::auth::open_registration(&state).await.unwrap());
    let (_, overview) = get_as(&app, &both, "/api/admin/overview").await;
    assert_eq!(overview["open_registration"], true);
    let rows = audit(&state.store, "set_open_registration").await;
    assert_eq!(rows[0].entry.before, Some(json!({"open": false})));
    assert_eq!(rows[0].entry.after, Some(json!({"open": true})));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_lowered_user_quota_refuses_the_next_call(pool: PgPool) {
    let (app, state, fake, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let a = default_user_id(&state).await;
    fake.on_eth_call(|_, _| Ok(alloy_primitives::Bytes::new()));
    let (status, body) = get(&app, "/api/search?q=vitalik.eth").await;
    assert_ne!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(state.gate.user_quota(a).used, 1);

    let quota = |calls: Value| json!({"type": "SetUserQuota", "address": hex(DEFAULT_USER), "calls": calls});
    act_ok(&app, &key, &both, &quota(json!(1))).await;
    assert_eq!(
        state
            .store
            .user_by_id(a)
            .await
            .unwrap()
            .unwrap()
            .daily_quota,
        Some(1)
    );
    let calls = fake.calls();
    let (status, body) = get(&app, "/api/search?q=vitalik.eth").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "user_quota_exhausted");
    assert_eq!(fake.calls(), calls);
    let (_, users) = get_as(&app, &both, "/api/admin/users").await;
    let row = users
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["address"] == hex(DEFAULT_USER))
        .unwrap()
        .clone();
    assert_eq!(row["used_today"], 1);
    assert_eq!(row["quota_limit"], 1);
    assert_eq!(row["quota_override"], 1);

    // Back to the default.
    act_ok(&app, &key, &both, &quota(Value::Null)).await;
    assert_eq!(state.gate.user_quota(a).limit, 5000);
    let (status, body) = get(&app, "/api/search?q=vitalik.eth").await;
    assert_ne!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_default_quota_reaches_users_without_an_override(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let a = default_user_id(&state).await;
    let (_, b) = second_user(&app, &state).await;
    let b_addr = state.store.user_by_id(b).await.unwrap().unwrap().address;
    act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "SetUserQuota", "address": hex(b_addr), "calls": 50}),
    )
    .await;
    let body = act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "SetDefaultQuota", "calls": 7}),
    )
    .await;
    assert_eq!(body["before"], json!({"calls": 5000}));
    assert_eq!(body["after"], json!({"calls": 7}));
    assert_eq!(state.gate.user_quota(a).limit, 7);
    assert_eq!(state.gate.user_quota(b).limit, 50);
    let (_, overview) = get_as(&app, &both, "/api/admin/overview").await;
    assert_eq!(overview["default_quota"], 7);
    assert_eq!(overview["server_limit"], state.cfg.etherscan.daily_limit);
    assert!(overview["server_used"].is_number());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn revoking_sessions_logs_the_user_out(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let (b_cookie, b) = second_user(&app, &state).await;
    let b_addr = state.store.user_by_id(b).await.unwrap().unwrap().address;
    let body = act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "RevokeSessions", "address": hex(b_addr)}),
    )
    .await;
    assert_eq!(body["after"], json!({"sessions_revoked": 1}));
    assert_eq!(
        get_as(&app, &b_cookie, "/api/status").await.0,
        StatusCode::UNAUTHORIZED
    );
    // Still whitelisted: B may log in again.
    assert!(state.store.whitelist_contains(b_addr).await.unwrap());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_audit_log_pages_filters_and_exports(pool: PgPool) {
    let (app, _, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let admin = hex(key_address(&key));
    let (_, page) = get_as(&app, &both, "/api/admin/audit").await;
    let rows = page["rows"].as_array().unwrap();
    // Newest first: admin-mode entry, then the admin's login (and the
    // default user's none: its session came from the store).
    assert_eq!(rows[0]["action"], "admin_mode_enter");
    assert_eq!(rows[1]["action"], "login");
    assert_eq!(rows[0]["outcome"], "ok");
    assert_eq!(page["next_cursor"], Value::Null);

    for i in 0..3u8 {
        let addr = hex(Address::repeat_byte(0x60 + i));
        act_ok(
            &app,
            &key,
            &both,
            &json!({"type": "WhitelistAdd", "address": addr}),
        )
        .await;
    }
    let (_, page) = get_as(
        &app,
        &both,
        &format!(
            "/api/admin/audit?action=whitelist_add&actor={}",
            admin.to_uppercase().replace("0X", "0x")
        ),
    )
    .await;
    assert_eq!(page["rows"].as_array().unwrap().len(), 3, "{page}");
    let (_, none) = get_as(&app, &both, "/api/admin/audit?actor=cli").await;
    assert!(none["rows"].as_array().unwrap().is_empty());
    let (status, _) = get_as(&app, &both, "/api/admin/audit?from=yesterday").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, future) = get_as(&app, &both, "/api/admin/audit?from=2999-01-01T00:00:00Z").await;
    assert!(future["rows"].as_array().unwrap().is_empty());

    let body = act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "ExportAudit", "from": null, "to": null}),
    )
    .await;
    let exported = body["rows"].as_array().unwrap();
    assert_eq!(exported.len(), 5, "{body}");
    assert_eq!(exported[0]["action"], "whitelist_add");
    assert!(
        exported
            .iter()
            .all(|r| r["id"].is_number() && r["at"].is_string())
    );
    assert_eq!(body["after"]["rows"], 5);
    // The export is audited after it ran.
    let (_, page) = get_as(&app, &both, "/api/admin/audit?action=export_audit").await;
    assert_eq!(page["rows"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn audit_pages_continue_with_the_cursor(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    for i in 0..105 {
        state
            .store
            .audit_append(&eg_store::AuditEntry {
                actor: "cli".into(),
                action: "import_labels".into(),
                target: Some(format!("set-{i}")),
                before: None,
                after: None,
                outcome: AuditOutcome::Ok,
                ip: None,
                user_agent: None,
                message: None,
                signature: None,
            })
            .await
            .unwrap();
    }
    let (_, first) = get_as(&app, &both, "/api/admin/audit?actor=cli").await;
    assert_eq!(first["rows"].as_array().unwrap().len(), 100);
    let cursor = first["next_cursor"].as_i64().unwrap();
    let (_, second) = get_as(
        &app,
        &both,
        &format!("/api/admin/audit?actor=cli&cursor={cursor}"),
    )
    .await;
    assert_eq!(second["rows"].as_array().unwrap().len(), 5);
    assert_eq!(second["next_cursor"], Value::Null);
    assert_eq!(second["rows"][4]["target"], "set-0");
}

// --------------------------------------------------------- what admins see

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn no_admin_endpoint_reveals_labels_workspaces_or_job_targets(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let target = Address::repeat_byte(0x77);
    // User A's private data: a label, a workspace and a job on `target`.
    let label = json!({"address": hex(target), "text": "SECRET-LABEL-TEXT", "category": "other"});
    let (status, body) = post_json(&app, "/api/labels", &label).await;
    assert!(status.is_success(), "{body}");
    let ws = json!({"name": "SECRET-WORKSPACE", "state": {"nodes": [hex(target)]}});
    let (status, body) = post_json(&app, "/api/workspaces", &ws).await;
    assert!(status.is_success(), "{body}");
    let (status, body) = post_json(&app, "/api/sync", &json!({"addresses": [hex(target)]})).await;
    assert!(status.is_success(), "{body}");
    let a = default_user_id(&state).await;
    sqlx::query("UPDATE jobs SET status = 'paused_user_quota' WHERE user_id = $1")
        .bind(a)
        .execute(state.store.pool())
        .await
        .unwrap();

    let both = admin_cookies(&app, &key).await;
    let mut seen = String::new();
    for uri in [
        "/api/admin/session",
        "/api/admin/overview",
        "/api/admin/users",
        "/api/admin/whitelist",
        "/api/admin/audit",
    ] {
        let (status, body) = get_as(&app, &both, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
        seen.push_str(&body.to_string());
    }
    let body = act_ok(
        &app,
        &key,
        &both,
        &json!({"type": "ExportAudit", "from": null, "to": null}),
    )
    .await;
    seen.push_str(&body.to_string());
    let seen = seen.to_lowercase();
    for secret in ["secret-label-text", "secret-workspace", &hex(target)[2..]] {
        assert!(!seen.contains(secret), "{secret} leaked: {seen}");
    }
    // Usage figures only: A's waiting jobs are counted, not shown.
    let (_, users) = get_as(&app, &both, "/api/admin/users").await;
    let row = users
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["address"] == hex(DEFAULT_USER))
        .unwrap()
        .clone();
    assert!(row["waiting_jobs"].as_u64().unwrap() >= 1, "{row}");
    let mut keys: Vec<&String> = row.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "address",
            "created_at",
            "is_admin",
            "last_login_at",
            "quota_limit",
            "quota_override",
            "used_today",
            "waiting_jobs"
        ]
    );
}

// ------------------------------------------------------------- CLI imports

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cli_imports_are_audited(pool: PgPool) {
    let store = Store::from_pool(pool);
    let data = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data");
    let summary =
        eg_server::cli::import_labels(&store, Some("sample"), &data.join("labels_sample.csv"))
            .await
            .unwrap();
    assert!(summary.starts_with("imported "), "{summary}");
    // A file that is not a label CSV fails, and the failure is audited too.
    assert!(
        eg_server::cli::import_labels(&store, Some("sample"), &data.join("tx_legacy.json"))
            .await
            .is_err()
    );
    let rows = audit(&store, "import_labels").await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.entry.actor == "cli"));
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Failed);
    assert_eq!(rows[1].entry.outcome, AuditOutcome::Ok);
    assert_eq!(rows[1].entry.target.as_deref(), Some("sample"));
    assert!(rows[1].entry.after.as_ref().unwrap()["imported"].is_number());

    let missing = data.join("no-such-file.json");
    assert!(
        eg_server::cli::import_tokens(
            &store,
            eg_server::import_tokens::TokenFormat::Uniswap,
            &missing
        )
        .await
        .is_err()
    );
    let rows = audit(&store, "import_tokens").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.actor, "cli");
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Failed);
    assert_eq!(rows[0].entry.target.as_deref(), Some("uniswap"));
}

// ------------------------------------------------------------- local data

/// An app like [`admin_app`] whose local datasets come from `server` and are
/// downloaded under `dir`.
async fn local_data_app(
    pool: PgPool,
    server: &MockServer,
    dir: &TempDir,
) -> (Router, AppState, SigningKey) {
    let key = new_key();
    let mut cfg = Config::default();
    cfg.auth.admins = vec![key_address(&key).to_checksum(None)];
    let (_, mut state, _) = gated_app(pool, cfg).await;
    state.upstream = Arc::new(UpstreamChecker::with_urls(Urls::with_base(&server.uri())));
    state.runner = Arc::new(Runner::new(dir.0.clone()));
    let app = as_default_user(router(state.clone()), &state).await;
    (app, state, key)
}

/// Serves a one-token Uniswap list, after `delay`.
async fn serve_uniswap(server: &MockServer, delay: Duration) {
    let list = format!(
        r#"{{"name":"x","version":{{"major":1,"minor":0,"patch":0}},"tokens":[{{"chainId":1,"address":"{}","symbol":"T","name":"Token"}}]}}"#,
        hex(Address::repeat_byte(0x31))
    );
    Mock::given(method("GET"))
        .and(path("/uniswap.json"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(list)
                .set_delay(delay),
        )
        .mount(server)
        .await;
}

/// Serves an eth-labels accounts CSV with one mainnet label.
async fn serve_labels(server: &MockServer) {
    let csv = format!(
        "address,chainId,label,nameTag\n{},1,okx,Wallet\n",
        hex(Address::repeat_byte(0x32))
    );
    Mock::given(method("GET"))
        .and(path("/labels.csv"))
        .respond_with(ResponseTemplate::new(200).set_body_string(csv))
        .mount(server)
        .await;
}

/// How the next local data task to end on `rx` ended.
async fn task_done(rx: &mut broadcast::Receiver<(Audience, Event)>) -> LocalDataOutcome {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let (_, Event::LocalDataDone { outcome, .. }) = rx.recv().await.unwrap() {
                return outcome;
            }
        }
    })
    .await
    .expect("the task ends")
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn update_action_signed_starts_the_task_and_audits(pool: PgPool) {
    let server = MockServer::start().await;
    serve_uniswap(&server, Duration::ZERO).await;
    let dir = TempDir::new();
    let (app, state, key) = local_data_app(pool, &server, &dir).await;
    let both = admin_cookies(&app, &key).await;
    let update = json!({"type": "UpdateLocalData", "source": "tokens_uniswap"});
    let (nonce, message) = issued(&app, &both, &update).await;
    assert!(
        message.contains("\nUpdate local dataset tokens_uniswap\n"),
        "{message}"
    );

    let mut rx = state.ctx.bus.subscribe();
    let (status, body) = submit(&app, &both, &update, &nonce, &personal_sign(&key, &message)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["after"], json!({"source": "tokens_uniswap"}));
    assert_eq!(task_done(&mut rx).await, LocalDataOutcome::Succeeded);

    let row = state
        .store
        .local_data_all()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.source == "tokens_uniswap")
        .unwrap();
    assert_eq!((row.state.as_str(), row.rows), ("idle", Some(1)));
    // The signed action is on record before the task's end.
    let started = audit(&state.store, "update_local_data").await;
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].entry.outcome, AuditOutcome::Ok);
    assert_eq!(started[0].entry.target.as_deref(), Some("tokens_uniswap"));
    assert_eq!(started[0].entry.message.as_deref(), Some(message.as_str()));
    let ended = audit(&state.store, "local_data_update_done").await;
    assert_eq!(ended.len(), 1);
    assert!(started[0].id < ended[0].id);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_busy_update_is_409_before_verification_and_the_nonce_still_works(pool: PgPool) {
    let server = MockServer::start().await;
    serve_uniswap(&server, Duration::from_secs(30)).await;
    serve_labels(&server).await;
    let dir = TempDir::new();
    let (app, state, key) = local_data_app(pool, &server, &dir).await;
    let both = admin_cookies(&app, &key).await;
    let mut rx = state.ctx.bus.subscribe();
    state
        .runner
        .start(&state, SourceId::TokensUniswap, key_address(&key))
        .await
        .unwrap();

    let update = json!({"type": "UpdateLocalData", "source": "eth_labels"});
    let (nonce, message) = issued(&app, &both, &update).await;
    // Refused before the nonce or the signature is looked at.
    let (status, body) = submit(&app, &both, &update, &nonce, "0xdead").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "busy");
    let rows = audit(&state.store, "update_local_data").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Denied);
    assert_eq!(rows[0].entry.after, Some(json!({"reason": "busy"})));
    assert_eq!(rows[0].entry.target.as_deref(), Some("eth_labels"));
    assert_eq!(rows[0].entry.message, None);

    assert!(state.runner.cancel(SourceId::TokensUniswap));
    assert_eq!(task_done(&mut rx).await, LocalDataOutcome::Cancelled);
    // The same nonce, now signed, still works.
    let (status, body) = submit(&app, &both, &update, &nonce, &personal_sign(&key, &message)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(task_done(&mut rx).await, LocalDataOutcome::Succeeded);
    let rows = audit(&state.store, "update_local_data").await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Ok);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cancel_action_cancels(pool: PgPool) {
    let server = MockServer::start().await;
    serve_uniswap(&server, Duration::from_secs(30)).await;
    let dir = TempDir::new();
    let (app, state, key) = local_data_app(pool, &server, &dir).await;
    let both = admin_cookies(&app, &key).await;
    let mut rx = state.ctx.bus.subscribe();
    state
        .runner
        .start(&state, SourceId::TokensUniswap, key_address(&key))
        .await
        .unwrap();

    let cancel = json!({"type": "CancelLocalData", "source": "tokens_uniswap"});
    let (_, message) = issued(&app, &both, &cancel).await;
    assert!(
        message.contains("\nCancel the update of local dataset tokens_uniswap\n"),
        "{message}"
    );
    let body = act_ok(&app, &key, &both, &cancel).await;
    assert_eq!(body["after"], json!({"cancelled": true}));
    assert_eq!(task_done(&mut rx).await, LocalDataOutcome::Cancelled);
    assert_eq!(state.runner.running(), None);

    // Nothing running: a no-op.
    let body = act_ok(&app, &key, &both, &cancel).await;
    assert_eq!(body["after"], json!({"cancelled": false}));
    let rows = audit(&state.store, "cancel_local_data").await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.entry.outcome == AuditOutcome::Ok
        && r.entry.target.as_deref() == Some("tokens_uniswap")));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn guess_on_without_signatures_is_409(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    let on = json!({"type": "SetSignatureGuess", "enabled": true});
    let (status, body) = act(&app, &key, &both, &on).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "no_signatures");
    assert!(!state.signatures_enabled());
    assert_eq!(
        state.store.setting_get(SIGNATURES_SETTING).await.unwrap(),
        None
    );
    let rows = audit(&state.store, "set_signature_guess").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.outcome, AuditOutcome::Failed);

    // Turning it off needs no signatures.
    let off = json!({"type": "SetSignatureGuess", "enabled": false});
    act_ok(&app, &key, &both, &off).await;
    assert_eq!(
        state.store.setting_get(SIGNATURES_SETTING).await.unwrap(),
        Some(json!(false))
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn guess_toggle_persists_and_applies(pool: PgPool) {
    let (app, state, _, key) = admin_app(pool.clone()).await;
    let both = admin_cookies(&app, &key).await;
    eg_store::upsert_signatures(&pool, &["transfer(address,uint256)".to_owned()])
        .await
        .unwrap();
    assert!(!state.signatures_enabled());

    let on = json!({"type": "SetSignatureGuess", "enabled": true});
    let (_, message) = issued(&app, &both, &on).await;
    assert!(
        message.contains("\nTurn signature guessing on\n"),
        "{message}"
    );
    let body = act_ok(&app, &key, &both, &on).await;
    assert_eq!(body["before"], json!({"enabled": false}));
    assert_eq!(body["after"], json!({"enabled": true}));
    assert!(state.signatures_enabled());
    assert_eq!(
        state.store.setting_get(SIGNATURES_SETTING).await.unwrap(),
        Some(json!(true))
    );

    let off = json!({"type": "SetSignatureGuess", "enabled": false});
    let (_, message) = issued(&app, &both, &off).await;
    assert!(
        message.contains("\nTurn signature guessing off\n"),
        "{message}"
    );
    let body = act_ok(&app, &key, &both, &off).await;
    assert_eq!(body["before"], json!({"enabled": true}));
    assert!(!state.signatures_enabled());
    assert_eq!(
        state.store.setting_get(SIGNATURES_SETTING).await.unwrap(),
        Some(json!(false))
    );
    let rows = audit(&state.store, "set_signature_guess").await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.entry.outcome == AuditOutcome::Ok));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn guess_toggle_applies_the_stored_value(pool: PgPool) {
    // Another toggle committed right after this one: the trigger stands in
    // for it, so the stored value differs from the request's. The switch
    // follows what is stored.
    let (app, state, _, key) = admin_app(pool.clone()).await;
    let both = admin_cookies(&app, &key).await;
    eg_store::upsert_signatures(&pool, &["transfer(address,uint256)".to_owned()])
        .await
        .unwrap();
    sqlx::query(
        "CREATE FUNCTION force_guess_off() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.key = 'signatures_enabled' THEN NEW.value := 'false'; END IF; \
         RETURN NEW; END $$",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER force_guess_off BEFORE INSERT OR UPDATE ON settings \
         FOR EACH ROW EXECUTE FUNCTION force_guess_off()",
    )
    .execute(&pool)
    .await
    .unwrap();

    let on = json!({"type": "SetSignatureGuess", "enabled": true});
    act_ok(&app, &key, &both, &on).await;
    assert_eq!(
        state.store.setting_get(SIGNATURES_SETTING).await.unwrap(),
        Some(json!(false))
    );
    assert!(!state.signatures_enabled());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn unknown_source_is_400(pool: PgPool) {
    let (app, _, _, key) = admin_app(pool).await;
    let both = admin_cookies(&app, &key).await;
    for action in [
        json!({"type": "UpdateLocalData", "source": "nope"}),
        json!({"type": "CancelLocalData", "source": "eth-labels"}),
    ] {
        let (status, body) = action_nonce(&app, &both, &action).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{action}: {body}");
        let (status, body) = submit(&app, &both, &action, "n", "0x").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{action}: {body}");
    }
}

// ----------------------------------------------------------------- helpers

async fn open_stream(app: &Router, cookie: &str) -> Body {
    let req = Request::get("/api/events")
        .header(header::COOKIE, cookie)
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    resp.into_body()
}

/// Whether the stream ends within `d` (reading and dropping its frames).
async fn ends_within(body: &mut Body, d: Duration) -> bool {
    tokio::time::timeout(d, async {
        while let Some(frame) = body.frame().await {
            frame.unwrap();
        }
    })
    .await
    .is_ok()
}
