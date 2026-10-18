//! The logged-in user and admin-mode extractors, and the middleware gating
//! `/api` routes on them.

use alloy_primitives::Address;
use axum::extract::{FromRequestParts, OriginalUri, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, header};
use axum::middleware::Next;
use axum::response::Response;
use eg_store::{AuditEntry, AuditOutcome, SessionKind, SessionRow, UserRow};

use super::{ADMIN_COOKIE, SESSION_COOKIE, client_ip, cookie, rate_key, user_agent};
use crate::dto::hex_addr;
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

/// The live admin-mode session of the request: its `eg_admin` cookie names
/// an admin session of `user` that was started from the request's own
/// `eg_session` login session (an admin cookie left over from an earlier
/// login does not count).
pub async fn admin_session(
    state: &AppState,
    headers: &HeaderMap,
    user: &CurrentUser,
) -> Result<Option<SessionRow>, ApiError> {
    if !user.is_admin {
        return Ok(None);
    }
    let (Some(admin), Some(login)) = (
        cookie(headers, ADMIN_COOKIE),
        cookie(headers, SESSION_COOKIE),
    ) else {
        return Ok(None);
    };
    let found = state.store.admin_session_lookup(admin, login).await?;
    Ok(found.filter(|(s, _)| s.user_id == user.id).map(|(s, _)| s))
}

/// A logged-in configured admin (`auth.admins`), in admin mode or not.
/// Rejects without a session with 401 `unauthorized` (`no_session`), and a
/// user who is not a configured admin with 404 `not_found` (the admin API
/// does not exist for them) after auditing the attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminUser(pub CurrentUser);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        if !user.is_admin {
            deny_admin_access(parts, state, &user, "not_admin").await?;
            return Err(ApiError::not_found("no such API route"));
        }
        Ok(AdminUser(user))
    }
}

/// A configured admin in admin mode: a live `eg_session` session plus a live
/// `eg_admin` admin-mode session started from it. Rejects like [`AdminUser`],
/// and without admin mode with 401 `unauthorized` (`no_admin_session`),
/// audited.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminMode(pub CurrentUser);

impl FromRequestParts<AppState> for AdminMode {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let AdminUser(user) = AdminUser::from_request_parts(parts, state).await?;
        if admin_session(state, &parts.headers, &user).await?.is_none() {
            deny_admin_access(parts, state, &user, "no_admin_session").await?;
            return Err(ApiError::unauthorized("no_admin_session"));
        }
        Ok(AdminMode(user))
    }
}

/// Longest request line kept as an `admin_access` audit target.
const MAX_AUDIT_TARGET: usize = 256;

/// Audits a refused admin API request (`admin_access`, `denied`, the
/// request's method and path as target).
async fn deny_admin_access(
    parts: &mut Parts,
    state: &AppState,
    user: &CurrentUser,
    reason: &str,
) -> Result<(), ApiError> {
    let meta = ClientMeta::from_request_parts(parts, state)
        .await
        .unwrap_or_else(|never| match never {});
    // The full path: nested routers see it without their prefix.
    let uri = parts
        .extensions
        .get::<OriginalUri>()
        .map_or(&parts.uri, |OriginalUri(u)| u);
    state
        .store
        .audit_append(&AuditEntry {
            actor: hex_addr(user.address),
            action: "admin_access".into(),
            target: Some(
                format!("{} {}", parts.method, uri.path())
                    .chars()
                    .take(MAX_AUDIT_TARGET)
                    .collect(),
            ),
            before: None,
            after: Some(serde_json::json!({ "reason": reason })),
            outcome: AuditOutcome::Denied,
            ip: meta.ip,
            user_agent: meta.user_agent,
            message: None,
            signature: None,
        })
        .await?;
    Ok(())
}

/// Client IP (D7) and `User-Agent`, for sessions and audit rows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl ClientMeta {
    /// The rate-limit key (see [`rate_key`]).
    pub fn ip_key(&self) -> String {
        rate_key(self.ip.as_deref())
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
/// must carry `Origin` equal to the public origin (401 `bad_origin`). Login
/// checks it itself, to audit the refusal.
pub async fn require_origin(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe && !origin_ok(&state, req.headers()) {
        return Err(ApiError::unauthorized("bad_origin"));
    }
    Ok(next.run(req).await)
}

/// Whether the request's `Origin` is the public origin.
pub fn origin_ok(state: &AppState, headers: &HeaderMap) -> bool {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    origin == Some(state.auth.origin.origin.as_str())
}
