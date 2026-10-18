use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::types::{Address, TransferKind, U256};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TimeRange {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

/// Direction relative to the center node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
    Both,
}

/// `asset: None` means ETH.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetFilter {
    pub asset: Option<Address>,
    pub min_raw: Option<U256>,
}

/// Empty `Vec`s mean unrestricted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeFilter {
    pub time: TimeRange,
    pub kinds: Vec<TransferKind>,
    pub direction: Direction,
    pub assets: Vec<AssetFilter>,
    /// Token contracts whose transfers are left out (ETH is never excluded).
    pub exclude_assets: Vec<Address>,
}

impl Default for EdgeFilter {
    fn default() -> Self {
        Self {
            time: TimeRange::default(),
            kinds: Vec::new(),
            direction: Direction::Both,
            assets: Vec::new(),
            exclude_assets: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortBy {
    Count,
    Amount,
    Recent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edge {
    pub from: Address,
    pub to: Address,
    pub asset: Option<Address>,
    /// `Native` for ETH (internal transfers included); otherwise the token
    /// standard of the grouped transfers. Never `Internal`.
    pub asset_kind: TransferKind,
    pub count: u64,
    pub sum: U256,
    pub first_ts: DateTime<Utc>,
    pub last_ts: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeQuery {
    pub centers: Vec<Address>,
    pub filter: EdgeFilter,
    pub limit_per_center: u32,
    /// Per-center overrides of `limit_per_center`.
    pub limits: HashMap<Address, u32>,
    /// Neighbours ranked ahead of all others (e.g. nodes already on canvas).
    pub prefer: Vec<Address>,
    pub sort: SortBy,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EdgeQueryResult {
    pub edges: Vec<Edge>,
    pub omitted: HashMap<Address, u64>,
}
