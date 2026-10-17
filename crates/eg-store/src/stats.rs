//! Probe cache, job ownership by batch, transfer counts and counterparty aggregation.
use std::collections::HashMap;

use alloy_primitives::U256;
use chrono::{DateTime, Utc};
use eg_core::filter::{Direction, EdgeFilter};
use eg_core::types::Address;
use sqlx::{Postgres, QueryBuilder, Row};

use crate::convert::{addr_to_bytes, bd_to_u256, bytes_to_addr, u256_to_bd};
use crate::edges::{push_filter, to_u64};
use crate::jobs::cancel_ids;
use crate::{JobKind, JobStatus, Result, Store, StoreError};

/// Per-address upper bound for [`Store::transfer_counts`].
const COUNT_CAP: i64 = 100_000;
/// Most assets reported per counterparty.
const MAX_ASSETS: usize = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatsRow {
    pub address: Address,
    pub nonce: Option<u64>,
    pub balance: Option<U256>,
    pub is_contract: Option<bool>,
    pub probed_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CounterpartySort {
    CountAsc,
    CountDesc,
    Recent,
}

/// `Eoa` also matches unknown accounts and addresses without an `accounts` row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountKindFilter {
    Eoa,
    Contract,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CounterpartyRow {
    pub address: Address,
    pub count: u64,
    pub last_ts: DateTime<Utc>,
    pub assets: Vec<Option<Address>>,
}

impl Store {
    pub async fn account_stats(&self, addrs: &[Address]) -> Result<Vec<StatsRow>> {
        if addrs.is_empty() {
            return Ok(Vec::new());
        }
        let keys: Vec<Vec<u8>> = addrs.iter().copied().map(addr_to_bytes).collect();
        let rows = sqlx::query(
            "SELECT address, nonce, balance, is_contract, probed_at FROM account_stats \
             WHERE address = ANY($1) ORDER BY address",
        )
        .bind(keys)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok(StatsRow {
                    address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("address")?),
                    nonce: r
                        .try_get::<Option<i64>, _>("nonce")?
                        .map(|v| to_u64(v, "nonce"))
                        .transpose()?,
                    balance: r
                        .try_get::<Option<bigdecimal::BigDecimal>, _>("balance")?
                        .map(|v| bd_to_u256(&v))
                        .transpose()?,
                    is_contract: r.try_get("is_contract")?,
                    probed_at: r.try_get("probed_at")?,
                })
            })
            .collect()
    }

    /// Inserts or replaces each row; the last occurrence of a duplicate address wins.
    pub async fn upsert_account_stats(&self, rows: &[StatsRow]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for r in rows {
            let nonce = r
                .nonce
                .map(|n| {
                    i64::try_from(n)
                        .map_err(|_| StoreError::Invalid(format!("nonce {n} exceeds i64")))
                })
                .transpose()?;
            sqlx::query(
                "INSERT INTO account_stats (address, nonce, balance, is_contract, probed_at) \
                 VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT (address) DO UPDATE SET nonce = EXCLUDED.nonce, \
                 balance = EXCLUDED.balance, is_contract = EXCLUDED.is_contract, \
                 probed_at = EXCLUDED.probed_at",
            )
            .bind(addr_to_bytes(r.address))
            .bind(nonce)
            .bind(r.balance.map(u256_to_bd))
            .bind(r.is_contract)
            .bind(r.probed_at)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Transfers sent or received per address (a self-transfer counts once),
    /// each address counted only up to 100000 so a huge address stays cheap.
    /// Addresses without transfers map to 0.
    pub async fn transfer_counts(&self, addrs: &[Address]) -> Result<HashMap<Address, u64>> {
        if addrs.is_empty() {
            return Ok(HashMap::new());
        }
        let keys: Vec<Vec<u8>> = addrs.iter().copied().map(addr_to_bytes).collect();
        let rows: Vec<(Vec<u8>, i64)> = sqlx::query_as(
            "SELECT a, LEAST(( \
                 SELECT count(*) FROM (SELECT 1 FROM transfers WHERE from_addr = a LIMIT $2) x \
             ) + ( \
                 SELECT count(*) FROM (SELECT 1 FROM transfers \
                 WHERE to_addr = a AND from_addr <> a LIMIT $2) y \
             ), $2)::bigint AS n FROM unnest($1::bytea[]) AS a",
        )
        .bind(keys)
        .bind(COUNT_CAP)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|(a, n)| Ok((bytes_to_addr(&a), to_u64(n, "count")?)))
            .collect()
    }

    /// Records that `batch` (or, for `None`, a batch-less caller) owns the job,
    /// if it is still active; a running job's pending cancellation is withdrawn
    /// since it has an owner again. Returns `false`, recording nothing, when the
    /// job has finished or was cancelled. Adding an existing owner is a no-op.
    ///
    /// The owner row goes in first: its foreign-key check share-locks the job,
    /// so this either commits before a concurrent [`Store::release_batch`]
    /// locks the job (which then sees the owner), or waits for it and then
    /// finds the job cancelled.
    pub async fn add_job_owner(&self, job_id: i64, batch: Option<&str>) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO job_owners (job_id, batch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(job_id)
        .bind(batch)
        .execute(&mut *tx)
        .await?;
        let live: Option<i64> = sqlx::query_scalar(
            "UPDATE jobs SET cancel_requested = false \
             WHERE id = $1 AND status IN ('pending', 'running', 'paused_quota') RETURNING id",
        )
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?;
        if live.is_none() {
            tx.rollback().await?;
            return Ok(false);
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Named batches owning each job (batch-less owners are not listed).
    pub async fn job_batches(&self, ids: &[i64]) -> Result<HashMap<i64, Vec<String>>> {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT job_id, batch_id FROM job_owners \
             WHERE job_id = ANY($1) AND batch_id IS NOT NULL ORDER BY job_id, batch_id",
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await?;
        let mut out: HashMap<i64, Vec<String>> = HashMap::new();
        for (id, b) in rows {
            out.entry(id).or_default().push(b);
        }
        Ok(out)
    }

    /// Drops `batch`'s ownership and cancels (as [`Store::cancel_job`]) the
    /// active jobs it leaves with no owner at all; a batch-less owner still
    /// counts as an owner. Returns each cancelled job's id, kind and resulting
    /// status, by id.
    pub async fn release_batch(&self, batch: &str) -> Result<Vec<(i64, JobKind, JobStatus)>> {
        let mut tx = self.pool.begin().await?;
        let released: Vec<i64> =
            sqlx::query_scalar("DELETE FROM job_owners WHERE batch_id = $1 RETURNING job_id")
                .bind(batch)
                .fetch_all(&mut *tx)
                .await?;
        // A new owner's foreign-key check share-locks its job row, so after
        // this lock every owner added concurrently is either committed (and
        // seen by the next statement's fresh snapshot) or waits for this
        // transaction, i.e. joins a job that is already cancelled.
        sqlx::query("SELECT 1 FROM jobs WHERE id = ANY($1) ORDER BY id FOR UPDATE")
            .bind(&released)
            .execute(&mut *tx)
            .await?;
        let orphans: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM jobs WHERE id = ANY($1) \
             AND NOT EXISTS (SELECT 1 FROM job_owners o WHERE o.job_id = jobs.id) \
             ORDER BY id",
        )
        .bind(&released)
        .fetch_all(&mut *tx)
        .await?;
        let out = cancel_ids(&mut tx, &orphans).await?;
        tx.commit().await?;
        Ok(out)
    }

    /// Neighbours of `addr` grouped by address, filtered like edges (and by
    /// account kind), sorted and paged; also returns the total neighbour count.
    pub async fn counterparties(
        &self,
        addr: Address,
        filter: &EdgeFilter,
        kind: Option<AccountKindFilter>,
        sort: CounterpartySort,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<CounterpartyRow>, u64)> {
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("");
        push_counterparty_cte(&mut qb, addr, filter, kind);
        qb.push(match sort {
            CounterpartySort::CountAsc => " SELECT * FROM h ORDER BY cnt ASC, nb ASC",
            CounterpartySort::CountDesc => " SELECT * FROM h ORDER BY cnt DESC, nb ASC",
            CounterpartySort::Recent => " SELECT * FROM h ORDER BY last_ts DESC, nb ASC",
        });
        qb.push(" LIMIT ")
            .push_bind(i64::from(limit))
            .push(" OFFSET ")
            .push_bind(i64::from(offset));
        let rows = qb.build().fetch_all(&self.pool).await?;
        let page = rows
            .iter()
            .map(|r| {
                Ok(CounterpartyRow {
                    address: bytes_to_addr(&r.try_get::<Vec<u8>, _>("nb")?),
                    count: to_u64(r.try_get("cnt")?, "count")?,
                    last_ts: r.try_get("last_ts")?,
                    assets: r
                        .try_get::<Vec<Option<Vec<u8>>>, _>("assets")?
                        .into_iter()
                        .map(|o| o.map(|b| bytes_to_addr(&b)))
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        // A short, non-empty page ends the list, so the total is known
        // without aggregating a second time.
        let total = if !page.is_empty() && (page.len() as u64) < u64::from(limit) {
            u64::from(offset) + page.len() as u64
        } else {
            let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("");
            push_counterparty_cte(&mut qb, addr, filter, kind);
            qb.push(" SELECT count(*) FROM h");
            to_u64(
                qb.build_query_scalar::<i64>().fetch_one(&self.pool).await?,
                "total",
            )?
        };
        Ok((page, total))
    }
}

/// Appends `WITH p AS (...), g AS (...), h AS (...)`: `p` the address's
/// transfers (one branch per direction so each uses its own index), `g` those
/// grouped per neighbour, `h` the kind-filtered neighbours.
fn push_counterparty_cte(
    qb: &mut QueryBuilder<Postgres>,
    addr: Address,
    filter: &EdgeFilter,
    kind: Option<AccountKindFilter>,
) {
    let a = addr_to_bytes(addr);
    let (out, inb) = match filter.direction {
        Direction::Out => (true, false),
        Direction::In => (false, true),
        Direction::Both => (true, true),
    };
    qb.push("WITH p AS (");
    if out {
        qb.push("SELECT to_addr AS nb, asset, ts FROM transfers WHERE from_addr = ")
            .push_bind(a.clone());
        push_filter(qb, filter);
    }
    if out && inb {
        qb.push(" UNION ALL ");
    }
    if inb {
        qb.push("SELECT from_addr AS nb, asset, ts FROM transfers WHERE to_addr = ")
            .push_bind(a.clone());
        push_filter(qb, filter);
    }
    qb.push(
        "), g AS (SELECT nb, count(*) AS cnt, max(ts) AS last_ts, \
         (array_agg(DISTINCT asset))[1:",
    )
    .push(MAX_ASSETS.to_string())
    .push("] AS assets FROM p WHERE nb <> ")
    .push_bind(a)
    .push(" GROUP BY nb), h AS (SELECT * FROM g");
    match kind {
        None => {}
        Some(AccountKindFilter::Contract) => {
            qb.push(
                " WHERE EXISTS (SELECT 1 FROM accounts c \
                 WHERE c.address = g.nb AND c.kind = 'contract')",
            );
        }
        Some(AccountKindFilter::Eoa) => {
            qb.push(
                " WHERE NOT EXISTS (SELECT 1 FROM accounts c \
                 WHERE c.address = g.nb AND c.kind = 'contract')",
            );
        }
    }
    qb.push(")");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NewJob;
    use alloy_primitives::B256;
    use eg_core::source::Priority;
    use eg_core::types::{Transfer, TransferKind};
    use sqlx::PgPool;

    fn ts(secs: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_700_000_000 + secs, 0).unwrap()
    }

    fn a(n: u8) -> Address {
        Address::repeat_byte(n)
    }

    fn tr(id: u16, from: Address, to: Address, asset: Option<Address>, at: i64) -> Transfer {
        let mut h = [0u8; 32];
        h[..2].copy_from_slice(&id.to_be_bytes());
        Transfer {
            tx_hash: B256::from(h),
            sub_id: String::new(),
            kind: if asset.is_some() {
                TransferKind::Erc20
            } else {
                TransferKind::Native
            },
            block_number: 100,
            ts: ts(at),
            from,
            to,
            asset,
            amount: U256::from(1),
            token_id: None,
            trace_id: None,
            log_index: asset.map(|_| 0),
            call_index: None,
        }
    }

    async fn job(s: &Store, key: &str, p: Priority) -> i64 {
        s.enqueue(&NewJob {
            key: key.into(),
            kind: JobKind::SyncAddress,
            params: serde_json::json!({}),
            priority: p,
        })
        .await
        .unwrap()
        .0
    }

    #[sqlx::test]
    async fn release_batch_keeps_jobs_with_other_owners(pool: PgPool) {
        let s = Store::from_pool(pool);
        let j1 = job(&s, "j1", Priority::Background).await;
        let j2 = job(&s, "j2", Priority::Background).await;
        let j3 = job(&s, "j3", Priority::Background).await;
        s.add_job_owner(j1, Some("b1")).await.unwrap();
        s.add_job_owner(j2, Some("b1")).await.unwrap();
        s.add_job_owner(j2, Some("b2")).await.unwrap();
        s.add_job_owner(j3, Some("b1")).await.unwrap();
        s.add_job_owner(j3, None).await.unwrap();
        // Adding the same owner twice is a no-op.
        s.add_job_owner(j1, Some("b1")).await.unwrap();
        s.add_job_owner(j3, None).await.unwrap();
        let batches = s.job_batches(&[j1, j2, j3]).await.unwrap();
        assert_eq!(batches[&j1], vec!["b1".to_string()]);
        assert_eq!(batches[&j2], vec!["b1".to_string(), "b2".to_string()]);
        assert_eq!(batches[&j3], vec!["b1".to_string()]);
        assert_eq!(
            s.release_batch("b1").await.unwrap(),
            vec![(j1, JobKind::SyncAddress, JobStatus::Cancelled)]
        );
        assert_eq!(
            s.job(j1).await.unwrap().unwrap().status,
            JobStatus::Cancelled
        );
        assert_eq!(s.job(j2).await.unwrap().unwrap().status, JobStatus::Pending);
        // The batch is gone; a second release finds nothing.
        assert!(s.release_batch("b1").await.unwrap().is_empty());
        assert_eq!(
            s.release_batch("b2").await.unwrap(),
            vec![(j2, JobKind::SyncAddress, JobStatus::Cancelled)]
        );
        assert_eq!(s.job(j3).await.unwrap().unwrap().status, JobStatus::Pending);
    }

    #[sqlx::test]
    async fn release_batch_ignores_finished_jobs(pool: PgPool) {
        let s = Store::from_pool(pool);
        let j = job(&s, "j", Priority::Background).await;
        s.add_job_owner(j, Some("b")).await.unwrap();
        let claimed = s.claim_next().await.unwrap().unwrap();
        s.complete_job(claimed.id).await.unwrap();
        assert!(s.release_batch("b").await.unwrap().is_empty());
    }

    #[sqlx::test]
    async fn release_batch_returns_running_and_paused_jobs(pool: PgPool) {
        let s = Store::from_pool(pool);
        let j1 = job(&s, "j1", Priority::Background).await;
        let j2 = job(&s, "j2", Priority::Background).await;
        s.add_job_owner(j1, Some("b")).await.unwrap();
        s.add_job_owner(j2, Some("b")).await.unwrap();
        s.claim_next().await.unwrap().unwrap();
        let second = s.claim_next().await.unwrap().unwrap();
        s.pause_job_quota(second.id).await.unwrap();
        // The running job is only flagged; the paused one is cancelled.
        assert_eq!(
            s.release_batch("b").await.unwrap(),
            vec![
                (j1, JobKind::SyncAddress, JobStatus::Running),
                (j2, JobKind::SyncAddress, JobStatus::Cancelled)
            ]
        );
        assert!(s.cancel_requested(j1).await.unwrap());
    }

    #[sqlx::test]
    async fn add_job_owner_refuses_finished_jobs_and_revives_flagged_ones(pool: PgPool) {
        let s = Store::from_pool(pool);
        let running = job(&s, "running", Priority::Background).await;
        let pending = job(&s, "pending", Priority::Background).await;
        assert!(s.add_job_owner(running, Some("b1")).await.unwrap());
        assert!(s.add_job_owner(pending, Some("b1")).await.unwrap());
        assert_eq!(s.claim_next().await.unwrap().unwrap().id, running);
        // b1 goes: the pending job is cancelled, the running one only flagged.
        s.release_batch("b1").await.unwrap();
        assert!(s.cancel_requested(running).await.unwrap());
        // A request that found the cancelled job by key must not join it.
        assert!(!s.add_job_owner(pending, Some("b2")).await.unwrap());
        assert!(s.job_batches(&[pending]).await.unwrap().is_empty());
        // A new owner of the still-running job withdraws its cancellation.
        assert!(s.add_job_owner(running, Some("b2")).await.unwrap());
        assert!(!s.cancel_requested(running).await.unwrap());
        assert_eq!(
            s.job_batches(&[running]).await.unwrap()[&running],
            vec!["b2".to_string()]
        );
    }

    #[sqlx::test]
    async fn release_batch_waits_for_a_concurrent_owner(pool: PgPool) {
        let s = Store::from_pool(pool.clone());
        let j = job(&s, "j", Priority::Background).await;
        s.add_job_owner(j, Some("b")).await.unwrap();
        // A concurrent sync request joins the job; its insert is not committed yet.
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO job_owners (job_id, batch_id) VALUES ($1, NULL)")
            .bind(j)
            .execute(&mut *tx)
            .await
            .unwrap();
        let release = tokio::spawn({
            let s = s.clone();
            async move { s.release_batch("b").await.unwrap() }
        });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(
            !release.is_finished(),
            "release must wait for the new owner"
        );
        tx.commit().await.unwrap();
        assert!(release.await.unwrap().is_empty());
        assert_eq!(s.job(j).await.unwrap().unwrap().status, JobStatus::Pending);
    }

    #[sqlx::test]
    async fn cancel_background_spares_interactive(pool: PgPool) {
        let s = Store::from_pool(pool);
        let hi = job(&s, "hi", Priority::Interactive).await;
        let bg = job(&s, "bg", Priority::Background).await;
        let low = job(&s, "low", Priority::Low).await;
        // Claim the interactive job so it is running; it must be left alone.
        assert_eq!(s.claim_next().await.unwrap().unwrap().id, hi);
        let mut got = s.cancel_background().await.unwrap();
        got.sort_by_key(|g| g.0);
        assert_eq!(
            got,
            vec![
                (bg, JobKind::SyncAddress, JobStatus::Cancelled),
                (low, JobKind::SyncAddress, JobStatus::Cancelled)
            ]
        );
        assert!(!s.cancel_requested(hi).await.unwrap());
        assert!(s.cancel_background().await.unwrap().is_empty());
    }

    #[sqlx::test]
    async fn counterparties_sorts_and_pages(pool: PgPool) {
        let s = Store::from_pool(pool);
        let me = a(1);
        let mut v = Vec::new();
        let mut id = 0;
        // Counterparty n (2..=6) has n-1 transfers; the last one is at time n.
        for n in 2u8..=6 {
            for i in 0..(n - 1) {
                id += 1;
                let (f, t) = if i % 2 == 0 { (me, a(n)) } else { (a(n), me) };
                v.push(tr(id, f, t, None, i64::from(n)));
            }
        }
        eg_core::types::assign_sub_ids(&mut v);
        s.upsert_transfers(&v).await.unwrap();
        let f = EdgeFilter::default();
        let (rows, total) = s
            .counterparties(me, &f, None, CounterpartySort::CountAsc, 2, 2)
            .await
            .unwrap();
        assert_eq!(total, 5);
        assert_eq!(
            rows.iter()
                .map(|r| (r.address, r.count))
                .collect::<Vec<_>>(),
            vec![(a(4), 3), (a(5), 4)]
        );
        let (rows, total) = s
            .counterparties(me, &f, None, CounterpartySort::CountDesc, 2, 0)
            .await
            .unwrap();
        assert_eq!((rows[0].count, rows[1].count, total), (5, 4, 5));
        let (rows, _) = s
            .counterparties(me, &f, None, CounterpartySort::Recent, 10, 0)
            .await
            .unwrap();
        assert_eq!(rows.first().unwrap().address, a(6));
        assert_eq!(rows.last().unwrap().last_ts, ts(2));
        // An offset past the end still reports the total.
        let (rows, total) = s
            .counterparties(me, &f, None, CounterpartySort::CountAsc, 2, 50)
            .await
            .unwrap();
        assert!(rows.is_empty());
        assert_eq!(total, 5);
        // Direction filter: only outgoing transfers.
        let out = EdgeFilter {
            direction: Direction::Out,
            ..EdgeFilter::default()
        };
        let (rows, total) = s
            .counterparties(me, &out, None, CounterpartySort::CountDesc, 10, 0)
            .await
            .unwrap();
        assert_eq!(total, 5);
        assert_eq!(rows[0].count, 3);
    }

    #[sqlx::test]
    async fn counterparties_ties_by_address_and_assets_capped(pool: PgPool) {
        let s = Store::from_pool(pool);
        let me = a(1);
        let mut v = vec![tr(1, me, a(9), None, 1), tr(2, me, a(8), None, 1)];
        for k in 0..7u8 {
            v.push(tr(10 + u16::from(k), me, a(7), Some(a(0x20 + k)), 1));
        }
        v.push(tr(30, me, a(7), None, 1));
        v.push(tr(31, me, me, None, 1));
        eg_core::types::assign_sub_ids(&mut v);
        s.upsert_transfers(&v).await.unwrap();
        let (rows, total) = s
            .counterparties(
                me,
                &EdgeFilter::default(),
                None,
                CounterpartySort::CountAsc,
                10,
                0,
            )
            .await
            .unwrap();
        // The self-transfer is not a counterparty.
        assert_eq!(total, 3);
        assert_eq!(
            rows.iter().map(|r| r.address).collect::<Vec<_>>(),
            vec![a(8), a(9), a(7)]
        );
        assert_eq!(rows[2].count, 8);
        assert_eq!(rows[2].assets.len(), 5);
    }

    #[sqlx::test]
    async fn counterparties_kind_filter(pool: PgPool) {
        let s = Store::from_pool(pool.clone());
        let me = a(1);
        let mut v = vec![
            tr(1, me, a(2), None, 1),
            tr(2, me, a(3), None, 1),
            tr(3, me, a(4), None, 1),
            tr(4, me, a(5), None, 1),
        ];
        eg_core::types::assign_sub_ids(&mut v);
        s.upsert_transfers(&v).await.unwrap();
        // a(2) contract, a(3) eoa, a(4) unknown, a(5) has no accounts row.
        for (n, k) in [(2u8, "contract"), (3, "eoa"), (4, "unknown")] {
            sqlx::query("INSERT INTO accounts (address, kind) VALUES ($1, $2)")
                .bind(addr_to_bytes(a(n)))
                .bind(k)
                .execute(&pool)
                .await
                .unwrap();
        }
        let f = EdgeFilter::default();
        let sort = CounterpartySort::CountAsc;
        let (rows, total) = s
            .counterparties(me, &f, Some(AccountKindFilter::Eoa), sort, 10, 0)
            .await
            .unwrap();
        assert_eq!(total, 3);
        assert_eq!(
            rows.iter().map(|r| r.address).collect::<Vec<_>>(),
            vec![a(3), a(4), a(5)]
        );
        let (rows, total) = s
            .counterparties(me, &f, Some(AccountKindFilter::Contract), sort, 10, 0)
            .await
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0].address, a(2));
        let (_, total) = s.counterparties(me, &f, None, sort, 10, 0).await.unwrap();
        assert_eq!(total, 4);
    }

    #[sqlx::test]
    async fn transfer_counts_is_capped(pool: PgPool) {
        let s = Store::from_pool(pool);
        let mut v = vec![
            tr(1, a(1), a(2), None, 1),
            tr(2, a(3), a(1), None, 2),
            tr(3, a(1), a(1), None, 3),
        ];
        eg_core::types::assign_sub_ids(&mut v);
        s.upsert_transfers(&v).await.unwrap();
        let c = s.transfer_counts(&[a(1), a(2), a(9)]).await.unwrap();
        assert_eq!((c[&a(1)], c[&a(2)], c[&a(9)]), (3, 1, 0));
        assert!(s.transfer_counts(&[]).await.unwrap().is_empty());
    }

    #[sqlx::test]
    async fn account_stats_roundtrip(pool: PgPool) {
        let s = Store::from_pool(pool);
        let full = StatsRow {
            address: a(1),
            nonce: Some(7),
            balance: Some(U256::MAX),
            is_contract: Some(false),
            probed_at: ts(0),
        };
        let sparse = StatsRow {
            address: a(2),
            nonce: None,
            balance: None,
            is_contract: Some(true),
            probed_at: ts(5),
        };
        s.upsert_account_stats(&[full.clone(), sparse.clone()])
            .await
            .unwrap();
        assert_eq!(
            s.account_stats(&[a(2), a(1), a(3)]).await.unwrap(),
            vec![full.clone(), sparse]
        );
        let newer = StatsRow {
            nonce: Some(8),
            probed_at: ts(9),
            ..full
        };
        s.upsert_account_stats(std::slice::from_ref(&newer))
            .await
            .unwrap();
        assert_eq!(s.account_stats(&[a(1)]).await.unwrap(), vec![newer]);
        assert!(s.account_stats(&[]).await.unwrap().is_empty());
    }
}
