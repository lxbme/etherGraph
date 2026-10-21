//! eg-blockscout: call traces and NFT metadata from the Blockscout REST API
//! (v2).
pub mod parse;
pub mod transport;

use std::sync::Arc;

use async_trait::async_trait;
use eg_core::source::{CallFrame, CallGate, NftMetadata, Priority, SourceError, TraceSource};
use eg_core::types::{Address, TxHash, U256};

pub use parse::{parse_raw_trace, parse_token_instance};
pub use transport::{
    FixturePathTransport, HttpPathTransport, HttpReply, PathTransport, RecordingPathTransport,
    fixture_key,
};

/// `TraceSource` over `GET /transactions/{hash}/raw-trace` and
/// `GET /tokens/{token}/instances/{id}`. Each request takes
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

impl BlockscoutTraceSource {
    /// `GET path` (plus the API key) after one gate permit: the body of a
    /// 200, `None` for a 404, otherwise the error the status maps to.
    async fn fetch(&self, p: Priority, path: &str) -> Result<Option<String>, SourceError> {
        let mut path = path.to_owned();
        if let Some(key) = &self.api_key {
            path.push_str("?apikey=");
            path.push_str(key);
        }
        self.gate.acquire(p).await?;
        let reply = self.transport.get(&path).await?;
        match reply.status {
            200 => Ok(Some(reply.body)),
            404 => Ok(None),
            429 if self.api_key.is_some() && credits_spent(&reply.body) => {
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
}

#[async_trait]
impl TraceSource for BlockscoutTraceSource {
    async fn call_trace(
        &self,
        p: Priority,
        hash: TxHash,
    ) -> Result<Option<Vec<CallFrame>>, SourceError> {
        let Some(body) = self
            .fetch(p, &format!("/transactions/{hash:#x}/raw-trace"))
            .await?
        else {
            return Ok(None);
        };
        let frames = parse_raw_trace(&body)?;
        // Every transaction has a root frame: an empty list means the trace
        // is not indexed yet.
        Ok((!frames.is_empty()).then_some(frames))
    }

    /// `GET /tokens/{token}/instances/{id}` (`id` in decimal).
    async fn nft_metadata(
        &self,
        p: Priority,
        token: Address,
        id: U256,
    ) -> Result<Option<NftMetadata>, SourceError> {
        self.fetch(p, &format!("/tokens/{token:#x}/instances/{id}"))
            .await?
            .map(|body| parse_token_instance(&body))
            .transpose()
    }

    fn name(&self) -> &'static str {
        "blockscout"
    }
}

/// Blockscout answers 429 both to its per-second rate limit and, for a PRO API
/// key, once the key's daily credits are spent. It documents no
/// machine-readable code for the latter (and the transport passes no headers
/// on), so this is a heuristic on the body, applied only when a key is
/// configured (keyless requests have no credits): a 429 that mentions credits
/// is exhaustion, which pauses trace fetching for everyone until the
/// UTC-midnight reset. Any other 429 is a rate limit (retried after a
/// slowdown); erring that way costs a retry, not a day without traces.
fn credits_spent(body: &str) -> bool {
    body.to_ascii_lowercase().contains("credit")
}
