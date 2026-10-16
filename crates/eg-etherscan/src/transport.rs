use async_trait::async_trait;
use eg_core::source::SourceError;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;

#[async_trait]
pub trait Transport: Send + Sync {
    /// Perform a GET with the given query params; returns the raw response body.
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
        let resp = self
            .client
            .get(&self.base_url)
            .query(params)
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

/// Forwards to HTTP and records each successful response body to `<dir>/<fixture_key>.json`.
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
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("body"))
            .mount(&ok)
            .await;
        let t = RecordingTransport::new(HttpTransport::new(&ok.uri()), &dir);
        assert_eq!(t.get(&params).await.unwrap(), "body");
        assert_eq!(
            FixtureTransport::new(&dir).get(&params).await.unwrap(),
            "body"
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
    }

    fn tempdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("eg-etherscan-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
