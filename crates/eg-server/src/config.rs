//! `config.toml` (spec §9). Every field has a default; `ETHERSCAN_API_KEY` and
//! `DATABASE_URL` override the file.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use alloy_primitives::Address;
use anyhow::{Context, bail};
use eg_ingest::config::IngestConfig;
use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub etherscan: EtherscanCfg,
    pub sync: SyncCfg,
    pub ens: EnsCfg,
    pub server: ServerCfg,
    pub source: SourceCfg,
    pub auth: AuthCfg,
}

/// `Debug` prints the API key as `***`.
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EtherscanCfg {
    pub api_key: Option<String>,
    pub base_url: String,
    pub rate_per_sec: f64,
    pub daily_limit: u32,
}

impl std::fmt::Debug for EtherscanCfg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EtherscanCfg")
            .field("api_key", &self.api_key.as_ref().map(|_| "***"))
            .field("base_url", &self.base_url)
            .field("rate_per_sec", &self.rate_per_sec)
            .field("daily_limit", &self.daily_limit)
            .finish()
    }
}

impl Default for EtherscanCfg {
    fn default() -> Self {
        Self {
            api_key: None,
            base_url: "https://api.etherscan.io/v2/api".into(),
            rate_per_sec: 2.5,
            daily_limit: 100_000,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SyncCfg {
    pub max_records_per_category: u32,
    pub stale_after_secs: u64,
    pub reorg_window_blocks: u64,
    pub workers: usize,
    pub hot_neighbor_threshold: u64,
}

impl Default for SyncCfg {
    fn default() -> Self {
        Self {
            max_records_per_category: 10_000,
            stale_after_secs: 600,
            reorg_window_blocks: 64,
            workers: 4,
            hot_neighbor_threshold: 500,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EnsCfg {
    pub universal_resolver: Address,
    pub multicall3: Address,
    pub multicall_batch_size: usize,
}

impl Default for EnsCfg {
    fn default() -> Self {
        let d = IngestConfig::default();
        Self {
            universal_resolver: d.universal_resolver,
            multicall3: d.multicall3,
            multicall_batch_size: d.multicall_batch_size,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerCfg {
    pub listen: SocketAddr,
    pub database_url: String,
    /// Built frontend served for non-API paths when the directory exists.
    pub static_dir: Option<PathBuf>,
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self {
            listen: SocketAddr::from(([127, 0, 0, 1], 8080)),
            database_url: String::new(),
            static_dir: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum SourceMode {
    /// Live Etherscan API.
    #[default]
    Etherscan,
    /// Replay recorded responses from `fixtures_dir`; no API key needed.
    Fixture,
    /// Live Etherscan API, recording every response into `fixtures_dir`.
    Record,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SourceCfg {
    pub mode: SourceMode,
    pub fixtures_dir: PathBuf,
}

impl Default for SourceCfg {
    fn default() -> Self {
        Self {
            mode: SourceMode::Etherscan,
            fixtures_dir: "fixtures".into(),
        }
    }
}

/// Wallet login, sessions and per-user limits.
#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthCfg {
    /// Scheme, host and port the browser uses (the SIWE domain/URI and the
    /// required `Origin` of state-changing requests); no trailing slash.
    /// Plain `http` only for `localhost` / `127.0.0.1`. See [`AuthCfg::origin`].
    pub public_origin: String,
    /// Admin wallet addresses. Empty is allowed (with a startup warning):
    /// nobody can enter admin mode.
    pub admins: Vec<String>,
    /// Etherscan calls per user per day until an admin changes the setting.
    pub default_daily_quota: u32,
    pub session_days: u32,
    pub admin_session_minutes: u32,
    /// Take the client IP from `X-Forwarded-For`'s right-most hop instead of
    /// the socket peer. Assumes exactly one trusted reverse proxy that appends
    /// (or overwrites) the header.
    pub trust_forwarded_for: bool,
}

impl Default for AuthCfg {
    fn default() -> Self {
        Self {
            public_origin: "http://127.0.0.1:8080".into(),
            admins: Vec::new(),
            default_daily_quota: 5000,
            session_days: 7,
            admin_session_minutes: 60,
            trust_forwarded_for: false,
        }
    }
}

/// Parses an address; mixed case must carry a valid EIP-55 checksum (a
/// mistyped character is then caught), all-lower or all-upper hex need not.
fn parse_admin(s: &str) -> anyhow::Result<Address> {
    let hex = s.strip_prefix("0x").unwrap_or(s);
    let mixed =
        hex.chars().any(|c| c.is_ascii_lowercase()) && hex.chars().any(|c| c.is_ascii_uppercase());
    if mixed {
        Address::parse_checksummed(s, None).map_err(|e| anyhow::anyhow!("{e}"))
    } else {
        s.parse::<Address>().map_err(|e| anyhow::anyhow!("{e}"))
    }
}

/// [`AuthCfg::public_origin`] parsed and normalized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicOrigin {
    /// `scheme://host[:port]`, lower case and without a default port: what a
    /// browser sends as `Origin`, and the SIWE message's URI.
    pub origin: String,
    /// `host[:port]`: the SIWE message's domain.
    pub domain: String,
    /// Cookies carry `Secure`: everywhere except plain-http local development.
    pub secure: bool,
}

/// What wallets (viem's `createSiweMessage`) accept as a message domain's host:
/// a DNS name with an alphabetic top-level label, an IPv4 address or `localhost`.
fn valid_host(host: &str) -> bool {
    if host == "localhost" || host.parse::<std::net::Ipv4Addr>().is_ok() {
        return true;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &&str| {
        !l.is_empty()
            && l.len() <= 63
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    labels.len() >= 2
        && labels.iter().all(label_ok)
        && labels
            .last()
            .is_some_and(|t| t.len() >= 2 && t.bytes().all(|b| b.is_ascii_alphabetic()))
}

fn parse_origin(raw: &str) -> Result<PublicOrigin, String> {
    let (scheme, rest) = raw
        .split_once("://")
        .ok_or("expected scheme://host[:port]")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return Err("the scheme must be http or https".into()),
    };
    if let Some(c) = rest.chars().find(|c| matches!(c, '/' | '?' | '#' | '@')) {
        return Err(format!(
            "no path, query, fragment or user info allowed (found {c:?})"
        ));
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => {
            let ok = !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
            let port = p
                .parse::<u16>()
                .ok()
                .filter(|&n| ok && n > 0)
                .ok_or_else(|| format!("invalid port {p:?}"))?;
            (h, Some(port))
        }
        None => (rest, None),
    };
    let host = host.to_ascii_lowercase();
    if !valid_host(&host) {
        return Err(format!(
            "invalid host {host:?} (a DNS name with a top-level domain, an IPv4 address or localhost)"
        ));
    }
    let local = host == "localhost" || host == "127.0.0.1";
    if scheme == "http" && !local {
        return Err("plain http is only allowed for localhost / 127.0.0.1; use https".into());
    }
    let domain = match port.filter(|&p| p != default_port) {
        Some(p) => format!("{host}:{p}"),
        None => host,
    };
    Ok(PublicOrigin {
        origin: format!("{scheme}://{domain}"),
        domain,
        secure: scheme == "https",
    })
}

impl AuthCfg {
    /// The parsed [`AuthCfg::public_origin`]: `http` or `https`, a host, an
    /// optional port, nothing else.
    pub fn origin(&self) -> anyhow::Result<PublicOrigin> {
        parse_origin(&self.public_origin).map_err(|e| {
            anyhow::anyhow!(
                "auth.public_origin must be scheme://host[:port], got {:?}: {e}",
                self.public_origin
            )
        })
    }

    /// The startup warning for an `https` origin without
    /// `trust_forwarded_for`: such a deployment normally sits behind a
    /// reverse proxy, which is then every client's IP, so all clients share
    /// one rate-limit bucket and audit rows record only the proxy.
    pub fn proxy_warning(&self) -> Option<&'static str> {
        let https = self.origin().is_ok_and(|o| o.secure);
        (https && !self.trust_forwarded_for).then_some(
            "auth.public_origin is https but auth.trust_forwarded_for is false: behind a reverse \
             proxy every client has the proxy's IP, so all clients share one login rate-limit \
             bucket (a single client can lock everyone out) and audit rows record only the \
             proxy; set trust_forwarded_for = true when exactly one trusted proxy appends \
             X-Forwarded-For",
        )
    }

    /// The configured admins; call after [`Config::validate`] (invalid
    /// entries are skipped).
    pub fn admin_addresses(&self) -> Vec<Address> {
        self.admins
            .iter()
            .filter_map(|a| parse_admin(a).ok())
            .collect()
    }

    fn validate(&self) -> anyhow::Result<()> {
        for a in &self.admins {
            parse_admin(a).with_context(|| format!("auth.admins: {a:?} is not a valid address"))?;
        }
        self.origin()?;
        if self.session_days == 0 {
            bail!("auth.session_days must be > 0");
        }
        if self.admin_session_minutes == 0 {
            bail!("auth.admin_session_minutes must be > 0");
        }
        Ok(())
    }
}

impl Config {
    /// Reads `path`, applies environment overrides and validates.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let cfg = Self::read(path)?;
        cfg.validate()
            .with_context(|| format!("invalid config {}", path.display()))?;
        Ok(cfg)
    }

    /// Like [`Config::load`] without [`Config::validate`], for callers that
    /// override fields (e.g. `--source`) before validating.
    pub fn read(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        Self::parse_unvalidated(&text, |k| std::env::var(k).ok())
            .with_context(|| format!("parsing config {}", path.display()))
    }

    /// Parses TOML, applies overrides from `env` and validates.
    pub fn parse(text: &str, env: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let cfg = Self::parse_unvalidated(text, env)?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn parse_unvalidated(text: &str, env: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let mut cfg: Config = toml::from_str(text)?;
        if let Some(key) = env("ETHERSCAN_API_KEY") {
            cfg.etherscan.api_key = Some(key);
        }
        if let Some(url) = env("DATABASE_URL") {
            cfg.server.database_url = url;
        }
        Ok(cfg)
    }

    /// Checks cross-field invariants; rerun after CLI overrides.
    pub fn validate(&self) -> anyhow::Result<()> {
        let has_key = self
            .etherscan
            .api_key
            .as_deref()
            .is_some_and(|k| !k.trim().is_empty());
        if !has_key && self.source.mode != SourceMode::Fixture {
            bail!(
                "etherscan.api_key (or ETHERSCAN_API_KEY) is required unless source.mode = \"fixture\""
            );
        }
        if self.server.database_url.trim().is_empty() {
            bail!("server.database_url (or DATABASE_URL) is required");
        }
        let rate = self.etherscan.rate_per_sec;
        if !(rate.is_finite() && rate > 0.0) {
            bail!("etherscan.rate_per_sec must be > 0, got {rate}");
        }
        if self.sync.workers == 0 {
            bail!("sync.workers must be > 0");
        }
        self.auth.validate()?;
        Ok(())
    }

    pub fn ingest(&self) -> IngestConfig {
        IngestConfig {
            max_records_per_category: self.sync.max_records_per_category,
            reorg_window_blocks: self.sync.reorg_window_blocks,
            stale_after: Duration::from_secs(self.sync.stale_after_secs),
            multicall_batch_size: self.ens.multicall_batch_size,
            multicall3: self.ens.multicall3,
            universal_resolver: self.ens.universal_resolver,
            rate_per_sec: self.etherscan.rate_per_sec,
            hot_neighbor_threshold: self.sync.hot_neighbor_threshold,
            ..IngestConfig::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_without_trusted_forwarding_warns_about_one_shared_bucket() {
        let auth = |origin: &str, trust| AuthCfg {
            public_origin: origin.into(),
            trust_forwarded_for: trust,
            ..AuthCfg::default()
        };
        let warning = auth("https://graph.example.org", false).proxy_warning();
        assert!(
            warning.is_some_and(|w| w.contains("trust_forwarded_for")),
            "{warning:?}"
        );
        assert_eq!(
            auth("https://graph.example.org", true).proxy_warning(),
            None
        );
        // Plain-http local development has no proxy in front.
        assert_eq!(auth("http://127.0.0.1:8080", false).proxy_warning(), None);
        assert_eq!(auth("http://localhost:5173", true).proxy_warning(), None);
    }
}
