//! Router assembly.

use axum::Router;
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::error::ApiError;
use crate::routes::{
    address, batches, counterparties, events, graph, identify, jobs, labels, probe, search, status,
    sync, token, transfers, tx, workspaces,
};
use crate::state::AppState;

/// All `/api` routes; when `server.static_dir` exists, other paths are served
/// from it with `index.html` as the SPA fallback.
pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/status", get(status::status))
        .route("/jobs", get(jobs::list).delete(jobs::cancel_scope))
        .route("/jobs/{id}", get(jobs::get).delete(jobs::cancel))
        .route("/batches/{id}", delete(batches::release))
        .route("/events", get(events::events))
        .route("/search", get(search::search))
        .route("/address/{addr}", get(address::profile))
        .route("/address/{addr}/counterparties", get(counterparties::list))
        .route("/token/{addr}", get(token::detail))
        .route("/sync", post(sync::sync))
        .route("/identify", post(identify::identify))
        .route("/probe", post(probe::probe))
        .route("/graph/edges", post(graph::edges))
        .route("/transfers", get(transfers::list))
        .route("/tx/{hash}", get(tx::tx))
        .route("/tx/{hash}/raw", get(tx::raw))
        .route("/labels", get(labels::list).post(labels::create))
        .route("/labels/{id}", delete(labels::delete))
        .route(
            "/workspaces",
            get(workspaces::list).post(workspaces::create),
        )
        .route(
            "/workspaces/{id}",
            get(workspaces::get)
                .put(workspaces::update)
                .delete(workspaces::delete),
        )
        .fallback(api_not_found)
        // Applies to the routes registered above.
        .method_not_allowed_fallback(method_not_allowed);
    let mut app = Router::new().nest("/api", api);
    if let Some(dir) = state.cfg.server.static_dir.as_ref().filter(|d| d.is_dir()) {
        let index = ServeFile::new(dir.join("index.html"));
        app = app.fallback_service(ServeDir::new(dir).fallback(index));
    }
    // One INFO span per request plus an INFO line per response.
    let trace = TraceLayer::new_for_http()
        .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
        .on_response(DefaultOnResponse::new().level(Level::INFO));
    app.layer(trace).with_state(state)
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "invalid_input",
        "method not allowed",
    )
}

async fn api_not_found() -> ApiError {
    ApiError::not_found("no such API route")
}
