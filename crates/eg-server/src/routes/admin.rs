//! `/api/admin/*` (spec §7–§8). A configured admin first enters admin mode
//! with a wallet signature (`eg_admin`, bound to the login session it was
//! entered from); every sensitive change then needs its own signature over
//! a server-written description. Users who are not admins find no admin API
//! (404) and their attempts are audited. Nothing here returns a user's
//! labels, workspaces or job targets: only usage figures.

use alloy_primitives::Address;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Duration, Utc};
use eg_store::{AuditEntry, AuditFilter, AuditOutcome, NoncePurpose, StoreError};
use serde::Deserialize;

use crate::auth::actions::{self, Action};
use crate::auth::extract::{AdminMode, AdminUser, ClientMeta, CurrentUser, admin_session};
use crate::auth::siwe::{self, MAX_MESSAGE_LEN, VerifyError, canonical_message, claimed};
use crate::auth::{
    ADMIN_COOKIE, ADMIN_COOKIE_PATH, MAX_AUDIT_SIGNATURE, SESSION_COOKIE, cookie,
    open_registration, set_cookie,
};
use crate::background::{default_user_limit, next_utc_midnight, refresh_user_limits};
use crate::dto::{
    AdminActionNonceDto, AdminActionNonceRequestDto, AdminActionRequestDto, AdminActionResultDto,
    AdminOverviewDto, AdminSessionDto, AdminUserDto, AuditPageDto, AuditRowDto, LoginDto,
    SiweFieldsDto, WhitelistEntryDto, hex_addr, rfc3339, rfc3339_micros,
};
use crate::error::{ApiError, invalid};
use crate::parse::parse_address;
use crate::routes::{ApiJson, ApiQuery};
use crate::state::AppState;

/// The admin-mode message's statement.
pub const ADMIN_STATEMENT: &str = "Enter etherGraph admin mode";
/// Rows per `GET /api/admin/audit` page.
pub const AUDIT_PAGE: u32 = 100;

fn entry(
    actor: Address,
    action: &str,
    meta: &ClientMeta,
    outcome: AuditOutcome,
    reason: Option<&str>,
) -> AuditEntry {
    AuditEntry {
        actor: hex_addr(actor),
        action: action.into(),
        target: None,
        before: None,
        after: reason.map(|r| serde_json::json!({ "reason": r })),
        outcome,
        ip: meta.ip.clone(),
        user_agent: meta.user_agent.clone(),
        message: None,
        signature: None,
    }
}

/// The signed payload for an audit row: the message, and the signature
/// unless it is implausibly long.
fn signed(e: &mut AuditEntry, message: &str, signature: &str) {
    e.message = Some(message.to_owned());
    e.signature = (signature.len() <= MAX_AUDIT_SIGNATURE).then(|| signature.to_owned());
}

/// Appends a `failed` row while the request is already failing; an error
/// here is only logged.
async fn audit_failed(s: &AppState, mut e: AuditEntry) {
    e.outcome = AuditOutcome::Failed;
    if let Err(err) = s.store.audit_append(&e).await {
        tracing::error!(error = %err, action = %e.action, "auditing a failed admin request failed");
    }
}

// ------------------------------------------------------------------ admin mode

/// `GET /api/admin/session/nonce`: the fields of the admin-mode message.
pub async fn session_nonce(
    State(s): State<AppState>,
    AdminUser(user): AdminUser,
) -> Result<Json<SiweFieldsDto>, ApiError> {
    let fields = siwe::issue(
        &s,
        NoncePurpose::Admin,
        Some(user.id),
        user.address,
        ADMIN_STATEMENT,
    )
    .await?;
    Ok(Json(fields))
}

/// `GET /api/admin/session`: the live admin-mode session, or 401
/// `no_admin_session`.
pub async fn session_get(
    State(s): State<AppState>,
    AdminUser(user): AdminUser,
    headers: HeaderMap,
) -> Result<Json<AdminSessionDto>, ApiError> {
    let session = admin_session(&s, &headers, &user)
        .await?
        .ok_or_else(|| ApiError::unauthorized("no_admin_session"))?;
    Ok(Json(AdminSessionDto {
        address: hex_addr(user.address),
        expires_at: rfc3339(session.expires_at),
    }))
}

enum Refusal {
    /// Refused; the reason is the 401's message and the audit row's.
    Denied(&'static str),
    Internal(ApiError),
}

impl From<StoreError> for Refusal {
    fn from(e: StoreError) -> Self {
        Refusal::Internal(e.into())
    }
}

impl From<ApiError> for Refusal {
    fn from(e: ApiError) -> Self {
        Refusal::Internal(e)
    }
}

/// `POST /api/admin/session {message, signature}`: enters admin mode for
/// the request's login session; sets `eg_admin`. Every attempt is audited
/// (`admin_mode_enter`).
pub async fn session_enter(
    State(s): State<AppState>,
    AdminUser(user): AdminUser,
    meta: ClientMeta,
    headers: HeaderMap,
    ApiJson(body): ApiJson<LoginDto>,
) -> Result<Response, ApiError> {
    let mut audit = entry(
        user.address,
        "admin_mode_enter",
        &meta,
        AuditOutcome::Ok,
        None,
    );
    match verify_admin_entry(&s, &user, &body, &mut audit).await {
        Ok(()) => {}
        Err(Refusal::Denied(r)) => {
            audit.outcome = AuditOutcome::Denied;
            audit.after = Some(serde_json::json!({ "reason": r }));
            s.store.audit_append(&audit).await?;
            return Err(ApiError::unauthorized(r));
        }
        Err(Refusal::Internal(e)) => {
            audit_failed(&s, audit).await;
            return Err(e);
        }
    }
    let login = cookie(&headers, SESSION_COOKIE).unwrap_or_default();
    let ttl = Duration::minutes(i64::from(s.cfg.auth.admin_session_minutes));
    let created = s
        .store
        .admin_session_create_audited(
            login,
            ttl,
            meta.ip.as_deref(),
            meta.user_agent.as_deref(),
            &audit,
        )
        .await;
    let (token, expires_at) = match created {
        Ok(Some(created)) => created,
        // The login session ended while the request was under way.
        Ok(None) => {
            audit.outcome = AuditOutcome::Denied;
            audit.after = Some(serde_json::json!({ "reason": "no_session" }));
            s.store.audit_append(&audit).await?;
            return Err(ApiError::unauthorized("no_session"));
        }
        Err(e) => {
            audit_failed(&s, audit).await;
            return Err(e.into());
        }
    };
    let cookie = set_cookie(
        ADMIN_COOKIE,
        &token,
        ADMIN_COOKIE_PATH,
        ttl.num_seconds().unsigned_abs(),
        s.auth.origin.secure,
    );
    let dto = AdminSessionDto {
        address: hex_addr(user.address),
        expires_at: rfc3339(expires_at),
    };
    Ok(([(header::SET_COOKIE, cookie)], Json(dto)).into_response())
}

/// D1 as for login, for the admin-mode message: issued to this admin with
/// purpose `admin`, rebuilt byte for byte, signed by the admin.
async fn verify_admin_entry(
    s: &AppState,
    user: &CurrentUser,
    body: &LoginDto,
    audit: &mut AuditEntry,
) -> Result<(), Refusal> {
    if body.message.len() > MAX_MESSAGE_LEN {
        return Err(Refusal::Denied("bad_message"));
    }
    let Some((address, nonce)) = claimed(&body.message) else {
        return Err(Refusal::Denied("bad_message"));
    };
    if address != user.address {
        return Err(Refusal::Denied("bad_message"));
    }
    let Some((fields, issued_to)) = siwe::take(s, nonce, NoncePurpose::Admin).await? else {
        return Err(Refusal::Denied("bad_nonce"));
    };
    if issued_to != Some(user.id) {
        return Err(Refusal::Denied("bad_nonce"));
    }
    signed(audit, &body.message, &body.signature);
    let origin = &s.auth.origin;
    if parse_address(&fields.address).ok() != Some(address)
        || fields.domain != origin.domain
        || fields.uri != origin.origin
        || fields.statement != ADMIN_STATEMENT
        || canonical_message(&fields.siwe_fields(), address) != body.message
    {
        return Err(Refusal::Denied("bad_message"));
    }
    match siwe::verify_signer(s, address, &body.message, &body.signature).await {
        Ok(()) => Ok(()),
        Err(VerifyError::BadSignature) => Err(Refusal::Denied("bad_signature")),
        Err(VerifyError::Store(e)) => Err(e.into()),
    }
}

/// `DELETE /api/admin/session`: leaves admin mode (audited when it was on)
/// and clears `eg_admin`; the login session stays.
pub async fn session_exit(
    State(s): State<AppState>,
    AdminUser(user): AdminUser,
    meta: ClientMeta,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if admin_session(&s, &headers, &user).await?.is_some() {
        if let Some(raw) = cookie(&headers, ADMIN_COOKIE) {
            s.store.session_delete(raw).await?;
        }
        s.store
            .audit_append(&entry(
                user.address,
                "admin_mode_exit",
                &meta,
                AuditOutcome::Ok,
                None,
            ))
            .await?;
    }
    let clear = set_cookie(ADMIN_COOKIE, "", ADMIN_COOKIE_PATH, 0, s.auth.origin.secure);
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear)]).into_response())
}

// ------------------------------------------------------------- signed actions

/// `POST /api/admin/actions/nonce {action}`: the message to sign for
/// `action`, describing it with its current values.
pub async fn action_nonce(
    State(s): State<AppState>,
    AdminMode(admin): AdminMode,
    ApiJson(req): ApiJson<AdminActionNonceRequestDto>,
) -> Result<Json<AdminActionNonceDto>, ApiError> {
    let action = Action::parse(&req.action)?;
    let (nonce, message) = actions::issue(&s, admin.id, &action).await?;
    Ok(Json(AdminActionNonceDto { nonce, message }))
}

/// `POST /api/admin/actions {action, nonce, signature}`: runs the action if
/// the nonce is fresh, unused and this admin's, the action is the one it was
/// issued for, the admin signed its message, and the values it describes
/// are still current. Every attempt is audited under the action's name.
pub async fn action_run(
    State(s): State<AppState>,
    AdminMode(admin): AdminMode,
    meta: ClientMeta,
    ApiJson(req): ApiJson<AdminActionRequestDto>,
) -> Result<Json<AdminActionResultDto>, ApiError> {
    let action = Action::parse(&req.action)?;
    let mut audit = entry(admin.address, action.name(), &meta, AuditOutcome::Ok, None);
    audit.target = action.target();
    match verify_action(&s, &admin, &action, &req, &mut audit).await {
        Ok(()) => {}
        Err(Refusal::Denied(r)) => {
            audit.outcome = AuditOutcome::Denied;
            audit.after = Some(serde_json::json!({ "reason": r }));
            s.store.audit_append(&audit).await?;
            return Err(ApiError::unauthorized(r));
        }
        Err(Refusal::Internal(e)) => {
            audit_failed(&s, audit).await;
            return Err(e);
        }
    }
    // The change and its `ok` row are committed together; on any error the
    // transaction rolls back and the attempt is recorded as `failed`.
    let done = async {
        let mut tx = s.store.begin().await?;
        let done = action.execute(&s, &mut tx, admin.address).await?;
        let mut ok = audit.clone();
        ok.before = done.before.clone();
        ok.after = done.after.clone();
        tx.audit_append(&ok).await?;
        tx.commit().await?;
        Ok::<_, ApiError>(done)
    }
    .await;
    match done {
        Ok(done) => {
            if done.refresh_limits
                && let Err(e) = refresh_user_limits(&s).await
            {
                // Stored and audited; the periodic refresh applies it.
                tracing::warn!(error = %e, "applying changed quota limits to the rate gate failed");
            }
            Ok(Json(AdminActionResultDto {
                before: done.before,
                after: done.after,
                rows: done
                    .rows
                    .map(|rows| rows.iter().map(AuditRowDto::from).collect()),
            }))
        }
        Err(e) => {
            audit.after = Some(serde_json::json!({ "error": e.message }));
            audit_failed(&s, audit).await;
            Err(e)
        }
    }
}

async fn verify_action(
    s: &AppState,
    admin: &CurrentUser,
    action: &Action,
    req: &AdminActionRequestDto,
    audit: &mut AuditEntry,
) -> Result<(), Refusal> {
    let Some(taken) = actions::take(s, &req.nonce).await? else {
        return Err(Refusal::Denied("bad_nonce"));
    };
    if taken.user_id != Some(admin.id) {
        return Err(Refusal::Denied("bad_nonce"));
    }
    signed(audit, &taken.message, &req.signature);
    if taken.payload_hash.as_deref() != Some(action.payload_hash().as_slice()) {
        return Err(Refusal::Denied("payload_mismatch"));
    }
    match siwe::verify_signer(s, admin.address, &taken.message, &req.signature).await {
        Ok(()) => {}
        Err(VerifyError::BadSignature) => return Err(Refusal::Denied("bad_signature")),
        Err(VerifyError::Store(e)) => return Err(e.into()),
    }
    // The values the admin saw ("from 1000 to 5000") must still hold.
    if action.describe(s).await? != taken.line {
        return Err(Refusal::Denied("stale_action"));
    }
    Ok(())
}

// ----------------------------------------------------------------------- reads

/// `GET /api/admin/overview`.
pub async fn overview(
    State(s): State<AppState>,
    AdminMode(_): AdminMode,
) -> Result<Json<AdminOverviewDto>, ApiError> {
    let server = *s.gate.subscribe_quota().borrow();
    Ok(Json(AdminOverviewDto {
        open_registration: open_registration(&s).await?,
        default_quota: default_user_limit(&s.store, &s.cfg).await?,
        server_used: server.used,
        server_limit: server.limit,
        reset_at: rfc3339(next_utc_midnight(Utc::now())),
    }))
}

/// `GET /api/admin/users`: every user with today's usage (the rate gate's
/// live figures), quota and number of jobs waiting for quota.
pub async fn users(
    State(s): State<AppState>,
    AdminMode(_): AdminMode,
) -> Result<Json<Vec<AdminUserDto>>, ApiError> {
    let rows = s.store.users_with_usage(Utc::now().date_naive()).await?;
    let waiting = s.store.user_waiting_job_counts().await?;
    let users = rows
        .into_iter()
        .map(|r| {
            let u = r.user;
            let q = s.gate.user_quota(u.id);
            AdminUserDto {
                address: hex_addr(u.address),
                is_admin: s.auth.is_admin(u.address),
                created_at: rfc3339(u.created_at),
                last_login_at: u.last_login_at.map(rfc3339),
                used_today: q.used,
                quota_limit: q.limit,
                quota_override: u.daily_quota,
                waiting_jobs: waiting.get(&u.id).copied().unwrap_or(0),
            }
        })
        .collect();
    Ok(Json(users))
}

/// `GET /api/admin/whitelist`: oldest first.
pub async fn whitelist(
    State(s): State<AppState>,
    AdminMode(_): AdminMode,
) -> Result<Json<Vec<WhitelistEntryDto>>, ApiError> {
    let rows = s.store.whitelist_list().await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| WhitelistEntryDto {
                address: hex_addr(r.address),
                added_by: r.added_by,
                added_at: rfc3339_micros(r.added_at),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct AuditQuery {
    actor: Option<String>,
    action: Option<String>,
    from: Option<String>,
    to: Option<String>,
    cursor: Option<i64>,
}

fn query_time(t: Option<&str>) -> Result<Option<DateTime<Utc>>, ApiError> {
    t.map(|t| {
        DateTime::parse_from_rfc3339(t)
            .map(|t| t.with_timezone(&Utc))
            .map_err(|e| invalid(format!("invalid time {t:?}: {e}")))
    })
    .transpose()
}

/// `GET /api/admin/audit?actor&action&from&to&cursor`: newest first,
/// [`AUDIT_PAGE`] rows a page. `actor` matches case-insensitively.
pub async fn audit(
    State(s): State<AppState>,
    AdminMode(_): AdminMode,
    ApiQuery(q): ApiQuery<AuditQuery>,
) -> Result<Json<AuditPageDto>, ApiError> {
    let filter = AuditFilter {
        actor: q.actor.map(|a| a.to_lowercase()),
        action: q.action,
        from: query_time(q.from.as_deref())?,
        to: query_time(q.to.as_deref())?,
    };
    let rows = s.store.audit_page(&filter, q.cursor, AUDIT_PAGE).await?;
    let next_cursor = (rows.len() == AUDIT_PAGE as usize)
        .then(|| rows.last().map(|r| r.id))
        .flatten();
    Ok(Json(AuditPageDto {
        rows: rows.iter().map(AuditRowDto::from).collect(),
        next_cursor,
    }))
}

/// Any other `/api/admin/*` path: missing for everyone, and audited for
/// non-admins (by [`AdminUser`]).
pub async fn not_found(AdminUser(_): AdminUser) -> ApiError {
    ApiError::not_found("no such API route")
}
