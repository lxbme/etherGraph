use chrono::NaiveDate;

use crate::{Result, Store, StoreError};

impl Store {
    /// Calls recorded for `day`; 0 when no row exists.
    pub async fn quota_get(&self, day: NaiveDate) -> Result<u32> {
        let v: Option<i32> = sqlx::query_scalar("SELECT calls FROM quota_usage WHERE day = $1")
            .bind(day)
            .fetch_optional(&self.pool)
            .await?;
        v.map_or(Ok(0), |v| {
            u32::try_from(v).map_err(|_| StoreError::Invalid(format!("negative quota {v}")))
        })
    }

    pub async fn quota_set(&self, day: NaiveDate, calls: u32) -> Result<()> {
        let calls = i32::try_from(calls)
            .map_err(|_| StoreError::Invalid(format!("quota {calls} exceeds i32")))?;
        sqlx::query(
            "INSERT INTO quota_usage (day, calls) VALUES ($1, $2) \
             ON CONFLICT (day) DO UPDATE SET calls = EXCLUDED.calls",
        )
        .bind(day)
        .bind(calls)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::Store;
    use chrono::NaiveDate;
    use sqlx::PgPool;

    #[sqlx::test]
    async fn quota_roundtrip(pool: PgPool) {
        let s = Store::from_pool(pool);
        let d = NaiveDate::from_ymd_opt(2026, 10, 17).unwrap();
        assert_eq!(s.quota_get(d).await.unwrap(), 0);
        s.quota_set(d, 42).await.unwrap();
        assert_eq!(s.quota_get(d).await.unwrap(), 42);
        s.quota_set(d, 100_000).await.unwrap();
        assert_eq!(s.quota_get(d).await.unwrap(), 100_000);
        let other = NaiveDate::from_ymd_opt(2026, 10, 18).unwrap();
        assert_eq!(s.quota_get(other).await.unwrap(), 0);
    }
}
