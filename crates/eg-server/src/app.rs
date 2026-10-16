//! Router assembly.

use axum::Router;
use axum::routing::{delete, get};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

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
    app.layer(TraceLayer::new_for_http()).with_state(state)
}

async fn api_not_found() -> ApiError {
    ApiError::not_found("no such API route")
}
