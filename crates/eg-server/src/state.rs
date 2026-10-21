//! Shared application state handed to every route.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use eg_blockscout::{
    BlockscoutTraceSource, FixturePathTransport, HttpPathTransport, PathTransport,
    RecordingPathTransport,
};
use eg_core::source::{ChainSource, TraceSource};
use eg_etherscan::ClientStats;
use eg_ingest::gate::{PriorityGate, TraceGate};
use eg_ingest::{EventBus, JobCtx};
use eg_store::Store;
use tokio::sync::Notify;

use crate::auth::AuthState;
use crate::config::{Config, SourceMode};
use crate::head::HeadCache;
use crate::trust::TrustCache;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub source: Arc<dyn ChainSource>,
    pub gate: Arc<PriorityGate>,
    /// Blockscout's own rate and pause; reset with `gate` at UTC midnight.
    pub trace_gate: Arc<TraceGate>,
    pub stats: Arc<ClientStats>,
    pub ctx: JobCtx,
    pub cfg: Arc<Config>,
    pub head: Arc<HeadCache>,
    pub trust: Arc<TrustCache>,
    pub auth: Arc<AuthState>,
    /// Calls and events no ABI decodes are named from the signature
    /// database (marked guessed) while this is on. Starts from
    /// `[signatures] enabled`; shared by every clone, so it can be flipped at
    /// runtime.
    pub signatures: Arc<AtomicBool>,
}

impl AppState {
    /// Builds the job context (fresh event bus and wake handle) around the
    /// given parts, and the Blockscout trace source `cfg` describes, billed
    /// to the users of `gate`.
    pub fn new(
        cfg: Arc<Config>,
        store: Store,
        source: Arc<dyn ChainSource>,
        gate: Arc<PriorityGate>,
        stats: Arc<ClientStats>,
    ) -> Self {
        let trace_gate = TraceGate::spawn(cfg.blockscout.rate_per_sec, gate.clone());
        let trace_source = blockscout_source(&cfg, trace_gate.clone());
        Self::with_trace(cfg, store, source, gate, stats, trace_gate, trace_source)
    }

    /// Like [`AppState::new`] with the given trace source (tests).
    pub fn with_trace(
        cfg: Arc<Config>,
        store: Store,
        source: Arc<dyn ChainSource>,
        gate: Arc<PriorityGate>,
        stats: Arc<ClientStats>,
        trace_gate: Arc<TraceGate>,
        trace_source: Arc<dyn TraceSource>,
    ) -> Self {
        let ctx = JobCtx {
            store: store.clone(),
            source: source.clone(),
            bus: EventBus::new(),
            cfg: Arc::new(cfg.ingest()),
            wake: Arc::new(Notify::new()),
            gate: gate.clone(),
            trace_source,
        };
        Self {
            auth: Arc::new(AuthState::new(&cfg)),
            signatures: Arc::new(AtomicBool::new(cfg.signatures.enabled)),
            store,
            source,
            gate,
            trace_gate,
            stats,
            ctx,
            cfg,
            head: Arc::new(HeadCache::default()),
            trust: Arc::new(TrustCache::default()),
        }
    }
}

impl AppState {
    /// Whether views guess undecoded calls and events from the signature
    /// database (see [`AppState::signatures`]).
    pub fn signatures_enabled(&self) -> bool {
        self.signatures.load(Ordering::Relaxed)
    }

    pub fn set_signatures_enabled(&self, on: bool) {
        self.signatures.store(on, Ordering::Relaxed);
    }
}

/// Blockscout over the transport of `cfg.source.mode`: live, replaying
/// `<fixtures_dir>/blockscout/`, or live while recording there.
pub fn blockscout_source(cfg: &Config, gate: Arc<TraceGate>) -> Arc<dyn TraceSource> {
    let bs = &cfg.blockscout;
    let transport: Arc<dyn PathTransport> = match cfg.source.mode {
        SourceMode::Etherscan => Arc::new(HttpPathTransport::new(&bs.base_url)),
        SourceMode::Fixture => Arc::new(FixturePathTransport::new(&cfg.source.fixtures_dir)),
        SourceMode::Record => Arc::new(RecordingPathTransport::new(
            HttpPathTransport::new(&bs.base_url),
            &cfg.source.fixtures_dir,
        )),
    };
    let api_key = bs.api_key.clone().filter(|k| !k.trim().is_empty());
    Arc::new(BlockscoutTraceSource::new(transport, gate, api_key))
}
