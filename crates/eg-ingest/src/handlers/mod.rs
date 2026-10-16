//! Job handlers. Tasks 15-17 register theirs in `default_handlers`.

use std::collections::HashMap;
use std::sync::Arc;

use eg_store::JobKind;

use crate::runner::JobHandler;

pub fn default_handlers() -> HashMap<JobKind, Arc<dyn JobHandler>> {
    HashMap::new()
}
