//! The last import of each local dataset (labels, token lists, signatures).
use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::{Result, Store};

#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct LocalDataRow {
    pub source: String,
    pub version: Option<String>,
    pub etag: Option<String>,
    pub sha256: Option<String>,
    /// Sourcify: `[{key, etag, size}]` of the fully imported files.
    pub manifest: Option<serde_json::Value>,
    pub imported_at: Option<DateTime<Utc>>,
    pub rows: Option<i64>,
    /// `idle`, `running` or `failed`.
    pub state: String,
    pub error: Option<String>,
    pub error_at: Option<DateTime<Utc>>,
    pub started_by: Option<String>,
}

impl Store {
    pub async fn local_data_all(&self) -> Result<Vec<LocalDataRow>> {
        Ok(sqlx::query_as("SELECT * FROM local_data ORDER BY source")
            .fetch_all(&self.pool)
            .await?)
    }

    /// Records a finished import: state `idle`, error cleared, `imported_at` now.
    pub async fn local_data_succeeded(
        &self,
        source: &str,
        version: Option<&str>,
        etag: Option<&str>,
        sha256: Option<&str>,
        manifest: Option<&serde_json::Value>,
        rows: i64,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO local_data \
               (source, version, etag, sha256, manifest, imported_at, rows, state) \
             VALUES ($1, $2, $3, $4, $5, now(), $6, 'idle') \
             ON CONFLICT (source) DO UPDATE SET \
               version = EXCLUDED.version, etag = EXCLUDED.etag, sha256 = EXCLUDED.sha256, \
               manifest = EXCLUDED.manifest, imported_at = EXCLUDED.imported_at, \
               rows = EXCLUDED.rows, state = 'idle', error = NULL, error_at = NULL",
        )
        .bind(source)
        .bind(version)
        .bind(etag)
        .bind(sha256)
        .bind(manifest)
        .bind(rows)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Marks `source` running for the admin `started_by`; last-success fields are kept.
    pub async fn local_data_running(&self, source: &str, started_by: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO local_data (source, state, started_by) VALUES ($1, 'running', $2) \
             ON CONFLICT (source) DO UPDATE SET state = 'running', started_by = EXCLUDED.started_by",
        )
        .bind(source)
        .bind(started_by)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Marks `source` failed with `error` at now; last-success fields are kept.
    pub async fn local_data_failed(&self, source: &str, error: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO local_data (source, state, error, error_at) \
             VALUES ($1, 'failed', $2, now()) \
             ON CONFLICT (source) DO UPDATE SET \
               state = 'failed', error = EXCLUDED.error, error_at = EXCLUDED.error_at",
        )
        .bind(source)
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Marks `source` idle (a cancelled task); error and last-success fields are untouched.
    pub async fn local_data_idle(&self, source: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO local_data (source, state) VALUES ($1, 'idle') \
             ON CONFLICT (source) DO UPDATE SET state = 'idle'",
        )
        .bind(source)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Fails every `running` source with `interrupted` (a restart killed its
    /// task); returns the sources.
    pub async fn local_data_interrupt_running(&self) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "UPDATE local_data SET state = 'failed', error = 'interrupted', error_at = now() \
             WHERE state = 'running' RETURNING source",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Row counts of datasets imported before this table existed, by source id:
    /// `eth_labels` (both eth-labels datasets), `tokens_*` (by `token_tags`
    /// source) and `signatures_sourcify`.
    pub async fn legacy_row_counts(&self) -> Result<HashMap<String, i64>> {
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT 'eth_labels', count(*) FROM labels \
               WHERE source IN ('eth-labels', 'eth-labels-xchain') \
             UNION ALL \
             SELECT CASE source WHEN 'uniswap' THEN 'tokens_uniswap' \
                                WHEN 'coingecko' THEN 'tokens_coingecko' \
                                ELSE 'tokens_eth_labels' END, count(*) \
               FROM token_tags WHERE source IN ('uniswap', 'coingecko', 'eth-labels') \
               GROUP BY source \
             UNION ALL \
             SELECT 'signatures_sourcify', count(*) FROM signatures",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use sqlx::PgPool;

    fn row<'a>(rows: &'a [LocalDataRow], source: &str) -> &'a LocalDataRow {
        rows.iter().find(|r| r.source == source).unwrap()
    }

    #[sqlx::test]
    async fn succeeded_then_failed_keeps_the_last_success(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.local_data_succeeded(
            "tokens_uniswap",
            Some("22.27.0"),
            None,
            Some("ab"),
            None,
            1791,
        )
        .await
        .unwrap();
        s.local_data_failed("tokens_uniswap", "timeout")
            .await
            .unwrap();
        let all = s.local_data_all().await.unwrap();
        let r = row(&all, "tokens_uniswap");
        assert_eq!(r.state, "failed");
        assert_eq!(r.error.as_deref(), Some("timeout"));
        assert!(r.error_at.is_some());
        assert_eq!(r.version.as_deref(), Some("22.27.0"));
        assert_eq!(r.sha256.as_deref(), Some("ab"));
        assert_eq!(r.rows, Some(1791));
        assert!(r.imported_at.is_some());

        // A later success clears the error.
        s.local_data_succeeded("tokens_uniswap", Some("22.28.0"), None, None, None, 5)
            .await
            .unwrap();
        let all = s.local_data_all().await.unwrap();
        let r = row(&all, "tokens_uniswap");
        assert_eq!((r.state.as_str(), r.error.as_deref()), ("idle", None));
        assert_eq!(r.error_at, None);
        assert_eq!(r.version.as_deref(), Some("22.28.0"));
    }

    #[sqlx::test]
    async fn interrupt_running_marks_failed_interrupted(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.local_data_running("eth_labels", "0xa").await.unwrap();
        s.local_data_running("signatures_sourcify", "0xa")
            .await
            .unwrap();
        s.local_data_succeeded("tokens_uniswap", None, None, None, None, 1)
            .await
            .unwrap();
        let mut hit = s.local_data_interrupt_running().await.unwrap();
        hit.sort();
        assert_eq!(hit, ["eth_labels", "signatures_sourcify"]);
        let all = s.local_data_all().await.unwrap();
        for id in ["eth_labels", "signatures_sourcify"] {
            let r = row(&all, id);
            assert_eq!(r.state, "failed");
            assert_eq!(r.error.as_deref(), Some("interrupted"));
        }
        assert_eq!(row(&all, "tokens_uniswap").state, "idle");
        assert!(s.local_data_interrupt_running().await.unwrap().is_empty());
    }

    #[sqlx::test]
    async fn idle_keeps_error_and_last_success(pool: PgPool) {
        let s = Store::from_pool(pool);
        s.local_data_succeeded("tokens_coingecko", Some("1.0.0"), None, None, None, 9)
            .await
            .unwrap();
        s.local_data_failed("tokens_coingecko", "boom")
            .await
            .unwrap();
        s.local_data_running("tokens_coingecko", "0xa")
            .await
            .unwrap();
        s.local_data_idle("tokens_coingecko").await.unwrap();
        let all = s.local_data_all().await.unwrap();
        let r = row(&all, "tokens_coingecko");
        assert_eq!(r.state, "idle");
        assert_eq!(r.error.as_deref(), Some("boom"));
        assert_eq!(r.version.as_deref(), Some("1.0.0"));
        assert_eq!(r.rows, Some(9));
    }

    #[sqlx::test]
    async fn legacy_counts_cover_existing_tables(pool: PgPool) {
        let s = Store::from_pool(pool.clone());
        let a = [0x11u8; 20].to_vec();
        for (text, source) in [
            ("a", "eth-labels"),
            ("b", "eth-labels-xchain"),
            ("c", "sample"),
        ] {
            sqlx::query(
                "INSERT INTO labels (address, text, category, source) VALUES ($1, $2, 'x', $3)",
            )
            .bind(&a)
            .bind(text)
            .bind(source)
            .execute(&pool)
            .await
            .unwrap();
        }
        for (src, tag) in [("uniswap", "t"), ("uniswap", "u"), ("coingecko", "t")] {
            sqlx::query("INSERT INTO token_tags (address, source, tag) VALUES ($1, $2, $3)")
                .bind(&a)
                .bind(src)
                .bind(tag)
                .execute(&pool)
                .await
                .unwrap();
        }
        upsert_signatures(
            &pool,
            &[
                "transfer(address,uint256)".to_owned(),
                "approve(address,uint256)".to_owned(),
            ],
        )
        .await
        .unwrap();
        let c = s.legacy_row_counts().await.unwrap();
        assert_eq!(c["eth_labels"], 2);
        assert_eq!(c["tokens_uniswap"], 2);
        assert_eq!(c["tokens_coingecko"], 1);
        assert!(!c.contains_key("tokens_eth_labels"));
        assert_eq!(c["signatures_sourcify"], 2);
    }
}
