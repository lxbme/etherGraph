//! Priority rate gate: every upstream call acquires a permit here.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
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

struct Request {
    priority: Priority,
    reply: Reply,
}

/// State readable from any thread; the dispatcher task is the only writer of
/// `queue_len` and the only incrementer of `used`.
struct Shared {
    rate: f64,
    limit: u32,
    used: AtomicU32,
    paused: AtomicBool,
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

    fn publish(&self) {
        self.quota_tx.send_replace(QuotaSnapshot {
            used: self.used.load(Ordering::SeqCst),
            limit: self.limit,
            paused: self.paused.load(Ordering::SeqCst),
        });
    }
}

/// Single-dispatcher rate limiter: one permit per `1 / current_rate` seconds,
/// handed out by priority with a guaranteed share for `Low`.
pub struct PriorityGate {
    tx: mpsc::UnboundedSender<Request>,
    shared: Arc<Shared>,
}

impl PriorityGate {
    /// Must be called inside a tokio runtime; the dispatcher exits when the
    /// gate is dropped.
    pub fn spawn(cfg: GateConfig) -> Arc<Self> {
        let (quota_tx, _) = watch::channel(QuotaSnapshot {
            used: cfg.initial_used,
            limit: cfg.daily_limit,
            paused: false,
        });
        let shared = Arc::new(Shared {
            rate: cfg.rate_per_sec,
            limit: cfg.daily_limit,
            used: AtomicU32::new(cfg.initial_used),
            paused: AtomicBool::new(false),
            slow_until: Mutex::new(None),
            queue_len: AtomicUsize::new(0),
            quota_tx,
        });
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(Dispatcher::new(shared.clone(), rx).run());
        Arc::new(Self { tx, shared })
    }

    /// Zeroes `used` and lifts the pause.
    pub fn reset_quota(&self) {
        self.shared.used.store(0, Ordering::SeqCst);
        self.shared.paused.store(false, Ordering::SeqCst);
        self.shared.publish();
    }

    pub fn used(&self) -> u32 {
        self.shared.used.load(Ordering::SeqCst)
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
    async fn acquire(&self, p: Priority) -> Result<(), SourceError> {
        if self.shared.paused.load(Ordering::SeqCst) {
            return Err(SourceError::QuotaExhausted);
        }
        let (reply, rx) = oneshot::channel();
        let stopped = || SourceError::Upstream("rate gate stopped".into());
        self.tx
            .send(Request { priority: p, reply })
            .map_err(|_| stopped())?;
        rx.await.map_err(|_| stopped())?
    }

    fn on_rate_limited(&self) {
        *self.shared.slow_until.lock().unwrap() = Some(Instant::now() + SLOWDOWN);
    }
}

struct Dispatcher {
    shared: Arc<Shared>,
    rx: mpsc::UnboundedReceiver<Request>,
    /// Indexed by `Priority::as_i16`: Interactive, Background, Low.
    queues: [VecDeque<Reply>; 3],
    /// Permits granted since `Low` last got one.
    since_low: u32,
    next_slot: Instant,
}

impl Dispatcher {
    fn new(shared: Arc<Shared>, rx: mpsc::UnboundedReceiver<Request>) -> Self {
        Self {
            shared,
            rx,
            queues: Default::default(),
            since_low: 0,
            next_slot: Instant::now(),
        }
    }

    async fn run(mut self) {
        loop {
            self.prune_cancelled();
            if self.is_empty() {
                match self.rx.recv().await {
                    Some(req) => self.enqueue(req),
                    None => return,
                }
                continue;
            }
            if Instant::now() < self.next_slot {
                tokio::select! {
                    _ = sleep_until(self.next_slot) => {}
                    req = self.rx.recv() => {
                        match req {
                            Some(req) => self.enqueue(req),
                            None => return,
                        }
                        continue;
                    }
                }
            }
            // Let requests that arrived meanwhile compete for this slot.
            while let Ok(req) = self.rx.try_recv() {
                self.enqueue(req);
            }
            self.grant_one();
        }
    }

    fn enqueue(&mut self, req: Request) {
        if self.shared.paused.load(Ordering::SeqCst) {
            let _ = req.reply.send(Err(SourceError::QuotaExhausted));
            return;
        }
        self.queues[req.priority.as_i16() as usize].push_back(req.reply);
        self.sync_len();
    }

    fn grant_one(&mut self) {
        loop {
            self.prune_cancelled();
            if self.is_empty() {
                return;
            }
            if self.shared.used.load(Ordering::SeqCst) >= self.shared.limit {
                self.exhaust();
                return;
            }
            let idx = self.pick();
            let reply = self.queues[idx]
                .pop_front()
                .expect("picked non-empty queue");
            self.sync_len();
            self.shared.used.fetch_add(1, Ordering::SeqCst);
            if reply.send(Ok(())).is_err() {
                // Cancelled between pruning and sending: refund and retry.
                self.shared.used.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            self.shared.publish();
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
        self.shared.paused.store(true, Ordering::SeqCst);
        for q in &mut self.queues {
            for reply in q.drain(..) {
                let _ = reply.send(Err(SourceError::QuotaExhausted));
            }
        }
        self.sync_len();
        self.shared.publish();
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
        assert_eq!(
            *quota.borrow(),
            QuotaSnapshot {
                used: 0,
                limit: 3,
                paused: false
            }
        );
        g.acquire(Priority::Interactive).await.unwrap();
        assert_eq!(g.used(), 1);
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
