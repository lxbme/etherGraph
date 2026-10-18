//! Fixed-window request counting per key (client IP).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

#[cfg(test)]
mod tests {
    use super::*;

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
