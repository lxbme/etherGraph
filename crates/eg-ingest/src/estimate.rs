//! Call-cost estimate for the 2-hop expansion confirmation.

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use eg_core::types::{Address, TransferKind};
use eg_store::SyncRow;

use crate::enqueue::SyncDirection;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Estimate {
    pub calls: u32,
    pub seconds: f64,
}

/// Estimated provider calls (and time at `rate` calls/s) to bring `addrs` up
/// to date. `Latest`: 5 calls (one per kind) for an address with no sync rows
/// or any row never synced / older than `stale_after`. `Older`: one call per
/// truncated kind.
pub fn estimate(
    addrs: &[Address],
    rows: &[SyncRow],
    dir: SyncDirection,
    now: DateTime<Utc>,
    stale_after: Duration,
    rate: f64,
) -> Estimate {
    let mut seen = HashSet::new();
    let stale = chrono::Duration::from_std(stale_after).unwrap_or(chrono::Duration::MAX);
    let mut calls = 0u32;
    for addr in addrs.iter().filter(|a| seen.insert(**a)) {
        let own: Vec<&SyncRow> = rows.iter().filter(|r| r.address == *addr).collect();
        calls += match dir {
            SyncDirection::Latest => {
                let needs = own.is_empty()
                    || own.iter().any(|r| match r.last_synced_at {
                        None => true,
                        Some(t) => now.signed_duration_since(t) > stale,
                    });
                if needs {
                    TransferKind::ALL.len() as u32
                } else {
                    0
                }
            }
            SyncDirection::Older => own.iter().filter(|r| r.truncated).count() as u32,
        };
    }
    Estimate {
        calls,
        seconds: f64::from(calls) / rate,
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
        assert_eq!(e.calls, 10);
        assert!((e.seconds - 10.0 / 2.8).abs() < 1e-9);
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
    }
}
