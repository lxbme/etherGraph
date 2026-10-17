//! Cached chain head, used for confirmation counts.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eg_core::source::{ChainSource, Priority};

use crate::state::AppState;

/// How long a fetched head is reused before asking the source again.
pub const HEAD_TTL: Duration = Duration::from_secs(60);

/// Never makes a caller wait: `get` answers from the cache and refreshes a
/// stale head in the background, so confirmations may lag by one view.
pub struct HeadCache {
    ttl: Duration,
    last: Arc<Mutex<Option<(u64, Instant)>>>,
    /// Set while a refresh task runs; at most one runs at a time.
    refreshing: Arc<AtomicBool>,
}

impl Default for HeadCache {
    fn default() -> Self {
        Self::new(HEAD_TTL)
    }
}

/// Clears the refreshing flag when the refresh task ends, even on panic.
struct RefreshGuard(Arc<AtomicBool>);

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl HeadCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            last: Arc::new(Mutex::new(None)),
            refreshing: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The cached latest block number, `None` until a first fetch succeeded.
    /// When it is older than the TTL (or missing) a background refresh at
    /// `Background` priority is started; a failed refresh keeps the old value.
    pub fn get(&self, s: &AppState) -> Option<u64> {
        self.get_from(&s.source)
    }

    fn get_from(&self, source: &Arc<dyn ChainSource>) -> Option<u64> {
        let cached = *self.last.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = cached.is_some_and(|(_, at)| at.elapsed() < self.ttl);
        if !fresh && !self.refreshing.swap(true, Ordering::AcqRel) {
            let guard = RefreshGuard(self.refreshing.clone());
            let (last, source) = (self.last.clone(), source.clone());
            tokio::spawn(async move {
                let _guard = guard;
                match source.latest_block(Priority::Background).await {
                    Ok(head) => {
                        *last.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((head, Instant::now()));
                    }
                    Err(e) => tracing::warn!(error = %e, "chain head refresh failed"),
                }
            });
        }
        cached.map(|(head, _)| head)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eg_core::source::SourceError;
    use eg_core::testing::FakeSource;

    fn fake(head: u64) -> (Arc<FakeSource>, Arc<dyn ChainSource>) {
        let f = Arc::new(FakeSource::new());
        f.set_latest_block(head);
        (f.clone(), f)
    }

    /// Lets a running refresh task finish.
    async fn settle(cache: &HeadCache) {
        while cache.refreshing.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn first_view_has_no_head_and_concurrent_views_share_one_refresh() {
        let (f, src) = fake(100);
        let cache = HeadCache::default();
        assert_eq!(cache.get_from(&src), None);
        assert_eq!(cache.get_from(&src), None);
        settle(&cache).await;
        assert_eq!(cache.get_from(&src), Some(100));
        assert_eq!(f.calls(), 1);
    }

    #[tokio::test]
    async fn reuses_the_head_within_ttl() {
        let (f, src) = fake(100);
        let cache = HeadCache::default();
        cache.get_from(&src);
        settle(&cache).await;
        f.set_latest_block(105);
        assert_eq!(cache.get_from(&src), Some(100));
        settle(&cache).await;
        assert_eq!(cache.get_from(&src), Some(100));
        assert_eq!(f.calls(), 1);
    }

    #[tokio::test]
    async fn stale_head_is_served_while_refreshing_and_kept_on_failure() {
        let (f, src) = fake(100);
        let cache = HeadCache::new(Duration::ZERO);
        cache.get_from(&src);
        settle(&cache).await;
        f.set_latest_block(105);
        f.fail_next(SourceError::Timeout);
        assert_eq!(cache.get_from(&src), Some(100));
        settle(&cache).await;
        assert_eq!(cache.get_from(&src), Some(100));
        settle(&cache).await;
        assert_eq!(cache.get_from(&src), Some(105));
        assert_eq!(f.calls(), 3);
    }

    #[tokio::test]
    async fn unknown_until_a_fetch_succeeds() {
        let (f, src) = fake(100);
        let cache = HeadCache::default();
        f.fail_next(SourceError::QuotaExhausted);
        assert_eq!(cache.get_from(&src), None);
        settle(&cache).await;
        assert_eq!(cache.get_from(&src), None);
        settle(&cache).await;
        assert_eq!(cache.get_from(&src), Some(100));
    }
}
