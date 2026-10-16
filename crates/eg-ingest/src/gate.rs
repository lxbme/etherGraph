//! Priority rate gate: every upstream call acquires a permit here.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use eg_core::source::{CallGate, Priority, SourceError};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Instant, sleep_until};

pub const SLOWDOWN_FACTOR: f64 = 0.8;
pub const SLOWDOWN: Duration = Duration::from_secs(60);
pub const LOW_SHARE_EVERY: u32 = 10;

pub struct GateConfig {
    pub rate_per_sec: f64,
    pub daily_limit: u32,
    pub initial_used: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct QuotaSnapshot {
    pub used: u32,
    pub limit: u32,
    pub paused: bool,
}

type Reply = oneshot::Sender<Result<(), SourceError>>;

enum Msg {
    Acquire { priority: Priority, reply: Reply },
    ResetQuota,
}

/// State readable from any thread. The dispatcher task is the only writer of
/// `queue_len` and of the quota snapshot, so quota state cannot race or tear.
struct Shared {
    rate: f64,
    slow_until: Mutex<Option<Instant>>,
    queue_len: AtomicUsize,
    quota_tx: watch::Sender<QuotaSnapshot>,
}

impl Shared {
    fn current_rate(&self) -> f64 {
        match *self.slow_until.lock().unwrap() {
            Some(until) if Instant::now() < until => self.rate * SLOWDOWN_FACTOR,
            _ => self.rate,
        }
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
        });
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(Dispatcher::new(shared.clone(), rx).run());
        Arc::new(Self { tx, shared })
    }

    /// Zeroes `used` and lifts the pause. Applied by the dispatcher in order,
    /// so any `acquire` issued after this call sees the reset quota.
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
}

#[async_trait]
impl CallGate for PriorityGate {
    /// While the quota is paused the dispatcher answers `Err(QuotaExhausted)`
    /// as soon as the request arrives, without waiting for a slot.
    async fn acquire(&self, p: Priority) -> Result<(), SourceError> {
        let (reply, rx) = oneshot::channel();
        let stopped = || SourceError::Upstream("rate gate stopped".into());
        self.tx
            .send(Msg::Acquire { priority: p, reply })
            .map_err(|_| stopped())?;
        rx.await.map_err(|_| stopped())?
    }

    fn on_rate_limited(&self) {
        *self.shared.slow_until.lock().unwrap() = Some(Instant::now() + SLOWDOWN);
    }
}

struct Dispatcher {
    shared: Arc<Shared>,
    rx: mpsc::UnboundedReceiver<Msg>,
    /// Indexed by `Priority::as_i16`: Interactive, Background, Low.
    queues: [VecDeque<Reply>; 3],
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
            Msg::Acquire { priority, reply } => {
                if self.quota.paused {
                    let _ = reply.send(Err(SourceError::QuotaExhausted));
                    return;
                }
                self.queues[priority.as_i16() as usize].push_back(reply);
                self.sync_len();
            }
            Msg::ResetQuota => {
                self.quota.used = 0;
                self.quota.paused = false;
                self.publish();
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
            let reply = self.queues[idx]
                .pop_front()
                .expect("picked non-empty queue");
            self.sync_len();
            if reply.send(Ok(())).is_err() {
                // Cancelled after pruning: try the next request in this slot.
                continue;
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

    fn exhaust(&mut self) {
        self.quota.paused = true;
        for q in &mut self.queues {
            for reply in q.drain(..) {
                let _ = reply.send(Err(SourceError::QuotaExhausted));
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
            q.retain(|reply| !reply.is_closed());
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::task::JoinHandle;
    use tokio::time::Instant;

    fn gate(rate_per_sec: f64, daily_limit: u32) -> Arc<PriorityGate> {
        PriorityGate::spawn(GateConfig {
            rate_per_sec,
            daily_limit,
            initial_used: 0,
        })
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

    #[test]
    #[should_panic(expected = "rate_per_sec must be finite and > 0")]
    fn rejects_zero_rate() {
        PriorityGate::spawn(GateConfig {
            rate_per_sec: 0.0,
            daily_limit: 1,
            initial_used: 0,
        });
    }

    #[test]
    #[should_panic(expected = "rate_per_sec must be finite and > 0")]
    fn rejects_non_finite_rate() {
        PriorityGate::spawn(GateConfig {
            rate_per_sec: f64::NAN,
            daily_limit: 1,
            initial_used: 0,
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
        });
        assert_eq!(g.used(), 10);
        assert_eq!(*g.subscribe_quota().borrow(), snap(10, 10, true));
        assert_eq!(
            g.acquire(Priority::Interactive).await,
            Err(SourceError::QuotaExhausted)
        );
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
