//! Token tags imported from curated token lists.
use eg_core::types::Address;
use sqlx::{Postgres, QueryBuilder, Row};

use crate::convert::{addr_to_bytes, bytes_to_addr};
use crate::{Result, Store};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenTagRow {
    pub address: Address,
    pub source: String,
    pub tag: String,
    pub website: Option<String>,
}

// 4 bind params per row.
const TAG_CHUNK: usize = 10_000;

impl Store {
    /// Replaces every tag of `source` in one transaction; returns the number
    /// inserted. Rows are expected unique per (address, tag) and must all
    /// carry `source` themselves.
    pub async fn replace_token_tags(&self, source: &str, rows: &[TokenTagRow]) -> Result<u64> {
        if let Some(r) = rows.iter().find(|r| r.source != source) {
            return Err(crate::StoreError::Invalid(format!(
                "token tag row has source {:?}, expected {source:?}",
                r.source
            )));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM token_tags WHERE source = $1")
            .bind(source)
            .execute(&mut *tx)
            .await?;
        let mut inserted = 0;
        for chunk in rows.chunks(TAG_CHUNK) {
            let mut qb: QueryBuilder<Postgres> =
                QueryBuilder::new("INSERT INTO token_tags (address, source, tag, website) ");
            qb.push_values(chunk, |mut b, r| {
                b.push_bind(addr_to_bytes(r.address))
                    .push_bind(&r.source)
                    .push_bind(&r.tag)
                    .push_bind(&r.website);
            });
            inserted += qb.build().execute(&mut *tx).await?.rows_affected();
        }
        tx.commit().await?;
        Ok(inserted)
    }

    pub async fn token_tags(&self, addrs: &[Address]) -> Result<Vec<TokenTagRow>> {
        let keys: Vec<Vec<u8>> = addrs.iter().copied().map(addr_to_bytes).collect();
        let rows = sqlx::query(
            "SELECT address, source, tag, website FROM token_tags \
             WHERE address = ANY($1) ORDER BY address, source, tag",
        )
        .bind(keys)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok(TokenTagRow {
                    address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
                    source: r.try_get("source")?,
                    tag: r.try_get("tag")?,
                    website: r.try_get("website")?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    fn row(a: u8, source: &str, tag: &str, website: Option<&str>) -> TokenTagRow {
        TokenTagRow {
            address: Address::repeat_byte(a),
            source: source.into(),
            tag: tag.into(),
            website: website.map(Into::into),
        }
    }

    #[sqlx::test]
    async fn replace_token_tags_replaces_only_its_source(pool: PgPool) {
        let store = Store::from_pool(pool);
        let a = Address::repeat_byte(1);
        let first = [
            row(1, "uniswap", "default-list", None),
            row(2, "uniswap", "default-list", None),
        ];
        let other = [row(1, "eth-labels", "stablecoin", Some("https://x.io"))];
        assert_eq!(
            store.replace_token_tags("uniswap", &first).await.unwrap(),
            2
        );
        assert_eq!(
            store
                .replace_token_tags("eth-labels", &other)
                .await
                .unwrap(),
            1
        );
        let fresh = [row(3, "uniswap", "default-list", None)];
        assert_eq!(
            store.replace_token_tags("uniswap", &fresh).await.unwrap(),
            1
        );
        let got = store
            .token_tags(&[a, Address::repeat_byte(2), Address::repeat_byte(3)])
            .await
            .unwrap();
        assert_eq!(got, [other[0].clone(), fresh[0].clone()]);
    }

    #[sqlx::test]
    async fn replace_token_tags_rejects_a_row_of_another_source(pool: PgPool) {
        let store = Store::from_pool(pool);
        let kept = [row(1, "uniswap", "default-list", None)];
        store.replace_token_tags("uniswap", &kept).await.unwrap();
        let bad = [row(2, "coingecko", "listed", None)];
        assert!(store.replace_token_tags("uniswap", &bad).await.is_err());
        let got = store.token_tags(&[Address::repeat_byte(1)]).await.unwrap();
        assert_eq!(got, kept);
    }
}
