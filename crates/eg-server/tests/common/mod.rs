#![allow(dead_code)]

use std::sync::Arc;

use alloy_primitives::{Address, Signature, address, eip191_hash_message};
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderValue, Request, StatusCode, header};
use chrono::Duration;
use eg_core::source::{ChainSource, TraceSource};
use eg_core::testing::{FakeSource, FakeTraceSource, GatedSource};
use eg_etherscan::ClientStats;
use eg_ingest::gate::{GateConfig, PriorityGate, TraceGate};
use eg_server::app::router;
use eg_server::auth::siwe::canonical_message;
use eg_server::config::Config;
use eg_server::dto::SiweFieldsDto;
use eg_server::state::AppState;
use eg_store::{SessionKind, Store};
use http_body_util::BodyExt;
use k256::ecdsa::SigningKey;
use sqlx::PgPool;
use tower::ServiceExt;
use tower::util::MapRequestLayer;

/// The `public_origin` of [`Config::default`], sent as `Origin` by the helpers.
pub const ORIGIN: &str = "http://127.0.0.1:8080";

/// The whitelisted, non-admin user every [`test_app`] request runs as.
pub const DEFAULT_USER: Address = address!("0x00000000000000000000000000000000000d3fa1");

/// App wired to a `FakeSource`, a `FakeTraceSource` and fast gates, every
/// request sent as [`DEFAULT_USER`] (see [`as_default_user`]). No runner
/// workers are spawned.
pub async fn test_app(pool: PgPool) -> (Router, AppState, Arc<FakeSource>) {
    let (app, state, fake, _) = test_app_traced(pool).await;
    (app, state, fake)
}

/// Like [`test_app`], also returning the `FakeTraceSource` behind
/// `state.ctx.trace_source` (its calls take no gate permit).
pub async fn test_app_traced(
    pool: PgPool,
) -> (Router, AppState, Arc<FakeSource>, Arc<FakeTraceSource>) {
    let fake = Arc::new(FakeSource::new());
    let trace = Arc::new(FakeTraceSource::new());
    let cfg = Config::default();
    let gate = gate_for(&cfg);
    let (raw, state) = app_with_gate(cfg, pool, fake.clone(), gate, trace.clone(), false);
    let app = as_default_user(raw, &state).await;
    (app, state, fake, trace)
}

/// Like [`test_app`] with any source.
pub async fn test_app_with(pool: PgPool, source: Arc<dyn ChainSource>) -> (Router, AppState) {
    let (raw, state) = app_with(Config::default(), pool, source);
    let app = as_default_user(raw, &state).await;
    (app, state)
}

/// The app without a default session: requests carry only the headers the
/// test sets.
pub fn anon_app(pool: PgPool, cfg: Config) -> (Router, AppState, Arc<FakeSource>) {
    let fake = Arc::new(FakeSource::new());
    let (app, state) = app_with(cfg, pool, fake.clone());
    (app, state, fake)
}

/// Like [`test_app`] with `cfg`, every source call taking a permit from the
/// app's gate as the Etherscan client does, billed to the calling task's
/// user: calls count toward the server and per-user quotas.
pub async fn gated_app(pool: PgPool, cfg: Config) -> (Router, AppState, Arc<FakeSource>) {
    let (app, state, fake, _) = gated_app_traced(pool, cfg).await;
    (app, state, fake)
}

/// Like [`gated_app`], also returning the `FakeTraceSource` behind
/// `state.ctx.trace_source`, whose calls each take a permit from
/// `state.trace_gate` as the Blockscout client does: they count toward the
/// per-user quota only.
pub async fn gated_app_traced(
    pool: PgPool,
    cfg: Config,
) -> (Router, AppState, Arc<FakeSource>, Arc<FakeTraceSource>) {
    let fake = Arc::new(FakeSource::new());
    let trace = Arc::new(FakeTraceSource::new());
    let gate = gate_for(&cfg);
    let source = Arc::new(GatedSource::new(fake.clone(), gate.clone()));
    let (raw, state) = app_with_gate(cfg, pool, source, gate, trace.clone(), true);
    let app = as_default_user(raw, &state).await;
    (app, state, fake, trace)
}

fn gate_for(cfg: &Config) -> Arc<PriorityGate> {
    PriorityGate::spawn(GateConfig {
        rate_per_sec: 1000.0,
        daily_limit: cfg.etherscan.daily_limit,
        initial_used: 0,
        default_user_limit: cfg.auth.default_daily_quota,
        user_limits: Default::default(),
        initial_user_used: Default::default(),
    })
}

fn app_with(cfg: Config, pool: PgPool, source: Arc<dyn ChainSource>) -> (Router, AppState) {
    let gate = gate_for(&cfg);
    let trace = Arc::new(FakeTraceSource::new());
    app_with_gate(cfg, pool, source, gate, trace, false)
}

/// `gated_trace`: `trace`'s calls take permits from the app's trace gate.
fn app_with_gate(
    cfg: Config,
    pool: PgPool,
    source: Arc<dyn ChainSource>,
    gate: Arc<PriorityGate>,
    trace: Arc<FakeTraceSource>,
    gated_trace: bool,
) -> (Router, AppState) {
    let trace_gate = TraceGate::spawn(1000.0, gate.clone());
    let trace_source: Arc<dyn TraceSource> = if gated_trace {
        Arc::new(GatedSource::new(trace, trace_gate.clone()))
    } else {
        trace
    };
    let state = AppState::with_trace(
        Arc::new(cfg),
        Store::from_pool(pool),
        source,
        gate,
        Arc::new(ClientStats::default()),
        trace_gate,
        trace_source,
    );
    (router(state.clone()), state)
}

/// Whitelists [`DEFAULT_USER`], gives it a session and wraps `app` so every
/// request without a `Cookie` header carries that session, and every request
/// without an `Origin` header the configured origin.
pub async fn as_default_user(app: Router, state: &AppState) -> Router {
    state
        .store
        .whitelist_add(DEFAULT_USER, "test")
        .await
        .unwrap();
    let user = state
        .store
        .upsert_user_on_login(DEFAULT_USER)
        .await
        .unwrap();
    let token = state
        .store
        .session_create(user.id, SessionKind::User, Duration::days(1), None, None)
        .await
        .unwrap();
    let cookie = HeaderValue::from_str(&format!("eg_session={token}")).unwrap();
    app.layer(MapRequestLayer::new(move |mut req: Request<Body>| {
        let h = req.headers_mut();
        if !h.contains_key(header::COOKIE) {
            h.insert(header::COOKIE, cookie.clone());
        }
        if !h.contains_key(header::ORIGIN) {
            h.insert(header::ORIGIN, HeaderValue::from_static(ORIGIN));
        }
        req
    }))
}

/// Sends `req` and returns the status and the body parsed as JSON (`Null` when empty).
pub async fn send(app: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let (status, _, json) = send_full(app, req).await;
    (status, json)
}

/// Like [`send`], also returning the `Set-Cookie` headers.
pub async fn send_full(
    app: &Router,
    req: Request<Body>,
) -> (StatusCode, Vec<String>, serde_json::Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let cookies = resp
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .collect();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, cookies, json)
}

pub async fn get(app: &Router, uri: &str) -> (StatusCode, serde_json::Value) {
    send(app, Request::get(uri).body(Body::empty()).unwrap()).await
}

pub async fn delete(app: &Router, uri: &str) -> (StatusCode, serde_json::Value) {
    send(app, Request::delete(uri).body(Body::empty()).unwrap()).await
}

pub async fn post_json(
    app: &Router,
    uri: &str,
    body: &serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = Request::post(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    send(app, req).await
}

/// `GET uri` with `cookie` (e.g. from [`login_as`]) and nothing else.
pub async fn get_as(app: &Router, cookie: &str, uri: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::get(uri)
        .header(header::COOKIE, cookie)
        .body(Body::empty())
        .unwrap();
    send(app, req).await
}

/// `POST uri` with a JSON body, `cookie` and the configured `Origin`.
pub async fn post_json_as(
    app: &Router,
    cookie: &str,
    uri: &str,
    body: &serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = Request::post(uri)
        .header("content-type", "application/json")
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(body.to_string()))
        .unwrap();
    send(app, req).await
}

/// `DELETE uri` with `cookie` and the configured `Origin`.
pub async fn delete_as(app: &Router, cookie: &str, uri: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::delete(uri)
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    send(app, req).await
}

/// A fresh random signing key (never a real one).
pub fn new_key() -> SigningKey {
    loop {
        if let Ok(k) = SigningKey::from_slice(&rand::random::<[u8; 32]>()) {
            return k;
        }
    }
}

pub fn key_address(key: &SigningKey) -> Address {
    Address::from_public_key(key.verifying_key())
}

/// EIP-191 `personal_sign` of `message`, as a wallet returns it (`0x` + 65 bytes hex).
pub fn personal_sign(key: &SigningKey, message: &str) -> String {
    let hash = eip191_hash_message(message);
    let (sig, recid) = key.sign_prehash_recoverable(hash.as_slice()).unwrap();
    let sig = Signature::from_signature_and_parity(sig, recid.is_y_odd());
    format!("0x{}", hex_encode(&sig.as_bytes()))
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The login nonce fields issued for `addr`.
pub async fn nonce_for(app: &Router, addr: Address) -> SiweFieldsDto {
    let req = Request::get(format!("/api/auth/nonce?address={addr:#x}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(app, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

/// The login message the server expects for `fields`, as the frontend builds it.
pub fn message_for(fields: &SiweFieldsDto) -> String {
    let addr: Address = fields.address.parse().unwrap();
    canonical_message(&fields.siwe_fields(), addr)
}

/// `POST /api/auth/login` with the configured `Origin` and no session (an
/// empty `Cookie` header, so [`as_default_user`] adds none); returns the
/// status, `Set-Cookie` headers and body.
pub async fn post_login(
    app: &Router,
    message: &str,
    signature: &str,
) -> (StatusCode, Vec<String>, serde_json::Value) {
    let body = serde_json::json!({"message": message, "signature": signature});
    let req = Request::post("/api/auth/login")
        .header("content-type", "application/json")
        .header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, "")
        .body(Body::from(body.to_string()))
        .unwrap();
    send_full(app, req).await
}

/// Logs in with `key` (whose address must be allowed to log in, e.g.
/// whitelisted) and returns the session cookie as `eg_session=…`, ready for a
/// `Cookie` header.
pub async fn login_as(app: &Router, key: &SigningKey) -> String {
    let fields = nonce_for(app, key_address(key)).await;
    let message = message_for(&fields);
    let (status, cookies, body) = post_login(app, &message, &personal_sign(key, &message)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    session_cookie(&cookies).expect("login sets eg_session")
}

/// `eg_session=…` from `Set-Cookie` headers, when one sets a non-empty session.
pub fn session_cookie(set_cookies: &[String]) -> Option<String> {
    set_cookies.iter().find_map(|c| {
        let pair = c.split(';').next()?.trim();
        let value = pair.strip_prefix("eg_session=")?;
        (!value.is_empty()).then(|| pair.to_owned())
    })
}

/// A fresh key whose address is whitelisted.
pub async fn whitelisted_key(state: &AppState) -> SigningKey {
    let key = new_key();
    state
        .store
        .whitelist_add(key_address(&key), "test")
        .await
        .unwrap();
    key
}

/// `PUT uri` with a JSON body, `cookie` and the configured `Origin`.
pub async fn put_json_as(
    app: &Router,
    cookie: &str,
    uri: &str,
    body: &serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = Request::put(uri)
        .header("content-type", "application/json")
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(body.to_string()))
        .unwrap();
    send(app, req).await
}

/// The user id of [`DEFAULT_USER`] (created by [`test_app`]).
pub async fn default_user_id(state: &AppState) -> i64 {
    state
        .store
        .upsert_user_on_login(DEFAULT_USER)
        .await
        .unwrap()
        .id
}

/// A second whitelisted user, logged in: its session cookie and user id.
pub async fn second_user(app: &Router, state: &AppState) -> (String, i64) {
    let key = whitelisted_key(state).await;
    let cookie = login_as(app, &key).await;
    let id = state
        .store
        .upsert_user_on_login(key_address(&key))
        .await
        .unwrap()
        .id;
    (cookie, id)
}
