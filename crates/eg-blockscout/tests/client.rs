use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use eg_blockscout::{BlockscoutTraceSource, HttpPathTransport};
use eg_core::source::{CallGate, CallKind, Priority, SourceError, TraceSource};
use eg_core::types::TxHash;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const ENS: &str = include_str!("data/ens_register.json");
const HASH: &str = "0x461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3";
const TRACE_PATH: &str = "/api/v2/transactions/0x461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3/raw-trace";

#[derive(Default)]
struct CountingGate {
    acquires: AtomicU32,
    rate_limited: AtomicU32,
    priorities: Mutex<Vec<Priority>>,
    fail_with: Option<SourceError>,
}

#[async_trait]
impl CallGate for CountingGate {
    async fn acquire(&self, p: Priority) -> Result<(), SourceError> {
        self.acquires.fetch_add(1, Ordering::SeqCst);
        self.priorities.lock().unwrap().push(p);
        match &self.fail_with {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }
    fn on_rate_limited(&self) {
        self.rate_limited.fetch_add(1, Ordering::SeqCst);
    }
}

fn hash() -> TxHash {
    HASH.parse().unwrap()
}

fn source(
    server: &MockServer,
    gate: CountingGate,
    key: Option<&str>,
) -> (BlockscoutTraceSource, Arc<CountingGate>) {
    let gate = Arc::new(gate);
    let transport = Arc::new(HttpPathTransport::new(&format!("{}/api/v2", server.uri())));
    let src = BlockscoutTraceSource::new(transport, gate.clone(), key.map(str::to_owned));
    (src, gate)
}

async fn respond(server: &MockServer, r: ResponseTemplate) {
    Mock::given(method("GET"))
        .and(path(TRACE_PATH))
        .respond_with(r)
        .mount(server)
        .await;
}

#[tokio::test]
async fn ok_returns_frames() {
    let server = MockServer::start().await;
    respond(&server, ResponseTemplate::new(200).set_body_string(ENS)).await;
    let (src, gate) = source(&server, CountingGate::default(), None);
    let frames = src
        .call_trace(Priority::Interactive, hash())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frames.len(), 17);
    assert_eq!(frames[0].kind, CallKind::Call);
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 1);
    assert_eq!(
        *gate.priorities.lock().unwrap(),
        vec![Priority::Interactive]
    );
    assert_eq!(src.name(), "blockscout");
}

#[tokio::test]
async fn not_found_is_none() {
    let server = MockServer::start().await;
    respond(
        &server,
        ResponseTemplate::new(404).set_body_string(r#"{"message":"Not found"}"#),
    )
    .await;
    let (src, gate) = source(&server, CountingGate::default(), None);
    assert_eq!(src.call_trace(Priority::Background, hash()).await, Ok(None));
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn empty_array_is_none() {
    // A real transaction always has a root frame; an empty list means the
    // trace is not indexed (yet), which must not be cached as a result.
    let server = MockServer::start().await;
    respond(&server, ResponseTemplate::new(200).set_body_string("[]")).await;
    let (src, _) = source(&server, CountingGate::default(), None);
    assert_eq!(src.call_trace(Priority::Background, hash()).await, Ok(None));
}

#[tokio::test]
async fn too_many_requests_is_rate_limited_and_notifies_gate() {
    let server = MockServer::start().await;
    respond(&server, ResponseTemplate::new(429)).await;
    let (src, gate) = source(&server, CountingGate::default(), None);
    let err = src.call_trace(Priority::Low, hash()).await.unwrap_err();
    assert_eq!(err, SourceError::RateLimited);
    assert_eq!(gate.rate_limited.load(Ordering::SeqCst), 1);
    // No client-side retry: the job runner retries.
    assert_eq!(gate.acquires.load(Ordering::SeqCst), 1);
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn server_errors_are_network() {
    for status in [500, 503] {
        let server = MockServer::start().await;
        respond(&server, ResponseTemplate::new(status)).await;
        let (src, gate) = source(&server, CountingGate::default(), None);
        let err = src
            .call_trace(Priority::Interactive, hash())
            .await
            .unwrap_err();
        assert!(matches!(err, SourceError::Network(_)), "{status}: {err:?}");
        assert_eq!(gate.rate_limited.load(Ordering::SeqCst), 0);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn connection_failure_is_network() {
    let gate = Arc::new(CountingGate::default());
    let transport = Arc::new(HttpPathTransport::new("http://127.0.0.1:1/api/v2"));
    let src = BlockscoutTraceSource::new(transport, gate, Some("SECRET123".into()));
    match src.call_trace(Priority::Interactive, hash()).await {
        Err(SourceError::Network(m)) => assert!(!m.contains("SECRET123"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn non_array_body_is_parse_error() {
    let server = MockServer::start().await;
    respond(
        &server,
        ResponseTemplate::new(200).set_body_string(r#"{"message":"Something went wrong"}"#),
    )
    .await;
    let (src, _) = source(&server, CountingGate::default(), None);
    let err = src
        .call_trace(Priority::Interactive, hash())
        .await
        .unwrap_err();
    assert!(matches!(err, SourceError::Parse(_)), "{err:?}");
}

#[tokio::test]
async fn apikey_sent_only_when_configured() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(TRACE_PATH))
        .and(query_param("apikey", "proapi_k"))
        .respond_with(ResponseTemplate::new(200).set_body_string(ENS))
        .expect(1)
        .mount(&server)
        .await;
    let (src, _) = source(&server, CountingGate::default(), Some("proapi_k"));
    assert!(
        src.call_trace(Priority::Low, hash())
            .await
            .unwrap()
            .is_some()
    );

    let bare = MockServer::start().await;
    respond(&bare, ResponseTemplate::new(200).set_body_string(ENS)).await;
    let (src, _) = source(&bare, CountingGate::default(), None);
    assert!(
        src.call_trace(Priority::Low, hash())
            .await
            .unwrap()
            .is_some()
    );
    let reqs = bare.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
    assert!(reqs[0].url.query().is_none(), "{}", reqs[0].url);
}

#[tokio::test]
async fn gate_refusal_sends_no_request() {
    let server = MockServer::start().await;
    respond(&server, ResponseTemplate::new(200).set_body_string(ENS)).await;
    let gate = CountingGate {
        fail_with: Some(SourceError::UserQuotaExhausted),
        ..Default::default()
    };
    let (src, gate) = source(&server, gate, None);
    let err = src
        .call_trace(Priority::Background, hash())
        .await
        .unwrap_err();
    assert_eq!(err, SourceError::UserQuotaExhausted);
    assert_eq!(*gate.priorities.lock().unwrap(), vec![Priority::Background]);
    assert!(server.received_requests().await.unwrap().is_empty());
}
