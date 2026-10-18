//! The logged-in user and admin-mode extractors, and the middleware gating
//! `/api` routes on them.

use alloy_primitives::Address;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, header};
use axum::middleware::Next;
use axum::response::Response;
use eg_store::{SessionKind, UserRow};

use super::{ADMIN_COOKIE, SESSION_COOKIE, client_ip, cookie, user_agent};
use crate::error::ApiError;
use crate::state::AppState;

/// The user of a live `eg_session` session. Rejects with 401 `unauthorized`
/// (`no_session`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CurrentUser {
    pub id: i64,
    pub address: Address,
    /// A configured admin (`auth.admins`), whether or not in admin mode.
    pub is_admin: bool,
}

impl CurrentUser {
    fn new(state: &AppState, u: &UserRow) -> Self {
        Self {
            id: u.id,
            address: u.address,
            is_admin: state.auth.is_admin(u.address),
        }
    }
}

/// The user of the request's `eg_session` cookie, if it names a live session.
pub async fn session_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<CurrentUser>, ApiError> {
    let Some(raw) = cookie(headers, SESSION_COOKIE) else {
        return Ok(None);
    };
    let found = state.store.session_lookup(raw, SessionKind::User).await?;
    Ok(found.map(|(_, u)| CurrentUser::new(state, &u)))
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        // Already resolved by the gate.
        if let Some(u) = parts.extensions.get::<CurrentUser>() {
            return Ok(u.clone());
        }
        session_user(state, &parts.headers)
            .await?
            .ok_or_else(|| ApiError::unauthorized("no_session"))
    }
}

/// Whether the request's `eg_admin` cookie names a live admin-mode session
/// of `user`.
pub async fn in_admin_mode(
    state: &AppState,
    headers: &HeaderMap,
    user: &CurrentUser,
) -> Result<bool, ApiError> {
    if !user.is_admin {
        return Ok(false);
    }
    let Some(raw) = cookie(headers, ADMIN_COOKIE) else {
        return Ok(false);
    };
    let found = state.store.session_lookup(raw, SessionKind::Admin).await?;
    Ok(found.is_some_and(|(s, _)| s.user_id == user.id))
}

/// A configured admin in admin mode: a live `eg_session` session plus a live
/// `eg_admin` admin-mode session of the same user. Rejects without a session
/// or admin-mode session with 401 `unauthorized`, and a user who is not a
/// configured admin with 404 `not_found` (the admin API does not exist for them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminMode(pub CurrentUser);

impl FromRequestParts<AppState> for AdminMode {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        if !user.is_admin {
            return Err(ApiError::not_found("no such API route"));
        }
        if !in_admin_mode(state, &parts.headers, &user).await? {
            return Err(ApiError::unauthorized("no_admin_session"));
        }
        Ok(AdminMode(user))
    }
}

/// Client IP (D7) and `User-Agent`, for sessions and audit rows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl ClientMeta {
    /// The rate-limit key.
    pub fn ip_key(&self) -> &str {
        self.ip.as_deref().unwrap_or("unknown")
    }
}

impl FromRequestParts<AppState> for ClientMeta {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, std::convert::Infallible> {
        Ok(Self {
            ip: client_ip(parts, state.auth.trust_forwarded_for),
            user_agent: user_agent(&parts.headers),
        })
    }
}

/// Middleware: rejects requests without a live session (401 `no_session`)
/// and hands the [`CurrentUser`] to the handler.
pub async fn require_user(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let (mut parts, body) = req.into_parts();
    let user = CurrentUser::from_request_parts(&mut parts, &state).await?;
    parts.extensions.insert(user);
    Ok(next.run(Request::from_parts(parts, body)).await)
}

/// Middleware against cross-site request forgery: a state-changing request
/// must carry `Origin` equal to the public origin (401 `bad_origin`).
pub async fn require_origin(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe {
        let origin = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok());
        if origin != Some(state.auth.origin.origin.as_str()) {
            return Err(ApiError::unauthorized("bad_origin"));
        }
    }
    Ok(next.run(req).await)
}
