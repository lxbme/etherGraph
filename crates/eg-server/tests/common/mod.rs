#![allow(dead_code)]

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use eg_core::testing::FakeSource;
use eg_etherscan::ClientStats;
use eg_ingest::gate::{GateConfig, PriorityGate};
use eg_server::app::router;
use eg_server::config::Config;
use eg_server::state::AppState;
use eg_store::Store;
use http_body_util::BodyExt;
use sqlx::PgPool;
use tower::ServiceExt;

/// App wired to a `FakeSource` and a fast gate. No runner workers are spawned.
pub fn test_app(pool: PgPool) -> (Router, AppState, Arc<FakeSource>) {
    let cfg = Arc::new(Config::default());
    let fake = Arc::new(FakeSource::new());
    let gate = PriorityGate::spawn(GateConfig {
        rate_per_sec: 1000.0,
        daily_limit: cfg.etherscan.daily_limit,
        initial_used: 0,
    });
    let state = AppState::new(
        cfg,
        Store::from_pool(pool),
        fake.clone(),
        gate,
        Arc::new(ClientStats::default()),
    );
    (router(state.clone()), state, fake)
}

/// Sends `req` and returns the status and the body parsed as JSON (`Null` when empty).
pub async fn send(app: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
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
