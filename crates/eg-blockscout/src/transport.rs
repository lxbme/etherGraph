use async_trait::async_trait;
use eg_core::source::SourceError;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;

use crate::parse::parse_raw_trace;

/// An HTTP response; the client maps the status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

#[async_trait]
pub trait PathTransport: Send + Sync {
    /// GET `path` (relative to the API base, may carry a query string).
    /// Only failures to get any response are errors (`Network`).
    async fn get(&self, path: &str) -> Result<HttpReply, SourceError>;
}

/// Live HTTP transport against a base URL such as `https://eth.blockscout.com/api/v2`.
pub struct HttpPathTransport {
    client: reqwest::Client,
    base_url: String,
}

impl HttpPathTransport {
    pub fn new(base_url: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_owned(),
        }
    }
}

#[async_trait]
impl PathTransport for HttpPathTransport {
    async fn get(&self, path: &str) -> Result<HttpReply, SourceError> {
        // `without_url` keeps the apikey out of error messages.
        let resp = self
            .client
            .get(format!("{}{path}", self.base_url))
            .send()
            .await
            .map_err(|e| SourceError::Network(e.without_url().to_string()))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| SourceError::Network(e.without_url().to_string()))?;
        Ok(HttpReply { status, body })
    }
}

/// Replays 200 responses from `<dir>/blockscout/<fixture_key>.json`.
pub struct FixturePathTransport {
    dir: PathBuf,
}

impl FixturePathTransport {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into().join("blockscout"),
        }
    }
}

#[async_trait]
impl PathTransport for FixturePathTransport {
    async fn get(&self, path: &str) -> Result<HttpReply, SourceError> {
        let key = fixture_key(path);
        let body = tokio::fs::read_to_string(self.dir.join(format!("{key}.json")))
            .await
            .map_err(|_| SourceError::FixtureMissing(key))?;
        Ok(HttpReply { status: 200, body })
    }
}

/// Forwards to HTTP and records each 200 response whose body parses as a raw
/// trace to `<dir>/blockscout/<fixture_key>.json`; anything else is passed on
/// but not recorded, so a replay never serves a transient failure.
pub struct RecordingPathTransport {
    inner: HttpPathTransport,
    dir: PathBuf,
}

impl RecordingPathTransport {
    pub fn new(inner: HttpPathTransport, dir: impl Into<PathBuf>) -> Self {
        Self {
            inner,
            dir: dir.into().join("blockscout"),
        }
    }
}

#[async_trait]
impl PathTransport for RecordingPathTransport {
    async fn get(&self, path: &str) -> Result<HttpReply, SourceError> {
        let reply = self.inner.get(path).await?;
        if reply.status != 200 || parse_raw_trace(&reply.body).is_err() {
            return Ok(reply);
        }
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| SourceError::Network(format!("record: {e}")))?;
        tokio::fs::write(
            self.dir.join(format!("{}.json", fixture_key(path))),
            &reply.body,
        )
        .await
        .map_err(|e| SourceError::Network(format!("record: {e}")))?;
        Ok(reply)
    }
}

/// Stable key for a request: the path with any `apikey` query parameter
/// removed, sha256, first 16 hex chars.
pub fn fixture_key(path: &str) -> String {
    let stripped = match path.split_once('?') {
        None => path.to_owned(),
        Some((base, query)) => {
            let kept: Vec<&str> = query
                .split('&')
                .filter(|kv| kv.split('=').next() != Some("apikey"))
                .collect();
            if kept.is_empty() {
                base.to_owned()
            } else {
                format!("{base}?{}", kept.join("&"))
            }
        }
    };
    hex::encode(Sha256::digest(stripped.as_bytes()))[..16].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACE: &str = r#"[{"action":{"callType":"call","from":"0x1111111111111111111111111111111111111111","to":"0x2222222222222222222222222222222222222222","gas":"0x10","input":"0x","value":"0x0"},"result":{"gasUsed":"0x5","output":"0x"},"subtraces":0,"traceAddress":[],"type":"call"}]"#;

    #[test]
    fn fixture_key_ignores_apikey() {
        let a = fixture_key("/transactions/0xab/raw-trace");
        assert_eq!(a, fixture_key("/transactions/0xab/raw-trace?apikey=K"));
        assert_eq!(
            fixture_key("/x?a=1"),
            fixture_key("/x?apikey=K&a=1"),
            "other query params are kept"
        );
        assert_ne!(a, fixture_key("/transactions/0xcd/raw-trace"));
        assert_ne!(fixture_key("/x?a=1"), fixture_key("/x"));
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn fixture_transport_reads_and_misses() {
        let dir = tempdir("fixture");
        let path = "/transactions/0xab/raw-trace";
        let t = FixturePathTransport::new(&dir);
        let r = t.get(path).await;
        assert!(matches!(r, Err(SourceError::FixtureMissing(_))), "{r:?}");

        std::fs::create_dir_all(dir.join("blockscout")).unwrap();
        std::fs::write(
            dir.join("blockscout")
                .join(format!("{}.json", fixture_key(path))),
            TRACE,
        )
        .unwrap();
        let reply = t.get(&format!("{path}?apikey=K")).await.unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body, TRACE);
    }

    #[tokio::test]
    async fn http_joins_base_and_path_and_passes_status() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v2/transactions/0xab/raw-trace"))
            .respond_with(ResponseTemplate::new(404).set_body_string("nf"))
            .mount(&server)
            .await;
        let t = HttpPathTransport::new(&format!("{}/api/v2/", server.uri()));
        let reply = t.get("/transactions/0xab/raw-trace").await.unwrap();
        assert_eq!(
            reply,
            HttpReply {
                status: 404,
                body: "nf".into()
            }
        );
    }

    #[tokio::test]
    async fn recording_writes_only_parsed_200s() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let path = "/transactions/0xab/raw-trace?apikey=K";

        let ok = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(TRACE))
            .mount(&ok)
            .await;
        let dir = tempdir("rec");
        let t = RecordingPathTransport::new(HttpPathTransport::new(&ok.uri()), &dir);
        assert_eq!(t.get(path).await.unwrap().body, TRACE);
        let replay = FixturePathTransport::new(&dir).get(path).await.unwrap();
        assert_eq!(replay.body, TRACE);

        for (status, body) in [(429, ""), (500, ""), (200, r#"{"message":"x"}"#)] {
            let bad = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(status).set_body_string(body))
                .mount(&bad)
                .await;
            let dir = tempdir(&format!("rec-{status}"));
            let t = RecordingPathTransport::new(HttpPathTransport::new(&bad.uri()), &dir);
            assert_eq!(t.get(path).await.unwrap().status, status);
            assert!(!dir.join("blockscout").exists(), "{status}");
        }
    }

    fn tempdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("eg-blockscout-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
