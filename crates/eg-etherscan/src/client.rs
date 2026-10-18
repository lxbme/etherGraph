use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use eg_core::source::{CallGate, Priority, SourceError};
use rand::Rng;
use serde::Serialize;

use crate::classify::classify;
use crate::transport::Transport;

pub const MAX_ATTEMPTS: u32 = 5;

#[derive(Default)]
pub struct ClientStats {
    calls: AtomicU64,
    retries: AtomicU64,
    errors: Mutex<HashMap<&'static str, u64>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatsSnapshot {
    pub calls: u64,
    pub retries: u64,
    pub errors: BTreeMap<String, u64>,
}

impl ClientStats {
    pub fn snapshot(&self) -> StatsSnapshot {
        let errors = self.errors.lock().unwrap_or_else(|e| e.into_inner());
        StatsSnapshot {
            calls: self.calls.load(Ordering::Relaxed),
            retries: self.retries.load(Ordering::Relaxed),
            errors: errors.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect(),
        }
    }

    fn record_error(&self, e: &SourceError) {
        let mut errors = self.errors.lock().unwrap_or_else(|e| e.into_inner());
        *errors.entry(error_name(e)).or_insert(0) += 1;
    }
}

fn error_name(e: &SourceError) -> &'static str {
    match e {
        SourceError::RateLimited => "rate_limited",
        SourceError::QuotaExhausted => "quota_exhausted",
        SourceError::UserQuotaExhausted => "user_quota_exhausted",
        SourceError::InvalidKey => "invalid_key",
        SourceError::WindowTooLarge => "window_too_large",
        SourceError::Timeout => "timeout",
        SourceError::Network(_) => "network",
        SourceError::Upstream(_) => "upstream",
        SourceError::Rpc { .. } => "rpc",
        SourceError::Parse(_) => "parse",
        SourceError::FixtureMissing(_) => "fixture_missing",
    }
}

/// How much of an unparseable response body is logged.
const SNIPPET_CHARS: usize = 512;

/// The first [`SNIPPET_CHARS`] characters of `body` with any occurrence of
/// `api_key` replaced. Response bodies never echo the key, but a log line must
/// not leak it even if one did.
fn body_snippet(body: &str, api_key: &str) -> String {
    let redacted = if api_key.is_empty() {
        body.to_owned()
    } else {
        body.replace(api_key, "<redacted>")
    };
    redacted.chars().take(SNIPPET_CHARS).collect()
}

pub struct EtherscanClient {
    transport: Arc<dyn Transport>,
    gate: Arc<dyn CallGate>,
    api_key: String,
    stats: Arc<ClientStats>,
}

impl EtherscanClient {
    pub fn new(
        transport: Arc<dyn Transport>,
        gate: Arc<dyn CallGate>,
        api_key: String,
        stats: Arc<ClientStats>,
    ) -> Self {
        Self {
            transport,
            gate,
            api_key,
            stats,
        }
    }

    pub async fn call(
        &self,
        p: Priority,
        params: &[(&str, String)],
    ) -> Result<serde_json::Value, SourceError> {
        let mut full: Vec<(String, String)> = params
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect();
        full.push(("chainid".into(), "1".into()));
        full.push(("apikey".into(), self.api_key.clone()));

        let mut attempt = 1;
        loop {
            self.gate.acquire(p).await?;
            self.stats.calls.fetch_add(1, Ordering::Relaxed);
            let result = match self.transport.get(&full).await {
                Ok(body) => {
                    let r = classify(&body);
                    if let Err(e @ SourceError::Parse(_)) = &r {
                        tracing::warn!(
                            error = %e,
                            body = %body_snippet(&body, &self.api_key),
                            "unparseable Etherscan response"
                        );
                    }
                    r
                }
                Err(e) => Err(e),
            };
            let err = match result {
                Ok(v) => return Ok(v),
                Err(e) => e,
            };
            self.stats.record_error(&err);
            match err {
                SourceError::RateLimited => self.gate.on_rate_limited(),
                SourceError::QuotaExhausted => self.gate.on_quota_exhausted(),
                _ => {}
            }
            if !err.is_retryable() || attempt >= MAX_ATTEMPTS {
                return Err(err);
            }
            self.stats.retries.fetch_add(1, Ordering::Relaxed);
            let jitter = rand::rng().random_range(0..=250u64);
            tokio::time::sleep(
                Duration::from_secs(1u64 << (attempt - 1)) + Duration::from_millis(jitter),
            )
            .await;
            attempt += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_snippet_truncates_and_redacts() {
        let long = format!("<html>{}</html>", "é".repeat(600));
        let s = body_snippet(&long, "KEY");
        assert_eq!(s.chars().count(), SNIPPET_CHARS);
        assert!(long.starts_with(&s));
        let leaky = "error for apikey=SECRET123: SECRET123";
        assert_eq!(
            body_snippet(leaky, "SECRET123"),
            "error for apikey=<redacted>: <redacted>"
        );
        // An empty key must not turn every gap into "<redacted>".
        assert_eq!(body_snippet("abc", ""), "abc");
    }
}
