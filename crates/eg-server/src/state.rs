//! Shared application state handed to every route.

use std::sync::Arc;

use eg_core::source::ChainSource;
use eg_etherscan::ClientStats;
use eg_ingest::gate::PriorityGate;
use eg_ingest::{EventBus, JobCtx};
use eg_store::Store;
use tokio::sync::Notify;

use crate::auth::AuthState;
use crate::config::Config;
use crate::head::HeadCache;
use crate::trust::TrustCache;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub source: Arc<dyn ChainSource>,
    pub gate: Arc<PriorityGate>,
    pub stats: Arc<ClientStats>,
    pub ctx: JobCtx,
    pub cfg: Arc<Config>,
    pub head: Arc<HeadCache>,
    pub trust: Arc<TrustCache>,
    pub auth: Arc<AuthState>,
}

impl AppState {
    /// Builds the job context (fresh event bus and wake handle) around the given parts.
    pub fn new(
        cfg: Arc<Config>,
        store: Store,
        source: Arc<dyn ChainSource>,
        gate: Arc<PriorityGate>,
        stats: Arc<ClientStats>,
    ) -> Self {
        let ctx = JobCtx {
            store: store.clone(),
            source: source.clone(),
            bus: EventBus::new(),
            cfg: Arc::new(cfg.ingest()),
            wake: Arc::new(Notify::new()),
        };
        Self {
            auth: Arc::new(AuthState::new(&cfg)),
            store,
            source,
            gate,
            stats,
            ctx,
            cfg,
            head: Arc::new(HeadCache::default()),
            trust: Arc::new(TrustCache::default()),
        }
    }
}
