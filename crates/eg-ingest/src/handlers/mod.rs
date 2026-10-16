//! Job handlers. `default_handlers` registers them all.

pub mod contract_meta;
pub mod fetch_tx;
pub mod names;
pub mod sync_address;
pub mod token_meta;

use std::collections::HashMap;
use std::sync::Arc;

use eg_store::JobKind;

use crate::runner::JobHandler;

pub use contract_meta::ContractMetaHandler;
pub use fetch_tx::FetchTxHandler;
pub use names::ResolveNamesHandler;
pub use sync_address::{SyncAddressHandler, SyncParams, SyncProgress};
pub use token_meta::TokenMetaHandler;

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
        (
            JobKind::ContractMeta,
            Arc::new(ContractMetaHandler) as Arc<dyn JobHandler>,
        ),
        (
            JobKind::TokenMeta,
            Arc::new(TokenMetaHandler) as Arc<dyn JobHandler>,
        ),
        (
            JobKind::ResolveNames,
            Arc::new(ResolveNamesHandler) as Arc<dyn JobHandler>,
        ),
    ])
}
