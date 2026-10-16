//! eg-store: Postgres persistence.
pub mod convert;
mod edges;
mod jobs;
mod labels;
mod meta;
mod quota;
mod transfers;
mod txs;
mod workspaces;

pub use edges::{TransferCursor, TransferQuery, TransferScope};
pub use jobs::{JobKind, JobRow, JobStatus, NewJob};
pub use labels::LabelRow;
pub use meta::{AccountRow, EnsRow, EnsStatus};
pub use txs::TxRow;
pub use workspaces::{WorkspaceMeta, WorkspaceRow};

use chrono::{DateTime, Utc};
use eg_core::source::TokenInfo;
use eg_core::types::{Address, Transfer, TransferKind};
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

use convert::{addr_to_bytes, bytes_to_addr};
use transfers::{to_i64, upsert_tokens_conn, upsert_transfers_conn};

#[derive(thiserror::Error, Debug)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("conflict")]
    Conflict,
    #[error("not found")]
    NotFound,
    /// A value cannot be represented in the database (e.g. a u64 above i64::MAX)
    /// or a stored value is not a known enum member.
    #[error("invalid value: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Syncing,
    Ok,
    Failed,
}

impl SyncState {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncState::Syncing => "syncing",
            SyncState::Ok => "ok",
            SyncState::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "syncing" => Some(SyncState::Syncing),
            "ok" => Some(SyncState::Ok),
            "failed" => Some(SyncState::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncUpdate {
    pub address: Address,
    pub kind: TransferKind,
    pub from_block: u64,
    pub to_block: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncRow {
    pub address: Address,
    pub kind: TransferKind,
    pub from_block: Option<u64>,
    pub to_block: Option<u64>,
    pub truncated: bool,
    pub state: SyncState,
    pub last_synced_at: Option<DateTime<Utc>>,
}

impl Store {
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Connects and applies pending migrations.
    pub async fn connect(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(url)
            .await?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|e| StoreError::Db(e.into()))?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn upsert_transfers(&self, ts: &[Transfer]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        upsert_transfers_conn(&mut tx, ts).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Single transaction: upsert transfers and tokens, store job progress
    /// (`NotFound` + rollback if the job does not exist), and optionally record
    /// sync coverage as `ok`.
    pub async fn write_page(
        &self,
        job_id: i64,
        transfers: &[Transfer],
        tokens: &[TokenInfo],
        progress: &serde_json::Value,
        sync: Option<&SyncUpdate>,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        upsert_transfers_conn(&mut tx, transfers).await?;
        upsert_tokens_conn(&mut tx, tokens).await?;
        let res = sqlx::query("UPDATE jobs SET progress = $1, updated_at = now() WHERE id = $2")
            .bind(progress)
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        if let Some(s) = sync {
            sqlx::query(
                "INSERT INTO address_sync (address, kind, from_block, to_block, truncated, state, \
                 last_synced_at) VALUES ($1, $2, $3, $4, $5, 'ok', now()) \
                 ON CONFLICT (address, kind) DO UPDATE SET from_block = EXCLUDED.from_block, \
                 to_block = EXCLUDED.to_block, truncated = EXCLUDED.truncated, state = 'ok', \
                 last_synced_at = now()",
            )
            .bind(addr_to_bytes(s.address))
            .bind(s.kind.as_i16())
            .bind(to_i64(s.from_block, "from_block")?)
            .bind(to_i64(s.to_block, "to_block")?)
            .bind(s.truncated)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Upserts the (address, kind) row; a missing row is created with null blocks.
    pub async fn set_sync_state(
        &self,
        addr: Address,
        kind: TransferKind,
        state: SyncState,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO address_sync (address, kind, state) VALUES ($1, $2, $3) \
             ON CONFLICT (address, kind) DO UPDATE SET state = EXCLUDED.state",
        )
        .bind(addr_to_bytes(addr))
        .bind(kind.as_i16())
        .bind(state.as_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn sync_rows(&self, addrs: &[Address]) -> Result<Vec<SyncRow>> {
        let keys: Vec<Vec<u8>> = addrs.iter().copied().map(addr_to_bytes).collect();
        let rows = sqlx::query(
            "SELECT address, kind, from_block, to_block, truncated, state, last_synced_at \
             FROM address_sync WHERE address = ANY($1) ORDER BY address, kind",
        )
        .bind(&keys)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                let kind: i16 = r.try_get("kind")?;
                let state: String = r.try_get("state")?;
                let blk = |c: &str| -> Result<Option<u64>> {
                    let v: Option<i64> = r.try_get(c)?;
                    v.map(|v| {
                        u64::try_from(v)
                            .map_err(|_| StoreError::Invalid(format!("negative {c} {v}")))
                    })
                    .transpose()
                };
                Ok(SyncRow {
                    address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
                    kind: TransferKind::from_i16(kind)
                        .ok_or_else(|| StoreError::Invalid(format!("unknown kind {kind}")))?,
                    from_block: blk("from_block")?,
                    to_block: blk("to_block")?,
                    truncated: r.try_get("truncated")?,
                    state: SyncState::parse(&state)
                        .ok_or_else(|| StoreError::Invalid(format!("unknown state {state}")))?,
                    last_synced_at: r.try_get("last_synced_at")?,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::bd_to_u256;
    use alloy_primitives::{B256, U256};
    use bigdecimal::BigDecimal;
    use eg_core::types::assign_sub_ids;
    use serde_json::json;

    fn tr(tx: u8, kind: TransferKind, amt: U256) -> Transfer {
        Transfer {
            tx_hash: B256::repeat_byte(tx),
            sub_id: String::new(),
            kind,
            block_number: 100,
            ts: DateTime::<Utc>::from_timestamp(1_700_000_000, 0).unwrap(),
            from: Address::repeat_byte(0xa),
            to: Address::repeat_byte(0xb),
            asset: (kind != TransferKind::Native).then(|| Address::repeat_byte(0xc)),
            amount: amt,
            token_id: None,
            trace_id: None,
            log_index: None,
        }
    }

    async fn count(pool: &PgPool) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM transfers")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn new_job(pool: &PgPool) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO jobs (key, kind, params, priority, status) \
             VALUES ('k', 'sync', '{}', 1, 'running') RETURNING id",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[sqlx::test]
    async fn upsert_is_idempotent(pool: PgPool) {
        let store = Store::from_pool(pool.clone());
        let mut v = vec![
            tr(1, TransferKind::Native, U256::from(1)),
            tr(2, TransferKind::Erc20, U256::from(2)),
            tr(3, TransferKind::Erc20, U256::from(3)),
        ];
        assign_sub_ids(&mut v);
        store.upsert_transfers(&v).await.unwrap();
        store.upsert_transfers(&v).await.unwrap();
        assert_eq!(count(&pool).await, 3);
    }

    #[sqlx::test]
    async fn identical_transfers_both_kept_and_refetch_dedupes(pool: PgPool) {
        let store = Store::from_pool(pool.clone());
        let mut v = vec![
            tr(1, TransferKind::Erc20, U256::from(5)),
            tr(1, TransferKind::Erc20, U256::from(5)),
        ];
        assign_sub_ids(&mut v);
        assert_ne!(v[0].sub_id, v[1].sub_id);
        store.upsert_transfers(&v).await.unwrap();
        assert_eq!(count(&pool).await, 2);
        let mut again = vec![
            tr(1, TransferKind::Erc20, U256::from(5)),
            tr(1, TransferKind::Erc20, U256::from(5)),
        ];
        assign_sub_ids(&mut again);
        store.upsert_transfers(&again).await.unwrap();
        assert_eq!(count(&pool).await, 2);
    }

    #[sqlx::test]
    async fn u256_max_roundtrip(pool: PgPool) {
        let store = Store::from_pool(pool.clone());
        let mut t = tr(1, TransferKind::Erc721, U256::MAX);
        t.token_id = Some(U256::MAX);
        let mut v = vec![t];
        assign_sub_ids(&mut v);
        store.upsert_transfers(&v).await.unwrap();
        let (a, id): (BigDecimal, Option<BigDecimal>) =
            sqlx::query_as("SELECT amount, token_id FROM transfers")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(bd_to_u256(&a).unwrap(), U256::MAX);
        assert_eq!(bd_to_u256(&id.unwrap()).unwrap(), U256::MAX);
    }

    #[sqlx::test]
    async fn write_page_updates_sync_and_progress(pool: PgPool) {
        let store = Store::from_pool(pool.clone());
        let job = new_job(&pool).await;
        let mut v = vec![tr(1, TransferKind::Native, U256::from(1))];
        assign_sub_ids(&mut v);
        let addr = Address::repeat_byte(0xa);
        let sync = SyncUpdate {
            address: addr,
            kind: TransferKind::Native,
            from_block: 10,
            to_block: 20,
            truncated: true,
        };
        let progress = json!({"cursor_block": 10});
        store
            .write_page(job, &v, &[], &progress, Some(&sync))
            .await
            .unwrap();
        assert_eq!(count(&pool).await, 1);
        let p: serde_json::Value = sqlx::query_scalar("SELECT progress FROM jobs WHERE id = $1")
            .bind(job)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(p, progress);
        let rows = store.sync_rows(&[addr]).await.unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.kind, TransferKind::Native);
        assert_eq!((r.from_block, r.to_block), (Some(10), Some(20)));
        assert!(r.truncated);
        assert_eq!(r.state, SyncState::Ok);
        assert!(r.last_synced_at.is_some());
    }

    #[sqlx::test]
    async fn write_page_is_atomic(pool: PgPool) {
        let store = Store::from_pool(pool.clone());
        let mut v = vec![tr(1, TransferKind::Native, U256::from(1))];
        assign_sub_ids(&mut v);
        let sync = SyncUpdate {
            address: Address::repeat_byte(0xa),
            kind: TransferKind::Native,
            from_block: 1,
            to_block: 2,
            truncated: false,
        };
        let err = store
            .write_page(999, &v, &[], &json!({}), Some(&sync))
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::NotFound));
        assert_eq!(count(&pool).await, 0);
        assert!(
            store
                .sync_rows(&[Address::repeat_byte(0xa)])
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[sqlx::test]
    async fn token_upsert_keeps_known_decimals(pool: PgPool) {
        let store = Store::from_pool(pool.clone());
        let job = new_job(&pool).await;
        let tok = |decimals, symbol: Option<&str>| TokenInfo {
            address: Address::repeat_byte(0xc),
            kind: TransferKind::Erc20,
            name: None,
            symbol: symbol.map(str::to_string),
            decimals,
        };
        store
            .write_page(job, &[], &[tok(Some(6), Some("USDC"))], &json!({}), None)
            .await
            .unwrap();
        store
            .write_page(job, &[], &[tok(None, None)], &json!({}), None)
            .await
            .unwrap();
        let (d, s): (Option<i16>, Option<String>) =
            sqlx::query_as("SELECT decimals, symbol FROM tokens")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(d, Some(6));
        assert_eq!(s.as_deref(), Some("USDC"));
    }

    #[sqlx::test]
    async fn token_batch_duplicates_merge_nonnull(pool: PgPool) {
        let store = Store::from_pool(pool.clone());
        let job = new_job(&pool).await;
        let tok = |decimals| TokenInfo {
            address: Address::repeat_byte(0xc),
            kind: TransferKind::Erc20,
            name: None,
            symbol: None,
            decimals,
        };
        store
            .write_page(job, &[], &[tok(Some(6)), tok(None)], &json!({}), None)
            .await
            .unwrap();
        let d: Option<i16> = sqlx::query_scalar("SELECT decimals FROM tokens")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(d, Some(6));
    }

    #[sqlx::test]
    async fn set_sync_state_creates_and_updates(pool: PgPool) {
        let store = Store::from_pool(pool);
        let a = Address::repeat_byte(7);
        store
            .set_sync_state(a, TransferKind::Erc20, SyncState::Syncing)
            .await
            .unwrap();
        let rows = store.sync_rows(&[a]).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, SyncState::Syncing);
        assert_eq!((rows[0].from_block, rows[0].to_block), (None, None));
        assert!(rows[0].last_synced_at.is_none());
        store
            .set_sync_state(a, TransferKind::Erc20, SyncState::Failed)
            .await
            .unwrap();
        assert_eq!(
            store.sync_rows(&[a]).await.unwrap()[0].state,
            SyncState::Failed
        );
    }

    #[sqlx::test]
    async fn sync_rows_filters_by_address(pool: PgPool) {
        let store = Store::from_pool(pool);
        let (a, b) = (Address::repeat_byte(1), Address::repeat_byte(2));
        for k in [TransferKind::Native, TransferKind::Erc20] {
            store.set_sync_state(a, k, SyncState::Ok).await.unwrap();
        }
        store
            .set_sync_state(b, TransferKind::Native, SyncState::Ok)
            .await
            .unwrap();
        assert_eq!(store.sync_rows(&[a]).await.unwrap().len(), 2);
        assert_eq!(store.sync_rows(&[a, b]).await.unwrap().len(), 3);
        assert!(store.sync_rows(&[]).await.unwrap().is_empty());
    }

    #[sqlx::test]
    async fn u64_above_i64_is_invalid_not_panic(pool: PgPool) {
        let store = Store::from_pool(pool);
        let mut t = tr(1, TransferKind::Native, U256::from(1));
        t.block_number = u64::MAX;
        t.sub_id = "top".into();
        let err = store.upsert_transfers(&[t]).await.unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
    }
}
