//! Edge aggregation around center nodes and keyset-paginated transfer listing.
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use eg_core::filter::{Direction, Edge, EdgeFilter, EdgeQuery, EdgeQueryResult, SortBy};
use eg_core::types::{Address, Transfer, TransferKind, TxHash};
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgRow;
use sqlx::{Postgres, QueryBuilder, Row};

use crate::convert::{addr_to_bytes, bd_to_u256, bytes_to_addr, u256_to_bd};
use crate::{Result, Store, StoreError};

pub enum TransferScope {
    Address(Address),
    Pair { from: Address, to: Address },
}

pub struct TransferQuery {
    pub scope: TransferScope,
    /// `None`: any asset; `Some(None)`: ETH only; `Some(Some(a))`: token `a` only.
    pub asset: Option<Option<Address>>,
    pub filter: EdgeFilter,
    pub cursor: Option<TransferCursor>,
    pub limit: u32,
}

/// Position after the last row of a page in `(ts, tx_hash, sub_id)` descending order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TransferCursor {
    pub ts: DateTime<Utc>,
    pub tx_hash: TxHash,
    pub sub_id: String,
}

impl TransferCursor {
    /// Base64url (no padding) of the JSON form.
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(self).expect("cursor serializes to JSON");
        URL_SAFE_NO_PAD.encode(json)
    }

    /// `None` on any malformed input.
    pub fn decode(s: &str) -> Option<Self> {
        let json = URL_SAFE_NO_PAD.decode(s).ok()?;
        serde_json::from_slice(&json).ok()
    }
}

/// `U256::MAX` in decimal; edge sums saturate here so one spam token cannot
/// make the aggregate unreadable (ranking still uses the uncapped sum).
const U256_MAX_DEC: &str =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const TRANSFER_COLS: &str = "tx_hash, sub_id, kind, block_number, ts, from_addr, to_addr, asset, \
                             amount, token_id, trace_id, log_index, call_index";

/// Appends ` AND ...` conditions for the time range, kinds and per-asset thresholds.
fn push_filter(qb: &mut QueryBuilder<Postgres>, f: &EdgeFilter) {
    if let Some(from) = f.time.from {
        qb.push(" AND ts >= ").push_bind(from);
    }
    if let Some(to) = f.time.to {
        qb.push(" AND ts <= ").push_bind(to);
    }
    if !f.kinds.is_empty() {
        let kinds: Vec<i16> = f.kinds.iter().map(|k| k.as_i16()).collect();
        qb.push(" AND kind = ANY(").push_bind(kinds).push(")");
    }
    if !f.assets.is_empty() {
        qb.push(" AND (");
        for (i, a) in f.assets.iter().enumerate() {
            if i > 0 {
                qb.push(" OR ");
            }
            match a.asset {
                None => qb.push("(asset IS NULL"),
                Some(addr) => qb.push("(asset = ").push_bind(addr_to_bytes(addr)),
            };
            if let Some(min) = a.min_raw {
                qb.push(" AND amount >= ").push_bind(u256_to_bd(min));
            }
            qb.push(")");
        }
        qb.push(")");
    }
}

pub(crate) fn to_u64(v: i64, what: &str) -> Result<u64> {
    u64::try_from(v).map_err(|_| StoreError::Invalid(format!("negative {what} {v}")))
}

pub(crate) fn transfer_from_row(r: &PgRow) -> Result<Transfer> {
    let hash: Vec<u8> = r.try_get("tx_hash")?;
    let kind: i16 = r.try_get("kind")?;
    Ok(Transfer {
        tx_hash: TxHash::try_from(hash.as_slice())
            .map_err(|_| StoreError::Invalid(format!("tx_hash of {} bytes", hash.len())))?,
        sub_id: r.try_get("sub_id")?,
        kind: TransferKind::from_i16(kind)
            .ok_or_else(|| StoreError::Invalid(format!("unknown kind {kind}")))?,
        block_number: to_u64(r.try_get("block_number")?, "block_number")?,
        ts: r.try_get("ts")?,
        from: bytes_to_addr(&r.try_get::<Vec<u8>, _>("from_addr")?),
        to: bytes_to_addr(&r.try_get::<Vec<u8>, _>("to_addr")?),
        asset: r
            .try_get::<Option<Vec<u8>>, _>("asset")?
            .map(|b| bytes_to_addr(&b)),
        amount: bd_to_u256(&r.try_get("amount")?)?,
        token_id: r
            .try_get::<Option<bigdecimal::BigDecimal>, _>("token_id")?
            .map(|v| bd_to_u256(&v))
            .transpose()?,
        trace_id: r.try_get("trace_id")?,
        log_index: r
            .try_get::<Option<i64>, _>("log_index")?
            .map(|v| to_u64(v, "log_index"))
            .transpose()?,
        call_index: r
            .try_get::<Option<i32>, _>("call_index")?
            .map(|v| u32::try_from(v).map_err(|_| StoreError::Invalid(format!("call_index {v}"))))
            .transpose()?,
    })
}

impl Store {
    /// Aggregates transfers touching `q.centers` into `(from, to, asset)` edges,
    /// keeping per center only the top `limit_per_center` neighbours by `q.sort`
    /// (ties by neighbour address ascending). `omitted[center]` counts the
    /// dropped neighbours and is present only when positive.
    pub async fn query_edges(&self, q: &EdgeQuery) -> Result<EdgeQueryResult> {
        if q.centers.is_empty() {
            return Ok(EdgeQueryResult::default());
        }
        let centers: Vec<Vec<u8>> = q.centers.iter().copied().map(addr_to_bytes).collect();
        let limit = i64::from(q.limit_per_center);
        let (out, inb) = match q.filter.direction {
            Direction::Out => (true, false),
            Direction::In => (false, true),
            Direction::Both => (true, true),
        };

        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
            "WITH f AS (SELECT from_addr, to_addr, asset, kind, amount, ts FROM transfers WHERE (",
        );
        if out {
            qb.push("from_addr = ANY(")
                .push_bind(centers.clone())
                .push(")");
        }
        if out && inb {
            qb.push(" OR ");
        }
        if inb {
            qb.push("to_addr = ANY(")
                .push_bind(centers.clone())
                .push(")");
        }
        qb.push(")");
        push_filter(&mut qb, &q.filter);
        // Internal transfers move ETH, so they count as native for `asset_kind`.
        qb.push(format!(
            "), g AS (SELECT from_addr, to_addr, asset, count(*) AS cnt, sum(amount) AS total, \
             min(ts) AS first_ts, max(ts) AS last_ts, \
             max(CASE WHEN kind = {internal} THEN {native}::smallint ELSE kind END) AS asset_kind \
             FROM f GROUP BY 1, 2, 3), \
             p AS (",
            internal = TransferKind::Internal.as_i16(),
            native = TransferKind::Native.as_i16(),
        ));
        if out {
            qb.push(
                "SELECT from_addr AS center, to_addr AS nb, cnt, total, last_ts FROM g \
                 WHERE from_addr = ANY(",
            )
            .push_bind(centers.clone())
            .push(")");
        }
        if out && inb {
            qb.push(" UNION ALL ");
        }
        if inb {
            qb.push(
                "SELECT to_addr AS center, from_addr AS nb, cnt, total, last_ts FROM g \
                 WHERE to_addr = ANY(",
            )
            .push_bind(centers)
            .push(")");
            if out {
                // A self-transfer already appears in the out-branch; count it once.
                qb.push(" AND from_addr <> to_addr");
            }
        }
        let key = match q.sort {
            SortBy::Count => "k_count",
            SortBy::Amount => "k_amount",
            SortBy::Recent => "k_recent",
        };
        qb.push(format!(
            "), r AS (SELECT center, nb, \
             row_number() OVER (PARTITION BY center ORDER BY {key} DESC, nb) AS rk, \
             count(*) OVER (PARTITION BY center) AS n \
             FROM (SELECT center, nb, sum(cnt) AS k_count, sum(total) AS k_amount, \
             max(last_ts) AS k_recent FROM p GROUP BY 1, 2) s) \
             SELECT g.from_addr, g.to_addr, g.asset, g.cnt, LEAST(g.total, {U256_MAX_DEC}) AS total, \
             g.first_ts, g.last_ts, g.asset_kind, \
             NULL::bytea AS center, NULL::bigint AS omitted FROM g \
             WHERE EXISTS (SELECT 1 FROM r WHERE r.rk <= "
        ));
        qb.push_bind(limit).push(" AND (");
        if out {
            qb.push("(r.center = g.from_addr AND r.nb = g.to_addr)");
        }
        if out && inb {
            qb.push(" OR ");
        }
        if inb {
            qb.push("(r.center = g.to_addr AND r.nb = g.from_addr)");
        }
        qb.push(")) UNION ALL SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, center, n - ")
            .push_bind(limit)
            .push(" FROM (SELECT DISTINCT center, n FROM r WHERE n > ")
            .push_bind(limit)
            .push(") o ORDER BY center NULLS FIRST, from_addr, to_addr, asset NULLS FIRST");

        let rows = qb.build().fetch_all(&self.pool).await?;
        let mut res = EdgeQueryResult::default();
        for r in &rows {
            if let Some(center) = r.try_get::<Option<Vec<u8>>, _>("center")? {
                let n: i64 = r.try_get("omitted")?;
                res.omitted
                    .insert(bytes_to_addr(&center), to_u64(n, "omitted")?);
                continue;
            }
            res.edges.push(Edge {
                from: bytes_to_addr(&r.try_get::<Vec<u8>, _>("from_addr")?),
                to: bytes_to_addr(&r.try_get::<Vec<u8>, _>("to_addr")?),
                asset: r
                    .try_get::<Option<Vec<u8>>, _>("asset")?
                    .map(|b| bytes_to_addr(&b)),
                asset_kind: {
                    let k: i16 = r.try_get("asset_kind")?;
                    TransferKind::from_i16(k)
                        .ok_or_else(|| StoreError::Invalid(format!("unknown kind {k}")))?
                },
                count: to_u64(r.try_get("cnt")?, "count")?,
                sum: bd_to_u256(&r.try_get("total")?)?,
                first_ts: r.try_get("first_ts")?,
                last_ts: r.try_get("last_ts")?,
            });
        }
        Ok(res)
    }

    /// Earliest and latest timestamps of transfers sent or received by `addr`;
    /// `None` when there are none.
    pub async fn address_activity(
        &self,
        addr: Address,
    ) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>> {
        let (first, last): (Option<DateTime<Utc>>, Option<DateTime<Utc>>) = sqlx::query_as(
            "SELECT min(ts), max(ts) FROM transfers WHERE from_addr = $1 OR to_addr = $1",
        )
        .bind(addr_to_bytes(addr))
        .fetch_one(&self.pool)
        .await?;
        Ok(first.zip(last))
    }

    /// One page of transfers ordered by `(ts, tx_hash, sub_id)` descending; the
    /// returned cursor is `Some` only when more rows follow.
    pub async fn list_transfers(
        &self,
        q: &TransferQuery,
    ) -> Result<(Vec<Transfer>, Option<TransferCursor>)> {
        let mut qb: QueryBuilder<Postgres> =
            QueryBuilder::new(format!("SELECT {TRANSFER_COLS} FROM transfers WHERE "));
        match q.scope {
            TransferScope::Address(a) => {
                let a = addr_to_bytes(a);
                match q.filter.direction {
                    Direction::Out => qb.push("from_addr = ").push_bind(a),
                    Direction::In => qb.push("to_addr = ").push_bind(a),
                    Direction::Both => qb
                        .push("(from_addr = ")
                        .push_bind(a.clone())
                        .push(" OR to_addr = ")
                        .push_bind(a)
                        .push(")"),
                };
            }
            TransferScope::Pair { from, to } => {
                qb.push("from_addr = ")
                    .push_bind(addr_to_bytes(from))
                    .push(" AND to_addr = ")
                    .push_bind(addr_to_bytes(to));
            }
        }
        match q.asset {
            None => {}
            Some(None) => {
                qb.push(" AND asset IS NULL");
            }
            Some(Some(a)) => {
                qb.push(" AND asset = ").push_bind(addr_to_bytes(a));
            }
        }
        push_filter(&mut qb, &q.filter);
        if let Some(c) = &q.cursor {
            qb.push(" AND (ts, tx_hash, sub_id) < (")
                .push_bind(c.ts)
                .push(", ")
                .push_bind(c.tx_hash.as_slice().to_vec())
                .push(", ")
                .push_bind(c.sub_id.clone())
                .push(")");
        }
        qb.push(" ORDER BY ts DESC, tx_hash DESC, sub_id DESC LIMIT ")
            .push_bind(i64::from(q.limit) + 1);

        let rows = qb.build().fetch_all(&self.pool).await?;
        let mut page = rows
            .iter()
            .map(transfer_from_row)
            .collect::<Result<Vec<_>>>()?;
        let limit = q.limit as usize;
        let next = if page.len() > limit {
            page.truncate(limit);
            page.last().map(|t| TransferCursor {
                ts: t.ts,
                tx_hash: t.tx_hash,
                sub_id: t.sub_id.clone(),
            })
        } else {
            None
        };
        Ok((page, next))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;
    use eg_core::filter::{AssetFilter, Direction, Edge, SortBy, TimeRange};
    use eg_core::types::{TransferKind, assign_sub_ids};
    use sqlx::PgPool;
    use std::collections::HashSet;

    const T0: i64 = 1_700_000_000;
    const C: Address = Address::repeat_byte(0xc0);
    const A: Address = Address::repeat_byte(0xa1);
    const B: Address = Address::repeat_byte(0xb1);
    const D: Address = Address::repeat_byte(0xd1);
    const USDT: Address = Address::repeat_byte(0x55);

    fn at(off: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(T0 + off, 0).unwrap()
    }

    fn e(i: u8) -> Address {
        Address::repeat_byte(0xe0 + i)
    }

    fn tr(
        n: u8,
        from: Address,
        to: Address,
        asset: Option<Address>,
        amt: u64,
        off: i64,
    ) -> Transfer {
        Transfer {
            tx_hash: TxHash::repeat_byte(n),
            sub_id: String::new(),
            kind: if asset.is_some() {
                TransferKind::Erc20
            } else {
                TransferKind::Native
            },
            block_number: 100 + u64::from(n),
            ts: at(off),
            from,
            to,
            asset,
            amount: U256::from(amt),
            token_id: None,
            trace_id: None,
            log_index: None,
            call_index: None,
        }
    }

    /// C→A 3×USDT (100, 200, 5000); C→B 1 ETH; D→C 1 ETH; C→E1..E5 1 ETH each
    /// (E transfers share one timestamp). 10 transfers, 8 neighbours of C.
    async fn seed(pool: &PgPool) -> Store {
        let mut v = vec![
            tr(1, C, A, Some(USDT), 100, 100),
            tr(2, C, A, Some(USDT), 200, 200),
            tr(3, C, A, Some(USDT), 5000, 300),
            tr(4, C, B, None, 7, 400),
            tr(5, D, C, None, 9, 500),
        ];
        for i in 1..=5 {
            v.push(tr(10 + i, C, e(i), None, 1, 600));
        }
        assign_sub_ids(&mut v);
        let store = Store::from_pool(pool.clone());
        store.upsert_transfers(&v).await.unwrap();
        store
    }

    fn query(filter: EdgeFilter, limit: u32, sort: SortBy) -> EdgeQuery {
        EdgeQuery {
            centers: vec![C],
            filter,
            limit_per_center: limit,
            sort,
        }
    }

    fn find(edges: &[Edge], from: Address, to: Address, asset: Option<Address>) -> &Edge {
        edges
            .iter()
            .find(|e| e.from == from && e.to == to && e.asset == asset)
            .expect("edge present")
    }

    fn neighbours(edges: &[Edge]) -> HashSet<Address> {
        edges
            .iter()
            .map(|e| if e.from == C { e.to } else { e.from })
            .collect()
    }

    #[sqlx::test]
    async fn edges_group_by_from_to_asset(pool: PgPool) {
        let store = seed(&pool).await;
        let r = store
            .query_edges(&query(EdgeFilter::default(), 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 8);
        let ca = find(&r.edges, C, A, Some(USDT));
        assert_eq!(ca.count, 3);
        assert_eq!(ca.sum, U256::from(5300));
        assert_eq!((ca.first_ts, ca.last_ts), (at(100), at(300)));
        let dc = find(&r.edges, D, C, None);
        assert_eq!((dc.count, dc.sum), (1, U256::from(9)));
        assert!(r.omitted.is_empty());
    }

    #[sqlx::test]
    async fn filter_direction_out_excludes_inbound(pool: PgPool) {
        let store = seed(&pool).await;
        let out = EdgeFilter {
            direction: Direction::Out,
            ..EdgeFilter::default()
        };
        let r = store
            .query_edges(&query(out, 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 7);
        assert!(r.edges.iter().all(|e| e.from == C));
        assert!(!r.edges.iter().any(|e| e.from == D && e.to == C));

        let inbound = EdgeFilter {
            direction: Direction::In,
            ..EdgeFilter::default()
        };
        let r = store
            .query_edges(&query(inbound, 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 1);
        find(&r.edges, D, C, None);
    }

    #[sqlx::test]
    async fn filter_asset_threshold(pool: PgPool) {
        let store = seed(&pool).await;
        let f = EdgeFilter {
            assets: vec![AssetFilter {
                asset: Some(USDT),
                min_raw: Some(U256::from(1000)),
            }],
            ..EdgeFilter::default()
        };
        let r = store
            .query_edges(&query(f, 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 1);
        let ca = find(&r.edges, C, A, Some(USDT));
        assert_eq!((ca.count, ca.sum), (1, U256::from(5000)));
        assert!(r.edges.iter().all(|e| e.asset.is_some()));

        // ETH threshold 5 keeps B (7) and D (9); USDT without min_raw keeps all 3.
        let f = EdgeFilter {
            assets: vec![
                AssetFilter {
                    asset: None,
                    min_raw: Some(U256::from(5)),
                },
                AssetFilter {
                    asset: Some(USDT),
                    min_raw: None,
                },
            ],
            ..EdgeFilter::default()
        };
        let r = store
            .query_edges(&query(f, 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 3);
        assert_eq!(find(&r.edges, C, A, Some(USDT)).count, 3);
        find(&r.edges, C, B, None);
        find(&r.edges, D, C, None);
    }

    #[sqlx::test]
    async fn filter_time_and_kinds(pool: PgPool) {
        let store = seed(&pool).await;
        let time = TimeRange {
            from: Some(at(150)),
            to: Some(at(400)),
        };
        let f = EdgeFilter {
            time: time.clone(),
            ..EdgeFilter::default()
        };
        let r = store
            .query_edges(&query(f, 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 2);
        let ca = find(&r.edges, C, A, Some(USDT));
        assert_eq!((ca.count, ca.sum), (2, U256::from(5200)));
        assert_eq!(find(&r.edges, C, B, None).count, 1);

        let f = EdgeFilter {
            time,
            kinds: vec![TransferKind::Erc20],
            ..EdgeFilter::default()
        };
        let r = store
            .query_edges(&query(f, 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 1);
        assert_eq!(r.edges[0].asset, Some(USDT));

        let f = EdgeFilter {
            kinds: vec![TransferKind::Native],
            ..EdgeFilter::default()
        };
        let r = store
            .query_edges(&query(f, 100, SortBy::Count))
            .await
            .unwrap();
        assert_eq!(r.edges.len(), 7);
        assert!(r.edges.iter().all(|e| e.asset.is_none()));
    }

    #[sqlx::test]
    async fn limit_per_center_reports_omitted(pool: PgPool) {
        let store = seed(&pool).await;
        let r = store
            .query_edges(&query(EdgeFilter::default(), 3, SortBy::Count))
            .await
            .unwrap();
        // A has count 3; the count-1 ties break by address ascending: B, D.
        assert_eq!(neighbours(&r.edges), HashSet::from([A, B, D]));
        assert_eq!(r.omitted.get(&C), Some(&5));
        assert_eq!(r.omitted.len(), 1);

        let r = store
            .query_edges(&query(EdgeFilter::default(), 1, SortBy::Amount))
            .await
            .unwrap();
        assert_eq!(neighbours(&r.edges), HashSet::from([A]));
        assert_eq!(r.omitted[&C], 7);

        let r = store
            .query_edges(&query(EdgeFilter::default(), 1, SortBy::Recent))
            .await
            .unwrap();
        assert_eq!(neighbours(&r.edges), HashSet::from([e(1)]));

        // A has a single neighbour (C), so nothing is omitted for it.
        let mut q = query(EdgeFilter::default(), 1, SortBy::Count);
        q.centers = vec![C, A];
        let r = store.query_edges(&q).await.unwrap();
        assert_eq!(r.omitted.get(&C), Some(&7));
        assert!(!r.omitted.contains_key(&A));
    }

    fn tq(scope: TransferScope, asset: Option<Option<Address>>, limit: u32) -> TransferQuery {
        TransferQuery {
            scope,
            asset,
            filter: EdgeFilter::default(),
            cursor: None,
            limit,
        }
    }

    #[sqlx::test]
    async fn transfers_pagination_stable(pool: PgPool) {
        let store = seed(&pool).await;
        let (all, next) = store
            .list_transfers(&tq(TransferScope::Address(C), None, 100))
            .await
            .unwrap();
        assert_eq!(all.len(), 10);
        assert!(next.is_none());
        for w in all.windows(2) {
            assert!((w[0].ts, w[0].tx_hash, &w[0].sub_id) > (w[1].ts, w[1].tx_hash, &w[1].sub_id));
        }

        let mut q = tq(TransferScope::Address(C), None, 2);
        let mut paged = Vec::new();
        let mut pages = 0;
        loop {
            let (page, next) = store.list_transfers(&q).await.unwrap();
            assert!(page.len() <= 2);
            pages += 1;
            paged.extend(page);
            match next {
                Some(c) => q.cursor = Some(TransferCursor::decode(&c.encode()).unwrap()),
                None => break,
            }
        }
        assert_eq!(pages, 5);
        assert_eq!(paged, all);
        let keys: HashSet<_> = paged
            .iter()
            .map(|t| (t.tx_hash, t.sub_id.clone()))
            .collect();
        assert_eq!(keys.len(), 10);
    }

    #[sqlx::test]
    async fn transfers_pair_scope_and_eth_only(pool: PgPool) {
        let store = seed(&pool).await;
        let pair = |from, to| TransferScope::Pair { from, to };

        let (v, _) = store
            .list_transfers(&tq(pair(C, A), None, 100))
            .await
            .unwrap();
        assert_eq!(v.len(), 3);
        assert!(v.iter().all(|t| t.from == C && t.to == A));
        assert_eq!(v[0].amount, U256::from(5000));
        assert_eq!(v[0].kind, TransferKind::Erc20);
        assert_eq!(v[0].asset, Some(USDT));
        assert_eq!(v[0].block_number, 103);

        let (v, _) = store
            .list_transfers(&tq(pair(A, C), None, 100))
            .await
            .unwrap();
        assert!(v.is_empty());

        let (v, _) = store
            .list_transfers(&tq(TransferScope::Address(C), Some(None), 100))
            .await
            .unwrap();
        assert_eq!(v.len(), 7);
        assert!(v.iter().all(|t| t.asset.is_none()));

        let (v, _) = store
            .list_transfers(&tq(pair(C, A), Some(None), 100))
            .await
            .unwrap();
        assert!(v.is_empty());

        let (v, _) = store
            .list_transfers(&tq(TransferScope::Address(C), Some(Some(USDT)), 100))
            .await
            .unwrap();
        assert_eq!(v.len(), 3);

        // Direction applies to Address scope; asset thresholds from the filter apply too.
        let mut q = tq(TransferScope::Address(C), None, 100);
        q.filter.direction = Direction::In;
        let (v, _) = store.list_transfers(&q).await.unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].from, D);

        let mut q = tq(TransferScope::Address(C), None, 100);
        q.filter.assets = vec![AssetFilter {
            asset: Some(USDT),
            min_raw: Some(U256::from(150)),
        }];
        q.filter.time.to = Some(at(250));
        let (v, _) = store.list_transfers(&q).await.unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].amount, U256::from(200));
    }

    #[sqlx::test]
    async fn self_transfer_counted_once_in_ranking(pool: PgPool) {
        // S sorts below A, so a double-counted self pair (2) would tie A (2) and win.
        let s = Address::repeat_byte(0x01);
        let mut v = vec![
            tr(1, s, s, None, 0, 100),
            tr(2, s, A, None, 1, 200),
            tr(3, A, s, None, 1, 300),
        ];
        assign_sub_ids(&mut v);
        let store = Store::from_pool(pool);
        store.upsert_transfers(&v).await.unwrap();
        let mut q = query(EdgeFilter::default(), 1, SortBy::Count);
        q.centers = vec![s];

        let r = store.query_edges(&q).await.unwrap();
        assert_eq!(r.edges.len(), 2);
        assert!(r.edges.iter().all(|e| e.from != e.to));
        assert_eq!(r.omitted.get(&s), Some(&1));

        q.limit_per_center = 2;
        let r = store.query_edges(&q).await.unwrap();
        assert_eq!(r.edges.len(), 3);
        let ss = find(&r.edges, s, s, None);
        assert_eq!(ss.count, 1);
        assert!(r.omitted.is_empty());
    }

    #[sqlx::test]
    async fn edge_sum_saturates_at_u256_max(pool: PgPool) {
        let mut v = vec![
            tr(1, C, A, Some(USDT), 0, 100),
            tr(2, C, A, Some(USDT), 0, 200),
        ];
        for t in &mut v {
            t.amount = U256::MAX;
        }
        assign_sub_ids(&mut v);
        let store = Store::from_pool(pool);
        store.upsert_transfers(&v).await.unwrap();
        let r = store
            .query_edges(&query(EdgeFilter::default(), 10, SortBy::Amount))
            .await
            .unwrap();
        let ca = find(&r.edges, C, A, Some(USDT));
        assert_eq!((ca.count, ca.sum), (2, U256::MAX));
        assert_eq!(U256_MAX_DEC, U256::MAX.to_string());
    }

    #[sqlx::test]
    async fn edges_report_asset_kind(pool: PgPool) {
        let nft = Address::repeat_byte(0x77);
        let multi = Address::repeat_byte(0x78);
        let mut v = vec![
            tr(1, C, A, None, 1, 100),
            tr(2, C, B, Some(USDT), 1, 100),
            tr(3, C, D, Some(nft), 1, 100),
            tr(4, C, e(1), Some(multi), 1, 100),
            tr(5, C, e(2), None, 1, 100),
        ];
        v[2].kind = TransferKind::Erc721;
        v[3].kind = TransferKind::Erc1155;
        v[4].kind = TransferKind::Internal;
        assign_sub_ids(&mut v);
        let store = Store::from_pool(pool);
        store.upsert_transfers(&v).await.unwrap();
        let r = store
            .query_edges(&query(EdgeFilter::default(), 100, SortBy::Count))
            .await
            .unwrap();
        let kind = |to, asset| find(&r.edges, C, to, asset).asset_kind;
        assert_eq!(kind(A, None), TransferKind::Native);
        assert_eq!(kind(B, Some(USDT)), TransferKind::Erc20);
        assert_eq!(kind(D, Some(nft)), TransferKind::Erc721);
        assert_eq!(kind(e(1), Some(multi)), TransferKind::Erc1155);
        // Internal ETH transfers count as native for the edge's asset kind.
        assert_eq!(kind(e(2), None), TransferKind::Native);
    }

    #[sqlx::test]
    async fn address_activity_spans_both_directions(pool: PgPool) {
        let store = seed(&pool).await;
        assert_eq!(
            store.address_activity(C).await.unwrap(),
            Some((at(100), at(600)))
        );
        assert_eq!(
            store.address_activity(D).await.unwrap(),
            Some((at(500), at(500)))
        );
        assert_eq!(store.address_activity(e(9)).await.unwrap(), None);
    }

    #[test]
    fn cursor_roundtrip() {
        let c = TransferCursor {
            ts: at(42),
            tx_hash: TxHash::repeat_byte(0xfe),
            sub_id: "erc20:0xab:0x1:0x2:5:-:0".into(),
        };
        let s = c.encode();
        assert!(!s.contains(['=', '+', '/']));
        assert_eq!(TransferCursor::decode(&s), Some(c));
        assert_eq!(TransferCursor::decode("!!!"), None);
        assert_eq!(TransferCursor::decode(""), None);
        assert_eq!(TransferCursor::decode("bm90IGpzb24"), None); // "not json"
    }
}
