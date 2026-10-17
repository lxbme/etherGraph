//! Quota persistence, UTC-midnight reset and `QuotaStatus` events.

use std::time::Duration;

use chrono::{DateTime, NaiveDate, Utc};
use eg_ingest::Event;
use eg_ingest::gate::QuotaSnapshot;
use tokio::sync::watch;

use crate::state::AppState;

const PERSIST_EVERY: Duration = Duration::from_secs(5);
/// Upper bound on how long the gate may take to apply a queued quota reset.
const RESET_APPLY_TIMEOUT: Duration = Duration::from_secs(1);
const STATUS_MIN_INTERVAL: Duration = Duration::from_secs(1);

/// The first UTC midnight strictly after `now`.
pub fn next_utc_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    now.date_naive()
        .succ_opt()
        .expect("date within chrono range")
        .and_hms_opt(0, 0, 0)
        .expect("midnight is valid")
        .and_utc()
}

/// Spawns the quota loop (persist every 5s, reset at UTC midnight) and the
/// `QuotaStatus` publisher (on snapshot change, at most once per second), and
/// starts the first chain head fetch.
pub fn spawn_background(state: &AppState) {
    state.head.prime(state);
    // Subscribe before spawning so no change after this call is missed.
    let quota_rx = state.gate.subscribe_quota();
    tokio::spawn(publish_quota_status(state.clone(), quota_rx));
    tokio::spawn(quota_loop(state.clone()));
}

async fn quota_loop(state: AppState) {
    let mut day = Utc::now().date_naive();
    let mut resume_pending = false;
    let mut tick = tokio::time::interval(PERSIST_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let now = Utc::now();
        let until_midnight = (next_utc_midnight(now) - now).to_std().unwrap_or_default();
        tokio::select! {
            _ = tick.tick() => {}
            _ = tokio::time::sleep(until_midnight) => {}
        }
        let today = Utc::now().date_naive();
        if today != day {
            resume_pending = !rollover(&state, day).await;
            day = today;
        } else if resume_pending {
            resume_pending = !resume_and_wake(&state).await;
        }
        persist(&state, day).await;
    }
}

/// Day change: stores `finished_day`'s final count, resets the gate's quota,
/// requeues quota-paused jobs and wakes the workers. Returns false when the
/// paused jobs could not be resumed (the caller retries).
pub async fn rollover(state: &AppState, finished_day: NaiveDate) -> bool {
    persist(state, finished_day).await;
    let mut rx = state.gate.subscribe_quota();
    let used = rx.borrow().used;
    state.gate.reset_quota();
    // The reset is applied asynchronously; `used` only grows until it lands,
    // so a smaller value means the reset is in effect.
    if used > 0 {
        let applied = rx.wait_for(|q| q.used < used);
        if tokio::time::timeout(RESET_APPLY_TIMEOUT, applied)
            .await
            .is_err()
        {
            tracing::warn!("quota reset not applied within {RESET_APPLY_TIMEOUT:?}");
        }
    }
    tracing::info!(%finished_day, used, "daily quota reset");
    resume_and_wake(state).await
}

async fn resume_and_wake(state: &AppState) -> bool {
    match state.store.resume_paused().await {
        Ok(n) => {
            if n > 0 {
                tracing::info!(jobs = n, "resumed quota-paused jobs");
            }
            state.ctx.wake.notify_waiters();
            true
        }
        Err(e) => {
            tracing::warn!(error = %e, "resume_paused failed; will retry");
            false
        }
    }
}

/// Stores today's (UTC) call count; used on shutdown.
pub async fn persist_quota(state: &AppState) {
    persist(state, Utc::now().date_naive()).await;
}

async fn persist(state: &AppState, day: NaiveDate) {
    if let Err(e) = state.store.quota_set(day, state.gate.used()).await {
        tracing::warn!(error = %e, %day, "persisting quota usage failed");
    }
}

async fn publish_quota_status(state: AppState, mut rx: watch::Receiver<QuotaSnapshot>) {
    while rx.changed().await.is_ok() {
        let q = *rx.borrow_and_update();
        state.ctx.bus.publish(Event::QuotaStatus {
            used: q.used,
            limit: q.limit,
            paused: q.paused,
            reset_at: next_utc_midnight(Utc::now()),
        });
        // Changes during the pause coalesce into the next event.
        tokio::time::sleep(STATUS_MIN_INTERVAL).await;
    }
}
