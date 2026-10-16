//! Batched upserts for transfers and tokens.
use std::collections::{HashMap, HashSet};

use eg_core::source::TokenInfo;
use eg_core::types::Transfer;
use sqlx::{PgConnection, Postgres, QueryBuilder};

use crate::convert::{addr_to_bytes, u256_to_bd};
use crate::{Result, StoreError};

// 12 bind params per transfer row; stay well under Postgres' 65535 limit.
const TRANSFER_CHUNK: usize = 2000;

pub(crate) fn to_i64(v: u64, what: &str) -> Result<i64> {
    i64::try_from(v).map_err(|_| StoreError::Invalid(format!("{what} {v} exceeds i64::MAX")))
}

pub(crate) async fn upsert_transfers_conn(conn: &mut PgConnection, ts: &[Transfer]) -> Result<()> {
    // One statement cannot touch the same row twice; keep the last occurrence.
    let mut rows: Vec<&Transfer> = Vec::with_capacity(ts.len());
    let mut seen = HashSet::new();
    for t in ts.iter().rev() {
        if seen.insert((t.tx_hash.as_slice(), t.sub_id.as_str())) {
            rows.push(t);
        }
    }
    rows.sort_by(|a, b| (a.tx_hash, &a.sub_id).cmp(&(b.tx_hash, &b.sub_id)));

    for chunk in rows.chunks(TRANSFER_CHUNK) {
        let mut vals = Vec::with_capacity(chunk.len());
        for t in chunk {
            vals.push((
                to_i64(t.block_number, "block_number")?,
                t.log_index.map(|l| to_i64(l, "log_index")).transpose()?,
            ));
        }
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
            "INSERT INTO transfers (tx_hash, sub_id, kind, block_number, ts, from_addr, to_addr, \
             asset, amount, token_id, trace_id, log_index) ",
        );
        qb.push_values(chunk.iter().zip(vals), |mut b, (t, (block, log_index))| {
            b.push_bind(t.tx_hash.as_slice().to_vec())
                .push_bind(&t.sub_id)
                .push_bind(t.kind.as_i16())
                .push_bind(block)
                .push_bind(t.ts)
                .push_bind(addr_to_bytes(t.from))
                .push_bind(addr_to_bytes(t.to))
                .push_bind(t.asset.map(addr_to_bytes))
                .push_bind(u256_to_bd(t.amount))
                .push_bind(t.token_id.map(u256_to_bd))
                .push_bind(&t.trace_id)
                .push_bind(log_index);
        });
        qb.push(
            " ON CONFLICT (tx_hash, sub_id) DO UPDATE SET kind = EXCLUDED.kind, \
             block_number = EXCLUDED.block_number, ts = EXCLUDED.ts, \
             from_addr = EXCLUDED.from_addr, to_addr = EXCLUDED.to_addr, \
             asset = EXCLUDED.asset, amount = EXCLUDED.amount, token_id = EXCLUDED.token_id, \
             trace_id = EXCLUDED.trace_id, log_index = EXCLUDED.log_index",
        );
        qb.build().execute(&mut *conn).await?;
    }
    Ok(())
}

/// Merges duplicates field-by-field (later non-null wins, null never erases;
/// the last kind wins) and sorts by address so concurrent writers lock rows in
/// the same order.
pub(crate) fn merge_tokens(tokens: &[TokenInfo]) -> Vec<TokenInfo> {
    let mut merged: HashMap<_, TokenInfo> = HashMap::new();
    for t in tokens {
        match merged.get_mut(&t.address) {
            Some(m) => {
                m.kind = t.kind;
                m.name = t.name.clone().or(m.name.take());
                m.symbol = t.symbol.clone().or(m.symbol.take());
                m.decimals = t.decimals.or(m.decimals);
            }
            None => {
                merged.insert(t.address, t.clone());
            }
        }
    }
    let mut merged: Vec<TokenInfo> = merged.into_values().collect();
    merged.sort_by_key(|t| t.address);
    merged
}

pub(crate) async fn upsert_tokens_conn(
    conn: &mut PgConnection,
    tokens: &[TokenInfo],
) -> Result<()> {
    for t in &merge_tokens(tokens) {
        sqlx::query(
            "INSERT INTO tokens (address, kind, name, symbol, decimals) VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (address) DO UPDATE SET kind = EXCLUDED.kind, \
             name = COALESCE(EXCLUDED.name, tokens.name), \
             symbol = COALESCE(EXCLUDED.symbol, tokens.symbol), \
             decimals = COALESCE(EXCLUDED.decimals, tokens.decimals)",
        )
        .bind(addr_to_bytes(t.address))
        .bind(t.kind.as_i16())
        .bind(&t.name)
        .bind(&t.symbol)
        .bind(t.decimals.map(i16::from))
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}
