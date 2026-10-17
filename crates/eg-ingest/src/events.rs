//! In-process event bus feeding the SSE stream.

use chrono::{DateTime, Utc};
use eg_core::types::{Address, TxHash};
use eg_store::{EnsStatus, JobKind, JobStatus};
use serde::Serialize;
use tokio::sync::broadcast;
use ts_rs::TS;

/// SSE payloads. The TypeScript binding (ts-rs) mirrors the serde JSON:
/// addresses/hashes are lowercase hex strings, times RFC 3339 strings.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum Event {
    JobProgress {
        #[ts(type = "number")]
        job_id: i64,
        kind: JobKind,
        fetched: u32,
        #[ts(type = "number | null")]
        cursor_block: Option<u64>,
        status: JobStatus,
        // Why the job failed; set only with status `failed`.
        // (Plain comment: ts-rs would copy a doc comment into the binding.)
        error: Option<String>,
    },
    AddressDataChanged {
        #[ts(type = "string")]
        address: Address,
    },
    TxReady {
        #[ts(type = "string")]
        hash: TxHash,
    },
    NamesResolved {
        items: Vec<NameItem>,
    },
    MetaUpdated {
        #[ts(type = "Array<string>")]
        addresses: Vec<Address>,
    },
    QuotaStatus {
        used: u32,
        limit: u32,
        paused: bool,
        #[ts(type = "string")]
        reset_at: DateTime<Utc>,
    },
    Lagged,
}

#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct NameItem {
    #[ts(type = "string")]
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
    use alloy_primitives::{B256, address};
    use ts_rs::TS;

    /// One value per variant; the match forces this list to grow with `Event`.
    fn one_of_each() -> Vec<Event> {
        let all = vec![
            Event::JobProgress {
                job_id: 1,
                kind: JobKind::SyncAddress,
                fetched: 2,
                cursor_block: Some(3),
                status: JobStatus::Failed,
                error: Some("boom".into()),
            },
            Event::AddressDataChanged {
                address: Address::repeat_byte(0xab),
            },
            Event::TxReady {
                hash: B256::repeat_byte(0xcd),
            },
            Event::NamesResolved {
                items: vec![NameItem {
                    address: Address::repeat_byte(1),
                    name: Some("a.eth".into()),
                    status: EnsStatus::Ok,
                }],
            },
            Event::MetaUpdated {
                addresses: vec![Address::repeat_byte(2)],
            },
            Event::QuotaStatus {
                used: 1,
                limit: 2,
                paused: false,
                reset_at: DateTime::<Utc>::from_timestamp(1_700_000_000, 0).unwrap(),
            },
            Event::Lagged,
        ];
        for e in &all {
            match e {
                Event::JobProgress { .. }
                | Event::AddressDataChanged { .. }
                | Event::TxReady { .. }
                | Event::NamesResolved { .. }
                | Event::MetaUpdated { .. }
                | Event::QuotaStatus { .. }
                | Event::Lagged => {}
            }
        }
        all
    }

    /// The `{ "type": "<Variant>", ... }` member of the generated union.
    fn ts_member<'a>(decl: &'a str, variant: &str) -> &'a str {
        let tag = format!("\"type\": \"{variant}\"");
        let start = decl
            .find(&tag)
            .unwrap_or_else(|| panic!("{tag} missing in {decl}"));
        let end = decl[start..].find('}').map_or(decl.len(), |i| start + i);
        &decl[start..end]
    }

    #[test]
    fn ts_binding_matches_serde_json() {
        let cfg = ts_rs::Config::from_env();
        let decl = Event::decl(&cfg);
        for e in one_of_each() {
            let v = serde_json::to_value(&e).unwrap();
            let obj = v.as_object().unwrap();
            let member = ts_member(&decl, obj["type"].as_str().unwrap());
            let mut ts_fields: Vec<&str> = member
                .split(',')
                .filter_map(|f| f.split(':').next())
                .map(|f| f.trim().trim_matches('"'))
                .filter(|f| !f.is_empty())
                .collect();
            ts_fields.sort();
            let mut json_fields: Vec<&str> = obj.keys().map(String::as_str).collect();
            json_fields.sort();
            assert_eq!(ts_fields, json_fields, "{member}");
        }
        // Hex/time values are strings and 64-bit ints are plain numbers.
        assert!(!decl.contains("bigint"), "{decl}");
        assert!(ts_member(&decl, "JobProgress").contains("cursor_block: number | null"));
        assert!(ts_member(&decl, "JobProgress").contains("error: string | null"));
        assert!(ts_member(&decl, "TxReady").contains("hash: string"));
        assert!(ts_member(&decl, "QuotaStatus").contains("reset_at: string"));
        assert!(ts_member(&decl, "MetaUpdated").contains("addresses: Array<string>"));
        let item = NameItem::decl(&cfg);
        assert!(item.contains("address: string"), "{item}");
        assert!(item.contains("name: string | null"), "{item}");
        assert_eq!(
            JobKind::inline(&cfg),
            r#""sync_address" | "fetch_tx" | "contract_meta" | "resolve_names" | "token_meta" | "fetch_block""#
        );
        assert_eq!(
            JobStatus::inline(&cfg),
            r#""pending" | "running" | "paused_quota" | "done" | "failed" | "cancelled""#
        );
        assert_eq!(
            EnsStatus::inline(&cfg),
            r#""ok" | "none" | "offchain" | "error""#
        );
    }

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
            error: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["kind"], "fetch_tx");
        assert_eq!(v["status"], "paused_quota");
        assert_eq!(v["error"], serde_json::Value::Null);
    }
}
