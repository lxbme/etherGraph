//! User and imported address labels.
use chrono::{DateTime, Utc};
use eg_core::types::Address;
use sqlx::{Postgres, QueryBuilder, Row};

use crate::convert::{addr_to_bytes, bytes_to_addr};
use crate::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabelRow {
    pub id: i64,
    pub address: Address,
    pub text: String,
    pub category: String,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

// 4 bind params per row.
const LABEL_CHUNK: usize = 10_000;

fn label_from_row(r: &sqlx::postgres::PgRow) -> Result<LabelRow> {
    Ok(LabelRow {
        id: r.try_get("id")?,
        address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
        text: r.try_get("text")?,
        category: r.try_get("category")?,
        source: r.try_get("source")?,
        created_at: r.try_get("created_at")?,
    })
}

impl Store {
    /// Inserts a `source = 'user'` label; the caller validates the input.
    pub async fn add_user_label(
        &self,
        addr: Address,
        text: &str,
        category: &str,
    ) -> Result<LabelRow> {
        let r = sqlx::query(
            "INSERT INTO labels (address, text, category, source) VALUES ($1, $2, $3, 'user') \
             RETURNING *",
        )
        .bind(addr_to_bytes(addr))
        .bind(text)
        .bind(category)
        .fetch_one(&self.pool)
        .await?;
        label_from_row(&r)
    }

    /// Only user labels can be deleted; anything else is `NotFound`.
    pub async fn delete_user_label(&self, id: i64) -> Result<()> {
        let res = sqlx::query("DELETE FROM labels WHERE id = $1 AND source = 'user'")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub async fn labels(&self, addrs: &[Address]) -> Result<Vec<LabelRow>> {
        let keys: Vec<Vec<u8>> = addrs.iter().copied().map(addr_to_bytes).collect();
        let rows = sqlx::query("SELECT * FROM labels WHERE address = ANY($1) ORDER BY address, id")
            .bind(keys)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(label_from_row).collect()
    }

    /// Replaces all labels of `import:<dataset>` in one transaction; returns the
    /// number inserted.
    pub async fn replace_import(
        &self,
        dataset: &str,
        rows: &[(Address, String, String)],
    ) -> Result<u64> {
        let source = format!("import:{dataset}");
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM labels WHERE source = $1")
            .bind(&source)
            .execute(&mut *tx)
            .await?;
        let mut inserted = 0;
        for chunk in rows.chunks(LABEL_CHUNK) {
            let mut qb: QueryBuilder<Postgres> =
                QueryBuilder::new("INSERT INTO labels (address, text, category, source) ");
            qb.push_values(chunk, |mut b, (a, text, category)| {
                b.push_bind(addr_to_bytes(*a))
                    .push_bind(text)
                    .push_bind(category)
                    .push_bind(&source);
            });
            inserted += qb.build().execute(&mut *tx).await?.rows_affected();
        }
        tx.commit().await?;
        Ok(inserted)
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use sqlx::PgPool;

    #[sqlx::test]
    async fn delete_import_label_rejected(pool: PgPool) {
        let store = Store::from_pool(pool);
        let a = Address::repeat_byte(1);
        store
            .replace_import("d", &[(a, "Binance".into(), "exchange".into())])
            .await
            .unwrap();
        let id = store.labels(&[a]).await.unwrap()[0].id;
        assert!(matches!(
            store.delete_user_label(id).await,
            Err(StoreError::NotFound)
        ));
        assert_eq!(store.labels(&[a]).await.unwrap().len(), 1);
    }

    #[sqlx::test]
    async fn replace_import_is_idempotent(pool: PgPool) {
        let store = Store::from_pool(pool);
        let a = Address::repeat_byte(1);
        let rows = vec![
            (a, "A".to_string(), "defi".to_string()),
            (Address::repeat_byte(2), "B".into(), "defi".into()),
        ];
        let u = store.add_user_label(a, "mine", "other").await.unwrap();
        assert_eq!(u.source, "user");
        assert_eq!(store.replace_import("d", &rows).await.unwrap(), 2);
        assert_eq!(store.replace_import("d", &rows).await.unwrap(), 2);
        let all = store.labels(&[a, Address::repeat_byte(2)]).await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.iter().filter(|l| l.source == "import:d").count(), 2);
        store.delete_user_label(u.id).await.unwrap();
        assert_eq!(store.labels(&[a]).await.unwrap().len(), 1);
    }
}
