//! In-process event bus feeding the SSE stream. Every event carries its
//! [`Audience`]; a user's stream forwards only the events addressed to them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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
    // The receiving user's quota, as in `/api/status`: their calls today and
    // daily limit; `paused` when they are over it or the server total is used
    // up (`server_paused`); `reset_at` the next UTC midnight.
    QuotaStatus {
        used: u32,
        limit: u32,
        paused: bool,
        server_paused: bool,
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

/// Who may receive an event: the user whose job (or request) caused it, or
/// nobody (a system job without an owner).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    User(i64),
    Nobody,
}

impl Audience {
    /// The audience of events caused by a job of `user` (`JobRow::user_id`).
    pub fn of(user: Option<i64>) -> Self {
        user.map_or(Self::Nobody, Self::User)
    }
}

/// How many live [`UserEvents`] each user has.
type Listeners = Arc<Mutex<HashMap<i64, usize>>>;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<(Audience, Event)>,
    listeners: Listeners,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            tx: broadcast::channel(1024).0,
            listeners: Listeners::default(),
        }
    }

    /// Publishing with no subscribers is not an error.
    pub fn publish(&self, audience: Audience, e: Event) {
        let _ = self.tx.send((audience, e));
    }

    /// Every event with its audience.
    pub fn subscribe(&self) -> broadcast::Receiver<(Audience, Event)> {
        self.tx.subscribe()
    }

    /// The events addressed to `user`; `user` counts as listening until the
    /// subscription is dropped.
    pub fn subscribe_user(&self, user: i64) -> UserEvents {
        *lock(&self.listeners).entry(user).or_insert(0) += 1;
        UserEvents {
            user,
            rx: self.tx.subscribe(),
            listeners: self.listeners.clone(),
        }
    }

    /// The users with at least one live [`UserEvents`], ascending.
    pub fn listening_users(&self) -> Vec<i64> {
        let mut v: Vec<i64> = lock(&self.listeners).keys().copied().collect();
        v.sort_unstable();
        v
    }
}

fn lock(l: &Listeners) -> std::sync::MutexGuard<'_, HashMap<i64, usize>> {
    l.lock().unwrap_or_else(|e| e.into_inner())
}

/// One user's view of the bus (see [`EventBus::subscribe_user`]).
pub struct UserEvents {
    user: i64,
    rx: broadcast::Receiver<(Audience, Event)>,
    listeners: Listeners,
}

impl UserEvents {
    /// The next event addressed to this user; [`Event::Lagged`] after events
    /// were missed (anyone's: the bus is shared); `None` once the bus is gone.
    pub async fn recv(&mut self) -> Option<Event> {
        loop {
            match self.rx.recv().await {
                Ok((Audience::User(u), e)) if u == self.user => return Some(e),
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => return Some(Event::Lagged),
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

impl Drop for UserEvents {
    fn drop(&mut self) {
        let mut l = lock(&self.listeners);
        if let Some(n) = l.get_mut(&self.user) {
            *n -= 1;
            if *n == 0 {
                l.remove(&self.user);
            }
        }
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
                server_paused: false,
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
            r#""pending" | "running" | "paused_quota" | "paused_user_quota" | "done" | "failed" | "cancelled""#
        );
        assert_eq!(
            EnsStatus::inline(&cfg),
            r#""ok" | "none" | "offchain" | "error""#
        );
    }

    fn changed(b: u8) -> Event {
        Event::AddressDataChanged {
            address: Address::repeat_byte(b),
        }
    }

    fn changed_byte(e: Option<Event>) -> u8 {
        match e {
            Some(Event::AddressDataChanged { address }) => address[0],
            other => panic!("unexpected {other:?}"),
        }
    }

    /// Nothing more arrives for `sub` within a short wait.
    async fn assert_quiet(sub: &mut UserEvents) {
        let next = tokio::time::timeout(std::time::Duration::from_millis(50), sub.recv()).await;
        assert!(next.is_err(), "unexpected {next:?}");
    }

    #[tokio::test]
    async fn a_user_receives_only_events_addressed_to_them() {
        let bus = EventBus::new();
        let mut a = bus.subscribe_user(1);
        let mut b = bus.subscribe_user(2);
        let mut all = bus.subscribe();
        bus.publish(Audience::User(1), changed(1));
        bus.publish(Audience::User(2), changed(2));
        bus.publish(Audience::Nobody, changed(3));
        bus.publish(Audience::User(1), changed(4));
        assert_eq!(changed_byte(a.recv().await), 1);
        assert_eq!(changed_byte(a.recv().await), 4);
        assert_quiet(&mut a).await;
        assert_eq!(changed_byte(b.recv().await), 2);
        assert_quiet(&mut b).await;
        // A raw subscriber sees every event with its audience.
        let (aud, _) = all.recv().await.unwrap();
        assert_eq!(aud, Audience::User(1));
        assert_eq!(all.recv().await.unwrap().0, Audience::User(2));
        assert_eq!(all.recv().await.unwrap().0, Audience::Nobody);
    }

    #[test]
    fn a_jobs_audience_is_its_owner() {
        assert_eq!(Audience::of(Some(7)), Audience::User(7));
        assert_eq!(Audience::of(None), Audience::Nobody);
    }

    #[tokio::test]
    async fn listening_users_follow_live_subscriptions() {
        let bus = EventBus::new();
        assert!(bus.listening_users().is_empty());
        let a1 = bus.subscribe_user(1);
        let a2 = bus.subscribe_user(1);
        let b = bus.subscribe_user(2);
        assert_eq!(bus.listening_users(), vec![1, 2]);
        drop(a1);
        assert_eq!(bus.listening_users(), vec![1, 2]);
        drop(b);
        assert_eq!(bus.listening_users(), vec![1]);
        drop(a2);
        assert!(bus.listening_users().is_empty());
    }

    #[tokio::test]
    async fn a_lagging_subscriber_gets_lagged_then_continues() {
        let bus = EventBus::new();
        let mut a = bus.subscribe_user(1);
        for _ in 0..1100 {
            bus.publish(Audience::User(2), changed(2));
        }
        bus.publish(Audience::User(1), changed(1));
        assert!(matches!(a.recv().await, Some(Event::Lagged)));
        assert_eq!(changed_byte(a.recv().await), 1);
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
