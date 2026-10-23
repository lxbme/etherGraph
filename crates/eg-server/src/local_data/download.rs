//! Downloads from the local datasets' upstreams: streamed to `<path>.part`
//! chunk by chunk (never buffered whole), capped in size even without a
//! Content-Length, cancellable between chunks, and redirected only within
//! the upstreams' own origins.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::sources::Urls;

/// Size cap and overall timeout (connect to last byte) of one download.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub cap: u64,
    pub timeout: Duration,
}

/// The list sources: 60 s and 50 MB.
pub const LIST_LIMITS: Limits = Limits {
    cap: 50 * 1024 * 1024,
    timeout: Duration::from_secs(60),
};

/// Sourcify, per file: 10 min and 200 MB.
pub const SOURCIFY_LIMITS: Limits = Limits {
    cap: 200 * 1024 * 1024,
    timeout: Duration::from_secs(10 * 60),
};

/// Progress is reported at most this often (and once at the end).
pub const PROGRESS_EVERY: Duration = Duration::from_millis(250);

const MAX_REDIRECTS: usize = 5;

#[derive(Debug, PartialEq, Eq)]
pub enum DownloadError {
    Cancelled,
    Failed(String),
}

/// A complete download.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Downloaded {
    pub bytes: u64,
    /// Hex SHA-256 of the body.
    pub sha256: String,
    /// The response's ETag, verbatim (quotes kept).
    pub etag: Option<String>,
    /// The most body bytes held in memory at once: one chunk, as the body
    /// is written out chunk by chunk.
    pub peak_buffered: usize,
}

/// `<path>.part`, where `path` is downloaded to before it is renamed.
pub fn part_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".part");
    PathBuf::from(p)
}

/// A client builder whose redirects stay within the origins (scheme, host
/// and port) of `urls`: the real upstreams are all `https`, so a redirect
/// can neither leave their hosts nor downgrade to `http`.
pub fn client_builder(urls: &Urls) -> reqwest::ClientBuilder {
    let origins = urls.origins();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if !origins.contains(&attempt.url().origin()) {
            attempt.error("redirect to a host that is not allowed")
        } else if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .user_agent("etherGraph")
}

/// The error text of a failed request, without its URL.
pub fn describe(e: reqwest::Error) -> String {
    if e.is_redirect() {
        "redirect to a host that is not allowed".into()
    } else if e.is_timeout() {
        "timed out".into()
    } else {
        e.without_url().to_string()
    }
}

fn too_large() -> String {
    "the response is too large".into()
}

/// Streams `url` into `part` (created, parent directories included) and
/// calls `progress(bytes, total)` at most every [`PROGRESS_EVERY`] and once
/// at the end. Fails on a non-2xx status, a body over `limits.cap` or
/// shorter than its Content-Length, or `limits.timeout`. On any error or a
/// cancel, `part` is removed.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    limits: Limits,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Downloaded, DownloadError> {
    let res = stream_to(client, url, part, limits, cancel, &mut progress).await;
    if res.is_err() {
        remove_part(part).await;
    }
    res
}

async fn stream_to(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    limits: Limits,
    cancel: &CancellationToken,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<Downloaded, DownloadError> {
    use DownloadError::{Cancelled, Failed};
    let send = client.get(url).timeout(limits.timeout).send();
    let mut resp = tokio::select! {
        _ = cancel.cancelled() => return Err(Cancelled),
        r = send => r.map_err(|e| Failed(describe(e)))?,
    };
    let status = resp.status();
    if !status.is_success() {
        return Err(Failed(format!("HTTP {}", status.as_u16())));
    }
    let total = resp.content_length();
    if total.is_some_and(|n| n > limits.cap) {
        return Err(Failed(too_large()));
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let io = |e: std::io::Error| Failed(format!("writing {}: {e}", part.display()));
    if let Some(dir) = part.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(io)?;
    }
    let mut file = tokio::fs::File::create(part).await.map_err(io)?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut peak_buffered = 0usize;
    let mut reported: Option<(Instant, u64)> = None;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Cancelled),
            c = resp.chunk() => c.map_err(|e| Failed(describe(e)))?,
        };
        let Some(chunk) = chunk else { break };
        bytes += chunk.len() as u64;
        peak_buffered = peak_buffered.max(chunk.len());
        if bytes > limits.cap {
            return Err(Failed(too_large()));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(io)?;
        if reported.is_none_or(|(at, _)| at.elapsed() >= PROGRESS_EVERY) {
            progress(bytes, total);
            reported = Some((Instant::now(), bytes));
        }
    }
    if total.is_some_and(|n| n != bytes) {
        return Err(Failed("the response was cut off".into()));
    }
    file.flush().await.map_err(io)?;
    file.sync_all().await.map_err(io)?;
    if reported.is_none_or(|(_, n)| n != bytes) {
        progress(bytes, total);
    }
    Ok(Downloaded {
        bytes,
        sha256: format!("{:x}", hasher.finalize()),
        etag,
        peak_buffered,
    })
}

/// Removes `part` if it exists.
pub async fn remove_part(part: &Path) {
    if let Err(e) = tokio::fs::remove_file(part).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(error = %e, path = %part.display(), "removing a partial download failed");
    }
}

/// The whole body of `resp`, refused once it exceeds `cap` bytes (announced
/// or not). For small bodies kept in memory, like a token list or a listing.
pub async fn read_capped(mut resp: reqwest::Response, cap: u64) -> Result<Bytes, String> {
    if resp.content_length().is_some_and(|n| n > cap) {
        return Err(too_large());
    }
    let mut body = BytesMut::new();
    while let Some(chunk) = resp.chunk().await.map_err(describe)? {
        if (body.len() + chunk.len()) as u64 > cap {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(urls: &Urls, url: &str) -> bool {
        urls.origins()
            .contains(&reqwest::Url::parse(url).unwrap().origin())
    }

    #[test]
    fn redirects_stay_on_https_and_the_upstream_hosts() {
        let real = Urls::default();
        assert!(allowed(&real, "https://raw.githubusercontent.com/x/y.csv"));
        assert!(allowed(
            &real,
            "https://export.sourcify.dev/v2/signatures/a.parquet"
        ));
        // No downgrade, no other port, no other host.
        assert!(!allowed(&real, "http://raw.githubusercontent.com/x/y.csv"));
        assert!(!allowed(&real, "https://raw.githubusercontent.com:8443/x"));
        assert!(!allowed(&real, "https://evil.example/x"));
        assert!(!allowed(&real, "https://tokens.uniswap.org.evil.example/"));
        // A test base keeps its own scheme and port.
        let test = Urls::with_base("http://127.0.0.1:4567");
        assert!(allowed(&test, "http://127.0.0.1:4567/moved"));
        assert!(!allowed(&test, "http://127.0.0.1:4568/moved"));
        assert!(!allowed(&test, "http://localhost:4567/moved"));
    }

    #[test]
    fn the_part_file_sits_next_to_its_target() {
        assert_eq!(
            part_path(Path::new("data/tokens/coingecko.json")),
            PathBuf::from("data/tokens/coingecko.json.part")
        );
    }

    #[test]
    fn limits() {
        assert_eq!(LIST_LIMITS.cap, 50 * 1024 * 1024);
        assert_eq!(LIST_LIMITS.timeout, Duration::from_secs(60));
        assert_eq!(SOURCIFY_LIMITS.cap, 200 * 1024 * 1024);
        assert_eq!(SOURCIFY_LIMITS.timeout, Duration::from_secs(600));
    }
}
