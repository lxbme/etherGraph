//! Call-cost estimates: syncs not yet enqueued (for the expansion
//! confirmation) and the calls still ahead of queued jobs.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use eg_core::types::{Address, TransferKind};
use eg_store::{JobKind, JobRow, SyncRow};

use crate::config::IngestConfig;
use crate::enqueue::SyncDirection;
use crate::handlers::{SyncParams, SyncProgress};

#[derive(Clone, Debug, PartialEq)]
pub struct Estimate {
    pub calls: u32,
    pub seconds: f64,
    /// Calls per requested address (0 when it needs none).
    pub per_address: HashMap<Address, u32>,
}

/// Calls a Latest sync makes before paging: `eth_blockNumber` for the head.
const LATEST_HEAD_CALLS: u32 = 1;

/// Lower-bound estimate of provider calls (and time at `rate` calls/s) to
/// bring `addrs` up to date; deeper pages are not counted. `Latest`: the head
/// lookup plus one first page per kind (6) for an address with no sync rows or
/// any row never synced / older than `stale_after`. `Older`: one call per
/// truncated kind.
pub fn estimate(
    addrs: &[Address],
    rows: &[SyncRow],
    dir: SyncDirection,
    now: DateTime<Utc>,
    stale_after: Duration,
    rate: f64,
) -> Estimate {
    let stale = chrono::Duration::from_std(stale_after).unwrap_or(chrono::Duration::MAX);
    let mut per_address = HashMap::new();
    for addr in addrs {
        if per_address.contains_key(addr) {
            continue;
        }
        let own: Vec<&SyncRow> = rows.iter().filter(|r| r.address == *addr).collect();
        let calls = match dir {
            SyncDirection::Latest => {
                let needs = own.is_empty()
                    || own.iter().any(|r| match r.last_synced_at {
                        None => true,
                        Some(t) => now.signed_duration_since(t) > stale,
                    });
                if needs {
                    LATEST_HEAD_CALLS + TransferKind::ALL.len() as u32
                } else {
                    0
                }
            }
            SyncDirection::Older => own.iter().filter(|r| r.truncated).count() as u32,
        };
        per_address.insert(*addr, calls);
    }
    let calls = per_address.values().sum();
    Estimate {
        calls,
        seconds: f64::from(calls) / rate,
        per_address,
    }
}

/// Provider calls `job` still needs (an upper bound for a sync: the kind in
/// progress counts in full). A sync not started yet also looks up the head;
/// each remaining kind costs `ceil(cap / page_size)` pages. Unreadable sync
/// params or progress count as 0: the job fails without calling out.
pub fn remaining_calls(job: &JobRow, cfg: &IngestConfig) -> u32 {
    match job.kind {
        JobKind::SyncAddress => {
            let Ok(p) = serde_json::from_value::<SyncParams>(job.params.clone()) else {
                return 0;
            };
            let kinds = p.kinds().len();
            let (head, done) = match &job.progress {
                None => (LATEST_HEAD_CALLS, 0),
                Some(v) => match serde_json::from_value::<SyncProgress>(v.clone()) {
                    Ok(prog) => (0, prog.kind_index),
                    Err(_) => return 0,
                },
            };
            let kinds = u32::try_from(kinds.saturating_sub(done)).unwrap_or(u32::MAX);
            let cap = p.cap.unwrap_or(cfg.max_records_per_category);
            let pages = cap.div_ceil(cfg.page_size.max(1));
            head.saturating_add(kinds.saturating_mul(pages))
        }
        JobKind::FetchTx => 4,
        JobKind::FetchBlock | JobKind::ResolveNames | JobKind::TokenMeta => 1,
        JobKind::ContractMeta => {
            let n = job.params["addresses"].as_array().map_or(0, Vec::len);
            u32::try_from(n).unwrap_or(u32::MAX).saturating_mul(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use eg_store::SyncState;

    fn now() -> DateTime<Utc> {
        Utc.timestamp_opt(1_700_000_000, 0).unwrap()
    }

    fn row(a: Address, kind: TransferKind, age: Option<i64>, truncated: bool) -> SyncRow {
        SyncRow {
            address: a,
            kind,
            from_block: Some(1),
            to_block: Some(2),
            truncated,
            state: SyncState::Ok,
            last_synced_at: age.map(|s| now() - chrono::Duration::seconds(s)),
        }
    }

    #[test]
    fn estimate_mixed() {
        let (never, fresh, stale, other) = (
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            Address::repeat_byte(3),
            Address::repeat_byte(4),
        );
        let mut rows = Vec::new();
        for k in TransferKind::ALL {
            rows.push(row(fresh, k, Some(10), false));
            rows.push(row(stale, k, Some(10_000), false));
            rows.push(row(other, k, Some(5), false));
        }
        let e = estimate(
            &[never, fresh, stale, other],
            &rows,
            SyncDirection::Latest,
            now(),
            Duration::from_secs(600),
            2.8,
        );
        // eth_blockNumber plus one first page per kind, for `never` and `stale`.
        assert_eq!(e.calls, 12);
        assert!((e.seconds - 12.0 / 2.8).abs() < 1e-9);
        assert_eq!(
            e.per_address,
            HashMap::from([(never, 6), (fresh, 0), (stale, 6), (other, 0)])
        );
    }

    fn job(
        kind: JobKind,
        params: serde_json::Value,
        progress: Option<serde_json::Value>,
    ) -> JobRow {
        JobRow {
            id: 1,
            key: "k".into(),
            kind,
            params,
            priority: eg_core::source::Priority::Background,
            status: eg_store::JobStatus::Pending,
            progress,
            attempts: 0,
            error: None,
            created_at: now(),
            updated_at: now(),
            user_id: None,
        }
    }

    fn sync_params(cap: Option<u32>, kinds: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "address": format!("{:#x}", Address::repeat_byte(1)),
            "direction": "latest",
            "kinds": kinds,
            "cap": cap,
        })
    }

    #[test]
    fn remaining_calls_per_job_kind() {
        let cfg = IngestConfig::default();
        // eth_blockNumber plus one page for each of the five kinds.
        let fresh = job(JobKind::SyncAddress, sync_params(Some(1000), &[]), None);
        assert_eq!(remaining_calls(&fresh, &cfg), 6);
        // Full depth: 10 pages per kind; two of five kinds left once started.
        let progress = serde_json::json!({
            "kind_index": 3,
            "cursor": {"end_block": 9, "page": 2, "fetched": 1000, "min_seen": 5, "skipped": false},
            "head": 9,
            "start_block": 0,
        });
        let started = job(JobKind::SyncAddress, sync_params(None, &[]), Some(progress));
        assert_eq!(remaining_calls(&started, &cfg), 20);
        let broken = job(
            JobKind::SyncAddress,
            sync_params(None, &[]),
            Some(serde_json::json!({"kind_index": "x"})),
        );
        assert_eq!(remaining_calls(&broken, &cfg), 0);
        // A cap that is not a page multiple rounds up; old params have no cap.
        let odd = job(
            JobKind::SyncAddress,
            sync_params(Some(1500), &["native"]),
            None,
        );
        assert_eq!(remaining_calls(&odd, &cfg), 3);
        let legacy = job(
            JobKind::SyncAddress,
            serde_json::json!({"address": format!("{:#x}", Address::repeat_byte(1)),
                "direction": "older", "kinds": ["native", "erc20"]}),
            None,
        );
        assert_eq!(remaining_calls(&legacy, &cfg), 21);
        let addrs = serde_json::json!({"addresses": ["0x01", "0x02", "0x03"]});
        for (kind, params, want) in [
            (JobKind::FetchTx, serde_json::json!({}), 4),
            (JobKind::FetchBlock, serde_json::json!({}), 1),
            (JobKind::ContractMeta, addrs.clone(), 6),
            (JobKind::ResolveNames, addrs.clone(), 1),
            (
                JobKind::TokenMeta,
                serde_json::json!({"tokens": ["0x01"]}),
                1,
            ),
        ] {
            assert_eq!(
                remaining_calls(&job(kind, params, None), &cfg),
                want,
                "{kind:?}"
            );
        }
    }

    #[test]
    fn estimate_older_counts_truncated_kinds() {
        let (a, b) = (Address::repeat_byte(1), Address::repeat_byte(2));
        let rows = vec![
            row(a, TransferKind::Native, Some(1), true),
            row(a, TransferKind::Erc20, Some(1), true),
            row(a, TransferKind::Erc721, Some(1), false),
            row(b, TransferKind::Internal, Some(1), true),
        ];
        let e = estimate(
            &[a, b, Address::repeat_byte(3)],
            &rows,
            SyncDirection::Older,
            now(),
            Duration::from_secs(600),
            2.0,
        );
        assert_eq!(e.calls, 3);
        assert!((e.seconds - 1.5).abs() < 1e-9);
        assert_eq!(
            e.per_address,
            HashMap::from([(a, 2), (b, 1), (Address::repeat_byte(3), 0)])
        );
    }
}
