//! Per-user Etherscan billing and daily limits (Review Focus 4): user A is the
//! default test user, user B a second logged-in user. Every source call goes
//! through the app's gate, billed like the Etherscan client's.

mod common;

use std::time::Duration;

use alloy_primitives::{Address, B256, Bytes, U256};
use axum::http::StatusCode;
use chrono::{NaiveDate, TimeZone, Utc};
use common::{
    default_user_id, gated_app, gated_app_traced, get, get_as, post_json, post_json_as, second_user,
};
use eg_core::source::{CallGate, Priority, RawLog, RawReceipt, RawTx, SourceError};
use eg_core::testing::FakeSource;
use eg_ingest::billing::billed;
use eg_ingest::{Runner, default_handlers};
use eg_server::background::{persist_quota, rollover};
use eg_server::config::Config;
use eg_server::state::AppState;
use eg_store::JobStatus;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::task::JoinHandle;

const X: Address = Address::repeat_byte(0x81);
const Y: Address = Address::repeat_byte(0x82);
const HASH: B256 = B256::repeat_byte(0x83);
const FROM: Address = Address::repeat_byte(0x84);
const TO: Address = Address::repeat_byte(0x85);
const TOKEN: Address = Address::repeat_byte(0x86);
const TRANSFER_TOPIC: B256 = B256::new(alloy_primitives::hex!(
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
));

fn hex(a: Address) -> String {
    format!("{a:#x}")
}

fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or("")
}

/// A mined ERC-20 transfer: fetching it costs tx, receipt, block and
/// internal_txs, and queues contract and token metadata.
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

fn workers(state: &AppState, n: usize) -> Vec<JoinHandle<()>> {
    Runner::spawn(state.ctx.clone(), n, default_handlers())
}

fn stop(hs: Vec<JoinHandle<()>>) {
    hs.iter().for_each(JoinHandle::abort);
}

async fn status_of(state: &AppState, id: i64) -> JobStatus {
    state.store.job(id).await.unwrap().unwrap().status
}

async fn wait_status(state: &AppState, id: i64, want: JobStatus) {
    for _ in 0..400 {
        if status_of(state, id).await == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "job {id} never reached {want:?}: {:?}",
        status_of(state, id).await
    );
}

/// Waits until no job is pending or running.
async fn wait_idle(state: &AppState) {
    for _ in 0..400 {
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

async fn sync_as(app: &axum::Router, cookie: Option<&str>, addr: Address) -> i64 {
    let body = json!({"addresses": [hex(addr)]});
    let (st, v) = match cookie {
        Some(c) => post_json_as(app, c, "/api/sync", &body).await,
        None => post_json(app, "/api/sync", &body).await,
    };
    assert_eq!(st, StatusCode::OK, "{v}");
    v["jobs"][0].as_i64().unwrap()
}

// A sync of an address without history costs 6 calls: the chain head and
// one page for each of the five transfer kinds.

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn a_user_over_quota_waits_while_others_keep_running(pool: PgPool) {
    let (app, state, fake) = gated_app(pool, Config::default()).await;
    let a = default_user_id(&state).await;
    let (b, b_id) = second_user(&app, &state).await;
    state.gate.set_user_limit(a, Some(3));
    let hs = workers(&state, 2);

    let ja = sync_as(&app, None, X).await;
    let jb = sync_as(&app, Some(&b), Y).await;
    wait_status(&state, ja, JobStatus::PausedUserQuota).await;
    wait_status(&state, jb, JobStatus::Done).await;
    stop(hs);

    // A's 4th call was refused before it reached the upstream.
    assert_eq!(state.gate.user_quota(a).used, 3);
    assert_eq!(state.gate.user_quota(b_id).used, 6);
    assert_eq!(fake.calls(), 9);
    assert_eq!(state.gate.used(), 9);

    let (_, mine) = get(&app, "/api/status").await;
    assert_eq!(
        (
            &mine["quota_used"],
            &mine["quota_limit"],
            &mine["paused"],
            &mine["server_paused"]
        ),
        (&json!(3), &json!(3), &json!(true), &json!(false)),
        "{mine}"
    );
    let (_, theirs) = get_as(&app, &b, "/api/status").await;
    assert_eq!(
        (
            &theirs["quota_used"],
            &theirs["quota_limit"],
            &theirs["paused"],
            &theirs["server_paused"]
        ),
        (&json!(6), &json!(5000), &json!(false), &json!(false)),
        "{theirs}"
    );
    let (_, jobs) = get(&app, "/api/jobs").await;
    assert_eq!(jobs[0]["status"], "paused_user_quota");
    let (_, me) = get(&app, "/api/auth/me").await;
    assert_eq!(
        (me["quota"]["used"].as_u64(), me["quota"]["limit"].as_u64()),
        (Some(3), Some(3))
    );

    // A's new work waits too; B's does not.
    let again = sync_as(&app, None, Y).await;
    assert_eq!(status_of(&state, again).await, JobStatus::PausedUserQuota);
    let theirs = sync_as(&app, Some(&b), X).await;
    assert_eq!(status_of(&state, theirs).await, JobStatus::Pending);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn server_total_pauses_everyone_and_rollover_resumes_both(pool: PgPool) {
    let mut cfg = Config::default();
    cfg.etherscan.daily_limit = 7;
    let (app, state, _) = gated_app(pool, cfg).await;
    let a = default_user_id(&state).await;
    let (b, b_id) = second_user(&app, &state).await;
    state.gate.set_user_limit(a, Some(3));

    let hs = workers(&state, 1);
    let ja = sync_as(&app, None, X).await;
    wait_status(&state, ja, JobStatus::PausedUserQuota).await;
    // B is far below their own limit, but the server total (3 + 4) runs out.
    let jb = sync_as(&app, Some(&b), Y).await;
    wait_status(&state, jb, JobStatus::PausedQuota).await;
    stop(hs);
    assert_eq!(state.gate.used(), 7);
    assert_eq!(state.gate.user_quota(b_id).used, 4);
    for cookie in [None, Some(b.as_str())] {
        let (_, st) = match cookie {
            Some(c) => get_as(&app, c, "/api/status").await,
            None => get(&app, "/api/status").await,
        };
        assert_eq!(
            (&st["paused"], &st["server_paused"]),
            (&json!(true), &json!(true)),
            "{st}"
        );
    }

    let day = NaiveDate::from_ymd_opt(2026, 10, 18).unwrap();
    assert!(rollover(&state, day).await);
    assert_eq!(status_of(&state, ja).await, JobStatus::Pending);
    assert_eq!(status_of(&state, jb).await, JobStatus::Pending);
    assert_eq!(state.gate.user_quota(a).used, 0);
    // The finished day's per-user counts were stored.
    assert_eq!(state.store.user_usage_get(a, day).await.unwrap(), 3);
    assert_eq!(state.store.user_usage_get(b_id, day).await.unwrap(), 4);

    let hs = workers(&state, 1);
    wait_status(&state, ja, JobStatus::Done).await;
    wait_status(&state, jb, JobStatus::Done).await;
    stop(hs);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn follow_up_jobs_belong_to_and_bill_the_parents_user(pool: PgPool) {
    let (app, state, fake) = gated_app(pool, Config::default()).await;
    let a = default_user_id(&state).await;
    let (_, b_id) = second_user(&app, &state).await;
    seed_tx(&fake);
    let hs = workers(&state, 2);
    let (st, v) = get(&app, &format!("/api/tx/{HASH:#x}")).await;
    assert_eq!(
        (st, &v["status"]),
        (StatusCode::OK, &json!("pending")),
        "{v}"
    );
    wait_status(&state, v["job_id"].as_i64().unwrap(), JobStatus::Done).await;
    wait_idle(&state).await;
    stop(hs);

    let rows: Vec<(String, String, Option<i64>)> =
        sqlx::query_as("SELECT kind, key, user_id FROM jobs ORDER BY id")
            .fetch_all(state.store.pool())
            .await
            .unwrap();
    let kinds: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(
        kinds,
        ["fetch_tx", "contract_meta", "token_meta"],
        "{rows:?}"
    );
    for (_, key, user) in &rows {
        assert_eq!(*user, Some(a), "{key}");
        assert!(key.starts_with(&format!("u{a}:")), "{key}");
    }
    // Every upstream call, the follow-ups' included, was billed to A.
    assert!(fake.calls() > 4, "{}", fake.calls());
    assert_eq!(state.gate.user_quota(a).used, fake.calls());
    assert_eq!(state.gate.user_quota(b_id).used, 0);
    assert_eq!(state.gate.used(), fake.calls());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn synchronous_calls_over_quota_are_429(pool: PgPool) {
    let (app, state, fake) = gated_app(pool, Config::default()).await;
    let a = default_user_id(&state).await;
    let (b, b_id) = second_user(&app, &state).await;
    state.gate.set_user_limit(a, Some(0));
    fake.on_eth_call(|_, _| Ok(Bytes::new()));

    let (st, v) = get(&app, "/api/search?q=vitalik.eth").await;
    assert_eq!(
        (st, code(&v)),
        (StatusCode::TOO_MANY_REQUESTS, "user_quota_exhausted"),
        "{v}"
    );
    let probe = json!({"addresses": [hex(X)]});
    let (st, v) = post_json(&app, "/api/probe", &probe).await;
    assert_eq!(
        (st, code(&v)),
        (StatusCode::TOO_MANY_REQUESTS, "user_quota_exhausted"),
        "{v}"
    );
    assert_eq!(fake.calls(), 0);

    // B's own quota is untouched: the search reaches the resolver (which
    // answers nothing here) and is billed to B.
    let (st, v) = get_as(&app, &b, "/api/search?q=vitalik.eth").await;
    assert_ne!(st, StatusCode::TOO_MANY_REQUESTS, "{v}");
    assert_eq!(fake.calls(), 1);
    assert_eq!(state.gate.user_quota(b_id).used, 1);
    assert_eq!(state.gate.user_quota(a).used, 0);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cache_hits_cost_nothing(pool: PgPool) {
    let (app, state, fake) = gated_app(pool, Config::default()).await;
    let a = default_user_id(&state).await;
    let (b, b_id) = second_user(&app, &state).await;
    seed_tx(&fake);

    // A pays for the probe and the transaction fetch.
    let probe = json!({"addresses": [hex(X)]});
    let (st, v) = post_json(&app, "/api/probe", &probe).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v["calls"].as_u64().unwrap() > 0);
    let hs = workers(&state, 1);
    let (_, v) = get(&app, &format!("/api/tx/{HASH:#x}")).await;
    wait_status(&state, v["job_id"].as_i64().unwrap(), JobStatus::Done).await;
    wait_idle(&state).await;
    stop(hs);
    let paid = state.gate.user_quota(a).used;
    assert!(paid > 0);

    // B reads the same data from the shared cache.
    let (st, v) = post_json_as(&app, &b, "/api/probe", &probe).await;
    assert_eq!((st, &v["calls"]), (StatusCode::OK, &json!(0)), "{v}");
    let (st, v) = get_as(&app, &b, &format!("/api/tx/{HASH:#x}")).await;
    assert_eq!((st, &v["status"]), (StatusCode::OK, &json!("ready")), "{v}");
    let fetches: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE user_id = $1 AND kind = 'fetch_tx'")
            .bind(b_id)
            .fetch_one(state.store.pool())
            .await
            .unwrap();
    assert_eq!(fetches, 0);
    assert_eq!(state.gate.user_quota(b_id).used, 0);
    assert_eq!(state.gate.user_quota(a).used, paid);
}

/// Trace calls take permits from `state.trace_gate`: they count toward the
/// user's quota (and its stored usage) only, and still run while the
/// server's Etherscan total is used up.
#[sqlx::test(migrations = "../eg-store/migrations")]
async fn trace_calls_bill_only_the_users_quota(pool: PgPool) {
    let mut cfg = Config::default();
    cfg.etherscan.daily_limit = 1;
    let (_, state, _, trace) = gated_app_traced(pool, cfg).await;
    let a = default_user_id(&state).await;
    state.gate.set_user_limit(a, Some(3));
    billed(Some(a), state.gate.acquire(Priority::Interactive))
        .await
        .unwrap();
    assert_eq!(
        state.gate.acquire(Priority::Interactive).await,
        Err(SourceError::QuotaExhausted)
    );

    let call = || {
        billed(
            Some(a),
            state
                .ctx
                .trace_source
                .call_trace(Priority::Interactive, HASH),
        )
    };
    assert_eq!(call().await, Ok(None));
    assert_eq!(call().await, Ok(None));
    assert_eq!(call().await, Err(SourceError::UserQuotaExhausted));
    assert_eq!(trace.calls(), 2);
    assert_eq!(state.gate.used(), 1);
    assert_eq!(state.gate.user_quota(a).used, 3);
    persist_quota(&state).await;
    let today = Utc::now().date_naive();
    assert_eq!(state.store.user_usage_get(a, today).await.unwrap(), 3);
}
