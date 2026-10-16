//! Job handlers. Tasks 15-17 register theirs in `default_handlers`.

pub mod fetch_tx;
pub mod sync_address;

use std::collections::HashMap;
use std::sync::Arc;

use eg_store::JobKind;

use crate::runner::JobHandler;

pub use fetch_tx::FetchTxHandler;
pub use sync_address::{SyncAddressHandler, SyncParams, SyncProgress};

pub fn default_handlers() -> HashMap<JobKind, Arc<dyn JobHandler>> {
    HashMap::from([
        (
            JobKind::SyncAddress,
            Arc::new(SyncAddressHandler) as Arc<dyn JobHandler>,
        ),
        (
            JobKind::FetchTx,
            Arc::new(FetchTxHandler) as Arc<dyn JobHandler>,
        ),
    ])
}
