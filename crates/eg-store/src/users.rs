//! Users, the whitelist, per-user quota usage and adopting pre-auth data.
use chrono::{DateTime, NaiveDate, Utc};
use eg_core::types::Address;
use sqlx::Row;
use sqlx::postgres::PgRow;

use crate::convert::{addr_to_bytes, bytes_to_addr};
use crate::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserRow {
    pub id: i64,
    pub address: Address,
    pub created_at: DateTime<Utc>,
    /// `None` for a user created without logging in (e.g. an adopting admin).
    pub last_login_at: Option<DateTime<Utc>>,
    /// `None`: the default daily quota applies.
    pub daily_quota: Option<i32>,
}

/// A user and their Etherscan calls on one day.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserUsageRow {
    pub user: UserRow,
    pub calls: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WhitelistRow {
    pub address: Address,
    pub added_by: String,
    pub added_at: DateTime<Utc>,
}

macro_rules! user_cols {
    () => {
        "users.id, users.address, users.created_at, users.last_login_at, users.daily_quota"
    };
}
pub(crate) use user_cols;

pub(crate) fn user_row(r: &PgRow) -> Result<UserRow> {
    Ok(UserRow {
        id: r.try_get("id")?,
        address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
        created_at: r.try_get("created_at")?,
        last_login_at: r.try_get("last_login_at")?,
        daily_quota: r.try_get("daily_quota")?,
    })
}

fn calls_u32(v: i32) -> Result<u32> {
    u32::try_from(v).map_err(|_| StoreError::Invalid(format!("negative call count {v}")))
}

impl Store {
    /// Creates the user on first login, or stamps `last_login_at` on an existing one.
    pub async fn upsert_user_on_login(&self, addr: Address) -> Result<UserRow> {
        let sql = concat!(
            "INSERT INTO users (address, last_login_at) VALUES ($1, now()) \
             ON CONFLICT (address) DO UPDATE SET last_login_at = now() RETURNING ",
            user_cols!()
        );
        let r = sqlx::query(sql)
            .bind(addr_to_bytes(addr))
            .fetch_one(&self.pool)
            .await?;
        user_row(&r)
    }

    pub async fn user_by_id(&self, id: i64) -> Result<Option<UserRow>> {
        let sql = concat!("SELECT ", user_cols!(), " FROM users WHERE id = $1");
        let r = sqlx::query(sql).bind(id).fetch_optional(&self.pool).await?;
        r.as_ref().map(user_row).transpose()
    }

    /// Every user with their calls on `day` (0 without a usage row), by id.
    pub async fn users_with_usage(&self, day: NaiveDate) -> Result<Vec<UserUsageRow>> {
        let sql = concat!(
            "SELECT ",
            user_cols!(),
            ", COALESCE(u.calls, 0) AS calls FROM users \
             LEFT JOIN user_quota_usage u ON u.user_id = users.id AND u.day = $1 \
             ORDER BY users.id"
        );
        let rows = sqlx::query(sql).bind(day).fetch_all(&self.pool).await?;
        rows.iter()
            .map(|r| {
                Ok(UserUsageRow {
                    user: user_row(r)?,
                    calls: calls_u32(r.try_get("calls")?)?,
                })
            })
            .collect()
    }

    /// `None` returns the user to the default quota; `NotFound` for an unknown id.
    pub async fn set_user_quota(&self, id: i64, calls: Option<i32>) -> Result<()> {
        let res = sqlx::query("UPDATE users SET daily_quota = $2 WHERE id = $1")
            .bind(id)
            .bind(calls)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Calls billed to `user_id` on `day`; 0 when no row exists.
    pub async fn user_usage_get(&self, user_id: i64, day: NaiveDate) -> Result<u32> {
        let v: Option<i32> = sqlx::query_scalar(
            "SELECT calls FROM user_quota_usage WHERE user_id = $1 AND day = $2",
        )
        .bind(user_id)
        .bind(day)
        .fetch_optional(&self.pool)
        .await?;
        v.map_or(Ok(0), calls_u32)
    }

    /// Adds `n` calls to `user_id`'s count for `day`; returns the new count.
    pub async fn user_usage_add(&self, user_id: i64, day: NaiveDate, n: u32) -> Result<u32> {
        let n = i32::try_from(n)
            .map_err(|_| StoreError::Invalid(format!("call count {n} exceeds i32")))?;
        let v: i32 = sqlx::query_scalar(
            "INSERT INTO user_quota_usage (user_id, day, calls) VALUES ($1, $2, $3) \
             ON CONFLICT (user_id, day) DO UPDATE \
             SET calls = user_quota_usage.calls + EXCLUDED.calls RETURNING calls",
        )
        .bind(user_id)
        .bind(day)
        .bind(n)
        .fetch_one(&self.pool)
        .await?;
        calls_u32(v)
    }

    /// Returns whether the address was added (false: already listed, unchanged).
    pub async fn whitelist_add(&self, addr: Address, added_by: &str) -> Result<bool> {
        let res = sqlx::query(
            "INSERT INTO whitelist (address, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(addr_to_bytes(addr))
        .bind(added_by)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Returns whether the address was listed.
    pub async fn whitelist_remove(&self, addr: Address) -> Result<bool> {
        let res = sqlx::query("DELETE FROM whitelist WHERE address = $1")
            .bind(addr_to_bytes(addr))
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    /// Oldest first.
    pub async fn whitelist_list(&self) -> Result<Vec<WhitelistRow>> {
        let rows = sqlx::query(
            "SELECT address, added_by, added_at FROM whitelist ORDER BY added_at, address",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok(WhitelistRow {
                    address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
                    added_by: r.try_get("added_by")?,
                    added_at: r.try_get("added_at")?,
                })
            })
            .collect()
    }

    pub async fn whitelist_contains(&self, addr: Address) -> Result<bool> {
        Ok(
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM whitelist WHERE address = $1)")
                .bind(addr_to_bytes(addr))
                .fetch_one(&self.pool)
                .await?,
        )
    }

    /// Gives user labels and workspaces created before accounts existed (no
    /// owner) to `admin`, creating that user if needed; imported labels stay
    /// unowned. Returns `(labels, workspaces)` adopted.
    pub async fn adopt_orphans(&self, admin: Address) -> Result<(u64, u64)> {
        let mut tx = self.pool.begin().await?;
        // The no-op update makes RETURNING yield the existing row's id too.
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO users (address) VALUES ($1) \
             ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address RETURNING id",
        )
        .bind(addr_to_bytes(admin))
        .fetch_one(&mut *tx)
        .await?;
        let labels = sqlx::query(
            "UPDATE labels SET owner_id = $1 WHERE source = 'user' AND owner_id IS NULL",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let workspaces = sqlx::query("UPDATE workspaces SET owner_id = $1 WHERE owner_id IS NULL")
            .bind(id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        tx.commit().await?;
        Ok((labels, workspaces))
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::NaiveDate;
    use serde_json::json;
    use sqlx::PgPool;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, d).unwrap()
    }

    #[sqlx::test]
    async fn upsert_user_on_login_keeps_id_and_stamps_login(pool: PgPool) {
        let s = Store::from_pool(pool);
        let a = Address::repeat_byte(1);
        let first = s.upsert_user_on_login(a).await.unwrap();
        assert_eq!(first.address, a);
        assert_eq!(first.daily_quota, None);
        let first_login = first.last_login_at.unwrap();
        let again = s.upsert_user_on_login(a).await.unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.created_at, first.created_at);
        assert!(again.last_login_at.unwrap() >= first_login);
        assert_eq!(s.user_by_id(first.id).await.unwrap(), Some(again));
        assert_eq!(s.user_by_id(9999).await.unwrap(), None);
    }

    #[sqlx::test]
    async fn user_quota_and_usage(pool: PgPool) {
        let s = Store::from_pool(pool);
        let a = s
            .upsert_user_on_login(Address::repeat_byte(1))
            .await
            .unwrap();
        let b = s
            .upsert_user_on_login(Address::repeat_byte(2))
            .await
            .unwrap();
        s.set_user_quota(a.id, Some(300)).await.unwrap();
        assert_eq!(
            s.user_by_id(a.id).await.unwrap().unwrap().daily_quota,
            Some(300)
        );
        s.set_user_quota(a.id, None).await.unwrap();
        assert_eq!(s.user_by_id(a.id).await.unwrap().unwrap().daily_quota, None);
        assert!(matches!(
            s.set_user_quota(9999, Some(1)).await,
            Err(StoreError::NotFound)
        ));

        assert_eq!(s.user_usage_get(a.id, day(19)).await.unwrap(), 0);
        assert_eq!(s.user_usage_add(a.id, day(19), 3).await.unwrap(), 3);
        assert_eq!(s.user_usage_add(a.id, day(19), 2).await.unwrap(), 5);
        assert_eq!(s.user_usage_add(a.id, day(20), 1).await.unwrap(), 1);
        assert_eq!(s.user_usage_get(a.id, day(19)).await.unwrap(), 5);
        assert_eq!(s.user_usage_get(b.id, day(19)).await.unwrap(), 0);

        let rows = s.users_with_usage(day(19)).await.unwrap();
        let got: Vec<(i64, u32)> = rows.iter().map(|r| (r.user.id, r.calls)).collect();
        assert_eq!(got, [(a.id, 5), (b.id, 0)]);
    }

    #[sqlx::test]
    async fn whitelist_add_remove_list(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (a, b) = (Address::repeat_byte(1), Address::repeat_byte(2));
        assert!(!s.whitelist_contains(a).await.unwrap());
        assert!(s.whitelist_add(a, "0xadmin").await.unwrap());
        assert!(!s.whitelist_add(a, "someone-else").await.unwrap());
        assert!(s.whitelist_add(b, "open-registration").await.unwrap());
        assert!(s.whitelist_contains(a).await.unwrap());
        let list = s.whitelist_list().await.unwrap();
        let got: Vec<(Address, &str)> = list
            .iter()
            .map(|w| (w.address, w.added_by.as_str()))
            .collect();
        assert_eq!(got, [(a, "0xadmin"), (b, "open-registration")]);
        assert!(s.whitelist_remove(a).await.unwrap());
        assert!(!s.whitelist_remove(a).await.unwrap());
        assert!(!s.whitelist_contains(a).await.unwrap());
    }

    #[sqlx::test]
    async fn adopt_orphans_assigns_user_data_to_the_admin(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (x, y) = (Address::repeat_byte(0xa), Address::repeat_byte(0xb));
        s.replace_import("d", &[(x, "Binance".into(), "cex".into())])
            .await
            .unwrap();
        s.add_user_label(x, "mine", "other").await.unwrap();
        s.add_user_label(y, "also mine", "other").await.unwrap();
        s.create_workspace("w1", 1, &json!({})).await.unwrap();
        s.create_workspace("w2", 1, &json!({})).await.unwrap();
        let other = s
            .upsert_user_on_login(Address::repeat_byte(2))
            .await
            .unwrap();
        let owned = s.create_workspace("theirs", 1, &json!({})).await.unwrap();
        sqlx::query("UPDATE workspaces SET owner_id = $1 WHERE id = $2")
            .bind(other.id)
            .bind(owned.id)
            .execute(s.pool())
            .await
            .unwrap();

        let admin = Address::repeat_byte(1);
        assert_eq!(s.adopt_orphans(admin).await.unwrap(), (2, 2));
        let admin_id: i64 = sqlx::query_scalar("SELECT id FROM users WHERE address = $1")
            .bind(admin.as_slice())
            .fetch_one(s.pool())
            .await
            .unwrap();
        // Created for the adoption; not a login.
        assert_eq!(
            s.user_by_id(admin_id).await.unwrap().unwrap().last_login_at,
            None
        );
        let labels: Vec<(String, Option<i64>)> =
            sqlx::query_as("SELECT source, owner_id FROM labels ORDER BY id")
                .fetch_all(s.pool())
                .await
                .unwrap();
        assert_eq!(
            labels,
            [
                ("import:d".to_string(), None),
                ("user".to_string(), Some(admin_id)),
                ("user".to_string(), Some(admin_id)),
            ]
        );
        let ws: Vec<(String, Option<i64>)> =
            sqlx::query_as("SELECT name, owner_id FROM workspaces ORDER BY id")
                .fetch_all(s.pool())
                .await
                .unwrap();
        assert_eq!(
            ws,
            [
                ("w1".to_string(), Some(admin_id)),
                ("w2".to_string(), Some(admin_id)),
                ("theirs".to_string(), Some(other.id)),
            ]
        );
        // Nothing left to adopt; the existing admin row is reused.
        assert_eq!(s.adopt_orphans(admin).await.unwrap(), (0, 0));
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
            .fetch_one(s.pool())
            .await
            .unwrap();
        assert_eq!(n, 2);
    }
}
