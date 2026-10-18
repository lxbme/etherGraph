//! Admin-editable settings stored as JSON values.
use sqlx::Postgres;

use crate::{Result, Store};

/// `bool`; seeded `false` by the migration.
pub const SETTING_OPEN_REGISTRATION: &str = "open_registration";
/// Integer calls per user per day; absent until an admin sets it, the
/// configured default applies.
pub const SETTING_DEFAULT_DAILY_QUOTA: &str = "default_daily_quota";

pub(crate) async fn setting_get<'c>(
    db: impl sqlx::Executor<'c, Database = Postgres>,
    key: &str,
) -> Result<Option<serde_json::Value>> {
    Ok(
        sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(key)
            .fetch_optional(db)
            .await?,
    )
}

pub(crate) async fn setting_set<'c>(
    db: impl sqlx::Executor<'c, Database = Postgres>,
    key: &str,
    value: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(key)
    .bind(value)
    .execute(db)
    .await?;
    Ok(())
}

impl Store {
    pub async fn setting_get(&self, key: &str) -> Result<Option<serde_json::Value>> {
        setting_get(&self.pool, key).await
    }

    pub async fn setting_set(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        setting_set(&self.pool, key, value).await
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;
    use sqlx::PgPool;

    #[sqlx::test]
    async fn settings_roundtrip(pool: PgPool) {
        let s = Store::from_pool(pool);
        // Seeded by the migration.
        assert_eq!(
            s.setting_get(SETTING_OPEN_REGISTRATION).await.unwrap(),
            Some(json!(false))
        );
        // Falls back to the configured default until an admin sets it.
        assert_eq!(
            s.setting_get(SETTING_DEFAULT_DAILY_QUOTA).await.unwrap(),
            None
        );
        s.setting_set(SETTING_DEFAULT_DAILY_QUOTA, &json!(7000))
            .await
            .unwrap();
        s.setting_set(SETTING_OPEN_REGISTRATION, &json!(true))
            .await
            .unwrap();
        assert_eq!(
            s.setting_get(SETTING_DEFAULT_DAILY_QUOTA).await.unwrap(),
            Some(json!(7000))
        );
        assert_eq!(
            s.setting_get(SETTING_OPEN_REGISTRATION).await.unwrap(),
            Some(json!(true))
        );
    }
}
