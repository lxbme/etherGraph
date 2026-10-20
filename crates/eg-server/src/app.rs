//! Router assembly.

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::handler::Handler;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{from_fn_with_state, map_response};
use axum::response::Response;
use axum::routing::{any, delete, get, post};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::auth::extract::{require_origin, require_user};
use crate::error::ApiError;
use crate::routes::{
    address, admin, auth, batches, counterparties, events, graph, identify, jobs, labels, nodes,
    probe, search, status, sync, token, transfers, tx, workspaces,
};
use crate::state::AppState;

/// All `/api` routes: `/api/health` and `/api/auth/*` are open, `/api/admin/*`
/// is for configured admins (see [`admin`]), the rest need a session, and
/// state-changing requests need the public `Origin`. When
/// `server.static_dir` exists, other paths are served from it with
/// `index.html` as the SPA fallback. No response may be framed.
pub fn router(state: AppState) -> Router {
    let protected = Router::new()
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
        .route("/graph/edges", post(graph::edges.layer(graph_body())))
        .route("/nodes", post(nodes::nodes))
        .route("/transfers", get(transfers::list))
        .route("/tx/{hash}", get(tx::tx))
        .route("/tx/{hash}/raw", get(tx::raw))
        .route("/tx/{hash}/trace", get(tx::trace))
        .route("/labels", get(labels::list).post(labels::create))
        .route("/labels/{id}", delete(labels::delete))
        .route(
            "/workspaces",
            get(workspaces::list).post(workspaces::create.layer(big_body())),
        )
        .route(
            "/workspaces/{id}",
            get(workspaces::get)
                .put(workspaces::update.layer(big_body()))
                .delete(workspaces::delete),
        )
        .route_layer(from_fn_with_state(state.clone(), require_user));
    let open = Router::new()
        .route("/health", get(status::health))
        .route("/auth/nonce", get(auth::nonce))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        // The admin API checks the session and admin mode in its extractors,
        // so that refusals are audited.
        .route("/admin/session/nonce", get(admin::session_nonce))
        .route(
            "/admin/session",
            get(admin::session_get)
                .post(admin::session_enter)
                .delete(admin::session_exit),
        )
        .route("/admin/actions/nonce", post(admin::action_nonce))
        .route("/admin/actions", post(admin::action_run))
        .route("/admin/overview", get(admin::overview))
        .route("/admin/users", get(admin::users))
        .route("/admin/whitelist", get(admin::whitelist))
        .route("/admin/audit", get(admin::audit))
        .route("/admin/{*rest}", any(admin::not_found));
    let api = protected
        .merge(open)
        .route_layer(from_fn_with_state(state.clone(), require_origin))
        // Checks the origin itself so that a refusal is audited.
        .route("/auth/login", post(auth::login))
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
    app.layer(map_response(no_framing))
        .layer(trace)
        .with_state(state)
}

/// Forbids framing every response (the SPA and the API) against
/// clickjacking: `X-Frame-Options` for older browsers, CSP
/// `frame-ancestors` for current ones.
async fn no_framing(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    res
}

/// Largest workspace body (a canvas with imported snapshots can be big): twice
/// the 32 MiB import cap, so a maximal imported file still saves with the rest
/// of the workspace around it.
const WORKSPACE_BODY_LIMIT: usize = 64 * 1024 * 1024;

fn big_body() -> DefaultBodyLimit {
    DefaultBodyLimit::max(WORKSPACE_BODY_LIMIT)
}

/// Largest graph request: room for `MAX_PICKS` picked addresses (about 45 bytes
/// each as JSON), plus `prefer` and the rest, above the 2 MiB default.
const GRAPH_BODY_LIMIT: usize = 8 * 1024 * 1024;
const _: () = assert!(GRAPH_BODY_LIMIT > 2 * 48 * graph::MAX_PICKS);

fn graph_body() -> DefaultBodyLimit {
    DefaultBodyLimit::max(GRAPH_BODY_LIMIT)
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
