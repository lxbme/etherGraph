//! Router assembly.

use axum::Router;
use axum::routing::{delete, get};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::error::ApiError;
use crate::routes::{events, jobs, status};
use crate::state::AppState;

/// All `/api` routes; when `server.static_dir` exists, other paths are served
/// from it with `index.html` as the SPA fallback.
pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/status", get(status::status))
        .route("/jobs", get(jobs::list))
        .route("/jobs/{id}", delete(jobs::cancel))
        .route("/events", get(events::events))
        .fallback(api_not_found);
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

async fn api_not_found() -> ApiError {
    ApiError::not_found("no such API route")
}
