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

/// SQL predicate of an imported (shared) label: no owner and not a user
/// label. A user label without an owner (left over from before accounts and
/// not yet adopted) belongs to nobody and is shown to nobody.
macro_rules! imported {
    () => {
        "(owner_id IS NULL AND source <> 'user')"
    };
}

/// `(address, text, category)` of an imported label.
pub type ImportRow = (Address, String, String);

impl Store {
    /// Inserts a `source = 'user'` label owned by `owner`; the caller
    /// validates the input.
    pub async fn add_user_label(
        &self,
        owner: i64,
        addr: Address,
        text: &str,
        category: &str,
    ) -> Result<LabelRow> {
        let r = sqlx::query(
            "INSERT INTO labels (address, text, category, source, owner_id) \
             VALUES ($1, $2, $3, 'user', $4) RETURNING *",
        )
        .bind(addr_to_bytes(addr))
        .bind(text)
        .bind(category)
        .bind(owner)
        .fetch_one(&self.pool)
        .await?;
        label_from_row(&r)
    }

    /// Deletes one of `owner`'s user labels; another user's label or an
    /// import is `NotFound`, like a missing one.
    pub async fn delete_user_label(&self, owner: i64, id: i64) -> Result<()> {
        let res =
            sqlx::query("DELETE FROM labels WHERE id = $1 AND source = 'user' AND owner_id = $2")
                .bind(id)
                .bind(owner)
                .execute(&self.pool)
                .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// The labels of `addrs` that `viewer` may see: every import plus the
    /// viewer's own user labels.
    pub async fn labels(&self, addrs: &[Address], viewer: i64) -> Result<Vec<LabelRow>> {
        let keys: Vec<Vec<u8>> = addrs.iter().copied().map(addr_to_bytes).collect();
        let rows = sqlx::query(concat!(
            "SELECT * FROM labels WHERE address = ANY($1) AND (",
            imported!(),
            " OR owner_id = $2) ORDER BY address, id"
        ))
        .bind(keys)
        .bind(viewer)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(label_from_row).collect()
    }

    /// Distinct addresses with an imported label of `category`. User labels
    /// never count: they are private to their owner.
    pub async fn imported_addresses_with_category(&self, category: &str) -> Result<Vec<Address>> {
        let rows: Vec<(Vec<u8>,)> = sqlx::query_as(concat!(
            "SELECT DISTINCT address FROM labels WHERE category = $1 AND ",
            imported!()
        ))
        .bind(category)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(a,)| bytes_to_addr(&a)).collect())
    }

    /// Replaces all labels of `import:<dataset>` in one transaction; returns the
    /// number inserted.
    pub async fn replace_import(&self, dataset: &str, rows: &[ImportRow]) -> Result<u64> {
        Ok(self.replace_imports(&[(dataset, rows)]).await?[0])
    }

    /// Replaces the labels of several `import:<dataset>` sources in one
    /// transaction (all or nothing); returns the number inserted per dataset.
    pub async fn replace_imports(&self, sets: &[(&str, &[ImportRow])]) -> Result<Vec<u64>> {
        let mut tx = self.pool.begin().await?;
        let mut counts = Vec::with_capacity(sets.len());
        for (dataset, rows) in sets {
            let source = format!("import:{dataset}");
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
            counts.push(inserted);
        }
        tx.commit().await?;
        Ok(counts)
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use sqlx::PgPool;

    async fn user(store: &Store, byte: u8) -> i64 {
        store
            .upsert_user_on_login(Address::repeat_byte(byte))
            .await
            .unwrap()
            .id
    }

    #[sqlx::test]
    async fn imported_addresses_with_category_ignores_user_labels(pool: PgPool) {
        let store = Store::from_pool(pool);
        let me = user(&store, 0xe0).await;
        let (a, b, c) = (
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            Address::repeat_byte(3),
        );
        store
            .replace_import(
                "d",
                &[
                    (a, "Fake".into(), "scam".into()),
                    (a, "Fake 2".into(), "scam".into()),
                    (c, "Dex".into(), "dex".into()),
                ],
            )
            .await
            .unwrap();
        store.add_user_label(me, b, "phish", "scam").await.unwrap();
        // An unadopted user label (no owner) is not an import either.
        sqlx::query(
            "INSERT INTO labels (address, text, category, source) VALUES ($1, 'x', 'scam', 'user')",
        )
        .bind(c.as_slice())
        .execute(store.pool())
        .await
        .unwrap();
        let got = store
            .imported_addresses_with_category("scam")
            .await
            .unwrap();
        assert_eq!(got, [a]);
    }

    #[sqlx::test]
    async fn labels_are_imports_plus_the_viewers_own(pool: PgPool) {
        let store = Store::from_pool(pool);
        let (me, other) = (user(&store, 0xe0).await, user(&store, 0xe1).await);
        let a = Address::repeat_byte(1);
        store
            .replace_import("d", &[(a, "Public".into(), "defi".into())])
            .await
            .unwrap();
        let mine = store.add_user_label(me, a, "mine", "other").await.unwrap();
        store
            .add_user_label(other, a, "theirs", "scam")
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO labels (address, text, category, source) \
             VALUES ($1, 'orphan', 'other', 'user')",
        )
        .bind(a.as_slice())
        .execute(store.pool())
        .await
        .unwrap();
        let texts = |rows: Vec<LabelRow>| rows.into_iter().map(|l| l.text).collect::<Vec<_>>();
        assert_eq!(
            texts(store.labels(&[a], me).await.unwrap()),
            ["Public", "mine"]
        );
        assert_eq!(
            texts(store.labels(&[a], other).await.unwrap()),
            ["Public", "theirs"]
        );

        // Only the owner deletes its label; for anyone else it is missing.
        assert!(matches!(
            store.delete_user_label(other, mine.id).await,
            Err(StoreError::NotFound)
        ));
        assert_eq!(store.labels(&[a], me).await.unwrap().len(), 2);
        store.delete_user_label(me, mine.id).await.unwrap();
        assert_eq!(texts(store.labels(&[a], me).await.unwrap()), ["Public"]);
    }

    #[sqlx::test]
    async fn delete_import_label_rejected(pool: PgPool) {
        let store = Store::from_pool(pool);
        let me = user(&store, 0xe0).await;
        let a = Address::repeat_byte(1);
        store
            .replace_import("d", &[(a, "Binance".into(), "cex".into())])
            .await
            .unwrap();
        let id = store.labels(&[a], me).await.unwrap()[0].id;
        assert!(matches!(
            store.delete_user_label(me, id).await,
            Err(StoreError::NotFound)
        ));
        assert_eq!(store.labels(&[a], me).await.unwrap().len(), 1);
    }

    #[sqlx::test]
    async fn replace_import_is_idempotent(pool: PgPool) {
        let store = Store::from_pool(pool);
        let me = user(&store, 0xe0).await;
        let a = Address::repeat_byte(1);
        let rows = vec![
            (a, "A".to_string(), "defi".to_string()),
            (Address::repeat_byte(2), "B".into(), "defi".into()),
        ];
        let u = store.add_user_label(me, a, "mine", "other").await.unwrap();
        assert_eq!(u.source, "user");
        assert_eq!(store.replace_import("d", &rows).await.unwrap(), 2);
        assert_eq!(store.replace_import("d", &rows).await.unwrap(), 2);
        let all = store
            .labels(&[a, Address::repeat_byte(2)], me)
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.iter().filter(|l| l.source == "import:d").count(), 2);
        store.delete_user_label(me, u.id).await.unwrap();
        assert_eq!(store.labels(&[a], me).await.unwrap().len(), 1);
    }

    #[sqlx::test]
    async fn replace_imports_is_all_or_nothing(pool: PgPool) {
        let store = Store::from_pool(pool);
        let me = user(&store, 0xe0).await;
        let a = Address::repeat_byte(1);
        let old = vec![(a, "Old".to_string(), "defi".to_string())];
        store.replace_import("m", &old).await.unwrap();
        store.replace_import("x", &old).await.unwrap();
        let new = vec![(a, "New".to_string(), "cex".to_string())];
        // NUL is rejected by Postgres text: the second dataset fails.
        let bad = vec![(a, "a\0b".to_string(), "cex".to_string())];
        assert!(
            store
                .replace_imports(&[("m", &new), ("x", &bad)])
                .await
                .is_err()
        );
        let got = store.labels(&[a], me).await.unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|l| l.text == "Old"));
        let counts = store
            .replace_imports(&[("m", &new), ("x", &new)])
            .await
            .unwrap();
        assert_eq!(counts, [1, 1]);
        assert!(
            store
                .labels(&[a], me)
                .await
                .unwrap()
                .iter()
                .all(|l| l.text == "New")
        );
    }
}
