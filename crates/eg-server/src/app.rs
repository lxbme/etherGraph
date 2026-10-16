//! Router assembly.

use axum::Router;
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::error::ApiError;
use crate::routes::{address, events, graph, jobs, search, status, sync, transfers};
use crate::state::AppState;

/// All `/api` routes; when `server.static_dir` exists, other paths are served
/// from it with `index.html` as the SPA fallback.
pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/status", get(status::status))
        .route("/jobs", get(jobs::list))
        .route("/jobs/{id}", delete(jobs::cancel))
        .route("/events", get(events::events))
        .route("/search", get(search::search))
        .route("/address/{addr}", get(address::profile))
        .route("/sync", post(sync::sync))
        .route("/graph/edges", post(graph::edges))
        .route("/transfers", get(transfers::list))
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
