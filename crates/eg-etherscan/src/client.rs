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
                Ok(body) => classify(&body),
                Err(e) => Err(e),
            };
            let err = match result {
                Ok(v) => return Ok(v),
                Err(e) => e,
            };
            self.stats.record_error(&err);
            if err == SourceError::RateLimited {
                self.gate.on_rate_limited();
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
