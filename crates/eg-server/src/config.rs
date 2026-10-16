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
            rate_per_sec: 2.8,
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
