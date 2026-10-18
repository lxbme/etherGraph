//! A store transaction for changes that must be stored together with their
//! audit row: either the change and the row are committed, or neither is.
//! Dropping a [`StoreTx`] without [`StoreTx::commit`] rolls it back.

use eg_core::types::Address;
use sqlx::{Postgres, Transaction};

use crate::audit::{AuditEntry, insert_audit};
use crate::labels::{ImportRow, replace_imports};
use crate::token_tags::{TokenTagRow, replace_token_tags};
use crate::users::UserRow;
use crate::{Result, Store, sessions, settings, users};

pub struct StoreTx {
    tx: Transaction<'static, Postgres>,
}

impl Store {
    pub async fn begin(&self) -> Result<StoreTx> {
        Ok(StoreTx {
            tx: self.pool.begin().await?,
        })
    }
}

impl StoreTx {
    pub async fn commit(self) -> Result<()> {
        Ok(self.tx.commit().await?)
    }

    /// See [`Store::audit_append`].
    pub async fn audit_append(&mut self, e: &AuditEntry) -> Result<i64> {
        insert_audit(&mut *self.tx, e).await
    }

    /// See [`Store::setting_get`].
    pub async fn setting_get(&mut self, key: &str) -> Result<Option<serde_json::Value>> {
        settings::setting_get(&mut *self.tx, key).await
    }

    /// See [`Store::setting_set`].
    pub async fn setting_set(&mut self, key: &str, value: &serde_json::Value) -> Result<()> {
        settings::setting_set(&mut *self.tx, key, value).await
    }

    /// See [`Store::user_by_address`].
    pub async fn user_by_address(&mut self, addr: Address) -> Result<Option<UserRow>> {
        users::user_by_address(&mut *self.tx, addr).await
    }

    /// See [`Store::set_user_quota`].
    pub async fn set_user_quota(&mut self, id: i64, calls: Option<i32>) -> Result<()> {
        users::set_user_quota(&mut *self.tx, id, calls).await
    }

    /// See [`Store::whitelist_add`].
    pub async fn whitelist_add(&mut self, addr: Address, added_by: &str) -> Result<bool> {
        users::whitelist_add(&mut *self.tx, addr, added_by).await
    }

    /// See [`Store::whitelist_remove`].
    pub async fn whitelist_remove(&mut self, addr: Address) -> Result<bool> {
        users::whitelist_remove(&mut *self.tx, addr).await
    }

    /// See [`Store::sessions_revoke_user`].
    pub async fn sessions_revoke_user(&mut self, user_id: i64) -> Result<u64> {
        sessions::sessions_revoke_user(&mut *self.tx, user_id).await
    }

    /// See [`Store::replace_imports`].
    pub async fn replace_imports(&mut self, sets: &[(&str, &[ImportRow])]) -> Result<Vec<u64>> {
        replace_imports(&mut self.tx, sets).await
    }

    /// See [`Store::replace_token_tags`].
    pub async fn replace_token_tags(&mut self, source: &str, rows: &[TokenTagRow]) -> Result<u64> {
        replace_token_tags(&mut self.tx, source, rows).await
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use sqlx::PgPool;

    fn entry() -> AuditEntry {
        AuditEntry {
            actor: "0x01".into(),
            action: "whitelist_remove".into(),
            target: None,
            before: None,
            after: None,
            outcome: AuditOutcome::Ok,
            ip: None,
            user_agent: None,
            message: None,
            signature: None,
        }
    }

    async fn audit_rows(s: &Store) -> usize {
        s.audit_page(&AuditFilter::default(), None, 100)
            .await
            .unwrap()
            .len()
    }

    #[sqlx::test]
    async fn changes_and_their_audit_row_commit_together(pool: PgPool) {
        let s = Store::from_pool(pool);
        let a = Address::repeat_byte(1);
        s.whitelist_add(a, "test").await.unwrap();
        let u = s.upsert_user_on_login(a).await.unwrap();
        let ttl = chrono::Duration::days(1);
        let session = s
            .session_create(u.id, SessionKind::User, ttl, None, None)
            .await
            .unwrap();

        // Dropped without commit: nothing happened.
        let mut tx = s.begin().await.unwrap();
        assert!(tx.whitelist_remove(a).await.unwrap());
        assert_eq!(tx.sessions_revoke_user(u.id).await.unwrap(), 1);
        tx.set_user_quota(u.id, Some(5)).await.unwrap();
        tx.setting_set("open_registration", &serde_json::json!(true))
            .await
            .unwrap();
        tx.audit_append(&entry()).await.unwrap();
        drop(tx);
        assert!(s.whitelist_contains(a).await.unwrap());
        assert!(
            s.session_lookup(&session, SessionKind::User)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(s.user_by_id(u.id).await.unwrap().unwrap().daily_quota, None);
        assert_eq!(
            s.setting_get("open_registration").await.unwrap(),
            Some(serde_json::json!(false))
        );
        assert_eq!(audit_rows(&s).await, 0);

        // Committed: all of it, and reads inside see the writes.
        let mut tx = s.begin().await.unwrap();
        assert!(tx.whitelist_remove(a).await.unwrap());
        assert_eq!(tx.sessions_revoke_user(u.id).await.unwrap(), 1);
        tx.set_user_quota(u.id, Some(5)).await.unwrap();
        assert_eq!(
            tx.user_by_address(a).await.unwrap().unwrap().daily_quota,
            Some(5)
        );
        tx.audit_append(&entry()).await.unwrap();
        tx.commit().await.unwrap();
        assert!(!s.whitelist_contains(a).await.unwrap());
        assert!(
            s.session_lookup(&session, SessionKind::User)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(audit_rows(&s).await, 1);
    }
}
