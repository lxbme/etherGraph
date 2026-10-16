//! Account metadata, ABIs, tokens and ENS names.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, Utc};
use eg_core::source::TokenInfo;
use eg_core::types::{AccountKind, Address, TransferKind, TxHash};
use serde::Serialize;
use sqlx::Row;
use sqlx::postgres::PgRow;

use crate::convert::{addr_to_bytes, bytes_to_addr};
use crate::transfers::upsert_tokens_conn;
use crate::{Result, Store, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountRow {
    pub address: Address,
    pub kind: AccountKind,
    pub contract_name: Option<String>,
    pub is_proxy: bool,
    pub implementation: Option<Address>,
    pub creator: Option<Address>,
    pub creation_tx: Option<TxHash>,
    pub meta_fetched_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnsStatus {
    Ok,
    None,
    Offchain,
    Error,
}

impl EnsStatus {
    fn as_str(self) -> &'static str {
        match self {
            EnsStatus::Ok => "ok",
            EnsStatus::None => "none",
            EnsStatus::Offchain => "offchain",
            EnsStatus::Error => "error",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "ok" => Some(EnsStatus::Ok),
            "none" => Some(EnsStatus::None),
            "offchain" => Some(EnsStatus::Offchain),
            "error" => Some(EnsStatus::Error),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnsRow {
    pub address: Address,
    pub name: Option<String>,
    pub status: EnsStatus,
    pub resolved_at: DateTime<Utc>,
}

type TokenRaw = (Vec<u8>, i16, Option<String>, Option<String>, Option<i16>);
type EnsRaw = (Vec<u8>, Option<String>, String, DateTime<Utc>);

fn kind_str(k: AccountKind) -> &'static str {
    match k {
        AccountKind::Eoa => "eoa",
        AccountKind::Contract => "contract",
        AccountKind::Unknown => "unknown",
    }
}

fn keys(addrs: &[Address]) -> Vec<Vec<u8>> {
    addrs.iter().copied().map(addr_to_bytes).collect()
}

/// Sorts by address and keeps the last occurrence of each address.
fn dedupe_sorted<T>(rows: &[T], addr: impl Fn(&T) -> Address) -> Vec<&T> {
    let mut seen = HashSet::new();
    let mut out: Vec<&T> = rows.iter().rev().filter(|r| seen.insert(addr(r))).collect();
    out.sort_by_key(|r| addr(r));
    out
}

/// Input addresses (deduped, input order) that are not in `fresh`.
fn not_in(addrs: &[Address], fresh: &HashSet<Address>) -> Vec<Address> {
    let mut seen = HashSet::new();
    addrs
        .iter()
        .copied()
        .filter(|a| !fresh.contains(a) && seen.insert(*a))
        .collect()
}

fn account_from_row(r: &PgRow) -> Result<AccountRow> {
    let kind: String = r.try_get("kind")?;
    let creation_tx = r
        .try_get::<Option<Vec<u8>>, _>("creation_tx")?
        .map(|b| {
            TxHash::try_from(b.as_slice())
                .map_err(|_| StoreError::Invalid(format!("creation_tx of {} bytes", b.len())))
        })
        .transpose()?;
    Ok(AccountRow {
        address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
        kind: match kind.as_str() {
            "eoa" => AccountKind::Eoa,
            "contract" => AccountKind::Contract,
            "unknown" => AccountKind::Unknown,
            _ => return Err(StoreError::Invalid(format!("unknown account kind {kind}"))),
        },
        contract_name: r.try_get("contract_name")?,
        is_proxy: r.try_get("is_proxy")?,
        implementation: r
            .try_get::<Option<Vec<u8>>, _>("implementation")?
            .map(|b| bytes_to_addr(&b)),
        creator: r
            .try_get::<Option<Vec<u8>>, _>("creator")?
            .map(|b| bytes_to_addr(&b)),
        creation_tx,
        meta_fetched_at: r
            .try_get::<Option<DateTime<Utc>>, _>("meta_fetched_at")?
            .ok_or_else(|| StoreError::Invalid("account without meta_fetched_at".into()))?,
    })
}

impl Store {
    pub async fn upsert_accounts(&self, rows: &[AccountRow]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for r in dedupe_sorted(rows, |r| r.address) {
            sqlx::query(
                "INSERT INTO accounts (address, kind, contract_name, is_proxy, implementation, \
                 creator, creation_tx, meta_fetched_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
                 ON CONFLICT (address) DO UPDATE SET kind = EXCLUDED.kind, \
                 contract_name = EXCLUDED.contract_name, is_proxy = EXCLUDED.is_proxy, \
                 implementation = EXCLUDED.implementation, creator = EXCLUDED.creator, \
                 creation_tx = EXCLUDED.creation_tx, meta_fetched_at = EXCLUDED.meta_fetched_at",
            )
            .bind(addr_to_bytes(r.address))
            .bind(kind_str(r.kind))
            .bind(&r.contract_name)
            .bind(r.is_proxy)
            .bind(r.implementation.map(addr_to_bytes))
            .bind(r.creator.map(addr_to_bytes))
            .bind(r.creation_tx.map(|h| h.as_slice().to_vec()))
            .bind(r.meta_fetched_at)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn accounts(&self, addrs: &[Address]) -> Result<Vec<AccountRow>> {
        let rows = sqlx::query("SELECT * FROM accounts WHERE address = ANY($1) ORDER BY address")
            .bind(keys(addrs))
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(account_from_row).collect()
    }

    /// Addresses with no account row or whose metadata is older than `ttl`.
    pub async fn addrs_needing_meta(
        &self,
        addrs: &[Address],
        ttl: Duration,
    ) -> Result<Vec<Address>> {
        let fresh: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT address FROM accounts WHERE address = ANY($1) \
             AND meta_fetched_at >= now() - make_interval(secs => $2)",
        )
        .bind(keys(addrs))
        .bind(ttl.as_secs_f64())
        .fetch_all(&self.pool)
        .await?;
        let fresh = fresh.iter().map(|b| bytes_to_addr(b)).collect();
        Ok(not_in(addrs, &fresh))
    }

    /// `None` stores SQL NULL, as does a string that is not valid JSON.
    pub async fn upsert_abi(&self, addr: Address, abi_json: Option<&str>) -> Result<()> {
        let abi: Option<serde_json::Value> = abi_json.and_then(|s| serde_json::from_str(s).ok());
        sqlx::query(
            "INSERT INTO abis (address, abi, fetched_at) VALUES ($1, $2, now()) \
             ON CONFLICT (address) DO UPDATE SET abi = EXCLUDED.abi, fetched_at = now()",
        )
        .bind(addr_to_bytes(addr))
        .bind(abi)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn abis(&self, addrs: &[Address]) -> Result<HashMap<Address, Option<String>>> {
        let rows: Vec<(Vec<u8>, Option<serde_json::Value>)> =
            sqlx::query_as("SELECT address, abi FROM abis WHERE address = ANY($1)")
                .bind(keys(addrs))
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|(a, abi)| (bytes_to_addr(&a), abi.map(|v| v.to_string())))
            .collect())
    }

    pub async fn upsert_tokens(&self, t: &[TokenInfo]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        upsert_tokens_conn(&mut tx, t).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn tokens(&self, addrs: &[Address]) -> Result<Vec<TokenInfo>> {
        let rows: Vec<TokenRaw> = sqlx::query_as(
            "SELECT address, kind, name, symbol, decimals FROM tokens \
             WHERE address = ANY($1) ORDER BY address",
        )
        .bind(keys(addrs))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(a, kind, name, symbol, decimals)| {
                Ok(TokenInfo {
                    address: bytes_to_addr(&a),
                    kind: TransferKind::from_i16(kind)
                        .ok_or_else(|| StoreError::Invalid(format!("unknown kind {kind}")))?,
                    name,
                    symbol,
                    decimals: decimals
                        .map(|d| {
                            u8::try_from(d)
                                .map_err(|_| StoreError::Invalid(format!("decimals {d}")))
                        })
                        .transpose()?,
                })
            })
            .collect()
    }

    /// Addresses with no token row or a NULL `decimals`.
    pub async fn tokens_missing_decimals(&self, addrs: &[Address]) -> Result<Vec<Address>> {
        let known: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT address FROM tokens WHERE address = ANY($1) AND decimals IS NOT NULL",
        )
        .bind(keys(addrs))
        .fetch_all(&self.pool)
        .await?;
        let known = known.iter().map(|b| bytes_to_addr(b)).collect();
        Ok(not_in(addrs, &known))
    }

    pub async fn upsert_ens(&self, rows: &[EnsRow]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for r in dedupe_sorted(rows, |r| r.address) {
            sqlx::query(
                "INSERT INTO ens_names (address, name, status, resolved_at) \
                 VALUES ($1, $2, $3, $4) ON CONFLICT (address) DO UPDATE SET \
                 name = EXCLUDED.name, status = EXCLUDED.status, \
                 resolved_at = EXCLUDED.resolved_at",
            )
            .bind(addr_to_bytes(r.address))
            .bind(&r.name)
            .bind(r.status.as_str())
            .bind(r.resolved_at)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn ens(&self, addrs: &[Address]) -> Result<Vec<EnsRow>> {
        let rows: Vec<EnsRaw> = sqlx::query_as(
            "SELECT address, name, status, resolved_at FROM ens_names \
             WHERE address = ANY($1) ORDER BY address",
        )
        .bind(keys(addrs))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(a, name, status, resolved_at)| {
                Ok(EnsRow {
                    address: bytes_to_addr(&a),
                    name,
                    status: EnsStatus::parse(&status).ok_or_else(|| {
                        StoreError::Invalid(format!("unknown ens status {status}"))
                    })?,
                    resolved_at,
                })
            })
            .collect()
    }

    /// Addresses with no ENS row or one resolved longer ago than `ttl`
    /// (negative results count as resolved).
    pub async fn addrs_needing_ens(
        &self,
        addrs: &[Address],
        ttl: Duration,
    ) -> Result<Vec<Address>> {
        let fresh: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT address FROM ens_names WHERE address = ANY($1) \
             AND resolved_at >= now() - make_interval(secs => $2)",
        )
        .bind(keys(addrs))
        .bind(ttl.as_secs_f64())
        .fetch_all(&self.pool)
        .await?;
        let fresh = fresh.iter().map(|b| bytes_to_addr(b)).collect();
        Ok(not_in(addrs, &fresh))
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::{Duration as CD, Utc};
    use sqlx::PgPool;
    use std::time::Duration;

    fn acct(n: u8, age_days: i64) -> AccountRow {
        AccountRow {
            address: Address::repeat_byte(n),
            kind: eg_core::types::AccountKind::Contract,
            contract_name: Some("C".into()),
            is_proxy: false,
            implementation: None,
            creator: None,
            creation_tx: None,
            meta_fetched_at: Utc::now() - CD::days(age_days),
        }
    }

    #[sqlx::test]
    async fn meta_ttl_selects_missing_and_stale(pool: PgPool) {
        let store = Store::from_pool(pool);
        store
            .upsert_accounts(&[acct(1, 0), acct(2, 8)])
            .await
            .unwrap();
        let ttl = Duration::from_secs(7 * 86400);
        let addrs: Vec<Address> = (1..=3).map(Address::repeat_byte).collect();
        let need = store.addrs_needing_meta(&addrs, ttl).await.unwrap();
        assert_eq!(need, vec![addrs[1], addrs[2]]);
        assert_eq!(store.accounts(&addrs).await.unwrap().len(), 2);
    }

    #[sqlx::test]
    async fn ens_negative_cached(pool: PgPool) {
        let store = Store::from_pool(pool);
        let a = Address::repeat_byte(5);
        store
            .upsert_ens(&[EnsRow {
                address: a,
                name: None,
                status: EnsStatus::None,
                resolved_at: Utc::now(),
            }])
            .await
            .unwrap();
        let ttl = Duration::from_secs(3600);
        assert!(store.addrs_needing_ens(&[a], ttl).await.unwrap().is_empty());
        assert_eq!(store.ens(&[a]).await.unwrap()[0].status, EnsStatus::None);
    }

    #[sqlx::test]
    async fn abi_and_tokens(pool: PgPool) {
        let store = Store::from_pool(pool);
        let a = Address::repeat_byte(7);
        store
            .upsert_abi(a, Some("[{\"type\":\"fallback\"}]"))
            .await
            .unwrap();
        store
            .upsert_abi(Address::repeat_byte(8), Some("not json"))
            .await
            .unwrap();
        let m = store
            .abis(&[a, Address::repeat_byte(8), Address::repeat_byte(9)])
            .await
            .unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[&a].as_deref(), Some("[{\"type\":\"fallback\"}]"));
        assert_eq!(m[&Address::repeat_byte(8)], None);

        let t = |d| eg_core::source::TokenInfo {
            address: a,
            kind: eg_core::types::TransferKind::Erc20,
            name: None,
            symbol: Some("X".into()),
            decimals: d,
        };
        store.upsert_tokens(&[t(None)]).await.unwrap();
        let other = Address::repeat_byte(1);
        assert_eq!(
            store.tokens_missing_decimals(&[other, a]).await.unwrap(),
            vec![other, a]
        );
        store.upsert_tokens(&[t(Some(18))]).await.unwrap();
        assert!(
            store
                .tokens_missing_decimals(&[a])
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.tokens(&[a]).await.unwrap()[0].decimals, Some(18));
    }
}
