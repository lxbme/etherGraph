//! Per-user event delivery over `/api/events` (Review Focus 5) and the
//! stream's session re-validation (Review Focus 3). User A is the default
//! test user, user B a second logged-in user.

mod common;

use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Address, B256, Bytes, U256};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chrono::{TimeZone, Utc};
use common::{
    ORIGIN, anon_app, as_default_user, default_user_id, gated_app, get, post_json, second_user,
};
use eg_core::source::{RawLog, RawReceipt, RawTx};
use eg_core::testing::FakeSource;
use eg_ingest::events::Audience;
use eg_ingest::{Event, Runner, default_handlers};
use eg_server::app::router;
use eg_server::auth::{AuthState, SESSION_RECHECK_EVERY};
use eg_server::background::spawn_background;
use eg_server::config::Config;
use eg_server::state::AppState;
use eg_store::JobStatus;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::task::JoinHandle;
use tower::ServiceExt;

const X: Address = Address::repeat_byte(0x91);
const HASH: B256 = B256::repeat_byte(0x93);
const FROM: Address = Address::repeat_byte(0x94);
const TOKEN: Address = Address::repeat_byte(0x96);
const TO: Address = Address::repeat_byte(0x95);
const TRANSFER_TOPIC: B256 = B256::new(alloy_primitives::hex!(
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
));

/// A mined ERC-20 transfer: fetching it queues contract and token metadata.
fn seed_tx(fake: &FakeSource) {
    let log = RawLog {
        address: TOKEN,
        topics: vec![TRANSFER_TOPIC, FROM.into_word(), TO.into_word()],
        data: Bytes::from(U256::from(100u8).to_be_bytes::<32>().to_vec()),
        log_index: 0,
    };
    fake.add_tx(
        RawTx {
            hash: HASH,
            from: FROM,
            to: Some(TOKEN),
            value: U256::ZERO,
            input: Bytes::from(vec![0xa9, 0x05, 0x9c, 0xbb]),
            block_number: Some(100),
            json: json!({"hash": format!("{HASH:#x}"), "input": "0xa9059cbb"}),
        },
        RawReceipt {
            success: true,
            gas_used: U256::from(21000u32),
            effective_gas_price: U256::from(1u8),
            contract_address: None,
            logs: vec![log],
            json: json!({"status": "0x1"}),
        },
        vec![],
        Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
    );
}

/// An open `/api/events` stream and every event read from it so far.
struct Sse {
    body: Body,
    buf: String,
    events: Vec<Value>,
    ended: bool,
}

impl Sse {
    /// Opens the stream with `cookie`, or as user A when `None`.
    async fn open(app: &Router, cookie: Option<&str>) -> Self {
        let mut req = Request::get("/api/events");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let resp = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        Self {
            body: resp.into_body(),
            buf: String::new(),
            events: Vec::new(),
            ended: false,
        }
    }

    /// Reads one body frame into `events`; false once the stream has ended.
    async fn read_frame(&mut self) -> bool {
        let Some(frame) = self.body.frame().await else {
            self.ended = true;
            return false;
        };
        if let Ok(data) = frame.unwrap().into_data() {
            self.buf.push_str(std::str::from_utf8(&data).unwrap());
        }
        while let Some(end) = self.buf.find("\n\n") {
            let chunk: String = self.buf.drain(..end + 2).collect();
            if let Some(data) = chunk.lines().find_map(|l| l.strip_prefix("data: ")) {
                self.events.push(serde_json::from_str(data).unwrap());
            }
        }
        true
    }

    /// The first event, read so far or arriving within 10 s, matching `pred`.
    async fn until(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let found = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(v) = self.events.iter().find(|v| pred(v)) {
                    return v.clone();
                }
                assert!(self.read_frame().await, "stream ended before {what}");
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("never saw {what}; got {:?}", self.events))
    }

    /// Reads whatever arrives within `d`.
    async fn drain(&mut self, d: Duration) {
        let _ = tokio::time::timeout(d, async { while self.read_frame().await {} }).await;
    }

    /// Whether the stream ends within `d`.
    async fn ends_within(&mut self, d: Duration) -> bool {
        self.drain(d).await;
        self.ended
    }
}

fn is(v: &Value, ty: &str) -> bool {
    v["type"] == ty
}

/// The `JobProgress` with which job `id` finished.
fn finished(v: &Value, id: i64) -> bool {
    is(v, "JobProgress") && v["job_id"] == id && v["status"] == "done"
}

fn kind_finished(v: &Value, kind: &str) -> bool {
    is(v, "JobProgress") && v["kind"] == kind && v["status"] == "done"
}

fn workers(state: &AppState, n: usize) -> Vec<JoinHandle<()>> {
    Runner::spawn(state.ctx.clone(), n, default_handlers())
}

async fn wait_idle(state: &AppState) {
    for _ in 0..1000 {
        let busy = state
            .store
            .active_jobs()
            .await
            .unwrap()
            .iter()
            .any(|j| matches!(j.status, JobStatus::Pending | JobStatus::Running));
        if !busy {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("jobs still running");
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_users_job_events_reach_only_their_stream(pool: PgPool) {
    let (app, state, fake) = gated_app(pool, Config::default()).await;
    let a = default_user_id(&state).await;
    let (b_cookie, b) = second_user(&app, &state).await;
    seed_tx(&fake);
    // ENS and token multicalls answer nothing; the jobs still finish.
    fake.on_eth_call(|_, _| Ok(Bytes::new()));
    spawn_background(&state);
    let mut sa = Sse::open(&app, None).await;
    let mut sb = Sse::open(&app, Some(&b_cookie)).await;
    // Each stream gets its user's status when it opens, before A starts.
    let b_limit = state.gate.user_quota(b).limit;
    let connect_status = |v: &Value, limit: u32| {
        is(v, "QuotaStatus")
            && v["used"] == 0
            && v["limit"] == limit
            && v["paused"] == false
            && v["server_paused"] == false
    };
    sb.until("B's connect-time status", |v| connect_status(v, b_limit))
        .await;
    let a_limit = state.gate.user_quota(a).limit;
    sa.until("A's connect-time status", |v| connect_status(v, a_limit))
        .await;
    let hs = workers(&state, 2);

    // A sync.
    let (st, v) = post_json(
        &app,
        "/api/sync",
        &json!({"addresses": [format!("{X:#x}")]}),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let sync = v["jobs"][0].as_i64().unwrap();
    sa.until("A's sync finishing", |v| finished(v, sync)).await;
    sa.until("A's address data", |v| {
        is(v, "AddressDataChanged") && v["address"] == format!("{X:#x}")
    })
    .await;

    // A transaction fetch and its contract and token metadata follow-ups.
    let tx = format!("/api/tx/{HASH:#x}");
    let (st, v) = get(&app, &tx).await;
    assert_eq!(
        (st, &v["status"]),
        (StatusCode::OK, &json!("pending")),
        "{v}"
    );
    let fetch = v["job_id"].as_i64().unwrap();
    sa.until("A's fetch_tx finishing", |v| finished(v, fetch))
        .await;
    sa.until("A's TxReady", |v| {
        is(v, "TxReady") && v["hash"] == format!("{HASH:#x}")
    })
    .await;
    sa.until("A's contract_meta", |v| kind_finished(v, "contract_meta"))
        .await;
    sa.until("A's token_meta", |v| kind_finished(v, "token_meta"))
        .await;
    sa.until("A's MetaUpdated", |v| is(v, "MetaUpdated")).await;
    wait_idle(&state).await;

    // Viewing the ready tx queues ENS names for its parties and, with the
    // block header gone, a fetch_block follow-up.
    sqlx::query("DELETE FROM blocks")
        .execute(state.store.pool())
        .await
        .unwrap();
    let (st, v) = get(&app, &tx).await;
    assert_eq!((st, &v["status"]), (StatusCode::OK, &json!("ready")), "{v}");
    sa.until("A's fetch_block", |v| kind_finished(v, "fetch_block"))
        .await;
    sa.until("A's resolve_names", |v| kind_finished(v, "resolve_names"))
        .await;
    sa.until("A's NamesResolved", |v| is(v, "NamesResolved"))
        .await;
    wait_idle(&state).await;
    hs.iter().for_each(JoinHandle::abort);

    // A's quota status carries A's own calls.
    let used = state.gate.user_quota(a).used;
    assert!(used > 0);
    sa.until("A's QuotaStatus", |v| {
        is(v, "QuotaStatus") && v["used"] == used && v["server_paused"] == false
    })
    .await;

    // B saw nothing while A's jobs ran: only its connect-time status.
    sb.drain(Duration::from_millis(1500)).await;
    assert_eq!(state.gate.user_quota(b).used, 0);
    assert_eq!(sb.events.len(), 1, "B received {:?}", sb.events);
    assert!(!sb.ended);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_stream_forwards_only_its_users_events(pool: PgPool) {
    let (app, state, _) = gated_app(pool, Config::default()).await;
    let a = default_user_id(&state).await;
    let (b_cookie, b) = second_user(&app, &state).await;
    let mut sa = Sse::open(&app, None).await;
    let mut sb = Sse::open(&app, Some(&b_cookie)).await;
    let changed = |n: u8| Event::AddressDataChanged {
        address: Address::repeat_byte(n),
    };
    state.ctx.bus.publish(Audience::Nobody, changed(1));
    state.ctx.bus.publish(Audience::User(b), changed(2));
    state.ctx.bus.publish(Audience::User(a), changed(3));
    let addr = |n: u8| json!(format!("{:#x}", Address::repeat_byte(n)));
    sa.until("A's event", |v| v["address"] == addr(3)).await;
    sb.until("B's event", |v| v["address"] == addr(2)).await;
    assert_eq!(sa.events.len(), 1, "{:?}", sa.events);
    sb.drain(Duration::from_millis(200)).await;
    assert_eq!(sb.events.len(), 1, "{:?}", sb.events);
}

/// The app of [`gated_app`] whose event streams re-check their session every
/// `every`.
async fn app_rechecking_every(pool: PgPool, every: Duration) -> (Router, AppState) {
    let (_, mut state, _) = anon_app(pool, Config::default());
    state.auth = Arc::new(AuthState {
        session_recheck: every,
        ..AuthState::new(&state.cfg)
    });
    let app = as_default_user(router(state.clone()), &state).await;
    (app, state)
}

#[test]
fn streams_recheck_their_session_every_30_seconds() {
    assert_eq!(SESSION_RECHECK_EVERY, Duration::from_secs(30));
    assert_eq!(
        AuthState::new(&Config::default()).session_recheck,
        SESSION_RECHECK_EVERY
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_revoked_sessions_stream_ends(pool: PgPool) {
    let (app, state) = app_rechecking_every(pool, Duration::from_millis(100)).await;
    let a = default_user_id(&state).await;
    let (b_cookie, b) = second_user(&app, &state).await;
    let mut sa = Sse::open(&app, None).await;
    let mut sb = Sse::open(&app, Some(&b_cookie)).await;
    // Live sessions keep their streams across several checks.
    assert!(!sb.ends_within(Duration::from_millis(500)).await);

    state.store.sessions_revoke_user(b).await.unwrap();
    assert!(
        sb.ends_within(Duration::from_secs(3)).await,
        "B's stream still open"
    );
    // A's stream is untouched.
    assert!(!sa.ends_within(Duration::from_millis(300)).await);
    state
        .ctx
        .bus
        .publish(Audience::User(a), Event::AddressDataChanged { address: X });
    sa.until("A's event", |v| is(v, "AddressDataChanged")).await;
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_logged_out_sessions_stream_ends(pool: PgPool) {
    let (app, _state) = app_rechecking_every(pool, Duration::from_millis(100)).await;
    let mut sa = Sse::open(&app, None).await;
    let req = Request::post("/api/auth/logout")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert!(resp.status().is_success(), "{}", resp.status());
    assert!(
        sa.ends_within(Duration::from_secs(3)).await,
        "A's stream still open"
    );
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn an_expired_sessions_stream_ends(pool: PgPool) {
    let (app, state) = app_rechecking_every(pool, Duration::from_millis(100)).await;
    let mut sa = Sse::open(&app, None).await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 second'")
        .execute(state.store.pool())
        .await
        .unwrap();
    assert!(
        sa.ends_within(Duration::from_secs(3)).await,
        "A's stream still open"
    );
}
