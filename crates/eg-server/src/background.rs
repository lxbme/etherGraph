//! Quota persistence (server and per user), UTC-midnight reset, per-user
//! limit refresh, `QuotaStatus` events and the purge of spent login nonces
//! and expired sessions.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, NaiveDate, Utc};
use eg_ingest::gate::{PriorityGate, QuotaSnapshot};
use eg_ingest::{Audience, Event};
use eg_store::{SETTING_DEFAULT_DAILY_QUOTA, Store, StoreError};
use tokio::sync::watch;
use tokio::time::{Instant, sleep_until};

use crate::config::Config;
use crate::state::AppState;

const PERSIST_EVERY: Duration = Duration::from_secs(5);
/// How often per-user limits are reloaded from the store (admin changes also
/// reach the gate at once through `PriorityGate::set_user_limit`).
const LIMITS_REFRESH_EVERY: Duration = Duration::from_secs(30);
/// Upper bound on how long the gate may take to apply a queued quota reset.
const RESET_APPLY_TIMEOUT: Duration = Duration::from_secs(1);
const STATUS_MIN_INTERVAL: Duration = Duration::from_secs(1);
const AUTH_PURGE_EVERY: Duration = Duration::from_secs(600);

/// The first UTC midnight strictly after `now`.
pub fn next_utc_midnight(now: DateTime<Utc>) -> DateTime<Utc> {
    now.date_naive()
        .succ_opt()
        .expect("date within chrono range")
        .and_hms_opt(0, 0, 0)
        .expect("midnight is valid")
        .and_utc()
}

/// Spawns the quota loop (persist every 5s, reset at UTC midnight), the
/// per-user limit refresh (every 30s), the per-user `QuotaStatus` publisher
/// (on change, at most once per second per user) and the auth purge (every
/// 10 minutes), and starts the first chain head fetch.
pub fn spawn_background(state: &AppState) {
    state.head.prime(state);
    // Subscribe before spawning so no change after this call is missed.
    let quota_rx = state.gate.subscribe_quota();
    tokio::spawn(publish_quota_status(state.clone(), quota_rx));
    tokio::spawn(quota_loop(state.clone()));
    tokio::spawn(limits_loop(state.clone()));
    tokio::spawn(auth_purge_loop(state.clone()));
}

/// Per-user limits and counts as the gate starts with them.
pub struct UserQuotas {
    /// Calls per day of a user without an override.
    pub default_limit: u32,
    pub overrides: HashMap<i64, u32>,
    /// Each user's calls on the day loaded (users without calls omitted).
    pub used: HashMap<i64, u32>,
}

/// The admin-set default daily quota, else the configured one.
pub async fn default_user_limit(store: &Store, cfg: &Config) -> Result<u32, StoreError> {
    let setting = store.setting_get(SETTING_DEFAULT_DAILY_QUOTA).await?;
    Ok(setting
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(cfg.auth.default_daily_quota))
}

/// Every user's limit and their calls on `day`.
pub async fn load_user_quotas(
    store: &Store,
    cfg: &Config,
    day: NaiveDate,
) -> Result<UserQuotas, StoreError> {
    let default_limit = default_user_limit(store, cfg).await?;
    let mut overrides = HashMap::new();
    let mut used = HashMap::new();
    for row in store.users_with_usage(day).await? {
        if let Some(q) = row.user.daily_quota {
            overrides.insert(row.user.id, u32::try_from(q).unwrap_or(0));
        }
        if row.calls > 0 {
            used.insert(row.user.id, row.calls);
        }
    }
    Ok(UserQuotas {
        default_limit,
        overrides,
        used,
    })
}

/// Requeues the jobs paused on their user's quota for every user who is
/// under it again (a raised limit, or a reset this process missed).
pub async fn resume_users_under_quota(
    store: &Store,
    gate: &PriorityGate,
) -> Result<u64, StoreError> {
    let users: Vec<i64> = store
        .user_paused_owners()
        .await?
        .into_iter()
        .filter(|u| !gate.user_quota(*u).exhausted())
        .collect();
    if users.is_empty() {
        return Ok(0);
    }
    store.resume_user_paused(Some(&users)).await
}

/// Reloads the default limit and every override into the gate, then resumes
/// the users whose new limit lets their paused jobs run.
pub async fn refresh_user_limits(state: &AppState) -> Result<(), StoreError> {
    let q = load_user_quotas(&state.store, &state.cfg, Utc::now().date_naive()).await?;
    state.gate.set_user_limits(q.default_limit, q.overrides);
    if resume_users_under_quota(&state.store, &state.gate).await? > 0 {
        state.ctx.wake.notify_waiters();
    }
    Ok(())
}

async fn limits_loop(state: AppState) {
    let mut tick = tokio::time::interval(LIMITS_REFRESH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires at once; the gate was just loaded at startup.
    tick.tick().await;
    loop {
        tick.tick().await;
        if let Err(e) = refresh_user_limits(&state).await {
            tracing::warn!(error = %e, "refreshing per-user quota limits failed");
        }
    }
}

async fn auth_purge_loop(state: AppState) {
    let mut tick = tokio::time::interval(AUTH_PURGE_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        purge_auth(&state).await;
    }
}

/// Deletes used or expired login nonces and expired sessions.
pub async fn purge_auth(state: &AppState) {
    match state.store.purge_expired_auth().await {
        Ok((nonces, sessions)) if nonces + sessions > 0 => {
            tracing::debug!(nonces, sessions, "purged spent nonces and expired sessions");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "purging nonces and sessions failed"),
    }
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

/// Day change: stores `finished_day`'s final counts (server and per user),
/// resets the gate's quotas, requeues the jobs paused on either quota and
/// wakes the workers. Returns false when the paused jobs could not be
/// resumed (the caller retries).
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
    let resumed = async {
        Ok::<_, StoreError>(
            state.store.resume_paused().await? + state.store.resume_user_paused(None).await?,
        )
    };
    match resumed.await {
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

/// Stores today's (UTC) call counts; used on shutdown.
pub async fn persist_quota(state: &AppState) {
    persist(state, Utc::now().date_naive()).await;
}

async fn persist(state: &AppState, day: NaiveDate) {
    if let Err(e) = state.store.quota_set(day, state.gate.used()).await {
        tracing::warn!(error = %e, %day, "persisting quota usage failed");
    }
    if let Err(e) = state
        .store
        .user_usage_set(day, &state.gate.user_usage())
        .await
    {
        tracing::warn!(error = %e, %day, "persisting per-user quota usage failed");
    }
}

/// A user's `QuotaStatus` figures, as `/api/status` reports them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct QuotaView {
    used: u32,
    limit: u32,
    paused: bool,
    server_paused: bool,
    reset_at: DateTime<Utc>,
}

impl QuotaView {
    fn of(gate: &PriorityGate, user: i64, server: QuotaSnapshot, now: DateTime<Utc>) -> Self {
        let mine = gate.user_quota(user);
        Self {
            used: mine.used,
            limit: mine.limit,
            paused: mine.exhausted() || server.paused,
            server_paused: server.paused,
            reset_at: next_utc_midnight(now),
        }
    }

    fn event(self) -> Event {
        Event::QuotaStatus {
            used: self.used,
            limit: self.limit,
            paused: self.paused,
            server_paused: self.server_paused,
            reset_at: self.reset_at,
        }
    }
}

/// Sends each user with an open event stream their own `QuotaStatus` when it
/// differs from the last one they were sent (their count or limit, the
/// server pause, or the day changed), at most once per
/// [`STATUS_MIN_INTERVAL`] per user; changes in between coalesce into the
/// next event. A newly listening user gets their current status at the next
/// change of anyone's quota.
async fn publish_quota_status(state: AppState, mut server_rx: watch::Receiver<QuotaSnapshot>) {
    let mut limits_rx = state.gate.subscribe_user_limits();
    let mut sent: HashMap<i64, (QuotaView, Instant)> = HashMap::new();
    loop {
        let server = *server_rx.borrow_and_update();
        limits_rx.mark_unchanged();
        let listening = state.ctx.bus.listening_users();
        sent.retain(|u, _| listening.binary_search(u).is_ok());
        let (now, at) = (Utc::now(), Instant::now());
        let mut due: Option<Instant> = None;
        for user in listening {
            let view = QuotaView::of(&state.gate, user, server, now);
            match sent.get(&user) {
                Some((last, _)) if *last == view => continue,
                Some((_, last_at)) if at < *last_at + STATUS_MIN_INTERVAL => {
                    let next = *last_at + STATUS_MIN_INTERVAL;
                    due = Some(due.map_or(next, |d| d.min(next)));
                    continue;
                }
                _ => {}
            }
            state.ctx.bus.publish(Audience::User(user), view.event());
            sent.insert(user, (view, at));
        }
        tokio::select! {
            r = server_rx.changed() => if r.is_err() { return },
            r = limits_rx.changed() => if r.is_err() { return },
            _ = sleep_until(due.unwrap_or(at)), if due.is_some() => {}
        }
    }
}
