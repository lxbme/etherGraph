use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use eg_core::source::{CallGate, Priority, SourceError};
use eg_etherscan::{ClientStats, EtherscanClient, HttpTransport, MAX_ATTEMPTS, Transport};
use serde_json::json;
use wiremock::matchers::{method, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Default)]
struct CountingGate {
    acquires: AtomicU32,
    rate_limited: AtomicU32,
    quota_exhausted: AtomicU32,
    fail_with: Option<SourceError>,
}

#[async_trait]
impl CallGate for CountingGate {
    async fn acquire(&self, _p: Priority) -> Result<(), SourceError> {
        self.acquires.fetch_add(1, Ordering::SeqCst);
        match &self.fail_with {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }
    fn on_rate_limited(&self) {
        self.rate_limited.fetch_add(1, Ordering::SeqCst);
    }
    fn on_quota_exhausted(&self) {
        self.quota_exhausted.fetch_add(1, Ordering::SeqCst);
    }
}

/// Runs each `HttpTransport::get` on its own OS thread and real-time runtime.
/// Under `start_paused`, tokio auto-advances the virtual clock while the test
/// runtime waits on real socket I/O, which would fire reqwest's 30s timeout
/// instantly; keeping the HTTP call off the paused runtime avoids that.
struct RealTimeHttp {
    base_url: String,
}

#[async_trait]
impl Transport for RealTimeHttp {
    async fn get(&self, params: &[(String, String)]) -> Result<String, SourceError> {
        let url = self.base_url.clone();
        let params = params.to_vec();
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let _ = tx.send(rt.block_on(HttpTransport::new(&url).get(&params)));
        });
        rx.await.unwrap()
    }
}

const OK: &str = r#"{"status":"1","message":"OK","result":["fine"]}"#;
const RATE: &str =
    r#"{"status":"0","message":"NOTOK","result":"Max calls per sec rate limit reached (3/sec)"}"#;
const DAILY: &str =
    r#"{"status":"0","message":"NOTOK","result":"Max daily rate limit reached. 100000 (100%)"}"#;
const BAD_KEY: &str = r#"{"status":"0","message":"NOTOK","result":"Invalid API Key (#err2)"}"#;

fn setup(
    server: &MockServer,
    gate: CountingGate,
) -> (EtherscanClient, Arc<CountingGate>, Arc<ClientStats>) {
    let gate = Arc::new(gate);
    let stats = Arc::new(ClientStats::default());
    let transport = Arc::new(RealTimeHttp {
        base_url: server.uri(),
    });
    let client = EtherscanClient::new(transport, gate.clone(), "k".into(), stats.clone());
    (client, gate, stats)
}

async fn mount_sequence(server: &MockServer, responses: Vec<ResponseTemplate>) {
    for r in responses {
        Mock::given(method("GET"))
            .respond_with(r)
            .up_to_n_times(1)
            .expect(1)
            .mount(server)
            .await;
    }
}

fn body(b: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(b)
}

#[tokio::test(start_paused = true)]
async fn retries_5xx_then_succeeds() {
    let server = MockServer::start().await;
    mount_sequence(
        &server,
        vec![
            ResponseTemplate::new(503),
            ResponseTemplate::new(503),
            body(OK),
        ],
    )
    .await;
    let (client, gate, _) = setup(&server, CountingGate::default());
    let v = client.call(Priority::Interactive, &[]).await.unwrap();
    assert_eq!(v, json!(["fine"]));
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn rate_limited_notifies_gate() {
    let server = MockServer::start().await;
    mount_sequence(&server, vec![body(RATE), body(OK)]).await;
    let (client, gate, _) = setup(&server, CountingGate::default());
    client.call(Priority::Background, &[]).await.unwrap();
    assert_eq!(gate.rate_limited.load(Ordering::SeqCst), 1);
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn invalid_key_not_retried() {
    let server = MockServer::start().await;
    mount_sequence(&server, vec![body(BAD_KEY)]).await;
    let (client, gate, _) = setup(&server, CountingGate::default());
    let err = client.call(Priority::Low, &[]).await.unwrap_err();
    assert_eq!(err, SourceError::InvalidKey);
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn gate_quota_error_short_circuits() {
    let server = MockServer::start().await;
    let gate = CountingGate {
        fail_with: Some(SourceError::QuotaExhausted),
        ..Default::default()
    };
    let (client, gate, stats) = setup(&server, gate);
    let err = client.call(Priority::Low, &[]).await.unwrap_err();
    assert_eq!(err, SourceError::QuotaExhausted);
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 1);
    assert!(server.received_requests().await.unwrap().is_empty());
    assert_eq!(stats.snapshot().calls, 0);
}

#[tokio::test(start_paused = true)]
async fn gives_up_after_max_attempts() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let (client, gate, _) = setup(&server, CountingGate::default());
    let start = tokio::time::Instant::now();
    let err = client.call(Priority::Interactive, &[]).await.unwrap_err();
    let elapsed = start.elapsed();
    assert!(matches!(err, SourceError::Network(_)));
    // Sleeps after attempts 1..=4 only: 1+2+4+8 = 15s, plus <= 4 * 250ms jitter.
    assert!(
        elapsed >= Duration::from_secs(15) && elapsed <= Duration::from_secs(16),
        "elapsed {elapsed:?}"
    );
    assert_eq!(gate.acquires.load(Ordering::SeqCst), MAX_ATTEMPTS);
    assert_eq!(MAX_ATTEMPTS, 5);
}

#[tokio::test]
async fn adds_chainid_and_apikey() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("chainid", "1"))
        .and(query_param("apikey", "k"))
        .and(query_param("module", "account"))
        .respond_with(body(OK))
        .expect(1)
        .mount(&server)
        .await;
    let (client, _, _) = setup(&server, CountingGate::default());
    client
        .call(Priority::Interactive, &[("module", "account".to_string())])
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn stats_count_calls_retries_errors() {
    let server = MockServer::start().await;
    mount_sequence(&server, vec![ResponseTemplate::new(503), body(OK)]).await;
    let (client, _, stats) = setup(&server, CountingGate::default());
    client.call(Priority::Interactive, &[]).await.unwrap();
    let s = stats.snapshot();
    assert_eq!(s.calls, 2);
    assert_eq!(s.retries, 1);
    assert_eq!(s.errors["network"], 1);
}

#[tokio::test]
async fn daily_limit_pauses_gate() {
    let server = MockServer::start().await;
    mount_sequence(&server, vec![body(DAILY)]).await;
    let (client, gate, _) = setup(&server, CountingGate::default());
    let err = client.call(Priority::Background, &[]).await.unwrap_err();
    assert_eq!(err, SourceError::QuotaExhausted);
    assert_eq!(gate.quota_exhausted.load(Ordering::SeqCst), 1);
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 1);
}
