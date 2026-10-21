//! Transactions table and per-tx transfers.
use alloy_primitives::U256;
use chrono::{DateTime, Utc};
use eg_core::types::{Address, Transfer, TxHash};
use sqlx::Row;

use crate::convert::{addr_to_bytes, bd_to_u256, bytes_to_addr, u256_to_bd};
use crate::edges::{to_u64, transfer_from_row};
use crate::transfers::to_i64;
use crate::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxRow {
    pub hash: TxHash,
    pub block_number: u64,
    pub ts: DateTime<Utc>,
    pub from: Address,
    pub to: Option<Address>,
    pub value: U256,
    pub selector: Option<[u8; 4]>,
    pub success: bool,
    pub gas_used: U256,
    pub fee: U256,
    pub raw_tx: serde_json::Value,
    pub raw_receipt: serde_json::Value,
    pub revert_reason: Option<String>,
}

fn tx_from_row(r: &sqlx::postgres::PgRow) -> Result<TxRow> {
    let hash: Vec<u8> = r.try_get("hash")?;
    let selector = r
        .try_get::<Option<Vec<u8>>, _>("selector")?
        .map(|b| {
            <[u8; 4]>::try_from(b.as_slice())
                .map_err(|_| StoreError::Invalid(format!("selector of {} bytes", b.len())))
        })
        .transpose()?;
    Ok(TxRow {
        hash: TxHash::try_from(hash.as_slice())
            .map_err(|_| StoreError::Invalid(format!("hash of {} bytes", hash.len())))?,
        block_number: to_u64(r.try_get("block_number")?, "block_number")?,
        ts: r.try_get("ts")?,
        from: bytes_to_addr(&r.try_get::<Vec<u8>, _>("from_addr")?),
        to: r
            .try_get::<Option<Vec<u8>>, _>("to_addr")?
            .map(|b| bytes_to_addr(&b)),
        value: bd_to_u256(&r.try_get("value")?)?,
        selector,
        success: r.try_get("success")?,
        gas_used: bd_to_u256(&r.try_get("gas_used")?)?,
        fee: bd_to_u256(&r.try_get("fee")?)?,
        raw_tx: r.try_get("raw_tx")?,
        raw_receipt: r.try_get("raw_receipt")?,
        revert_reason: r.try_get("revert_reason")?,
    })
}

impl Store {
    pub async fn upsert_transaction(&self, row: &TxRow) -> Result<()> {
        sqlx::query(
            "INSERT INTO transactions (hash, block_number, ts, from_addr, to_addr, value, selector, \
             success, gas_used, fee, raw_tx, raw_receipt, revert_reason) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             ON CONFLICT (hash) DO UPDATE SET block_number = EXCLUDED.block_number, \
             ts = EXCLUDED.ts, from_addr = EXCLUDED.from_addr, to_addr = EXCLUDED.to_addr, \
             value = EXCLUDED.value, selector = EXCLUDED.selector, success = EXCLUDED.success, \
             gas_used = EXCLUDED.gas_used, fee = EXCLUDED.fee, raw_tx = EXCLUDED.raw_tx, \
             raw_receipt = EXCLUDED.raw_receipt, \
             revert_reason = EXCLUDED.revert_reason",
        )
        .bind(row.hash.as_slice().to_vec())
        .bind(to_i64(row.block_number, "block_number")?)
        .bind(row.ts)
        .bind(addr_to_bytes(row.from))
        .bind(row.to.map(addr_to_bytes))
        .bind(u256_to_bd(row.value))
        .bind(row.selector.map(|s| s.to_vec()))
        .bind(row.success)
        .bind(u256_to_bd(row.gas_used))
        .bind(u256_to_bd(row.fee))
        .bind(&row.raw_tx)
        .bind(&row.raw_receipt)
        .bind(&row.revert_reason)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn transaction(&self, hash: TxHash) -> Result<Option<TxRow>> {
        let r = sqlx::query("SELECT * FROM transactions WHERE hash = $1")
            .bind(hash.as_slice().to_vec())
            .fetch_optional(&self.pool)
            .await?;
        r.as_ref().map(tx_from_row).transpose()
    }

    /// The recorded lookup of the tx recipient's current EIP-7702 delegate:
    /// `None` when not looked up (or no such tx), `Some(None)` when looked
    /// up and none was found.
    pub async fn to_current_delegate(&self, hash: TxHash) -> Result<Option<Option<Address>>> {
        let delegate: Option<Option<Vec<u8>>> = sqlx::query_scalar(
            "SELECT to_current_delegate FROM transactions \
             WHERE hash = $1 AND to_delegate_checked_at IS NOT NULL",
        )
        .bind(hash.as_slice().to_vec())
        .fetch_optional(&self.pool)
        .await?;
        Ok(delegate.map(|d| d.map(|b| bytes_to_addr(&b))))
    }

    /// Records the lookup of the tx recipient's current EIP-7702 delegate
    /// (`None`: none found), replacing an earlier one.
    pub async fn set_to_current_delegate(
        &self,
        hash: TxHash,
        delegate: Option<Address>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE transactions SET to_current_delegate = $2, to_delegate_checked_at = now() \
             WHERE hash = $1",
        )
        .bind(hash.as_slice().to_vec())
        .bind(delegate.map(addr_to_bytes))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Hashes of the stored transactions mined in block `number`.
    pub async fn tx_hashes_in_block(&self, number: u64) -> Result<Vec<TxHash>> {
        let rows: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT hash FROM transactions WHERE block_number = $1 ORDER BY hash",
        )
        .bind(to_i64(number, "block_number")?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|h| {
                TxHash::try_from(h.as_slice())
                    .map_err(|_| StoreError::Invalid(format!("hash of {} bytes", h.len())))
            })
            .collect()
    }

    /// Transfers of one tx ordered by `log_index` (NULLs last), then `sub_id`.
    pub async fn transfers_of_tx(&self, hash: TxHash) -> Result<Vec<Transfer>> {
        let rows = sqlx::query(
            "SELECT * FROM transfers WHERE tx_hash = $1 ORDER BY log_index NULLS LAST, sub_id",
        )
        .bind(hash.as_slice().to_vec())
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(transfer_from_row).collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use alloy_primitives::{B256, U256};
    use serde_json::json;
    use sqlx::PgPool;

    #[sqlx::test]
    async fn transaction_roundtrip(pool: PgPool) {
        let store = Store::from_pool(pool);
        let mut row = TxRow {
            hash: B256::repeat_byte(1),
            block_number: 19_000_000,
            ts: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            from: Address::repeat_byte(2),
            to: None,
            value: U256::MAX,
            selector: Some([0xa9, 0x05, 0x9c, 0xbb]),
            success: false,
            gas_used: U256::from(21000),
            fee: U256::from(12345678901234567890u128),
            raw_tx: json!({"a": 1}),
            raw_receipt: json!({"b": [2]}),
            revert_reason: Some("Reverted".into()),
        };
        assert!(store.transaction(row.hash).await.unwrap().is_none());
        store.upsert_transaction(&row).await.unwrap();
        assert_eq!(store.transaction(row.hash).await.unwrap().unwrap(), row);
        row.selector = None;
        row.success = true;
        store.upsert_transaction(&row).await.unwrap();
        assert_eq!(store.transaction(row.hash).await.unwrap().unwrap(), row);
        assert!(store.transfers_of_tx(row.hash).await.unwrap().is_empty());
    }

    #[sqlx::test]
    async fn to_current_delegate_records_the_lookup(pool: PgPool) {
        let store = Store::from_pool(pool);
        let row = TxRow {
            hash: B256::repeat_byte(1),
            block_number: 1,
            ts: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            from: Address::repeat_byte(2),
            to: Some(Address::repeat_byte(2)),
            value: U256::ZERO,
            selector: None,
            success: true,
            gas_used: U256::from(21000),
            fee: U256::ZERO,
            raw_tx: json!({}),
            raw_receipt: json!({}),
            revert_reason: None,
        };
        // No such tx, then a tx not looked up yet.
        assert_eq!(store.to_current_delegate(row.hash).await.unwrap(), None);
        store.upsert_transaction(&row).await.unwrap();
        assert_eq!(store.to_current_delegate(row.hash).await.unwrap(), None);
        // Looked up, none found.
        store.set_to_current_delegate(row.hash, None).await.unwrap();
        assert_eq!(
            store.to_current_delegate(row.hash).await.unwrap(),
            Some(None)
        );
        let d = Address::repeat_byte(3);
        store
            .set_to_current_delegate(row.hash, Some(d))
            .await
            .unwrap();
        assert_eq!(
            store.to_current_delegate(row.hash).await.unwrap(),
            Some(Some(d))
        );
        // Storing the tx again keeps the lookup.
        store.upsert_transaction(&row).await.unwrap();
        assert_eq!(
            store.to_current_delegate(row.hash).await.unwrap(),
            Some(Some(d))
        );
    }

    #[sqlx::test]
    async fn transfers_of_tx_ordering(pool: PgPool) {
        use eg_core::types::{Transfer, TransferKind};
        let store = Store::from_pool(pool);
        let h = B256::repeat_byte(9);
        let mk = |sub: &str, log: Option<u64>| Transfer {
            tx_hash: h,
            sub_id: sub.to_string(),
            kind: TransferKind::Erc20,
            block_number: 1,
            ts: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            from: Address::repeat_byte(1),
            to: Address::repeat_byte(2),
            asset: Some(Address::repeat_byte(3)),
            amount: U256::from(1),
            token_id: None,
            trace_id: None,
            log_index: log,
            call_index: None,
        };
        store
            .upsert_transfers(&[
                mk("a", Some(2)),
                mk("n", None),
                mk("b", Some(1)),
                mk("z", Some(1)),
                mk("c", Some(1)),
                mk("m", None),
            ])
            .await
            .unwrap();
        let got: Vec<String> = store
            .transfers_of_tx(h)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.sub_id)
            .collect();
        assert_eq!(got, ["b", "c", "z", "a", "m", "n"]);
    }
}
