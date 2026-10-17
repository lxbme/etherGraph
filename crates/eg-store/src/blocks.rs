//! Block headers of fetched transactions.
use eg_core::source::RawBlock;
use sqlx::Row;

use crate::convert::{addr_to_bytes, bd_to_u256, bytes_to_addr, u256_to_bd};
use crate::edges::to_u64;
use crate::transfers::to_i64;
use crate::{Result, Store};

/// A stored block header; same fields as the fetched [`RawBlock`].
pub type BlockRow = RawBlock;

impl Store {
    pub async fn upsert_block(&self, b: &RawBlock) -> Result<()> {
        sqlx::query(
            "INSERT INTO blocks (number, ts, base_fee, gas_limit, gas_used, fee_recipient) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (number) DO UPDATE SET ts = EXCLUDED.ts, base_fee = EXCLUDED.base_fee, \
             gas_limit = EXCLUDED.gas_limit, gas_used = EXCLUDED.gas_used, \
             fee_recipient = EXCLUDED.fee_recipient",
        )
        .bind(to_i64(b.number, "number")?)
        .bind(b.ts)
        .bind(b.base_fee.map(u256_to_bd))
        .bind(u256_to_bd(b.gas_limit))
        .bind(u256_to_bd(b.gas_used))
        .bind(addr_to_bytes(b.fee_recipient))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn block(&self, number: u64) -> Result<Option<BlockRow>> {
        let r = sqlx::query("SELECT * FROM blocks WHERE number = $1")
            .bind(to_i64(number, "number")?)
            .fetch_optional(&self.pool)
            .await?;
        r.map(|r| {
            Ok(BlockRow {
                number: to_u64(r.try_get("number")?, "number")?,
                ts: r.try_get("ts")?,
                base_fee: r
                    .try_get::<Option<bigdecimal::BigDecimal>, _>("base_fee")?
                    .map(|v| bd_to_u256(&v))
                    .transpose()?,
                gas_limit: bd_to_u256(&r.try_get("gas_limit")?)?,
                gas_used: bd_to_u256(&r.try_get("gas_used")?)?,
                fee_recipient: bytes_to_addr(&r.try_get::<Vec<u8>, _>("fee_recipient")?),
            })
        })
        .transpose()
    }
}
