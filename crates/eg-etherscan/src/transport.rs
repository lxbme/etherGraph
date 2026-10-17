use async_trait::async_trait;
use eg_core::source::SourceError;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;

use crate::classify::classify;

#[async_trait]
pub trait Transport: Send + Sync {
    /// Send one API request with the given params (`eth_call` goes as a form
    /// POST, everything else as a GET query); returns the raw response body.
    async fn get(&self, params: &[(String, String)]) -> Result<String, SourceError>;
}

/// Live HTTP transport. Network errors and 5xx map to `Network`, 4xx to `Upstream`.
pub struct HttpTransport {
    client: reqwest::Client,
    base_url: String,
}

impl HttpTransport {
    pub fn new(base_url: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            client,
            base_url: base_url.to_owned(),
        }
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn get(&self, params: &[(String, String)]) -> Result<String, SourceError> {
        // eth_call batches exceed URL length limits (~8 KB), so it goes as a form POST.
        let is_post = params.iter().any(|(k, v)| k == "action" && v == "eth_call");
        let req = if is_post {
            self.client.post(&self.base_url).form(params)
        } else {
            self.client.get(&self.base_url).query(params)
        };
        let resp = req
            .send()
            .await
            .map_err(|e| SourceError::Network(e.without_url().to_string()))?;
        let status = resp.status();
        if status.is_server_error() {
            return Err(SourceError::Network(format!("http {status}")));
        }
        if status.is_client_error() {
            return Err(SourceError::Upstream(format!("http {status}")));
        }
        resp.text()
            .await
            .map_err(|e| SourceError::Network(e.without_url().to_string()))
    }
}

/// Replays responses from `<dir>/<fixture_key>.json`.
pub struct FixtureTransport {
    dir: PathBuf,
}

impl FixtureTransport {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
}

#[async_trait]
impl Transport for FixtureTransport {
    async fn get(&self, params: &[(String, String)]) -> Result<String, SourceError> {
        let key = fixture_key(params);
        tokio::fs::read_to_string(self.dir.join(format!("{key}.json")))
            .await
            .map_err(|_| SourceError::FixtureMissing(key))
    }
}

/// Forwards to HTTP and records each successful response body to
/// `<dir>/<fixture_key>.json`. Bodies that classify as an error (rate limit,
/// quota, invalid key, ...) are passed on but not recorded, so a replay never
/// serves a transient failure.
pub struct RecordingTransport {
    inner: HttpTransport,
    dir: PathBuf,
}

impl RecordingTransport {
    pub fn new(inner: HttpTransport, dir: impl Into<PathBuf>) -> Self {
        Self {
            inner,
            dir: dir.into(),
        }
    }
}

#[async_trait]
impl Transport for RecordingTransport {
    async fn get(&self, params: &[(String, String)]) -> Result<String, SourceError> {
        let body = self.inner.get(params).await?;
        if classify(&body).is_err() {
            return Ok(body);
        }
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| SourceError::Network(format!("record: {e}")))?;
        let path = self.dir.join(format!("{}.json", fixture_key(params)));
        tokio::fs::write(path, &body)
            .await
            .map_err(|e| SourceError::Network(format!("record: {e}")))?;
        Ok(body)
    }
}

/// Stable key for a request: apikey removed, sorted, `k=v&...`, sha256, first 16 hex chars.
pub fn fixture_key(params: &[(String, String)]) -> String {
    let mut pairs: Vec<&(String, String)> = params.iter().filter(|(k, _)| k != "apikey").collect();
    pairs.sort();
    let joined = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    hex::encode(Sha256::digest(joined.as_bytes()))[..16].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(k: &str, v: &str) -> (String, String) {
        (k.into(), v.into())
    }

    #[test]
    fn fixture_key_ignores_apikey_and_order() {
        let a = fixture_key(&[
            p("module", "account"),
            p("apikey", "X"),
            p("action", "txlist"),
        ]);
        let b = fixture_key(&[
            p("action", "txlist"),
            p("module", "account"),
            p("apikey", "Y"),
        ]);
        let c = fixture_key(&[p("action", "txlist"), p("module", "proxy")]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn fixture_transport_missing_file() {
        let dir = tempdir("missing");
        let t = FixtureTransport::new(&dir);
        let r = t.get(&[p("a", "b")]).await;
        assert!(matches!(r, Err(SourceError::FixtureMissing(_))), "{r:?}");
    }

    #[tokio::test]
    async fn fixture_transport_reads_file() {
        let dir = tempdir("reads");
        let params = [p("a", "b"), p("apikey", "k")];
        std::fs::write(
            dir.join(format!("{}.json", fixture_key(&params))),
            "{\"x\":1}",
        )
        .unwrap();
        let t = FixtureTransport::new(&dir);
        assert_eq!(t.get(&params).await.unwrap(), "{\"x\":1}");
    }

    #[tokio::test]
    async fn http_get_sends_query_and_maps_status() {
        use wiremock::matchers::{method, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(query_param("module", "account"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;
        let t = HttpTransport::new(&server.uri());
        assert_eq!(t.get(&[p("module", "account")]).await.unwrap(), "ok");

        let s5 = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&s5)
            .await;
        let r = HttpTransport::new(&s5.uri()).get(&[]).await;
        assert!(matches!(r, Err(SourceError::Network(_))), "{r:?}");

        let s4 = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&s4)
            .await;
        let r = HttpTransport::new(&s4.uri()).get(&[]).await;
        assert!(matches!(r, Err(SourceError::Upstream(_))), "{r:?}");

        let r = HttpTransport::new("http://127.0.0.1:1").get(&[]).await;
        assert!(matches!(r, Err(SourceError::Network(_))), "{r:?}");
    }

    #[tokio::test]
    async fn eth_call_is_posted_as_form_without_query() {
        use wiremock::matchers::{body_string_contains, method};
        use wiremock::{Mock, MockServer, Request, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_string_contains("action=eth_call"))
            .and(body_string_contains("data=0xabcdef"))
            .and(body_string_contains("apikey=K"))
            .respond_with(ResponseTemplate::new(200).set_body_string("posted"))
            .mount(&server)
            .await;
        let t = HttpTransport::new(&server.uri());
        let out = t
            .get(&[
                p("chainid", "1"),
                p("module", "proxy"),
                p("action", "eth_call"),
                p("data", "0xabcdef"),
                p("apikey", "K"),
            ])
            .await
            .unwrap();
        assert_eq!(out, "posted");
        let reqs: Vec<Request> = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        assert!(reqs[0].url.query().is_none(), "{}", reqs[0].url);
    }

    #[tokio::test]
    async fn non_eth_call_stays_get_with_query() {
        use wiremock::matchers::{method, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(query_param("action", "txlist"))
            .and(query_param("apikey", "K"))
            .respond_with(ResponseTemplate::new(200).set_body_string("got"))
            .mount(&server)
            .await;
        let t = HttpTransport::new(&server.uri());
        let out = t
            .get(&[p("action", "txlist"), p("apikey", "K")])
            .await
            .unwrap();
        assert_eq!(out, "got");
    }

    #[tokio::test]
    async fn network_error_does_not_leak_apikey() {
        let r = HttpTransport::new("http://127.0.0.1:1")
            .get(&[p("apikey", "SECRET123")])
            .await;
        match r {
            Err(SourceError::Network(m)) => assert!(!m.contains("SECRET123"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn recording_writes_only_on_success() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let dir = tempdir("rec").join("nested");
        let params = [p("a", "b"), p("apikey", "k")];

        let ok = MockServer::start().await;
        let fine = r#"{"status":"1","message":"OK","result":[]}"#;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(fine))
            .mount(&ok)
            .await;
        let t = RecordingTransport::new(HttpTransport::new(&ok.uri()), &dir);
        assert_eq!(t.get(&params).await.unwrap(), fine);
        assert_eq!(
            FixtureTransport::new(&dir).get(&params).await.unwrap(),
            fine
        );

        let bad = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&bad)
            .await;
        let dir2 = tempdir("rec2").join("nested");
        let t = RecordingTransport::new(HttpTransport::new(&bad.uri()), &dir2);
        assert!(t.get(&params).await.is_err());
        assert!(!dir2.exists());

        // A 200 whose body is an Etherscan error is passed on, not recorded.
        let limited = MockServer::start().await;
        let rate = r#"{"status":"0","message":"NOTOK","result":"Max calls per sec rate limit reached (3/sec)"}"#;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(rate))
            .mount(&limited)
            .await;
        let dir3 = tempdir("rec3").join("nested");
        let t = RecordingTransport::new(HttpTransport::new(&limited.uri()), &dir3);
        assert_eq!(t.get(&params).await.unwrap(), rate);
        assert!(!dir3.exists());
    }

    fn tempdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("eg-etherscan-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
