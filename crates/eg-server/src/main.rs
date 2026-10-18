use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use chrono::Utc;
use clap::{Parser, Subcommand};
use eg_etherscan::{
    ClientStats, EtherscanClient, EtherscanSource, FixtureTransport, HttpTransport,
    RecordingTransport, Transport,
};
use eg_ingest::gate::{GateConfig, PriorityGate};
use eg_ingest::{Runner, default_handlers};
use eg_server::app::router;
use eg_server::background::{persist_quota, spawn_background};
use eg_server::config::{Config, SourceMode};
use eg_server::state::AppState;
use eg_store::Store;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "eg-server", about = "etherGraph backend")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the HTTP API and the job workers.
    Serve {
        #[arg(long, default_value = "config.toml")]
        config: PathBuf,
        /// Overrides `source.mode` from the config file.
        #[arg(long, value_enum)]
        source: Option<SourceMode>,
    },
    /// Replace imported label datasets from a CSV.
    ImportLabels {
        #[arg(long, default_value = "config.toml")]
        config: PathBuf,
        /// `simple` (address,text,category) or `eth-labels` (address,chainId,label,nameTag).
        #[arg(long, value_enum, default_value = "simple")]
        format: LabelFormat,
        /// Dataset name (`simple` only); its previous labels are replaced.
        #[arg(long)]
        dataset: Option<String>,
        /// The CSV file (`--csv <path>` or positional).
        #[arg(long = "csv", value_name = "PATH", conflicts_with = "csv_pos")]
        csv_flag: Option<PathBuf>,
        #[arg(value_name = "CSV")]
        csv_pos: Option<PathBuf>,
    },
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum LabelFormat {
    Simple,
    EthLabels,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    match Cli::parse().cmd {
        Cmd::Serve { config, source } => serve(&config, source).await,
        Cmd::ImportLabels {
            config,
            format,
            dataset,
            csv_flag,
            csv_pos,
        } => {
            let csv = csv_flag
                .or(csv_pos)
                .context("a CSV path is required (--csv <path>)")?;
            import_labels_cmd(&config, format, dataset.as_deref(), &csv).await
        }
    }
}

async fn import_labels_cmd(
    config: &Path,
    format: LabelFormat,
    dataset: Option<&str>,
    csv: &Path,
) -> anyhow::Result<()> {
    match (format, dataset) {
        (LabelFormat::Simple, None) => anyhow::bail!("--dataset is required with --format simple"),
        (LabelFormat::EthLabels, Some(_)) => {
            anyhow::bail!("--dataset is not allowed with --format eth-labels")
        }
        _ => {}
    }
    let cfg = Config::read(config)?;
    anyhow::ensure!(
        !cfg.server.database_url.trim().is_empty(),
        "server.database_url (or DATABASE_URL) is required"
    );
    let file = std::fs::File::open(csv).with_context(|| format!("opening {}", csv.display()))?;
    let store = Store::connect(&cfg.server.database_url)
        .await
        .context("connecting to the database")?;
    match dataset {
        Some(dataset) => {
            let (imported, skipped) =
                eg_server::import_labels::import_labels(&store, dataset, file).await?;
            println!("imported {imported}, skipped {skipped}");
        }
        None => {
            let (mainnet, xchain, skipped) =
                eg_server::eth_labels::import_eth_labels(&store, file).await?;
            println!("imported {mainnet} mainnet, {xchain} cross-chain, skipped {skipped}");
        }
    }
    Ok(())
}

async fn serve(path: &Path, source: Option<SourceMode>) -> anyhow::Result<()> {
    let mut cfg = Config::read(path)?;
    if let Some(mode) = source {
        cfg.source.mode = mode;
    }
    cfg.validate()
        .with_context(|| format!("invalid config {}", path.display()))?;

    let store = Store::connect(&cfg.server.database_url)
        .await
        .context("connecting to the database")?;
    let reset = store.reset_running().await?;
    if reset > 0 {
        tracing::info!(jobs = reset, "requeued jobs left running by a previous run");
    }

    let initial_used = store.quota_get(Utc::now().date_naive()).await?;
    let gate = PriorityGate::spawn(GateConfig {
        rate_per_sec: cfg.etherscan.rate_per_sec,
        daily_limit: cfg.etherscan.daily_limit,
        initial_used,
    });
    if initial_used < cfg.etherscan.daily_limit {
        // Jobs paused on an earlier day whose midnight reset this process missed.
        store.resume_paused().await?;
    }

    let stats = Arc::new(ClientStats::default());
    let transport: Arc<dyn Transport> = match cfg.source.mode {
        SourceMode::Etherscan => Arc::new(HttpTransport::new(&cfg.etherscan.base_url)),
        SourceMode::Fixture => Arc::new(FixtureTransport::new(&cfg.source.fixtures_dir)),
        SourceMode::Record => Arc::new(RecordingTransport::new(
            HttpTransport::new(&cfg.etherscan.base_url),
            &cfg.source.fixtures_dir,
        )),
    };
    let api_key = cfg.etherscan.api_key.clone().unwrap_or_default();
    let client = EtherscanClient::new(transport, gate.clone(), api_key, stats.clone());
    let source = Arc::new(EtherscanSource::new(client));

    let cfg = Arc::new(cfg);
    let state = AppState::new(cfg.clone(), store, source, gate, stats);
    Runner::spawn(state.ctx.clone(), cfg.sync.workers, default_handlers());
    spawn_background(&state);

    let listener = tokio::net::TcpListener::bind(cfg.server.listen)
        .await
        .with_context(|| format!("binding {}", cfg.server.listen))?;
    tracing::info!(addr = %cfg.server.listen, source = ?cfg.source.mode, "listening");
    // Open SSE streams never finish, so shut down on SIGINT/SIGTERM without
    // draining connections; persist the quota count first.
    tokio::select! {
        r = axum::serve(listener, router(state.clone())) => r?,
        r = shutdown_signal() => {
            let signal = r?;
            tracing::info!(signal, "shutting down");
            persist_quota(&state).await;
        }
    }
    Ok(())
}

/// Resolves with the signal's name on Ctrl-C (SIGINT) or, on Unix, SIGTERM.
async fn shutdown_signal() -> anyhow::Result<&'static str> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate())?;
        tokio::select! {
            r = tokio::signal::ctrl_c() => r.map(|()| "SIGINT").map_err(Into::into),
            _ = term.recv() => Ok("SIGTERM"),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok("ctrl-c")
    }
}
