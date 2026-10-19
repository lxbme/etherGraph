//! Rate gates: every upstream call acquires a permit here.
//!
//! An Etherscan permit ([`PriorityGate`]) counts toward the server's daily
//! total and, when the calling task is [`billed`](crate::billing::billed) to a
//! user, toward that user's own daily limit. A Blockscout permit
//! ([`TraceGate`]) counts only toward the user's limit, in the same book.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use eg_core::source::{CallGate, Priority, SourceError};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Instant, sleep_until};

use crate::billing::bill_to;

pub const SLOWDOWN_FACTOR: f64 = 0.8;
pub const SLOWDOWN: Duration = Duration::from_secs(60);
pub const LOW_SHARE_EVERY: u32 = 10;

pub struct GateConfig {
    pub rate_per_sec: f64,
    /// The server's daily total.
    pub daily_limit: u32,
    pub initial_used: u32,
    /// Daily calls of a user without an override.
    pub default_user_limit: u32,
    /// Per-user overrides of `default_user_limit`.
    pub user_limits: HashMap<i64, u32>,
    /// Calls each user already made today.
    pub initial_user_used: HashMap<i64, u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct QuotaSnapshot {
    pub used: u32,
    pub limit: u32,
    pub paused: bool,
}

/// One user's calls today and their effective daily limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct UserQuota {
    pub used: u32,
    pub limit: u32,
}

impl UserQuota {
    pub fn exhausted(&self) -> bool {
        self.used >= self.limit
    }
}

/// Per-user counts and limits. Counts are written by the dispatcher and by
/// [`PriorityGate::charge_user`]; limits by the admin/refresh setters.
struct UserBook {
    used: HashMap<i64, u32>,
    limits: HashMap<i64, u32>,
    default_limit: u32,
}

impl UserBook {
    fn quota(&self, user: i64) -> UserQuota {
        UserQuota {
            used: self.used.get(&user).copied().unwrap_or(0),
            limit: self
                .limits
                .get(&user)
                .copied()
                .unwrap_or(self.default_limit),
        }
    }
}

type Reply = oneshot::Sender<Result<(), SourceError>>;

/// A queued permit request and the user it is billed to.
struct Waiter {
    user: Option<i64>,
    reply: Reply,
}

enum Msg {
    Acquire {
        priority: Priority,
        user: Option<i64>,
        reply: Reply,
    },
    ResetQuota,
    /// The upstream reported its daily limit before our own count did.
    QuotaExhausted,
}

/// State readable from any thread. The dispatcher task is the only writer of
/// `queue_len` and of the quota snapshot, so quota state cannot race or tear.
struct Shared {
    rate: f64,
    slow_until: Mutex<Option<Instant>>,
    queue_len: AtomicUsize,
    quota_tx: watch::Sender<QuotaSnapshot>,
    users: Mutex<UserBook>,
    /// Ticks whenever a per-user limit changes, or a count changes without
    /// the server snapshot ([`PriorityGate::charge_user`]).
    limits_tx: watch::Sender<()>,
}

impl Shared {
    fn current_rate(&self) -> f64 {
        match *self.slow_until.lock().unwrap() {
            Some(until) if Instant::now() < until => self.rate * SLOWDOWN_FACTOR,
            _ => self.rate,
        }
    }

    fn users(&self) -> std::sync::MutexGuard<'_, UserBook> {
        self.users.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Single-dispatcher rate limiter: one permit per `1 / current_rate` seconds,
/// handed out by priority with a guaranteed share for `Low`.
pub struct PriorityGate {
    tx: mpsc::UnboundedSender<Msg>,
    shared: Arc<Shared>,
}

impl PriorityGate {
    /// Must be called inside a tokio runtime; the dispatcher exits when the
    /// gate is dropped.
    ///
    /// # Panics
    /// If `rate_per_sec` is not finite and positive.
    pub fn spawn(cfg: GateConfig) -> Arc<Self> {
        assert!(
            cfg.rate_per_sec.is_finite() && cfg.rate_per_sec > 0.0,
            "GateConfig.rate_per_sec must be finite and > 0, got {}",
            cfg.rate_per_sec
        );
        let (quota_tx, _) = watch::channel(QuotaSnapshot {
            used: cfg.initial_used,
            limit: cfg.daily_limit,
            paused: cfg.initial_used >= cfg.daily_limit,
        });
        let shared = Arc::new(Shared {
            rate: cfg.rate_per_sec,
            slow_until: Mutex::new(None),
            queue_len: AtomicUsize::new(0),
            quota_tx,
            users: Mutex::new(UserBook {
                used: cfg.initial_user_used,
                limits: cfg.user_limits,
                default_limit: cfg.default_user_limit,
            }),
            limits_tx: watch::channel(()).0,
        });
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(Dispatcher::new(shared.clone(), rx).run());
        Arc::new(Self { tx, shared })
    }

    /// Zeroes `used` (the server's and every user's) and lifts the pause.
    /// Applied by the dispatcher in order, so any `acquire` issued after this
    /// call sees the reset quota.
    pub fn reset_quota(&self) {
        // A send error means the dispatcher is gone; nothing left to reset.
        let _ = self.tx.send(Msg::ResetQuota);
    }

    pub fn used(&self) -> u32 {
        self.shared.quota_tx.borrow().used
    }

    /// `rate * SLOWDOWN_FACTOR` while a slowdown is active.
    pub fn current_rate(&self) -> f64 {
        self.shared.current_rate()
    }

    pub fn queue_len(&self) -> usize {
        self.shared.queue_len.load(Ordering::SeqCst)
    }

    pub fn subscribe_quota(&self) -> watch::Receiver<QuotaSnapshot> {
        self.shared.quota_tx.subscribe()
    }

    /// `user`'s calls today and effective limit.
    pub fn user_quota(&self, user: i64) -> UserQuota {
        self.shared.users().quota(user)
    }

    /// Every user's calls today (users with no calls are omitted), by id.
    pub fn user_usage(&self) -> Vec<(i64, u32)> {
        let mut v: Vec<(i64, u32)> = self
            .shared
            .users()
            .used
            .iter()
            .map(|(u, n)| (*u, *n))
            .collect();
        v.sort_unstable();
        v
    }

    /// Changes after every [`set_user_limit`](Self::set_user_limit),
    /// [`set_user_limits`](Self::set_user_limits) and
    /// [`charge_user`](Self::charge_user) (other per-user counts change with
    /// the server snapshot of [`subscribe_quota`](Self::subscribe_quota)).
    pub fn subscribe_user_limits(&self) -> watch::Receiver<()> {
        self.shared.limits_tx.subscribe()
    }

    /// Counts one call of another upstream (Blockscout) against `user`'s
    /// daily quota only: the server total is neither read nor counted.
    /// `Err(UserQuotaExhausted)` when the user has no calls left; `None`
    /// (an unbilled call) is always `Ok`.
    pub fn charge_user(&self, user: Option<i64>) -> Result<(), SourceError> {
        let Some(u) = user else { return Ok(()) };
        {
            let mut users = self.shared.users();
            if users.quota(u).exhausted() {
                return Err(SourceError::UserQuotaExhausted);
            }
            *users.used.entry(u).or_insert(0) += 1;
        }
        self.shared.limits_tx.send_replace(());
        Ok(())
    }

    /// Sets `user`'s own limit (`None`: back to the default); requests made
    /// after this call see it.
    pub fn set_user_limit(&self, user: i64, limit: Option<u32>) {
        {
            let mut users = self.shared.users();
            match limit {
                Some(l) => users.limits.insert(user, l),
                None => users.limits.remove(&user),
            };
        }
        self.shared.limits_tx.send_replace(());
    }

    /// Replaces the default limit and every user override (a refresh from
    /// the store).
    pub fn set_user_limits(&self, default_limit: u32, overrides: HashMap<i64, u32>) {
        {
            let mut users = self.shared.users();
            users.default_limit = default_limit;
            users.limits = overrides;
        }
        self.shared.limits_tx.send_replace(());
    }
}

#[async_trait]
impl CallGate for PriorityGate {
    /// Billed to the calling task's [`bill_to`] user. While the quota is
    /// paused the dispatcher answers `Err(QuotaExhausted)` as soon as the
    /// request arrives, without waiting for a slot; while that user's own
    /// quota is used up, `Err(UserQuotaExhausted)`.
    async fn acquire(&self, p: Priority) -> Result<(), SourceError> {
        let (reply, rx) = oneshot::channel();
        let stopped = || SourceError::Upstream("rate gate stopped".into());
        self.tx
            .send(Msg::Acquire {
                priority: p,
                user: bill_to(),
                reply,
            })
            .map_err(|_| stopped())?;
        rx.await.map_err(|_| stopped())?
    }

    fn on_rate_limited(&self) {
        *self.shared.slow_until.lock().unwrap() = Some(Instant::now() + SLOWDOWN);
    }

    /// Marks the day's quota as used up (`used = limit`, paused) until
    /// [`PriorityGate::reset_quota`]; queued requests fail with `QuotaExhausted`.
    fn on_quota_exhausted(&self) {
        // A send error means the dispatcher is gone; nothing left to pause.
        let _ = self.tx.send(Msg::QuotaExhausted);
    }
}

struct Dispatcher {
    shared: Arc<Shared>,
    rx: mpsc::UnboundedReceiver<Msg>,
    /// Indexed by `Priority::as_i16`: Interactive, Background, Low.
    queues: [VecDeque<Waiter>; 3],
    /// Permits granted since `Low` last got one.
    since_low: u32,
    next_slot: Instant,
    quota: QuotaSnapshot,
}

impl Dispatcher {
    fn new(shared: Arc<Shared>, rx: mpsc::UnboundedReceiver<Msg>) -> Self {
        let quota = *shared.quota_tx.borrow();
        Self {
            shared,
            rx,
            queues: Default::default(),
            since_low: 0,
            next_slot: Instant::now(),
            quota,
        }
    }

    async fn run(mut self) {
        loop {
            self.prune_cancelled();
            if self.is_empty() {
                match self.rx.recv().await {
                    Some(msg) => self.handle(msg),
                    None => return,
                }
                continue;
            }
            if Instant::now() < self.next_slot {
                tokio::select! {
                    _ = sleep_until(self.next_slot) => {}
                    msg = self.rx.recv() => {
                        match msg {
                            Some(msg) => self.handle(msg),
                            None => return,
                        }
                        continue;
                    }
                }
            }
            // Let messages that arrived meanwhile apply before this slot.
            while let Ok(msg) = self.rx.try_recv() {
                self.handle(msg);
            }
            self.grant_one();
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Acquire {
                priority,
                user,
                reply,
            } => {
                if self.quota.paused {
                    let _ = reply.send(Err(SourceError::QuotaExhausted));
                    return;
                }
                if self.user_exhausted(user) {
                    let _ = reply.send(Err(SourceError::UserQuotaExhausted));
                    return;
                }
                self.queues[priority.as_i16() as usize].push_back(Waiter { user, reply });
                self.sync_len();
            }
            Msg::ResetQuota => {
                self.quota.used = 0;
                self.quota.paused = false;
                self.shared.users().used.clear();
                self.publish();
            }
            Msg::QuotaExhausted => {
                self.quota.used = self.quota.limit;
                self.exhaust();
            }
        }
    }

    fn grant_one(&mut self) {
        loop {
            self.prune_cancelled();
            if self.is_empty() {
                return;
            }
            if self.quota.used >= self.quota.limit {
                self.exhaust();
                return;
            }
            let idx = self.pick();
            let Waiter { user, reply } = self.queues[idx]
                .pop_front()
                .expect("picked non-empty queue");
            self.sync_len();
            {
                // Check and count under one lock: `charge_user` writes the
                // same book from other threads.
                let mut users = self.shared.users();
                if user.is_some_and(|u| users.quota(u).exhausted()) {
                    // The user reached their limit while this request waited;
                    // it uses no slot.
                    let _ = reply.send(Err(SourceError::UserQuotaExhausted));
                    continue;
                }
                if reply.send(Ok(())).is_err() {
                    // Cancelled after pruning: try the next request in this slot.
                    continue;
                }
                if let Some(u) = user {
                    *users.used.entry(u).or_insert(0) += 1;
                }
            }
            self.quota.used += 1;
            self.publish();
            self.since_low = if idx == Priority::Low.as_i16() as usize {
                0
            } else {
                self.since_low.saturating_add(1)
            };
            let interval = Duration::from_secs_f64(1.0 / self.shared.current_rate());
            self.next_slot = Instant::now() + interval;
            return;
        }
    }

    fn pick(&self) -> usize {
        let low = Priority::Low.as_i16() as usize;
        if self.since_low >= LOW_SHARE_EVERY - 1 && !self.queues[low].is_empty() {
            return low;
        }
        self.queues
            .iter()
            .position(|q| !q.is_empty())
            .expect("pick called with all queues empty")
    }

    fn user_exhausted(&self, user: Option<i64>) -> bool {
        user.is_some_and(|u| self.shared.users().quota(u).exhausted())
    }

    fn exhaust(&mut self) {
        self.quota.paused = true;
        for q in &mut self.queues {
            for w in q.drain(..) {
                let _ = w.reply.send(Err(SourceError::QuotaExhausted));
            }
        }
        self.sync_len();
        self.publish();
    }

    fn publish(&self) {
        self.shared.quota_tx.send_replace(self.quota);
    }

    fn prune_cancelled(&mut self) {
        for q in &mut self.queues {
            q.retain(|w| !w.reply.is_closed());
        }
        self.sync_len();
    }

    fn is_empty(&self) -> bool {
        self.queues.iter().all(VecDeque::is_empty)
    }

    fn sync_len(&self) {
        let len = self.queues.iter().map(VecDeque::len).sum();
        self.shared.queue_len.store(len, Ordering::SeqCst);
    }
}

/// Rate gate for Blockscout trace requests: its own rate and its own pause
/// (Blockscout's daily credits), never counted toward the server's Etherscan
/// total. Each permit is billed to the calling task's [`bill_to`] user in the
/// per-user book of the [`PriorityGate`] it was given, shared with Etherscan
/// calls.
pub struct TraceGate {
    rate: f64,
    users: Arc<PriorityGate>,
    /// Blockscout reported its daily credits spent; cleared at the UTC-midnight
    /// reset.
    paused: AtomicBool,
    slow_until: Mutex<Option<Instant>>,
    /// When the next permit may be handed out; each request reserves its slot
    /// in arrival order.
    next_slot: Mutex<Instant>,
}

impl TraceGate {
    /// Named like [`PriorityGate::spawn`], but runs no task: each request
    /// sleeps until its reserved slot.
    ///
    /// # Panics
    /// If `rate_per_sec` is not finite and positive.
    pub fn spawn(rate_per_sec: f64, users: Arc<PriorityGate>) -> Arc<Self> {
        assert!(
            rate_per_sec.is_finite() && rate_per_sec > 0.0,
            "TraceGate rate_per_sec must be finite and > 0, got {rate_per_sec}"
        );
        Arc::new(Self {
            rate: rate_per_sec,
            users,
            paused: AtomicBool::new(false),
            slow_until: Mutex::new(None),
            next_slot: Mutex::new(Instant::now()),
        })
    }

    /// Lifts the pause; called at the UTC-midnight reset.
    pub fn reset_quota(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// `rate * SLOWDOWN_FACTOR` while a slowdown is active.
    pub fn current_rate(&self) -> f64 {
        match *self.slow_until.lock().unwrap() {
            Some(until) if Instant::now() < until => self.rate * SLOWDOWN_FACTOR,
            _ => self.rate,
        }
    }

    fn check_paused(&self) -> Result<(), SourceError> {
        if self.paused() {
            Err(SourceError::QuotaExhausted)
        } else {
            Ok(())
        }
    }
}

#[async_trait]
impl CallGate for TraceGate {
    /// `Err(QuotaExhausted)` at once while paused, `Err(UserQuotaExhausted)`
    /// at once when the [`bill_to`] user has no calls left; otherwise waits
    /// for a slot, then charges the user (checked again: their Etherscan
    /// calls may have used the rest meanwhile), so only requests that are
    /// actually sent count. A pause reported while waiting fails the request.
    async fn acquire(&self, _p: Priority) -> Result<(), SourceError> {
        let user = bill_to();
        self.check_paused()?;
        if user.is_some_and(|u| self.users.user_quota(u).exhausted()) {
            return Err(SourceError::UserQuotaExhausted);
        }
        let slot = {
            let interval = Duration::from_secs_f64(1.0 / self.current_rate());
            let mut next = self.next_slot.lock().unwrap();
            let slot = (*next).max(Instant::now());
            *next = slot + interval;
            slot
        };
        sleep_until(slot).await;
        self.check_paused()?;
        self.users.charge_user(user)
    }

    fn on_rate_limited(&self) {
        *self.slow_until.lock().unwrap() = Some(Instant::now() + SLOWDOWN);
    }

    /// Pauses until [`TraceGate::reset_quota`].
    fn on_quota_exhausted(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing::billed;
    use tokio::task::JoinHandle;
    use tokio::time::Instant;

    fn gate(rate_per_sec: f64, daily_limit: u32) -> Arc<PriorityGate> {
        user_gate(rate_per_sec, daily_limit, u32::MAX)
    }

    /// A gate whose users may each make `user_limit` calls a day.
    fn user_gate(rate_per_sec: f64, daily_limit: u32, user_limit: u32) -> Arc<PriorityGate> {
        PriorityGate::spawn(GateConfig {
            rate_per_sec,
            daily_limit,
            initial_used: 0,
            default_user_limit: user_limit,
            user_limits: HashMap::new(),
            initial_user_used: HashMap::new(),
        })
    }

    async fn acquire_as(g: &PriorityGate, user: i64) -> Result<(), SourceError> {
        billed(Some(user), g.acquire(Priority::Interactive)).await
    }

    fn uq(used: u32, limit: u32) -> UserQuota {
        UserQuota { used, limit }
    }

    type Order = Arc<Mutex<Vec<&'static str>>>;

    fn spawn_acquire(
        g: &Arc<PriorityGate>,
        p: Priority,
        label: &'static str,
        order: &Order,
    ) -> JoinHandle<()> {
        let g = g.clone();
        let order = order.clone();
        tokio::spawn(async move {
            g.acquire(p).await.unwrap();
            order.lock().unwrap().push(label);
        })
    }

    async fn wait_queue_len(g: &PriorityGate, n: usize) {
        while g.queue_len() != n {
            tokio::task::yield_now().await;
        }
    }

    fn snap(used: u32, limit: u32, paused: bool) -> QuotaSnapshot {
        QuotaSnapshot {
            used,
            limit,
            paused,
        }
    }

    async fn wait_snapshot(rx: &mut watch::Receiver<QuotaSnapshot>, want: QuotaSnapshot) {
        tokio::time::timeout(Duration::from_secs(5), rx.wait_for(|s| *s == want))
            .await
            .unwrap_or_else(|_| panic!("snapshot never became {want:?}"))
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn spacing_matches_rate() {
        let g = gate(2.0, 1000);
        let start = Instant::now();
        for _ in 0..5 {
            g.acquire(Priority::Interactive).await.unwrap();
        }
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_secs_f64(2.0), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs_f64(2.5), "{elapsed:?}");
        assert_eq!(g.used(), 5);
    }

    #[tokio::test(start_paused = true)]
    async fn interactive_jumps_queue() {
        let g = gate(2.0, 1000);
        let order: Order = Arc::default();
        let mut handles = Vec::new();
        for label in ["b1", "b2", "b3"] {
            handles.push(spawn_acquire(&g, Priority::Background, label, &order));
        }
        // b1 is granted immediately; b2 and b3 wait.
        wait_queue_len(&g, 2).await;
        handles.push(spawn_acquire(&g, Priority::Interactive, "i", &order));
        for h in handles {
            h.await.unwrap();
        }
        let order = order.lock().unwrap().clone();
        assert_eq!(order.len(), 4);
        assert_eq!(order[1], "i", "{order:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn low_not_starved() {
        let g = gate(2.0, 1000);
        let order: Order = Arc::default();
        let mut handles = Vec::new();
        for _ in 0..30 {
            handles.push(spawn_acquire(&g, Priority::Interactive, "i", &order));
        }
        wait_queue_len(&g, 29).await;
        handles.push(spawn_acquire(&g, Priority::Low, "low", &order));
        for h in handles {
            h.await.unwrap();
        }
        let order = order.lock().unwrap().clone();
        assert_eq!(order.len(), 31);
        let pos = order.iter().position(|l| *l == "low").unwrap();
        assert!(pos < 10, "low granted at position {pos}");
    }

    #[tokio::test(start_paused = true)]
    async fn slowdown_then_recover() {
        let g = gate(2.8, 1000);
        assert_eq!(g.current_rate(), 2.8);
        g.on_rate_limited();
        assert_eq!(g.current_rate(), 2.8 * SLOWDOWN_FACTOR);
        tokio::time::advance(Duration::from_secs(61)).await;
        assert_eq!(g.current_rate(), 2.8);
    }

    #[tokio::test(start_paused = true)]
    async fn quota_exhausted_and_reset() {
        let g = gate(2.0, 3);
        let quota = g.subscribe_quota();
        for _ in 0..3 {
            g.acquire(Priority::Interactive).await.unwrap();
        }
        assert_eq!(
            g.acquire(Priority::Interactive).await,
            Err(SourceError::QuotaExhausted)
        );
        assert_eq!(
            *quota.borrow(),
            QuotaSnapshot {
                used: 3,
                limit: 3,
                paused: true
            }
        );
        // While paused, new acquires fail immediately.
        assert_eq!(
            g.acquire(Priority::Background).await,
            Err(SourceError::QuotaExhausted)
        );
        g.reset_quota();
        // Requests sent after reset_quota are ordered after it.
        g.acquire(Priority::Interactive).await.unwrap();
        assert_eq!(g.used(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn reset_after_exhaustion_restores_service() {
        let g = gate(2.0, 2);
        let mut quota = g.subscribe_quota();
        for _ in 0..2 {
            g.acquire(Priority::Interactive).await.unwrap();
        }
        assert_eq!(
            g.acquire(Priority::Background).await,
            Err(SourceError::QuotaExhausted)
        );
        g.reset_quota();
        wait_snapshot(&mut quota, snap(0, 2, false)).await;
        assert_eq!(g.used(), 0);
        for _ in 0..2 {
            g.acquire(Priority::Low).await.unwrap();
        }
        assert_eq!(*quota.borrow(), snap(2, 2, false));
        assert_eq!(
            g.acquire(Priority::Interactive).await,
            Err(SourceError::QuotaExhausted)
        );
        assert_eq!(*quota.borrow(), snap(2, 2, true));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_caller_around_reset_never_wraps_used() {
        let g = gate(2.0, 5);
        let mut quota = g.subscribe_quota();
        g.acquire(Priority::Interactive).await.unwrap();
        let cancelled = {
            let g = g.clone();
            tokio::spawn(async move { g.acquire(Priority::Interactive).await })
        };
        wait_queue_len(&g, 1).await;
        g.reset_quota();
        cancelled.abort();
        let _ = cancelled.await;
        wait_snapshot(&mut quota, snap(0, 5, false)).await;
        g.acquire(Priority::Background).await.unwrap();
        assert_eq!(g.used(), 1);
    }

    /// Real threads: resets, cancellations and grants interleave freely.
    /// `used` must never exceed the limit (a wrap would show as u32::MAX).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_reset_and_cancel_stress() {
        let g = gate(100_000.0, 3);
        let quota = g.subscribe_quota();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut handles = Vec::new();
        for i in 0..8u64 {
            let (g, stop) = (g.clone(), stop.clone());
            handles.push(tokio::spawn(async move {
                while !stop.load(Ordering::Relaxed) {
                    // Every other caller gives up almost immediately.
                    let wait = Duration::from_micros(if i % 2 == 0 { 1 } else { 1000 });
                    let _ = tokio::time::timeout(wait, g.acquire(Priority::Background)).await;
                }
            }));
        }
        {
            let (g, stop) = (g.clone(), stop.clone());
            handles.push(tokio::spawn(async move {
                while !stop.load(Ordering::Relaxed) {
                    g.reset_quota();
                    tokio::task::yield_now().await;
                }
            }));
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(300);
        while std::time::Instant::now() < deadline {
            let s = *quota.borrow();
            assert!(s.used <= s.limit, "used out of range: {s:?}");
            assert!(g.used() <= 3, "used out of range: {}", g.used());
            tokio::task::yield_now().await;
        }
        stop.store(true, Ordering::Relaxed);
        for h in handles {
            h.await.unwrap();
        }
        g.reset_quota();
        tokio::time::timeout(Duration::from_secs(5), g.acquire(Priority::Interactive))
            .await
            .expect("acquire after reset timed out")
            .unwrap();
        assert!(g.used() <= 3);
    }

    #[tokio::test(start_paused = true)]
    async fn upstream_quota_exhaustion_pauses_gate() {
        let g = gate(2.0, 1000);
        let mut quota = g.subscribe_quota();
        g.acquire(Priority::Interactive).await.unwrap();
        // The next request waits for its slot when the upstream reports the
        // daily limit; it fails along with every later request.
        let queued = {
            let g = g.clone();
            tokio::spawn(async move { g.acquire(Priority::Background).await })
        };
        wait_queue_len(&g, 1).await;
        g.on_quota_exhausted();
        assert_eq!(queued.await.unwrap(), Err(SourceError::QuotaExhausted));
        wait_snapshot(&mut quota, snap(1000, 1000, true)).await;
        assert_eq!(
            g.acquire(Priority::Interactive).await,
            Err(SourceError::QuotaExhausted)
        );
        g.reset_quota();
        g.acquire(Priority::Low).await.unwrap();
        assert_eq!(g.used(), 1);
    }

    #[test]
    #[should_panic(expected = "rate_per_sec must be finite and > 0")]
    fn rejects_zero_rate() {
        PriorityGate::spawn(GateConfig {
            rate_per_sec: 0.0,
            daily_limit: 1,
            initial_used: 0,
            default_user_limit: 1,
            user_limits: HashMap::new(),
            initial_user_used: HashMap::new(),
        });
    }

    #[test]
    #[should_panic(expected = "rate_per_sec must be finite and > 0")]
    fn rejects_non_finite_rate() {
        PriorityGate::spawn(GateConfig {
            rate_per_sec: f64::NAN,
            daily_limit: 1,
            initial_used: 0,
            default_user_limit: 1,
            user_limits: HashMap::new(),
            initial_user_used: HashMap::new(),
        });
    }

    #[tokio::test(start_paused = true)]
    async fn exhaustion_fails_every_queued_request() {
        let g = gate(2.0, 1);
        let mut handles = Vec::new();
        for p in [Priority::Interactive, Priority::Background, Priority::Low] {
            let g = g.clone();
            handles.push(tokio::spawn(async move { g.acquire(p).await }));
        }
        let mut results = Vec::new();
        for h in handles {
            results.push(h.await.unwrap());
        }
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| **r == Err(SourceError::QuotaExhausted))
                .count(),
            2
        );
        assert_eq!(g.queue_len(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn initial_used_seeds_quota() {
        let g = PriorityGate::spawn(GateConfig {
            rate_per_sec: 2.0,
            daily_limit: 10,
            initial_used: 10,
            default_user_limit: 1,
            user_limits: HashMap::new(),
            initial_user_used: HashMap::new(),
        });
        assert_eq!(g.used(), 10);
        assert_eq!(*g.subscribe_quota().borrow(), snap(10, 10, true));
        assert_eq!(
            g.acquire(Priority::Interactive).await,
            Err(SourceError::QuotaExhausted)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn user_limit_refuses_only_that_user() {
        let g = user_gate(1000.0, 1000, 3);
        for _ in 0..3 {
            acquire_as(&g, 1).await.unwrap();
        }
        assert_eq!(
            acquire_as(&g, 1).await,
            Err(SourceError::UserQuotaExhausted)
        );
        acquire_as(&g, 2).await.unwrap();
        // Unbilled (system) calls count only toward the server total.
        g.acquire(Priority::Interactive).await.unwrap();
        assert_eq!(g.user_quota(1), uq(3, 3));
        assert!(g.user_quota(1).exhausted());
        assert_eq!(g.user_quota(2), uq(1, 3));
        assert_eq!(g.user_quota(3), uq(0, 3));
        assert_eq!(g.used(), 5);
        assert!(!g.subscribe_quota().borrow().paused);
        assert_eq!(g.user_usage(), vec![(1, 3), (2, 1)]);
    }

    #[tokio::test(start_paused = true)]
    async fn server_total_still_caps_billed_calls() {
        let g = user_gate(1000.0, 2, 10);
        acquire_as(&g, 1).await.unwrap();
        acquire_as(&g, 2).await.unwrap();
        assert_eq!(acquire_as(&g, 1).await, Err(SourceError::QuotaExhausted));
        assert_eq!(acquire_as(&g, 3).await, Err(SourceError::QuotaExhausted));
        assert!(g.subscribe_quota().borrow().paused);
        assert_eq!(g.user_quota(1), uq(1, 10));
    }

    #[tokio::test(start_paused = true)]
    async fn user_limits_change_immediately() {
        let g = user_gate(1000.0, 1000, 5);
        g.set_user_limit(1, Some(1));
        acquire_as(&g, 1).await.unwrap();
        assert_eq!(
            acquire_as(&g, 1).await,
            Err(SourceError::UserQuotaExhausted)
        );
        g.set_user_limit(1, Some(2));
        acquire_as(&g, 1).await.unwrap();
        assert_eq!(g.user_quota(1), uq(2, 2));
        // Back to the default.
        g.set_user_limit(1, None);
        assert_eq!(g.user_quota(1), uq(2, 5));
        acquire_as(&g, 1).await.unwrap();
        // A refresh replaces the default and every override.
        g.set_user_limits(2, HashMap::from([(1, 10)]));
        assert_eq!(g.user_quota(1), uq(3, 10));
        assert_eq!(g.user_quota(2), uq(0, 2));
    }

    #[tokio::test(start_paused = true)]
    async fn limit_changes_are_signalled() {
        let g = user_gate(1000.0, 1000, 5);
        let mut limits = g.subscribe_user_limits();
        assert!(!limits.has_changed().unwrap());
        g.set_user_limit(1, Some(1));
        assert!(limits.has_changed().unwrap());
        limits.mark_unchanged();
        g.set_user_limits(2, HashMap::new());
        assert!(limits.has_changed().unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn reset_clears_user_counts() {
        let g = user_gate(1000.0, 1000, 1);
        acquire_as(&g, 1).await.unwrap();
        assert_eq!(
            acquire_as(&g, 1).await,
            Err(SourceError::UserQuotaExhausted)
        );
        g.reset_quota();
        acquire_as(&g, 1).await.unwrap();
        assert_eq!(g.user_quota(1), uq(1, 1));
        assert_eq!(g.used(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn user_reaching_the_limit_while_queued_is_refused_at_grant() {
        let g = user_gate(2.0, 1000, 1);
        let spawn_as = |user: i64| {
            let g = g.clone();
            tokio::spawn(async move { acquire_as(&g, user).await })
        };
        let first = spawn_as(1);
        let second = spawn_as(1);
        let other = spawn_as(2);
        assert_eq!(first.await.unwrap(), Ok(()));
        assert_eq!(second.await.unwrap(), Err(SourceError::UserQuotaExhausted));
        assert_eq!(other.await.unwrap(), Ok(()));
        assert_eq!(g.user_quota(1), uq(1, 1));
        assert_eq!(g.used(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn initial_user_usage_seeds_counts() {
        let g = PriorityGate::spawn(GateConfig {
            rate_per_sec: 2.0,
            daily_limit: 1000,
            initial_used: 4,
            default_user_limit: 3,
            user_limits: HashMap::from([(2, 10)]),
            initial_user_used: HashMap::from([(1, 3), (2, 1)]),
        });
        assert_eq!(
            acquire_as(&g, 1).await,
            Err(SourceError::UserQuotaExhausted)
        );
        assert_eq!(g.user_quota(2), uq(1, 10));
        assert_eq!(g.user_usage(), vec![(1, 3), (2, 1)]);
    }

    #[tokio::test(start_paused = true)]
    async fn charge_user_counts_only_the_user_book() {
        let g = user_gate(1000.0, 1, 5);
        let limits = g.subscribe_user_limits();
        acquire_as(&g, 1).await.unwrap();
        // The server total is used up: Etherscan calls pause, charges do not.
        assert_eq!(acquire_as(&g, 2).await, Err(SourceError::QuotaExhausted));
        assert!(!limits.has_changed().unwrap());
        g.charge_user(Some(1)).unwrap();
        // A count change outside the server snapshot is signalled.
        assert!(limits.has_changed().unwrap());
        g.charge_user(Some(2)).unwrap();
        // Unbilled calls charge nobody.
        g.charge_user(None).unwrap();
        assert_eq!(g.used(), 1);
        assert_eq!(*g.subscribe_quota().borrow(), snap(1, 1, true));
        assert_eq!(g.user_quota(1), uq(2, 5));
        assert_eq!(g.user_usage(), vec![(1, 2), (2, 1)]);
    }

    #[tokio::test(start_paused = true)]
    async fn charge_user_refuses_an_exhausted_user() {
        let g = user_gate(1000.0, 1000, 2);
        g.charge_user(Some(1)).unwrap();
        acquire_as(&g, 1).await.unwrap();
        assert_eq!(g.charge_user(Some(1)), Err(SourceError::UserQuotaExhausted));
        // Both paths share one book.
        assert_eq!(
            acquire_as(&g, 1).await,
            Err(SourceError::UserQuotaExhausted)
        );
        assert_eq!(g.user_quota(1), uq(2, 2));
        g.charge_user(Some(2)).unwrap();
        g.reset_quota();
        acquire_as(&g, 3).await.unwrap(); // ordered after the reset
        g.charge_user(Some(1)).unwrap();
        assert_eq!(g.user_quota(1), uq(1, 2));
    }

    /// Real threads: Etherscan grants and Blockscout charges for one user
    /// interleave; together they never lose a count or pass the limit.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_grants_and_charges_share_the_user_limit() {
        const LIMIT: u32 = 200;
        let g = user_gate(1_000_000.0, u32::MAX, LIMIT);
        let granted = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let mut handles = Vec::new();
        for i in 0..8 {
            let (g, granted) = (g.clone(), granted.clone());
            handles.push(tokio::spawn(async move {
                loop {
                    let r = if i % 2 == 0 {
                        acquire_as(&g, 1).await
                    } else {
                        let r = g.charge_user(Some(1));
                        tokio::task::yield_now().await;
                        r
                    };
                    match r {
                        Ok(()) => {
                            granted.fetch_add(1, Ordering::SeqCst);
                        }
                        Err(SourceError::UserQuotaExhausted) => return,
                        Err(e) => panic!("{e:?}"),
                    }
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(granted.load(Ordering::SeqCst), LIMIT);
        assert_eq!(g.user_quota(1), uq(LIMIT, LIMIT));
    }

    #[tokio::test(start_paused = true)]
    async fn trace_gate_bills_the_task_local_user() {
        let users = user_gate(1000.0, 1000, 2);
        let t = TraceGate::spawn(2.0, users.clone());
        billed(Some(7), t.acquire(Priority::Interactive))
            .await
            .unwrap();
        assert_eq!(users.user_quota(7), uq(1, 2));
        // Never counted toward the server's Etherscan total.
        assert_eq!(users.used(), 0);
        // Unbilled requests charge nobody.
        t.acquire(Priority::Interactive).await.unwrap();
        assert_eq!(users.user_usage(), vec![(7, 1)]);
        acquire_as(&users, 7).await.unwrap();
        // The user's Etherscan call used the rest of their quota.
        let start = Instant::now();
        assert_eq!(
            billed(Some(7), t.acquire(Priority::Interactive)).await,
            Err(SourceError::UserQuotaExhausted)
        );
        assert_eq!(start.elapsed(), Duration::ZERO, "refused without waiting");
        assert_eq!(users.user_quota(7), uq(2, 2));
    }

    #[tokio::test(start_paused = true)]
    async fn trace_gate_spacing_and_slowdown() {
        let users = gate(1000.0, 1000);
        let t = TraceGate::spawn(2.0, users);
        let start = Instant::now();
        for _ in 0..5 {
            t.acquire(Priority::Interactive).await.unwrap();
        }
        assert_eq!(start.elapsed(), Duration::from_secs(2));
        t.on_rate_limited();
        assert_eq!(t.current_rate(), 2.0 * SLOWDOWN_FACTOR);
        let start = Instant::now();
        for _ in 0..2 {
            t.acquire(Priority::Interactive).await.unwrap();
        }
        // The slot reserved before the slowdown still applies at the old rate.
        assert_eq!(
            start.elapsed(),
            Duration::from_secs_f64(0.5 + 1.0 / (2.0 * SLOWDOWN_FACTOR))
        );
        tokio::time::advance(SLOWDOWN).await;
        assert_eq!(t.current_rate(), 2.0);
    }

    #[tokio::test(start_paused = true)]
    async fn trace_gate_paused_returns_quota_exhausted_until_reset() {
        let users = user_gate(1000.0, 1000, 10);
        let t = TraceGate::spawn(2.0, users.clone());
        t.acquire(Priority::Interactive).await.unwrap();
        // The next request waits 0.5 s for its slot when Blockscout reports
        // its daily credits spent; it fails without charging its user.
        let queued = {
            let t = t.clone();
            tokio::spawn(billed(Some(1), async move {
                t.acquire(Priority::Interactive).await
            }))
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        t.on_quota_exhausted();
        assert!(t.paused());
        assert_eq!(queued.await.unwrap(), Err(SourceError::QuotaExhausted));
        assert_eq!(
            billed(Some(1), t.acquire(Priority::Interactive)).await,
            Err(SourceError::QuotaExhausted)
        );
        assert_eq!(users.user_quota(1), uq(0, 10));
        // Etherscan is unaffected.
        acquire_as(&users, 1).await.unwrap();
        t.reset_quota();
        assert!(!t.paused());
        billed(Some(1), t.acquire(Priority::Interactive))
            .await
            .unwrap();
        assert_eq!(users.user_quota(1), uq(2, 10));
    }

    #[tokio::test]
    #[should_panic(expected = "rate_per_sec must be finite and > 0")]
    async fn trace_gate_rejects_zero_rate() {
        TraceGate::spawn(0.0, gate(1.0, 1));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_request_consumes_no_quota() {
        let g = gate(2.0, 1000);
        g.acquire(Priority::Interactive).await.unwrap();
        // Next slot is 0.5s away, so this request queues; cancel it.
        let cancelled = {
            let g = g.clone();
            tokio::spawn(async move { g.acquire(Priority::Interactive).await })
        };
        wait_queue_len(&g, 1).await;
        cancelled.abort();
        let _ = cancelled.await;
        g.acquire(Priority::Background).await.unwrap();
        assert_eq!(g.used(), 2);
    }
}
