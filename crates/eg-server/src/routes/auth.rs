//! `/api/auth/*`: wallet login (SIWE), logout and the current user. These
//! routes and `/api/health` are the only ones open without a session.

use alloy_primitives::Address;
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{AppendHeaders, IntoResponse, Response};
use chrono::{Duration, Utc};
use eg_store::{
    AuditEntry, AuditOutcome, NoncePurpose, SETTING_DEFAULT_DAILY_QUOTA, SessionKind, StoreError,
    UserRow,
};
use serde::Deserialize;

use crate::auth::extract::{ClientMeta, CurrentUser, in_admin_mode, origin_ok};
use crate::auth::siwe::{
    self, LOGIN_STATEMENT, MAX_MESSAGE_LEN, VerifyError, canonical_message, claimed,
};
use crate::auth::{
    ADMIN_COOKIE, ADMIN_COOKIE_PATH, SESSION_COOKIE, cookie, open_registration, set_cookie,
};
use crate::background::next_utc_midnight;
use crate::dto::{LoginDto, MeDto, QuotaDto, SiweFieldsDto, hex_addr, rfc3339};
use crate::error::{ApiError, invalid};
use crate::parse::parse_address;
use crate::routes::ApiQuery;
use crate::state::AppState;

const OPEN_REGISTRATION_ADDED_BY: &str = "open-registration";
/// Longest signature (hex characters) copied into the audit log.
const MAX_AUDIT_SIGNATURE: usize = 4098;

#[derive(Deserialize)]
pub struct NonceQuery {
    address: String,
}

/// `GET /api/auth/nonce?address=0x…`: the fields of a login message for
/// `address`, valid for five minutes.
pub async fn nonce(
    State(s): State<AppState>,
    meta: ClientMeta,
    ApiQuery(q): ApiQuery<NonceQuery>,
) -> Result<Json<SiweFieldsDto>, ApiError> {
    if !s.auth.nonce_limit.allow(&meta.ip_key()) {
        return Err(ApiError::rate_limited());
    }
    let address = parse_address(&q.address)?;
    let fields = siwe::issue(&s, NoncePurpose::Login, None, address, LOGIN_STATEMENT).await?;
    Ok(Json(fields))
}

/// What is known about a login attempt, for its audit row.
#[derive(Default)]
struct Attempt {
    /// The address the message claims, once read.
    actor: Option<Address>,
    /// A server-issued nonce was taken: only then are the message and
    /// signature worth keeping.
    nonce_taken: bool,
}

enum LoginError {
    /// Refused; the reason is the 401's message and the audit row's.
    Denied(&'static str),
    Internal(ApiError),
}

impl From<StoreError> for LoginError {
    fn from(e: StoreError) -> Self {
        LoginError::Internal(e.into())
    }
}

/// `POST /api/auth/login`: checks the origin, verifies the signed message and
/// starts a session. Every attempt past the rate limit is audited, and a
/// session exists only together with its `ok` audit row.
pub async fn login(
    State(s): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Response, ApiError> {
    if !s.auth.login_limit.allow(&meta.ip_key()) {
        return Err(ApiError::rate_limited());
    }
    let parsed = serde_json::from_slice::<LoginDto>(&raw);
    let mut attempt = Attempt {
        actor: parsed
            .as_ref()
            .ok()
            .and_then(|b| claimed(&b.message))
            .map(|(a, _)| a),
        nonce_taken: false,
    };
    let entry = |attempt: &Attempt, body: Option<&LoginDto>, outcome, after| AuditEntry {
        actor: attempt.actor.map_or_else(|| "unknown".to_owned(), hex_addr),
        action: "login".into(),
        target: None,
        before: None,
        after,
        outcome,
        ip: meta.ip.clone(),
        user_agent: meta.user_agent.clone(),
        message: body
            .filter(|_| attempt.nonce_taken)
            .map(|b| b.message.clone()),
        signature: body
            .filter(|b| attempt.nonce_taken && b.signature.len() <= MAX_AUDIT_SIGNATURE)
            .map(|b| b.signature.clone()),
    };
    let reason = |r: &'static str| Some(serde_json::json!({ "reason": r }));
    if !origin_ok(&s, &headers) {
        s.store
            .audit_append(&entry(
                &attempt,
                None,
                AuditOutcome::Denied,
                reason("bad_origin"),
            ))
            .await?;
        return Err(ApiError::unauthorized("bad_origin"));
    }
    let body = parsed.map_err(|e| invalid(format!("invalid login body: {e}")))?;
    let failed = |attempt: &Attempt| entry(attempt, Some(&body), AuditOutcome::Failed, None);
    match verify_login(&s, &body, &mut attempt).await {
        Ok(user) => {
            let me = me_dto(&s, &user, false).await?;
            let ttl = Duration::days(i64::from(s.cfg.auth.session_days));
            let created = s
                .store
                .session_create_audited(
                    user.id,
                    SessionKind::User,
                    ttl,
                    meta.ip.as_deref(),
                    meta.user_agent.as_deref(),
                    &entry(&attempt, Some(&body), AuditOutcome::Ok, None),
                )
                .await;
            let token = match created {
                Ok(t) => t,
                Err(e) => {
                    audit_best_effort(&s, &failed(&attempt)).await;
                    return Err(e.into());
                }
            };
            let cookie = set_cookie(
                SESSION_COOKIE,
                &token,
                "/",
                ttl.num_seconds().unsigned_abs(),
                s.auth.origin.secure,
            );
            Ok(([(header::SET_COOKIE, cookie)], Json(me)).into_response())
        }
        Err(LoginError::Denied(r)) => {
            s.store
                .audit_append(&entry(
                    &attempt,
                    Some(&body),
                    AuditOutcome::Denied,
                    reason(r),
                ))
                .await?;
            Err(ApiError::unauthorized(r))
        }
        Err(LoginError::Internal(e)) => {
            audit_best_effort(&s, &failed(&attempt)).await;
            Err(e)
        }
    }
}

/// Appends a `failed` row while the request is already failing; an error
/// here is only logged.
async fn audit_best_effort(s: &AppState, e: &AuditEntry) {
    if let Err(err) = s.store.audit_append(e).await {
        tracing::error!(error = %err, "auditing a failed login failed");
    }
}

/// D1: the message must be exactly the text the server would build from the
/// nonce record for the claimed address; then the signature, then the
/// whitelist rule. Returns the logged-in user (created on first login).
async fn verify_login(
    s: &AppState,
    body: &LoginDto,
    attempt: &mut Attempt,
) -> Result<UserRow, LoginError> {
    if body.message.len() > MAX_MESSAGE_LEN {
        return Err(LoginError::Denied("bad_message"));
    }
    let Some((address, nonce)) = claimed(&body.message) else {
        return Err(LoginError::Denied("bad_message"));
    };
    attempt.actor = Some(address);
    let Some((fields, _)) = siwe::take(s, nonce, NoncePurpose::Login).await? else {
        return Err(LoginError::Denied("bad_nonce"));
    };
    attempt.nonce_taken = true;
    // Issued for this address under the current origin, and not edited.
    let issued_for = parse_address(&fields.address).ok();
    let origin = &s.auth.origin;
    if issued_for != Some(address)
        || fields.domain != origin.domain
        || fields.uri != origin.origin
        || canonical_message(&fields.siwe_fields(), address) != body.message
    {
        return Err(LoginError::Denied("bad_message"));
    }
    match siwe::verify_signer(s, address, &body.message, &body.signature).await {
        Ok(()) => {}
        Err(VerifyError::BadSignature) => return Err(LoginError::Denied("bad_signature")),
        Err(VerifyError::Store(e)) => return Err(LoginError::from(e)),
    }
    if !s.auth.is_admin(address) && !s.store.whitelist_contains(address).await? {
        if !open_registration(s).await? {
            return Err(LoginError::Denied("not_whitelisted"));
        }
        s.store
            .whitelist_add(address, OPEN_REGISTRATION_ADDED_BY)
            .await?;
    }
    Ok(s.store.upsert_user_on_login(address).await?)
}

/// `POST /api/auth/logout`: ends the session and the user's admin-mode
/// sessions (audited when there was a session) and clears both cookies.
pub async fn logout(
    State(s): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(raw) = cookie(&headers, SESSION_COOKIE) {
        let found = s.store.session_lookup(raw, SessionKind::User).await?;
        s.store.session_delete(raw).await?;
        if let Some((_, user)) = found {
            s.store
                .sessions_delete_kind(user.id, SessionKind::Admin)
                .await?;
            s.store
                .audit_append(&AuditEntry {
                    actor: hex_addr(user.address),
                    action: "logout".into(),
                    target: None,
                    before: None,
                    after: None,
                    outcome: AuditOutcome::Ok,
                    ip: meta.ip,
                    user_agent: meta.user_agent,
                    message: None,
                    signature: None,
                })
                .await?;
        }
    }
    let secure = s.auth.origin.secure;
    let clear = AppendHeaders([
        (
            header::SET_COOKIE,
            set_cookie(SESSION_COOKIE, "", "/", 0, secure),
        ),
        (
            header::SET_COOKIE,
            set_cookie(ADMIN_COOKIE, "", ADMIN_COOKIE_PATH, 0, secure),
        ),
    ]);
    Ok((StatusCode::NO_CONTENT, clear).into_response())
}

/// `GET /api/auth/me`: the logged-in user, or 401.
pub async fn me(
    State(s): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
) -> Result<Json<MeDto>, ApiError> {
    let row = s
        .store
        .user_by_id(user.id)
        .await?
        .ok_or_else(|| ApiError::unauthorized("no_session"))?;
    let admin_mode = in_admin_mode(&s, &headers, &user).await?;
    Ok(Json(me_dto(&s, &row, admin_mode).await?))
}

async fn me_dto(s: &AppState, user: &UserRow, admin_mode: bool) -> Result<MeDto, ApiError> {
    let now = Utc::now();
    let used = s.store.user_usage_get(user.id, now.date_naive()).await?;
    Ok(MeDto {
        address: hex_addr(user.address),
        is_admin: s.auth.is_admin(user.address),
        admin_mode,
        quota: QuotaDto {
            used,
            limit: daily_limit(s, user).await?,
            reset_at: rfc3339(next_utc_midnight(now)),
        },
    })
}

/// The user's daily Etherscan call limit: their own, else the admin-set
/// default, else the configured default.
pub async fn daily_limit(s: &AppState, user: &UserRow) -> Result<u32, ApiError> {
    if let Some(q) = user.daily_quota {
        return Ok(u32::try_from(q).unwrap_or(0));
    }
    let setting = s.store.setting_get(SETTING_DEFAULT_DAILY_QUOTA).await?;
    Ok(setting
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(s.cfg.auth.default_daily_quota))
}
