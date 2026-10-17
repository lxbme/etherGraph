//! Cached chain head, used for confirmation counts.

use std::time::{Duration, Instant};

use eg_core::source::{ChainSource, Priority};
use tokio::sync::Mutex;

use crate::state::AppState;

/// How long a fetched head is reused before asking the source again.
pub const HEAD_TTL: Duration = Duration::from_secs(60);

pub struct HeadCache {
    ttl: Duration,
    last: Mutex<Option<(u64, Instant)>>,
}

impl Default for HeadCache {
    fn default() -> Self {
        Self::new(HEAD_TTL)
    }
}

impl HeadCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            last: Mutex::new(None),
        }
    }

    /// The latest block number, at most `ttl` old. A failed refresh keeps the
    /// previous value; `None` when no head was ever fetched.
    pub async fn get(&self, s: &AppState) -> Option<u64> {
        self.get_from(s.source.as_ref()).await
    }

    async fn get_from(&self, source: &dyn ChainSource) -> Option<u64> {
        // Held across the refresh so concurrent callers share one call.
        let mut last = self.last.lock().await;
        if let Some((head, at)) = *last
            && at.elapsed() < self.ttl
        {
            return Some(head);
        }
        match source.latest_block(Priority::Background).await {
            Ok(head) => {
                *last = Some((head, Instant::now()));
                Some(head)
            }
            Err(e) => {
                tracing::warn!(error = %e, "chain head refresh failed");
                last.map(|(head, _)| head)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eg_core::source::SourceError;
    use eg_core::testing::FakeSource;

    #[tokio::test]
    async fn reuses_the_head_within_ttl() {
        let fake = FakeSource::new();
        fake.set_latest_block(100);
        let cache = HeadCache::default();
        assert_eq!(cache.get_from(&fake).await, Some(100));
        fake.set_latest_block(105);
        assert_eq!(cache.get_from(&fake).await, Some(100));
        assert_eq!(fake.calls(), 1);
    }

    #[tokio::test]
    async fn refreshes_after_ttl_and_keeps_old_value_on_failure() {
        let fake = FakeSource::new();
        fake.set_latest_block(100);
        let cache = HeadCache::new(Duration::ZERO);
        assert_eq!(cache.get_from(&fake).await, Some(100));
        fake.set_latest_block(105);
        assert_eq!(cache.get_from(&fake).await, Some(105));
        fake.fail_next(SourceError::Timeout);
        assert_eq!(cache.get_from(&fake).await, Some(105));
        assert_eq!(fake.calls(), 3);
    }

    #[tokio::test]
    async fn unknown_when_the_first_fetch_fails() {
        let fake = FakeSource::new();
        fake.fail_next(SourceError::QuotaExhausted);
        assert_eq!(HeadCache::default().get_from(&fake).await, None);
    }
}
