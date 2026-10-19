//! eg-blockscout: call traces from the Blockscout REST API (v2).
pub mod parse;
pub mod transport;

use std::sync::Arc;

use async_trait::async_trait;
use eg_core::source::{CallFrame, CallGate, Priority, SourceError, TraceSource};
use eg_core::types::TxHash;

pub use parse::parse_raw_trace;
pub use transport::{
    FixturePathTransport, HttpPathTransport, HttpReply, PathTransport, RecordingPathTransport,
    fixture_key,
};

/// `TraceSource` over `GET /transactions/{hash}/raw-trace`. Each request takes
/// one gate permit first; there is no retry loop here (the job runner retries).
pub struct BlockscoutTraceSource {
    transport: Arc<dyn PathTransport>,
    gate: Arc<dyn CallGate>,
    api_key: Option<String>,
}

impl BlockscoutTraceSource {
    pub fn new(
        transport: Arc<dyn PathTransport>,
        gate: Arc<dyn CallGate>,
        api_key: Option<String>,
    ) -> Self {
        Self {
            transport,
            gate,
            api_key,
        }
    }
}

#[async_trait]
impl TraceSource for BlockscoutTraceSource {
    async fn call_trace(
        &self,
        p: Priority,
        hash: TxHash,
    ) -> Result<Option<Vec<CallFrame>>, SourceError> {
        let mut path = format!("/transactions/{hash:#x}/raw-trace");
        if let Some(key) = &self.api_key {
            path.push_str("?apikey=");
            path.push_str(key);
        }
        self.gate.acquire(p).await?;
        let reply = self.transport.get(&path).await?;
        match reply.status {
            200 => {
                let frames = parse_raw_trace(&reply.body)?;
                // Every transaction has a root frame: an empty list means the
                // trace is not indexed yet.
                Ok((!frames.is_empty()).then_some(frames))
            }
            404 => Ok(None),
            429 if credits_spent(&reply.body) => {
                self.gate.on_quota_exhausted();
                Err(SourceError::QuotaExhausted)
            }
            429 => {
                self.gate.on_rate_limited();
                Err(SourceError::RateLimited)
            }
            s if s >= 500 => Err(SourceError::Network(format!("http {s}"))),
            s => Err(SourceError::Upstream(format!("http {s}"))),
        }
    }

    fn name(&self) -> &'static str {
        "blockscout"
    }
}

/// Blockscout answers 429 both to its per-second rate limit and, for a PRO API
/// key, once the key's daily credits are spent. It documents no
/// machine-readable code for the latter (and the transport passes no headers
/// on), so this is a heuristic on the body: a 429 that mentions credits, a
/// daily limit or a quota is exhaustion (trace fetching pauses until the
/// UTC-midnight reset); any other 429 is a rate limit (retried after a
/// slowdown).
fn credits_spent(body: &str) -> bool {
    let body = body.to_ascii_lowercase();
    ["credit", "daily", "quota"]
        .iter()
        .any(|w| body.contains(w))
}
