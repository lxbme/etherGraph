//! Cached call traces (`call_traces`), shared by all users.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use eg_core::source::CallFrame;
use eg_core::types::{Address, TxHash};
use sqlx::Row;

use crate::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallTraceRow {
    pub hash: TxHash,
    /// Sorted by `path` (pre-order).
    pub frames: Vec<CallFrame>,
    /// EIP-7702 delegated callees: account → the contract it delegates to,
    /// read from the account's code at `fetched_at` (today's delegation, not
    /// necessarily the one at the transaction). Accounts the transaction's own
    /// authorization list sets or clears are left out: the list decides.
    pub delegates: HashMap<Address, Address>,
    /// The trace source's name, e.g. `"blockscout"`.
    pub source: String,
    pub fetched_at: DateTime<Utc>,
}

fn invalid(what: &str, e: serde_json::Error) -> StoreError {
    StoreError::Invalid(format!("call trace {what}: {e}"))
}

impl Store {
    pub async fn call_trace(&self, hash: TxHash) -> Result<Option<CallTraceRow>> {
        let Some(r) = sqlx::query(
            "SELECT frames, delegates, source, fetched_at FROM call_traces WHERE tx_hash = $1",
        )
        .bind(hash.as_slice())
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        Ok(Some(CallTraceRow {
            hash,
            frames: serde_json::from_value(r.try_get("frames")?)
                .map_err(|e| invalid("frames", e))?,
            delegates: serde_json::from_value(r.try_get("delegates")?)
                .map_err(|e| invalid("delegates", e))?,
            source: r.try_get("source")?,
            fetched_at: r.try_get("fetched_at")?,
        }))
    }

    pub async fn upsert_call_trace(&self, row: &CallTraceRow) -> Result<()> {
        let frames = serde_json::to_value(&row.frames).map_err(|e| invalid("frames", e))?;
        let delegates =
            serde_json::to_value(&row.delegates).map_err(|e| invalid("delegates", e))?;
        sqlx::query(
            "INSERT INTO call_traces (tx_hash, frames, delegates, source, fetched_at) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (tx_hash) DO UPDATE SET frames = EXCLUDED.frames, \
             delegates = EXCLUDED.delegates, source = EXCLUDED.source, \
             fetched_at = EXCLUDED.fetched_at",
        )
        .bind(row.hash.as_slice())
        .bind(frames)
        .bind(delegates)
        .bind(&row.source)
        .bind(row.fetched_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{B256, Bytes, U256};
    use eg_core::source::CallKind;
    use sqlx::PgPool;

    fn frame(path: Vec<u32>, kind: CallKind, subtraces: u32) -> CallFrame {
        CallFrame {
            path,
            kind,
            from: Address::repeat_byte(1),
            to: Some(Address::repeat_byte(2)),
            value: U256::MAX,
            input: Bytes::from(vec![0xa9, 0x05, 0x9c, 0xbb]),
            output: None,
            gas: 100,
            gas_used: Some(42),
            error: Some("Reverted".into()),
            subtraces,
        }
    }

    #[sqlx::test]
    async fn call_trace_round_trip(pool: PgPool) {
        let s = Store::from_pool(pool);
        let hash = B256::repeat_byte(7);
        assert_eq!(s.call_trace(hash).await.unwrap(), None);
        let mut row = CallTraceRow {
            hash,
            frames: vec![
                frame(vec![], CallKind::Call, 1),
                frame(vec![0], CallKind::DelegateCall, 0),
            ],
            delegates: HashMap::from([(Address::repeat_byte(3), Address::repeat_byte(4))]),
            source: "blockscout".into(),
            fetched_at: DateTime::from_timestamp(1_760_000_000, 0).unwrap(),
        };
        s.upsert_call_trace(&row).await.unwrap();
        assert_eq!(s.call_trace(hash).await.unwrap(), Some(row.clone()));

        row.frames.truncate(1);
        row.delegates.clear();
        s.upsert_call_trace(&row).await.unwrap();
        assert_eq!(s.call_trace(hash).await.unwrap(), Some(row));
        assert_eq!(s.call_trace(B256::repeat_byte(8)).await.unwrap(), None);
    }
}
