//! Login sessions and single-use signing nonces.
//!
//! A session token is 32 random bytes handed to the client hex-encoded; only
//! its SHA-256 is stored, so a database read does not yield usable cookies.
use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::Row;
use sqlx::postgres::PgRow;

use crate::users::{UserRow, user_cols, user_row};
use crate::{Result, Store, StoreError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionKind {
    /// The `eg_session` login session.
    User,
    /// The short-lived `eg_admin` admin-mode session.
    Admin,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::User => "user",
            SessionKind::Admin => "admin",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "user" => SessionKind::User,
            "admin" => SessionKind::Admin,
            _ => return Err(StoreError::Invalid(format!("unknown session kind {s}"))),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRow {
    pub user_id: i64,
    pub kind: SessionKind,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoncePurpose {
    Login,
    /// Entering admin mode.
    Admin,
    /// One signed admin action.
    Action,
}

impl NoncePurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            NoncePurpose::Login => "login",
            NoncePurpose::Admin => "admin",
            NoncePurpose::Action => "action",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "login" => NoncePurpose::Login,
            "admin" => NoncePurpose::Admin,
            "action" => NoncePurpose::Action,
            _ => return Err(StoreError::Invalid(format!("unknown nonce purpose {s}"))),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NonceRow {
    pub nonce: String,
    pub purpose: NoncePurpose,
    pub user_id: Option<i64>,
    /// The message fields the nonce was issued with.
    pub fields: serde_json::Value,
    /// SHA-256 of the signed admin action's canonical payload.
    pub payload_hash: Option<Vec<u8>>,
    pub expires_at: DateTime<Utc>,
}

const TOKEN_BYTES: usize = 32;

/// SHA-256 of the decoded token; `None` for anything that is not a token we
/// could have issued.
fn token_hash(raw: &str) -> Option<Vec<u8>> {
    let bytes = hex::decode(raw).ok()?;
    (bytes.len() == TOKEN_BYTES).then(|| Sha256::digest(&bytes).to_vec())
}

/// `ttl` as fractional seconds for `make_interval`.
fn secs(ttl: Duration) -> f64 {
    ttl.num_milliseconds() as f64 / 1000.0
}

fn session_row(r: &PgRow) -> Result<SessionRow> {
    Ok(SessionRow {
        user_id: r.try_get("user_id")?,
        kind: SessionKind::parse(r.try_get("kind")?)?,
        created_at: r.try_get("s_created_at")?,
        expires_at: r.try_get("expires_at")?,
        ip: r.try_get("ip")?,
        user_agent: r.try_get("user_agent")?,
    })
}

impl Store {
    /// Stores a new session expiring after `ttl`; returns the raw token (hex),
    /// which is never stored.
    pub async fn session_create(
        &self,
        user_id: i64,
        kind: SessionKind,
        ttl: Duration,
        ip: Option<&str>,
        user_agent: Option<&str>,
    ) -> Result<String> {
        let token: [u8; TOKEN_BYTES] = rand::random();
        sqlx::query(
            "INSERT INTO sessions (token_hash, user_id, kind, expires_at, ip, user_agent) \
             VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6)",
        )
        .bind(Sha256::digest(token).to_vec())
        .bind(user_id)
        .bind(kind.as_str())
        .bind(secs(ttl))
        .bind(ip)
        .bind(user_agent)
        .execute(&self.pool)
        .await?;
        Ok(hex::encode(token))
    }

    /// The live session of `kind` for `raw` and its user; `None` when unknown,
    /// expired, of another kind or malformed.
    pub async fn session_lookup(
        &self,
        raw: &str,
        kind: SessionKind,
    ) -> Result<Option<(SessionRow, UserRow)>> {
        let Some(hash) = token_hash(raw) else {
            return Ok(None);
        };
        let sql = concat!(
            "SELECT s.user_id, s.kind, s.created_at AS s_created_at, s.expires_at, s.ip, \
             s.user_agent, ",
            user_cols!(),
            " FROM sessions s JOIN users ON users.id = s.user_id \
             WHERE s.token_hash = $1 AND s.kind = $2 AND s.expires_at > now()"
        );
        let row = sqlx::query(sql)
            .bind(hash)
            .bind(kind.as_str())
            .fetch_optional(&self.pool)
            .await?;
        row.map(|r| Ok((session_row(&r)?, user_row(&r)?)))
            .transpose()
    }

    /// Returns whether a session was deleted.
    pub async fn session_delete(&self, raw: &str) -> Result<bool> {
        let Some(hash) = token_hash(raw) else {
            return Ok(false);
        };
        let res = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(hash)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Deletes every session (user and admin) of `user_id`; returns how many.
    pub async fn sessions_revoke_user(&self, user_id: i64) -> Result<u64> {
        let res = sqlx::query("DELETE FROM sessions WHERE user_id = $1")
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }

    /// Deletes used or expired nonces and expired sessions; returns
    /// `(nonces, sessions)` deleted. A deleted nonce stays unusable: taking
    /// it finds no row.
    pub async fn purge_expired_auth(&self) -> Result<(u64, u64)> {
        let nonces =
            sqlx::query("DELETE FROM auth_nonces WHERE used_at IS NOT NULL OR expires_at <= now()")
                .execute(&self.pool)
                .await?
                .rows_affected();
        let sessions = sqlx::query("DELETE FROM sessions WHERE expires_at <= now()")
            .execute(&self.pool)
            .await?
            .rows_affected();
        Ok((nonces, sessions))
    }

    /// Stores a fresh random nonce (32 hex characters, valid for `ttl`) with
    /// the message fields and payload hash it is issued for.
    pub async fn nonce_issue(
        &self,
        purpose: NoncePurpose,
        user_id: Option<i64>,
        fields: &serde_json::Value,
        payload_hash: Option<&[u8]>,
        ttl: Duration,
    ) -> Result<String> {
        let nonce = hex::encode(rand::random::<[u8; 16]>());
        sqlx::query(
            "INSERT INTO auth_nonces (nonce, purpose, user_id, fields, payload_hash, expires_at) \
             VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))",
        )
        .bind(&nonce)
        .bind(purpose.as_str())
        .bind(user_id)
        .bind(fields)
        .bind(payload_hash)
        .bind(secs(ttl))
        .execute(&self.pool)
        .await?;
        Ok(nonce)
    }

    /// Consumes `nonce` if it was issued for `purpose`, is unexpired and
    /// unused; a single `UPDATE`, so concurrent takers cannot both succeed.
    pub async fn nonce_take(&self, nonce: &str, purpose: NoncePurpose) -> Result<Option<NonceRow>> {
        let row = sqlx::query(
            "UPDATE auth_nonces SET used_at = now() \
             WHERE nonce = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() \
             RETURNING nonce, purpose, user_id, fields, payload_hash, expires_at",
        )
        .bind(nonce)
        .bind(purpose.as_str())
        .fetch_optional(&self.pool)
        .await?;
        row.map(|r| {
            Ok(NonceRow {
                nonce: r.try_get("nonce")?,
                purpose: NoncePurpose::parse(r.try_get("purpose")?)?,
                user_id: r.try_get("user_id")?,
                fields: r.try_get("fields")?,
                payload_hash: r.try_get("payload_hash")?,
                expires_at: r.try_get("expires_at")?,
            })
        })
        .transpose()
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::Duration;
    use eg_core::types::Address;
    use serde_json::json;
    use sqlx::PgPool;

    async fn user(s: &Store, b: u8) -> UserRow {
        s.upsert_user_on_login(Address::repeat_byte(b))
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn session_lookup_checks_kind_and_expiry(pool: PgPool) {
        let s = Store::from_pool(pool);
        let u = user(&s, 1).await;
        let raw = s
            .session_create(
                u.id,
                SessionKind::User,
                Duration::days(7),
                Some("1.2.3.4"),
                Some("ua"),
            )
            .await
            .unwrap();
        assert_eq!(raw.len(), 64);
        let (sess, owner) = s
            .session_lookup(&raw, SessionKind::User)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner, u);
        assert_eq!(sess.user_id, u.id);
        assert_eq!(sess.kind, SessionKind::User);
        assert_eq!(sess.ip.as_deref(), Some("1.2.3.4"));
        assert_eq!(sess.user_agent.as_deref(), Some("ua"));
        // Wrong kind, unknown and malformed tokens.
        assert!(
            s.session_lookup(&raw, SessionKind::Admin)
                .await
                .unwrap()
                .is_none()
        );
        let other = "00".repeat(32);
        assert!(
            s.session_lookup(&other, SessionKind::User)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            s.session_lookup("not-hex", SessionKind::User)
                .await
                .unwrap()
                .is_none()
        );
        // Only the hash is stored.
        let stored: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM sessions")
            .fetch_one(s.pool())
            .await
            .unwrap();
        assert_eq!(stored.len(), 32);
        assert_ne!(hex::encode(&stored), raw);

        let expired = s
            .session_create(u.id, SessionKind::Admin, Duration::seconds(-1), None, None)
            .await
            .unwrap();
        assert!(
            s.session_lookup(&expired, SessionKind::Admin)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[sqlx::test]
    async fn session_delete_and_revoke(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, b) = (user(&s, 1).await, user(&s, 2).await);
        let ttl = Duration::days(1);
        let a1 = s
            .session_create(a.id, SessionKind::User, ttl, None, None)
            .await
            .unwrap();
        let a2 = s
            .session_create(a.id, SessionKind::Admin, ttl, None, None)
            .await
            .unwrap();
        let b1 = s
            .session_create(b.id, SessionKind::User, ttl, None, None)
            .await
            .unwrap();
        assert_ne!(a1, b1);
        assert!(s.session_delete(&a1).await.unwrap());
        assert!(!s.session_delete(&a1).await.unwrap());
        assert!(!s.session_delete("garbage").await.unwrap());
        assert!(
            s.session_lookup(&a1, SessionKind::User)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            s.session_lookup(&a2, SessionKind::Admin)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(s.sessions_revoke_user(a.id).await.unwrap(), 1);
        assert!(
            s.session_lookup(&a2, SessionKind::Admin)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            s.session_lookup(&b1, SessionKind::User)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[sqlx::test]
    async fn nonce_is_single_use_and_expires(pool: PgPool) {
        let s = Store::from_pool(pool);
        let u = user(&s, 1).await;
        let fields = json!({"domain": "127.0.0.1:8080"});
        let n = s
            .nonce_issue(
                NoncePurpose::Action,
                Some(u.id),
                &fields,
                Some(&[7u8; 32]),
                Duration::minutes(5),
            )
            .await
            .unwrap();
        assert!(
            n.len() >= 8 && n.chars().all(|c| c.is_ascii_alphanumeric()),
            "{n}"
        );
        // Wrong purpose does not consume it.
        assert!(
            s.nonce_take(&n, NoncePurpose::Login)
                .await
                .unwrap()
                .is_none()
        );
        let row = s
            .nonce_take(&n, NoncePurpose::Action)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.nonce, n);
        assert_eq!(row.purpose, NoncePurpose::Action);
        assert_eq!(row.user_id, Some(u.id));
        assert_eq!(row.fields, fields);
        assert_eq!(row.payload_hash.as_deref(), Some(&[7u8; 32][..]));
        assert!(
            s.nonce_take(&n, NoncePurpose::Action)
                .await
                .unwrap()
                .is_none()
        );

        let other = s
            .nonce_issue(
                NoncePurpose::Login,
                None,
                &fields,
                None,
                Duration::minutes(5),
            )
            .await
            .unwrap();
        assert_ne!(other, n);
        let expired = s
            .nonce_issue(
                NoncePurpose::Login,
                None,
                &fields,
                None,
                Duration::seconds(-1),
            )
            .await
            .unwrap();
        assert!(
            s.nonce_take(&expired, NoncePurpose::Login)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            s.nonce_take("unknown", NoncePurpose::Login)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[sqlx::test]
    async fn purge_drops_expired_sessions_and_spent_nonces(pool: PgPool) {
        let s = Store::from_pool(pool);
        let u = user(&s, 1).await;
        let live = s
            .session_create(u.id, SessionKind::User, Duration::days(1), None, None)
            .await
            .unwrap();
        s.session_create(u.id, SessionKind::Admin, Duration::seconds(-1), None, None)
            .await
            .unwrap();
        let issue = |ttl| {
            let s = s.clone();
            async move {
                s.nonce_issue(NoncePurpose::Login, None, &json!({}), None, ttl)
                    .await
                    .unwrap()
            }
        };
        let fresh = issue(Duration::minutes(5)).await;
        let used = issue(Duration::minutes(5)).await;
        issue(Duration::seconds(-1)).await;
        assert!(
            s.nonce_take(&used, NoncePurpose::Login)
                .await
                .unwrap()
                .is_some()
        );

        assert_eq!(s.purge_expired_auth().await.unwrap(), (2, 1));
        assert_eq!(s.purge_expired_auth().await.unwrap(), (0, 0));
        assert!(
            s.session_lookup(&live, SessionKind::User)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            s.nonce_take(&fresh, NoncePurpose::Login)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[sqlx::test]
    async fn concurrent_nonce_take_succeeds_once(pool: PgPool) {
        let s = Store::from_pool(pool);
        let n = s
            .nonce_issue(
                NoncePurpose::Admin,
                None,
                &json!({}),
                None,
                Duration::minutes(5),
            )
            .await
            .unwrap();
        let (x, y) = tokio::join!(
            s.nonce_take(&n, NoncePurpose::Admin),
            s.nonce_take(&n, NoncePurpose::Admin)
        );
        assert_eq!(
            usize::from(x.unwrap().is_some()) + usize::from(y.unwrap().is_some()),
            1
        );
    }
}
