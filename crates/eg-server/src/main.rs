use std::net::SocketAddr;
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
use eg_server::background::{
    cancel_legacy_jobs, load_user_quotas, persist_quota, resume_users_under_quota, spawn_background,
};
use eg_server::config::{Config, SourceMode};
use eg_server::import_tokens::TokenFormat;
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
    /// Replace the token tags of one list (Uniswap, CoinGecko or eth-labels).
    ImportTokens {
        #[arg(long, default_value = "config.toml")]
        config: PathBuf,
        #[arg(long, value_enum)]
        format: TokenFormat,
        /// The list file (`--file <path>` or positional).
        #[arg(long = "file", value_name = "PATH", conflicts_with = "file_pos")]
        file_flag: Option<PathBuf>,
        #[arg(value_name = "FILE")]
        file_pos: Option<PathBuf>,
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
        Cmd::ImportTokens {
            config,
            format,
            file_flag,
            file_pos,
        } => {
            let file = file_flag
                .or(file_pos)
                .context("a file path is required (--file <path>)")?;
            import_tokens_cmd(&config, format, &file).await
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
    let store = connect(config).await?;
    println!(
        "{}",
        eg_server::cli::import_labels(&store, dataset, csv).await?
    );
    Ok(())
}

async fn import_tokens_cmd(config: &Path, format: TokenFormat, path: &Path) -> anyhow::Result<()> {
    let store = connect(config).await?;
    println!(
        "{}",
        eg_server::cli::import_tokens(&store, format, path).await?
    );
    Ok(())
}

/// The database of the config at `config`, for a command-line import.
async fn connect(config: &Path) -> anyhow::Result<Store> {
    let cfg = Config::read(config)?;
    anyhow::ensure!(
        !cfg.server.database_url.trim().is_empty(),
        "server.database_url (or DATABASE_URL) is required"
    );
    Store::connect(&cfg.server.database_url)
        .await
        .context("connecting to the database")
}

async fn serve(path: &Path, source: Option<SourceMode>) -> anyhow::Result<()> {
    let mut cfg = Config::read(path)?;
    if let Some(mode) = source {
        cfg.source.mode = mode;
    }
    cfg.validate()
        .with_context(|| format!("invalid config {}", path.display()))?;

    if let Some(warning) = cfg.auth.proxy_warning() {
        tracing::warn!("{warning}");
    }

    let store = Store::connect(&cfg.server.database_url)
        .await
        .context("connecting to the database")?;
    // Labels and workspaces from before accounts existed belong to the first admin.
    match cfg.auth.admin_addresses().first() {
        Some(&admin) => {
            let (labels, workspaces) = store.adopt_orphans(admin).await?;
            if labels > 0 || workspaces > 0 {
                tracing::info!(%admin, labels, workspaces, "assigned unowned data to the first admin");
            }
        }
        None => tracing::warn!("auth.admins is empty: nobody can enter admin mode"),
    }
    match store.listed_symbol_counts().await {
        Ok((listed, with_symbol)) if listed > 0 && with_symbol == 0 => tracing::warn!(
            "the Uniswap/CoinGecko token lists carry no symbols; re-run `eg-server import-tokens` \
             for them to enable impersonation detection"
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "checking the token lists failed"),
    }
    let reset = store.reset_running().await?;
    if reset > 0 {
        tracing::info!(jobs = reset, "requeued jobs left running by a previous run");
    }

    let today = Utc::now().date_naive();
    let initial_used = store.quota_get(today).await?;
    let users = load_user_quotas(&store, &cfg, today).await?;
    let gate = PriorityGate::spawn(GateConfig {
        rate_per_sec: cfg.etherscan.rate_per_sec,
        daily_limit: cfg.etherscan.daily_limit,
        initial_used,
        default_user_limit: users.default_limit,
        user_limits: users.overrides,
        initial_user_used: users.used,
    });
    // Jobs paused on an earlier day whose midnight reset this process missed.
    if initial_used < cfg.etherscan.daily_limit {
        store.resume_paused().await?;
    }
    resume_users_under_quota(&store, &gate).await?;

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
    cancel_legacy_jobs(&state).await?;
    Runner::spawn(state.ctx.clone(), cfg.sync.workers, default_handlers());
    spawn_background(&state);

    let listener = tokio::net::TcpListener::bind(cfg.server.listen)
        .await
        .with_context(|| format!("binding {}", cfg.server.listen))?;
    tracing::info!(addr = %cfg.server.listen, source = ?cfg.source.mode, "listening");
    // Open SSE streams never finish, so shut down on SIGINT/SIGTERM without
    // draining connections; persist the quota count first.
    tokio::select! {
        // The peer address is the client IP for rate limits and audit rows.
        r = axum::serve(
            listener,
            router(state.clone()).into_make_service_with_connect_info::<SocketAddr>(),
        ) => r?,
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
