//! Signed admin actions (spec §8): the server describes each action in a
//! human-readable line with its concrete values, the admin signs that text
//! with a single-use nonce, and the nonce row keeps the SHA-256 of the
//! action's canonical JSON so that the executed action is exactly the
//! signed one.

use alloy_primitives::Address;
use chrono::{DateTime, Utc};
use eg_store::{
    AuditFilter, AuditRow, NoncePurpose, SETTING_DEFAULT_DAILY_QUOTA, SETTING_OPEN_REGISTRATION,
    StoreError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::auth::open_registration;
use crate::auth::siwe::MESSAGE_TTL;
use crate::background::{default_user_limit, refresh_user_limits};
use crate::dto::{AdminAction, hex_addr, rfc3339};
use crate::error::{ApiError, invalid};
use crate::parse::parse_address;
use crate::state::AppState;

/// Most audit rows one export returns (newest first).
pub const MAX_EXPORT_ROWS: usize = 100_000;
const EXPORT_PAGE: u32 = 1000;

/// An [`AdminAction`] with validated values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    WhitelistAdd(Address),
    WhitelistRemove(Address),
    SetOpenRegistration(bool),
    SetDefaultQuota(i32),
    SetUserQuota(Address, Option<i32>),
    RevokeSessions(Address),
    ExportAudit(Option<DateTime<Utc>>, Option<DateTime<Utc>>),
}

/// What the nonce row stores besides the payload hash: the signed text
/// except the nonce.
#[derive(Serialize, Deserialize)]
struct Issued {
    line: String,
    issued_at: String,
}

/// What an executed action changed, for the response and its audit row.
#[derive(Debug, Default)]
pub struct Executed {
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub rows: Option<Vec<AuditRow>>,
}

fn quota(calls: i32) -> Result<i32, ApiError> {
    if calls < 0 {
        return Err(invalid(format!("calls must be at least 0, got {calls}")));
    }
    Ok(calls)
}

fn time(s: &Option<String>) -> Result<Option<DateTime<Utc>>, ApiError> {
    s.as_deref()
        .map(|t| {
            DateTime::parse_from_rfc3339(t)
                .map(|t| t.with_timezone(&Utc))
                .map_err(|e| invalid(format!("invalid time {t:?}: {e}")))
        })
        .transpose()
}

impl Action {
    pub fn parse(a: &AdminAction) -> Result<Self, ApiError> {
        Ok(match a {
            AdminAction::WhitelistAdd { address } => Self::WhitelistAdd(parse_address(address)?),
            AdminAction::WhitelistRemove { address } => {
                Self::WhitelistRemove(parse_address(address)?)
            }
            AdminAction::SetOpenRegistration { open } => Self::SetOpenRegistration(*open),
            AdminAction::SetDefaultQuota { calls } => Self::SetDefaultQuota(quota(*calls)?),
            AdminAction::SetUserQuota { address, calls } => {
                Self::SetUserQuota(parse_address(address)?, calls.map(quota).transpose()?)
            }
            AdminAction::RevokeSessions { address } => {
                Self::RevokeSessions(parse_address(address)?)
            }
            AdminAction::ExportAudit { from, to } => Self::ExportAudit(time(from)?, time(to)?),
        })
    }

    /// The action's audit-log name.
    pub fn name(&self) -> &'static str {
        match self {
            Self::WhitelistAdd(_) => "whitelist_add",
            Self::WhitelistRemove(_) => "whitelist_remove",
            Self::SetOpenRegistration(_) => "set_open_registration",
            Self::SetDefaultQuota(_) => "set_default_quota",
            Self::SetUserQuota(..) => "set_user_quota",
            Self::RevokeSessions(_) => "revoke_sessions",
            Self::ExportAudit(..) => "export_audit",
        }
    }

    /// The address acted on, for the audit row.
    pub fn target(&self) -> Option<String> {
        match self {
            Self::WhitelistAdd(a)
            | Self::WhitelistRemove(a)
            | Self::SetUserQuota(a, _)
            | Self::RevokeSessions(a) => Some(hex_addr(*a)),
            _ => None,
        }
    }

    /// The canonical form: lower-case addresses, millisecond UTC times.
    fn canonical(&self) -> AdminAction {
        let t = |t: &Option<DateTime<Utc>>| t.map(rfc3339);
        match self {
            Self::WhitelistAdd(a) => AdminAction::WhitelistAdd {
                address: hex_addr(*a),
            },
            Self::WhitelistRemove(a) => AdminAction::WhitelistRemove {
                address: hex_addr(*a),
            },
            Self::SetOpenRegistration(open) => AdminAction::SetOpenRegistration { open: *open },
            Self::SetDefaultQuota(calls) => AdminAction::SetDefaultQuota { calls: *calls },
            Self::SetUserQuota(a, calls) => AdminAction::SetUserQuota {
                address: hex_addr(*a),
                calls: *calls,
            },
            Self::RevokeSessions(a) => AdminAction::RevokeSessions {
                address: hex_addr(*a),
            },
            Self::ExportAudit(from, to) => AdminAction::ExportAudit {
                from: t(from),
                to: t(to),
            },
        }
    }

    /// SHA-256 of the canonical form's JSON.
    pub fn payload_hash(&self) -> Vec<u8> {
        let json = serde_json::to_vec(&self.canonical()).expect("actions serialize");
        Sha256::digest(json).to_vec()
    }

    /// The line the admin signs, with the action's concrete values read now
    /// (e.g. the quota being replaced). 404 for a user who never logged in.
    pub async fn describe(&self, s: &AppState) -> Result<String, ApiError> {
        let addr = |a: &Address| a.to_checksum(None);
        Ok(match self {
            Self::WhitelistAdd(a) => format!("Add {} to the whitelist", addr(a)),
            Self::WhitelistRemove(a) => format!(
                "Remove {} from the whitelist and end all of its sessions",
                addr(a)
            ),
            Self::SetOpenRegistration(true) => "Turn open registration on".into(),
            Self::SetOpenRegistration(false) => "Turn open registration off".into(),
            Self::SetDefaultQuota(calls) => format!(
                "Set the default daily quota from {} to {calls}",
                default_user_limit(&s.store, &s.cfg).await?
            ),
            Self::SetUserQuota(a, calls) => {
                let user = known_user(s, *a).await?;
                let default = default_user_limit(&s.store, &s.cfg).await?;
                let show = |q: Option<i32>| {
                    q.map_or_else(|| format!("the default ({default})"), |n| n.to_string())
                };
                format!(
                    "Set the daily quota of {} from {} to {}",
                    addr(a),
                    show(user.daily_quota),
                    show(*calls)
                )
            }
            Self::RevokeSessions(a) => {
                known_user(s, *a).await?;
                format!("End all sessions of {}", addr(a))
            }
            Self::ExportAudit(from, to) => format!(
                "Export the audit log from {} to {}",
                from.map_or_else(|| "the beginning".to_owned(), rfc3339),
                to.map_or_else(|| "now".to_owned(), rfc3339)
            ),
        })
    }

    /// Carries the action out; `admin` is recorded where it adds a row.
    /// Quota changes are written to the store first, then reach the rate
    /// gate at once.
    pub async fn execute(&self, s: &AppState, admin: Address) -> Result<Executed, ApiError> {
        let store = &s.store;
        Ok(match self {
            Self::WhitelistAdd(a) => {
                let added = store.whitelist_add(*a, &hex_addr(admin)).await?;
                Executed {
                    before: Some(json!({ "listed": !added })),
                    after: Some(json!({ "listed": true })),
                    rows: None,
                }
            }
            Self::WhitelistRemove(a) => {
                let listed = store.whitelist_remove(*a).await?;
                let revoked = match store.user_by_address(*a).await? {
                    Some(u) => store.sessions_revoke_user(u.id).await?,
                    None => 0,
                };
                Executed {
                    before: Some(json!({ "listed": listed })),
                    after: Some(json!({ "listed": false, "sessions_revoked": revoked })),
                    rows: None,
                }
            }
            Self::SetOpenRegistration(open) => {
                let before = open_registration(s).await?;
                store
                    .setting_set(SETTING_OPEN_REGISTRATION, &json!(open))
                    .await?;
                Executed {
                    before: Some(json!({ "open": before })),
                    after: Some(json!({ "open": open })),
                    rows: None,
                }
            }
            Self::SetDefaultQuota(calls) => {
                let before = default_user_limit(store, &s.cfg).await?;
                store
                    .setting_set(SETTING_DEFAULT_DAILY_QUOTA, &json!(calls))
                    .await?;
                refresh_user_limits(s).await?;
                Executed {
                    before: Some(json!({ "calls": before })),
                    after: Some(json!({ "calls": calls })),
                    rows: None,
                }
            }
            Self::SetUserQuota(a, calls) => {
                let user = known_user(s, *a).await?;
                let before = json!({
                    "calls": user.daily_quota,
                    "effective": s.gate.user_quota(user.id).limit,
                });
                store.set_user_quota(user.id, *calls).await?;
                refresh_user_limits(s).await?;
                Executed {
                    before: Some(before),
                    after: Some(json!({
                        "calls": calls,
                        "effective": s.gate.user_quota(user.id).limit,
                    })),
                    rows: None,
                }
            }
            Self::RevokeSessions(a) => {
                let user = known_user(s, *a).await?;
                let revoked = store.sessions_revoke_user(user.id).await?;
                Executed {
                    before: None,
                    after: Some(json!({ "sessions_revoked": revoked })),
                    rows: None,
                }
            }
            Self::ExportAudit(from, to) => {
                let (rows, truncated) = export(s, *from, *to).await?;
                Executed {
                    before: None,
                    after: Some(json!({
                        "from": from.map(rfc3339),
                        "to": to.map(rfc3339),
                        "rows": rows.len(),
                        "truncated": truncated,
                    })),
                    rows: Some(rows),
                }
            }
        })
    }
}

async fn known_user(s: &AppState, a: Address) -> Result<eg_store::UserRow, ApiError> {
    s.store
        .user_by_address(a)
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no user {}", hex_addr(a))))
}

/// Every audit row between `from` and `to`, newest first, up to
/// [`MAX_EXPORT_ROWS`]; true when rows were left out.
async fn export(
    s: &AppState,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Result<(Vec<AuditRow>, bool), StoreError> {
    let filter = AuditFilter {
        from,
        to,
        ..AuditFilter::default()
    };
    let mut rows: Vec<AuditRow> = Vec::new();
    loop {
        let cursor = rows.last().map(|r| r.id);
        let page = s.store.audit_page(&filter, cursor, EXPORT_PAGE).await?;
        let last = page.len() < EXPORT_PAGE as usize;
        rows.extend(page);
        if rows.len() > MAX_EXPORT_ROWS {
            rows.truncate(MAX_EXPORT_ROWS);
            return Ok((rows, true));
        }
        if last {
            return Ok((rows, false));
        }
    }
}

/// The signed text: the description, then the nonce and issue time.
pub fn message(line: &str, nonce: &str, issued_at: &str) -> String {
    format!("{line}\n\nNonce: {nonce}\nIssued At: {issued_at}")
}

/// Issues a nonce for `action` to admin `user_id` and returns it with the
/// message to sign (valid for five minutes).
pub async fn issue(
    s: &AppState,
    user_id: i64,
    action: &Action,
) -> Result<(String, String), ApiError> {
    let issued = Issued {
        line: action.describe(s).await?,
        issued_at: rfc3339(Utc::now()),
    };
    let fields = serde_json::to_value(&issued).expect("fields serialize");
    let nonce = s
        .store
        .nonce_issue(
            NoncePurpose::Action,
            Some(user_id),
            &fields,
            Some(&action.payload_hash()),
            MESSAGE_TTL,
        )
        .await?;
    let text = message(&issued.line, &nonce, &issued.issued_at);
    Ok((nonce, text))
}

/// A taken action nonce: whom it was issued to, the hash of the action it
/// was issued for, and the line and full message signed.
pub struct Taken {
    pub user_id: Option<i64>,
    pub payload_hash: Option<Vec<u8>>,
    pub line: String,
    pub message: String,
}

/// Consumes `nonce` (purpose `action`, unexpired, unused).
pub async fn take(s: &AppState, nonce: &str) -> Result<Option<Taken>, StoreError> {
    let Some(row) = s.store.nonce_take(nonce, NoncePurpose::Action).await? else {
        return Ok(None);
    };
    let issued: Issued = serde_json::from_value(row.fields)
        .map_err(|e| StoreError::Invalid(format!("action nonce fields: {e}")))?;
    Ok(Some(Taken {
        user_id: row.user_id,
        payload_hash: row.payload_hash,
        message: message(&issued.line, &row.nonce, &issued.issued_at),
        line: issued.line,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_hash_ignores_address_case_and_time_spelling() {
        let a = Address::repeat_byte(0xab);
        let lower = AdminAction::SetUserQuota {
            address: hex_addr(a),
            calls: Some(5),
        };
        let checksummed = AdminAction::SetUserQuota {
            address: a.to_checksum(None),
            calls: Some(5),
        };
        let hash = |x: &AdminAction| Action::parse(x).unwrap().payload_hash();
        assert_eq!(hash(&lower), hash(&checksummed));
        let other = AdminAction::SetUserQuota {
            address: hex_addr(a),
            calls: Some(6),
        };
        assert_ne!(hash(&lower), hash(&other));
        let export = |from: &str| AdminAction::ExportAudit {
            from: Some(from.into()),
            to: None,
        };
        assert_eq!(
            hash(&export("2026-10-19T00:00:00Z")),
            hash(&export("2026-10-19T02:00:00.000+02:00"))
        );
    }

    #[test]
    fn invalid_actions_do_not_parse() {
        for bad in [
            AdminAction::WhitelistAdd {
                address: "0x12".into(),
            },
            AdminAction::SetDefaultQuota { calls: -1 },
            AdminAction::SetUserQuota {
                address: hex_addr(Address::ZERO),
                calls: Some(-1),
            },
            AdminAction::ExportAudit {
                from: None,
                to: Some("tomorrow".into()),
            },
        ] {
            assert!(Action::parse(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn message_layout() {
        assert_eq!(
            message(
                "Turn open registration on",
                "abc",
                "2026-10-19T12:00:00.000Z"
            ),
            "Turn open registration on\n\nNonce: abc\nIssued At: 2026-10-19T12:00:00.000Z"
        );
    }
}
