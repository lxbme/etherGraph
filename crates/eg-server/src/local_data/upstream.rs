//! Asks each upstream what it serves now, without downloading it: a HEAD for
//! the CSV files, the (small) JSON of the token lists, the XML listing of
//! Sourcify. Results are kept for [`CACHE_TTL`]; a failed source is asked
//! again on the next check.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use tokio::sync::Mutex;

use super::sources::{SourceId, Urls, valid_signature_key};

pub const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const TIMEOUT: Duration = Duration::from_secs(60);
/// Largest list or listing body read.
const MAX_BODY: usize = 50 * 1024 * 1024;

/// What an upstream serves now.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Upstream {
    /// A token list's `major.minor.patch`.
    pub version: Option<String>,
    /// A CSV file's ETag.
    pub etag: Option<String>,
    /// Bytes of the file, of the list, or of all Sourcify files.
    pub size: Option<u64>,
    /// Sourcify's files (keys already checked), sorted by key.
    pub files: Option<Vec<RemoteFile>>,
    /// A token list's body, for the import that follows the check.
    pub body: Option<Bytes>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteFile {
    pub key: String,
    pub etag: String,
    pub size: u64,
    pub last_modified: String,
}

struct Cache {
    entries: HashMap<SourceId, (Instant, Upstream)>,
    checked_at: Option<DateTime<Utc>>,
}

pub struct UpstreamChecker {
    http: reqwest::Client,
    urls: Urls,
    cache: Mutex<Cache>,
}

impl Default for UpstreamChecker {
    fn default() -> Self {
        Self::with_urls(Urls::default())
    }
}

impl UpstreamChecker {
    /// A checker for `urls`; redirects are followed only to their hosts.
    pub fn with_urls(urls: Urls) -> Self {
        let hosts = urls.hosts();
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            let ok = attempt
                .url()
                .host_str()
                .is_some_and(|h| hosts.iter().any(|a| a == h));
            if !ok {
                attempt.error("redirect to a host that is not allowed")
            } else if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        });
        let http = reqwest::Client::builder()
            .redirect(policy)
            .timeout(TIMEOUT)
            .user_agent("etherGraph")
            .build()
            .expect("the http client builds");
        Self {
            http,
            urls,
            cache: Mutex::new(Cache {
                entries: HashMap::new(),
                checked_at: None,
            }),
        }
    }

    pub fn urls(&self) -> &Urls {
        &self.urls
    }

    /// When an upstream was last asked (successfully or not).
    pub async fn checked_at(&self) -> Option<DateTime<Utc>> {
        self.cache.lock().await.checked_at
    }

    /// Every source's upstream. Sources checked less than [`CACHE_TTL`] ago
    /// are served from the cache unless `force`.
    pub async fn check(&self, force: bool) -> HashMap<SourceId, Result<Upstream, String>> {
        // Held across the requests, so concurrent callers share one check.
        let mut cache = self.cache.lock().await;
        let mut out = HashMap::new();
        let mut stale = Vec::new();
        for id in SourceId::ALL {
            match cache.entries.get(&id) {
                Some((at, up)) if !force && at.elapsed() < CACHE_TTL => {
                    out.insert(id, Ok(up.clone()));
                }
                _ => stale.push(id),
            }
        }
        if stale.is_empty() {
            return out;
        }
        let fetched = futures::future::join_all(stale.iter().map(|&id| self.fetch(id))).await;
        let now = Instant::now();
        for (id, res) in stale.into_iter().zip(fetched) {
            match &res {
                Ok(up) => {
                    cache.entries.insert(id, (now, up.clone()));
                }
                Err(_) => {
                    cache.entries.remove(&id);
                }
            }
            out.insert(id, res);
        }
        cache.checked_at = Some(Utc::now());
        out
    }

    async fn fetch(&self, id: SourceId) -> Result<Upstream, String> {
        match id {
            SourceId::EthLabels | SourceId::TokensEthLabels => self.head(self.urls.of(id)).await,
            SourceId::TokensUniswap | SourceId::TokensCoingecko => {
                self.list(self.urls.of(id)).await
            }
            SourceId::SignaturesSourcify => self.listing().await,
        }
    }

    async fn head(&self, url: &str) -> Result<Upstream, String> {
        let resp = self.http.head(url).send().await.map_err(describe)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        let header = |name: &str| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        Ok(Upstream {
            etag: header("etag"),
            size: header("content-length").and_then(|v| v.parse().ok()),
            ..Upstream::default()
        })
    }

    async fn list(&self, url: &str) -> Result<Upstream, String> {
        let body = self.get(url).await?;
        let json: serde_json::Value =
            serde_json::from_slice(&body).map_err(|e| format!("not a token list: {e}"))?;
        let v = &json["version"];
        let part = |k: &str| v[k].as_u64();
        let (Some(a), Some(b), Some(c)) = (part("major"), part("minor"), part("patch")) else {
            return Err("the token list has no version".into());
        };
        Ok(Upstream {
            version: Some(format!("{a}.{b}.{c}")),
            size: Some(body.len() as u64),
            body: Some(body),
            ..Upstream::default()
        })
    }

    async fn listing(&self) -> Result<Upstream, String> {
        let body = self.get(&self.urls.sourcify_list).await?;
        let xml = std::str::from_utf8(&body).map_err(|_| "the listing is not UTF-8".to_string())?;
        let files = parse_listing(xml);
        Ok(Upstream {
            size: Some(files.iter().map(|f| f.size).sum()),
            files: Some(files),
            ..Upstream::default()
        })
    }

    async fn get(&self, url: &str) -> Result<Bytes, String> {
        let resp = self.http.get(url).send().await.map_err(describe)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        if resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
            return Err("the response is too large".into());
        }
        let body = resp.bytes().await.map_err(describe)?;
        if body.len() > MAX_BODY {
            return Err("the response is too large".into());
        }
        Ok(body)
    }
}

fn describe(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

/// The `Contents` of an S3 listing; entries whose key is not a signature
/// file key (see [`valid_signature_key`]) or that lack a field are dropped.
fn parse_listing(xml: &str) -> Vec<RemoteFile> {
    let mut files: Vec<RemoteFile> = xml
        .split("<Contents>")
        .skip(1)
        .filter_map(|chunk| {
            let item = chunk.split("</Contents>").next()?;
            let key = tag(item, "Key")?;
            if !valid_signature_key(&key) {
                return None;
            }
            Some(RemoteFile {
                key,
                etag: tag(item, "ETag")?,
                size: tag(item, "Size")?.trim().parse().ok()?,
                last_modified: tag(item, "LastModified")?,
            })
        })
        .collect();
    files.sort_by(|a, b| a.key.cmp(&b.key));
    files
}

/// The unescaped text of the first `<name>` element of `s`.
fn tag(s: &str, name: &str) -> Option<String> {
    let start = s.find(&format!("<{name}>"))? + name.len() + 2;
    let end = start + s[start..].find(&format!("</{name}>"))?;
    Some(unescape(&s[start..end]))
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}
