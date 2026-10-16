//! In-process event bus feeding the SSE stream.

use chrono::{DateTime, Utc};
use eg_core::types::{Address, TxHash};
use eg_store::{EnsStatus, JobKind, JobStatus};
use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum Event {
    JobProgress {
        job_id: i64,
        kind: JobKind,
        fetched: u32,
        cursor_block: Option<u64>,
        status: JobStatus,
    },
    AddressDataChanged {
        address: Address,
    },
    TxReady {
        hash: TxHash,
    },
    NamesResolved {
        items: Vec<NameItem>,
    },
    MetaUpdated {
        addresses: Vec<Address>,
    },
    QuotaStatus {
        used: u32,
        limit: u32,
        paused: bool,
        reset_at: DateTime<Utc>,
    },
    Lagged,
}

#[derive(Clone, Debug, Serialize)]
pub struct NameItem {
    pub address: Address,
    pub name: Option<String>,
    pub status: EnsStatus,
}

#[derive(Clone)]
pub struct EventBus(broadcast::Sender<Event>);

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        Self(broadcast::channel(1024).0)
    }

    /// Publishing with no subscribers is not an error.
    pub fn publish(&self, e: Event) {
        let _ = self.0.send(e);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.0.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;

    #[test]
    fn serializes_tagged_lowercase() {
        let e = Event::AddressDataChanged {
            address: address!("0xcA11bde05977b3631167028862bE2a173976CA11"),
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"type":"AddressDataChanged",
                "address":"0xca11bde05977b3631167028862be2a173976ca11"})
        );
        let p = Event::JobProgress {
            job_id: 1,
            kind: JobKind::FetchTx,
            fetched: 0,
            cursor_block: None,
            status: JobStatus::PausedQuota,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["kind"], "fetch_tx");
        assert_eq!(v["status"], "paused_quota");
    }
}
