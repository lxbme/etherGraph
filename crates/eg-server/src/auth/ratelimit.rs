//! Fixed-window request counting per key (client IP), and a server-wide
//! cap on audit rows.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

/// Keys tracked before expired windows are swept.
const SWEEP_AT: usize = 10_000;

pub struct RateLimiter {
    limit: u32,
    window: Duration,
    /// Key → (window start, requests in it).
    hits: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Counts a request from `key`; false once `key` used up its window.
    pub fn allow(&self, key: &str) -> bool {
        self.allow_at(key, Instant::now())
    }

    fn allow_at(&self, key: &str, now: Instant) -> bool {
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() >= SWEEP_AT {
            hits.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = hits.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        if entry.1 >= self.limit {
            return false;
        }
        entry.1 += 1;
        true
    }
}

/// Client buckets counted per window for [`Suppressed::top_buckets`]; refusals
/// from further buckets count toward the totals only.
const TRACKED_BUCKETS: usize = 1_000;

/// Buckets named in a [`Suppressed`] summary.
pub const TOP_BUCKETS: usize = 10;

/// A server-wide cap on audit rows per fixed window, over every client: rows
/// past it are left out, and counted for one summary row per window.
pub struct AuditCap {
    limit: u32,
    window: Duration,
    current: Mutex<CapWindow>,
}

struct CapWindow {
    start: Instant,
    started_at: DateTime<Utc>,
    written: u32,
    /// Rows left out, per audit action.
    by_action: BTreeMap<String, u64>,
    /// Rows left out, per client bucket (at most [`TRACKED_BUCKETS`]).
    by_bucket: HashMap<String, u64>,
}

impl CapWindow {
    fn new(start: Instant) -> Self {
        Self {
            start,
            started_at: Utc::now(),
            written: 0,
            by_action: BTreeMap::new(),
            by_bucket: HashMap::new(),
        }
    }
}

/// What a window left out: the content of its summary row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suppressed {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub total: u64,
    pub by_action: BTreeMap<String, u64>,
    /// The [`TOP_BUCKETS`] buckets that were left out most, most first.
    pub top_buckets: Vec<(String, u64)>,
}

impl AuditCap {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            current: Mutex::new(CapWindow::new(Instant::now())),
        }
    }

    pub fn limit(&self) -> u32 {
        self.limit
    }

    pub fn window(&self) -> Duration {
        self.window
    }

    /// Counts one row of `action` from client bucket `bucket`: whether it may
    /// be written, and the summary of a window that just ended having left
    /// rows out (to be written first).
    pub fn admit(&self, action: &str, bucket: &str) -> (bool, Option<Suppressed>) {
        self.admit_at(action, bucket, Instant::now())
    }

    /// The summary of the window if it has ended having left rows out; a new
    /// window starts once it has ended.
    pub fn take_ended(&self) -> Option<Suppressed> {
        self.take_ended_at(Instant::now())
    }

    fn admit_at(&self, action: &str, bucket: &str, now: Instant) -> (bool, Option<Suppressed>) {
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let ended = self.roll(&mut cur, now);
        if cur.written < self.limit {
            cur.written += 1;
            return (true, ended);
        }
        *cur.by_action.entry(action.to_owned()).or_default() += 1;
        if cur.by_bucket.len() < TRACKED_BUCKETS || cur.by_bucket.contains_key(bucket) {
            *cur.by_bucket.entry(bucket.to_owned()).or_default() += 1;
        }
        (false, ended)
    }

    fn take_ended_at(&self, now: Instant) -> Option<Suppressed> {
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        self.roll(&mut cur, now)
    }

    /// Starts a new window once `cur` has ended; returns its summary when it
    /// left rows out.
    fn roll(&self, cur: &mut CapWindow, now: Instant) -> Option<Suppressed> {
        if now.duration_since(cur.start) < self.window {
            return None;
        }
        let old = std::mem::replace(cur, CapWindow::new(now));
        let total: u64 = old.by_action.values().sum();
        if total == 0 {
            return None;
        }
        let mut top: Vec<(String, u64)> = old.by_bucket.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top.truncate(TOP_BUCKETS);
        let span = chrono::Duration::from_std(self.window).unwrap_or(chrono::Duration::MAX);
        Some(Suppressed {
            from: old.started_at,
            to: old
                .started_at
                .checked_add_signed(span)
                .unwrap_or(old.started_at),
            total,
            by_action: old.by_action,
            top_buckets: top,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_audit_cap_counts_what_it_leaves_out_per_window() {
        let cap = AuditCap::new(2, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(cap.admit_at("login", "a", t0), (true, None));
        assert_eq!(cap.admit_at("admin_access", "b", t0), (true, None));
        for (action, bucket) in [("login", "a"), ("login", "c"), ("admin_access", "a")] {
            assert_eq!(cap.admit_at(action, bucket, t0), (false, None));
        }
        // Not over yet.
        assert_eq!(cap.take_ended_at(t0 + Duration::from_secs(59)), None);
        // The next window's first row brings the summary along.
        let (write, ended) = cap.admit_at("login", "z", t0 + Duration::from_secs(60));
        assert!(write);
        let ended = ended.unwrap();
        assert_eq!(ended.total, 3);
        assert_eq!(
            ended.by_action,
            BTreeMap::from([("admin_access".to_owned(), 1), ("login".to_owned(), 2)])
        );
        assert_eq!(
            ended.top_buckets,
            [("a".to_owned(), 2), ("c".to_owned(), 1)]
        );
        assert!(ended.to > ended.from);
        // A window that left nothing out has no summary.
        assert_eq!(cap.take_ended_at(t0 + Duration::from_secs(120)), None);
        assert_eq!(cap.take_ended_at(t0 + Duration::from_secs(240)), None);
    }

    #[test]
    fn the_audit_cap_tracks_a_bounded_number_of_buckets() {
        let cap = AuditCap::new(0, Duration::from_secs(1));
        let t0 = Instant::now();
        for i in 0..TRACKED_BUCKETS + 50 {
            assert!(!cap.admit_at("login", &i.to_string(), t0).0);
        }
        assert_eq!(cap.current.lock().unwrap().by_bucket.len(), TRACKED_BUCKETS);
        let ended = cap.take_ended_at(t0 + Duration::from_secs(1)).unwrap();
        assert_eq!(ended.total, (TRACKED_BUCKETS + 50) as u64);
        assert_eq!(ended.top_buckets.len(), TOP_BUCKETS);
    }

    #[test]
    fn limits_each_key_per_window() {
        let rl = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        for _ in 0..3 {
            assert!(rl.allow_at("a", t0));
        }
        assert!(!rl.allow_at("a", t0 + Duration::from_secs(59)));
        assert!(rl.allow_at("b", t0));
        // A new window starts after the old one ends.
        assert!(rl.allow_at("a", t0 + Duration::from_secs(60)));
    }

    #[test]
    fn sweeps_expired_keys() {
        let rl = RateLimiter::new(1, Duration::from_secs(1));
        let t0 = Instant::now();
        for i in 0..SWEEP_AT {
            rl.allow_at(&i.to_string(), t0);
        }
        rl.allow_at("late", t0 + Duration::from_secs(2));
        assert_eq!(rl.hits.lock().unwrap().len(), 1);
    }
}
