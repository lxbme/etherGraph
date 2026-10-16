//! Ingest tunables.

use std::time::Duration;

use alloy_primitives::{Address, address};

#[derive(Clone, Debug)]
pub struct IngestConfig {
    pub page_size: u32,
    pub max_records_per_category: u32,
    pub reorg_window_blocks: u64,
    pub stale_after: Duration,
    pub meta_ttl: Duration,
    pub ens_ttl: Duration,
    pub multicall_batch_size: usize,
    pub multicall3: Address,
    pub universal_resolver: Address,
    pub rate_per_sec: f64,
    pub hot_neighbor_threshold: u64,
    pub max_attempts: i32,
}

impl Default for IngestConfig {
    fn default() -> Self {
        const WEEK: Duration = Duration::from_secs(7 * 24 * 3600);
        Self {
            page_size: 1000,
            max_records_per_category: 10_000,
            reorg_window_blocks: 64,
            stale_after: Duration::from_secs(600),
            meta_ttl: WEEK,
            ens_ttl: WEEK,
            multicall_batch_size: 50,
            multicall3: address!("0xcA11bde05977b3631167028862bE2a173976CA11"),
            universal_resolver: address!("0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe"),
            rate_per_sec: 2.8,
            hot_neighbor_threshold: 500,
            max_attempts: 3,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_global_constraints() {
        let c = IngestConfig::default();
        assert_eq!(c.page_size, 1000);
        assert_eq!(c.max_records_per_category, 10_000);
        assert_eq!(c.reorg_window_blocks, 64);
        assert_eq!(c.stale_after, Duration::from_secs(600));
        assert_eq!(c.meta_ttl, Duration::from_secs(7 * 24 * 3600));
        assert_eq!(c.ens_ttl, Duration::from_secs(7 * 24 * 3600));
        assert_eq!(c.multicall_batch_size, 50);
        assert_eq!(
            c.multicall3,
            address!("0xcA11bde05977b3631167028862bE2a173976CA11")
        );
        assert_eq!(
            c.universal_resolver,
            address!("0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe")
        );
        assert_eq!(c.rate_per_sec, 2.8);
        assert_eq!(c.hot_neighbor_threshold, 500);
        assert_eq!(c.max_attempts, 3);
    }
}
