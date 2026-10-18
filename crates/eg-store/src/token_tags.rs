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
    /// The symbol the list gives the token.
    pub symbol: Option<String>,
    /// The name the list gives the token.
    pub name: Option<String>,
}

/// A token on the Uniswap or CoinGecko list, with the list's symbol and name
/// (each falling back to the `tokens` row).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedTokenRow {
    pub address: Address,
    pub source: String,
    pub symbol: Option<String>,
    pub name: Option<String>,
}

/// The `token_tags` sources that make a token listed.
const LISTED_SOURCES: [&str; 2] = ["uniswap", "coingecko"];

// 6 bind params per row.
const TAG_CHUNK: usize = 10_000;

fn addresses(rows: Vec<(Vec<u8>,)>) -> Vec<Address> {
    rows.into_iter().map(|(a,)| bytes_to_addr(&a)).collect()
}

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
            let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
                "INSERT INTO token_tags (address, source, tag, website, symbol, name) ",
            );
            qb.push_values(chunk, |mut b, r| {
                b.push_bind(addr_to_bytes(r.address))
                    .push_bind(&r.source)
                    .push_bind(&r.tag)
                    .push_bind(&r.website)
                    .push_bind(&r.symbol)
                    .push_bind(&r.name);
            });
            inserted += qb.build().execute(&mut *tx).await?.rows_affected();
        }
        tx.commit().await?;
        Ok(inserted)
    }

    pub async fn token_tags(&self, addrs: &[Address]) -> Result<Vec<TokenTagRow>> {
        let keys: Vec<Vec<u8>> = addrs.iter().copied().map(addr_to_bytes).collect();
        let rows = sqlx::query(
            "SELECT address, source, tag, website, symbol, name FROM token_tags \
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
                    symbol: r.try_get("symbol")?,
                    name: r.try_get("name")?,
                })
            })
            .collect()
    }

    /// Every Uniswap and CoinGecko row, one per (address, source).
    pub async fn listed_tokens(&self) -> Result<Vec<ListedTokenRow>> {
        let rows = sqlx::query(
            "SELECT DISTINCT ON (g.address, g.source) g.address, g.source, \
                    COALESCE(g.symbol, t.symbol) AS symbol, COALESCE(g.name, t.name) AS name \
             FROM token_tags g LEFT JOIN tokens t ON t.address = g.address \
             WHERE g.source = ANY($1) ORDER BY g.address, g.source, g.tag",
        )
        .bind(LISTED_SOURCES)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok(ListedTokenRow {
                    address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
                    source: r.try_get("source")?,
                    symbol: r.try_get("symbol")?,
                    name: r.try_get("name")?,
                })
            })
            .collect()
    }

    /// Distinct addresses carrying `tag` from `source`.
    pub async fn token_tag_addresses(&self, source: &str, tag: &str) -> Result<Vec<Address>> {
        let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
            "SELECT DISTINCT address FROM token_tags WHERE source = $1 AND tag = $2",
        )
        .bind(source)
        .bind(tag)
        .fetch_all(&self.pool)
        .await?;
        Ok(addresses(rows))
    }

    /// `(rows, rows with a symbol)` of the Uniswap and CoinGecko sources.
    pub async fn listed_symbol_counts(&self) -> Result<(u64, u64)> {
        let (total, with_symbol): (i64, i64) =
            sqlx::query_as("SELECT count(*), count(symbol) FROM token_tags WHERE source = ANY($1)")
                .bind(LISTED_SOURCES)
                .fetch_one(&self.pool)
                .await?;
        Ok((total.unsigned_abs(), with_symbol.unsigned_abs()))
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
            symbol: None,
            name: None,
        }
    }

    fn named(a: u8, source: &str, symbol: Option<&str>, name: Option<&str>) -> TokenTagRow {
        TokenTagRow {
            symbol: symbol.map(Into::into),
            name: name.map(Into::into),
            ..row(a, source, "listed", None)
        }
    }

    #[sqlx::test]
    async fn symbol_and_name_round_trip(pool: PgPool) {
        let store = Store::from_pool(pool);
        let rows = [named(1, "coingecko", Some("USDT"), Some("Tether USD"))];
        store.replace_token_tags("coingecko", &rows).await.unwrap();
        let got = store.token_tags(&[Address::repeat_byte(1)]).await.unwrap();
        assert_eq!(got, rows);
    }

    #[sqlx::test]
    async fn listed_tokens_fall_back_to_the_tokens_table(pool: PgPool) {
        use eg_core::source::TokenInfo;
        use eg_core::types::TransferKind;
        let store = Store::from_pool(pool);
        store
            .upsert_tokens(&[TokenInfo {
                address: Address::repeat_byte(2),
                kind: TransferKind::Erc20,
                name: Some("Two Token".into()),
                symbol: Some("TWO".into()),
                decimals: Some(18),
            }])
            .await
            .unwrap();
        store
            .replace_token_tags(
                "uniswap",
                &[
                    named(1, "uniswap", Some("ONE"), Some("One")),
                    named(2, "uniswap", None, Some("Listed Two")),
                ],
            )
            .await
            .unwrap();
        store
            .replace_token_tags("coingecko", &[named(3, "coingecko", None, None)])
            .await
            .unwrap();
        store
            .replace_token_tags(
                "eth-labels",
                &[named(4, "eth-labels", Some("FOUR"), Some("Four"))],
            )
            .await
            .unwrap();
        let mut got = store.listed_tokens().await.unwrap();
        got.sort_by_key(|r| r.address);
        let want = |a: u8, source: &str, symbol: Option<&str>, name: Option<&str>| ListedTokenRow {
            address: Address::repeat_byte(a),
            source: source.into(),
            symbol: symbol.map(Into::into),
            name: name.map(Into::into),
        };
        assert_eq!(
            got,
            [
                want(1, "uniswap", Some("ONE"), Some("One")),
                want(2, "uniswap", Some("TWO"), Some("Listed Two")),
                want(3, "coingecko", None, None),
            ]
        );
    }

    #[sqlx::test]
    async fn tag_addresses_and_symbol_counts(pool: PgPool) {
        let store = Store::from_pool(pool);
        assert_eq!(store.listed_symbol_counts().await.unwrap(), (0, 0));
        store
            .replace_token_tags(
                "eth-labels",
                &[
                    row(1, "eth-labels", "spam-token", None),
                    row(2, "eth-labels", "defi", None),
                    row(3, "eth-labels", "spam-token", None),
                ],
            )
            .await
            .unwrap();
        let mut spam = store
            .token_tag_addresses("eth-labels", "spam-token")
            .await
            .unwrap();
        spam.sort();
        assert_eq!(spam, [Address::repeat_byte(1), Address::repeat_byte(3)]);
        store
            .replace_token_tags("uniswap", &[row(1, "uniswap", "default-list", None)])
            .await
            .unwrap();
        assert_eq!(store.listed_symbol_counts().await.unwrap(), (1, 0));
        store
            .replace_token_tags("coingecko", &[named(2, "coingecko", Some("B"), None)])
            .await
            .unwrap();
        assert_eq!(store.listed_symbol_counts().await.unwrap(), (2, 1));
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
