//! The local signature database: text signatures keyed by their keccak256.
use std::collections::HashMap;

use alloy_primitives::{B256, keccak256};
use sqlx::PgPool;

use crate::Result;

/// Inserts the signatures not stored yet (hash = keccak256 of the text, computed
/// here) and returns how many were new.
pub async fn upsert_signatures(pool: &PgPool, texts: &[String]) -> Result<u64> {
    if texts.is_empty() {
        return Ok(0);
    }
    let hashes: Vec<Vec<u8>> = texts
        .iter()
        .map(|t| keccak256(t.as_bytes()).to_vec())
        .collect();
    let res = sqlx::query(
        "INSERT INTO signatures (hash, text) \
         SELECT * FROM UNNEST($1::bytea[], $2::text[]) ON CONFLICT (hash) DO NOTHING",
    )
    .bind(&hashes)
    .bind(texts)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Every stored signature whose hash starts with one of `selectors`, in text order.
pub async fn signatures_by_selector(
    pool: &PgPool,
    selectors: &[[u8; 4]],
) -> Result<HashMap<[u8; 4], Vec<String>>> {
    let mut out: HashMap<[u8; 4], Vec<String>> = HashMap::new();
    if selectors.is_empty() {
        return Ok(out);
    }
    let sels: Vec<Vec<u8>> = selectors.iter().map(|s| s.to_vec()).collect();
    let rows: Vec<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT hash, text FROM signatures \
         WHERE substring(hash FROM 1 FOR 4) = ANY($1::bytea[]) ORDER BY text",
    )
    .bind(&sels)
    .fetch_all(pool)
    .await?;
    for (hash, text) in rows {
        if let Some(sel) = hash.get(..4).and_then(|s| <[u8; 4]>::try_from(s).ok()) {
            out.entry(sel).or_default().push(text);
        }
    }
    Ok(out)
}

/// The text of each of `hashes` that is stored.
pub async fn signatures_by_hash(pool: &PgPool, hashes: &[B256]) -> Result<HashMap<B256, String>> {
    if hashes.is_empty() {
        return Ok(HashMap::new());
    }
    let hs: Vec<Vec<u8>> = hashes.iter().map(|h| h.to_vec()).collect();
    let rows: Vec<(Vec<u8>, String)> =
        sqlx::query_as("SELECT hash, text FROM signatures WHERE hash = ANY($1::bytea[])")
            .bind(&hs)
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(h, t)| Some((B256::try_from(h.as_slice()).ok()?, t)))
        .collect())
}

pub async fn signature_count(pool: &PgPool) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM signatures")
        .fetch_one(pool)
        .await?)
}

/// Whether any signature is stored (without counting them).
pub async fn signatures_exist(pool: &PgPool) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM signatures)")
            .fetch_one(pool)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> String {
        s.to_owned()
    }

    #[sqlx::test]
    async fn upsert_counts_new_and_dedups(pool: PgPool) {
        let n = upsert_signatures(&pool, &[t("a()"), t("b()"), t("a()")])
            .await
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(upsert_signatures(&pool, &[t("a()")]).await.unwrap(), 0);
        assert_eq!(upsert_signatures(&pool, &[]).await.unwrap(), 0);
        assert_eq!(signature_count(&pool).await.unwrap(), 2);
    }

    #[sqlx::test]
    async fn signatures_exist_once_one_is_stored(pool: PgPool) {
        assert!(!signatures_exist(&pool).await.unwrap());
        upsert_signatures(&pool, &[t("a()")]).await.unwrap();
        assert!(signatures_exist(&pool).await.unwrap());
    }

    #[sqlx::test]
    async fn lookups_by_selector_and_hash(pool: PgPool) {
        upsert_signatures(&pool, &[t("transfer(address,uint256)"), t("a()")])
            .await
            .unwrap();
        let sel = [0xa9, 0x05, 0x9c, 0xbb];
        let got = signatures_by_selector(&pool, &[sel, [0; 4]]).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[&sel], vec![t("transfer(address,uint256)")]);
        let h = keccak256("a()");
        let got = signatures_by_hash(&pool, &[h, B256::ZERO]).await.unwrap();
        assert_eq!(got, HashMap::from([(h, t("a()"))]));
        assert!(signatures_by_hash(&pool, &[]).await.unwrap().is_empty());
    }
}
