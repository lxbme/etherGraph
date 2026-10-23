//! Updates of the local datasets, one at a time, in the background: download
//! to `<path>.part`, check it parses, rename, replace the rows. A failed or
//! cancelled update leaves the tables as they were. Admins see the progress
//! on their event streams; every task ends with a status row, an audit row
//! and a [`Event::LocalDataDone`].

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use eg_core::types::Address;
use eg_ingest::{Audience, Event, LocalDataOutcome, LocalDataPhase};
use eg_store::{AuditEntry, AuditOutcome, ImportRow, Store, StoreError, TokenTagRow};
use futures::FutureExt;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::download::{self, DownloadError, LIST_LIMITS, Limits, part_path, remove_part};
use super::sources::SourceId;
use crate::dto::hex_addr;
use crate::eth_labels::{MAINNET_DATASET, XCHAIN_DATASET, parse_eth_labels};
use crate::import_tokens::{TokenFormat, parse_token_rows, token_list_version};
use crate::state::AppState;

/// Where downloads go when nothing else is configured: `data/` relative to
/// the working directory.
pub const DEFAULT_DATA_DIR: &str = "data";

/// The audit action of a finished task.
pub const DONE_ACTION: &str = "local_data_update_done";

#[derive(Debug)]
pub enum StartError {
    /// Another task is running.
    Busy,
    /// Marking the source running failed; nothing was started.
    Store(StoreError),
}

struct RunningTask {
    source: SourceId,
    cancel: CancellationToken,
}

type Slot = Arc<Mutex<Option<RunningTask>>>;

fn lock(slot: &Slot) -> MutexGuard<'_, Option<RunningTask>> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// The single task slot.
pub struct Runner {
    slot: Slot,
    data_dir: PathBuf,
    list_limits: Limits,
}

impl Runner {
    /// A runner downloading under `data_dir`.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            slot: Slot::default(),
            data_dir: data_dir.into(),
            list_limits: LIST_LIMITS,
        }
    }

    /// The list sources' size cap and timeout instead of [`LIST_LIMITS`] (tests).
    pub fn with_list_limits(mut self, cap: u64, timeout: std::time::Duration) -> Self {
        self.list_limits = Limits { cap, timeout };
        self
    }

    /// The source being updated, if any.
    pub fn running(&self) -> Option<SourceId> {
        lock(&self.slot).as_ref().map(|t| t.source)
    }

    /// Marks `source` running for `admin` and starts its update in the
    /// background. [`StartError::Busy`] while another task runs.
    pub async fn start(
        &self,
        s: &AppState,
        source: SourceId,
        admin: Address,
    ) -> Result<(), StartError> {
        let cancel = CancellationToken::new();
        {
            let mut slot = lock(&self.slot);
            if slot.is_some() {
                return Err(StartError::Busy);
            }
            *slot = Some(RunningTask {
                source,
                cancel: cancel.clone(),
            });
        }
        if let Err(e) = s
            .store
            .local_data_running(source.as_str(), &hex_addr(admin))
            .await
        {
            *lock(&self.slot) = None;
            return Err(StartError::Store(e));
        }
        let task = Task {
            s: s.clone(),
            source,
            admin,
            cancel,
            data_dir: self.data_dir.clone(),
            list_limits: self.list_limits,
        };
        let slot = self.slot.clone();
        tokio::spawn(task.run(slot));
        Ok(())
    }

    /// Asks the running update of `source` to stop at its next check; false
    /// when `source` is not running.
    pub fn cancel(&self, source: SourceId) -> bool {
        match lock(&self.slot).as_ref() {
            Some(t) if t.source == source => {
                t.cancel.cancel();
                true
            }
            _ => false,
        }
    }
}

/// At startup: a source left `running` lost its task with the previous
/// process; it becomes `failed` / `interrupted` (not resumed).
pub async fn interrupt_running(store: &Store) -> eg_store::Result<Vec<String>> {
    let hit = store.local_data_interrupt_running().await?;
    for source in &hit {
        tracing::warn!(source, "a local data update was interrupted by a restart");
    }
    Ok(hit)
}

/// A list source's file under the data dir and its parser.
fn list_file(id: SourceId) -> Option<(&'static str, ListKind)> {
    Some(match id {
        SourceId::EthLabels => ("eth-labels/accounts.csv", ListKind::EthLabels),
        SourceId::TokensUniswap => (
            "tokens/uniswap-default.json",
            ListKind::Tokens(TokenFormat::Uniswap),
        ),
        SourceId::TokensCoingecko => (
            "tokens/coingecko.json",
            ListKind::Tokens(TokenFormat::Coingecko),
        ),
        SourceId::TokensEthLabels => (
            "tokens/eth-labels-tokens.csv",
            ListKind::Tokens(TokenFormat::EthLabels),
        ),
        SourceId::SignaturesSourcify => return None,
    })
}

#[derive(Clone, Copy)]
enum ListKind {
    EthLabels,
    Tokens(TokenFormat),
}

/// A list file's rows, ready to replace the old ones.
enum Parsed {
    Labels {
        mainnet: Vec<ImportRow>,
        xchain: Vec<ImportRow>,
    },
    Tokens(TokenFormat, Vec<TokenTagRow>),
}

impl Parsed {
    fn rows(&self) -> u64 {
        match self {
            Parsed::Labels { mainnet, xchain } => (mainnet.len() + xchain.len()) as u64,
            Parsed::Tokens(_, rows) => rows.len() as u64,
        }
    }
}

/// Parses the file with the existing importers' parsers; no rows is an error
/// (a wrong file must not empty the dataset). Returns the rows and, for a
/// token-list JSON, its version.
fn parse(kind: ListKind, path: &Path) -> anyhow::Result<(Parsed, Option<String>)> {
    let body = std::fs::read(path)?;
    match kind {
        ListKind::EthLabels => {
            let (mainnet, xchain, skipped) = parse_eth_labels(body.as_slice())?;
            anyhow::ensure!(
                !mainnet.is_empty() || !xchain.is_empty(),
                "no label rows parsed ({skipped} skipped); refusing to replace eth-labels"
            );
            Ok((Parsed::Labels { mainnet, xchain }, None))
        }
        ListKind::Tokens(format) => {
            let (rows, _) = parse_token_rows(format, body.as_slice())?;
            let version = match format {
                TokenFormat::EthLabels => None,
                _ => token_list_version(&body),
            };
            Ok((Parsed::Tokens(format, rows), version))
        }
    }
}

/// Why a task stopped early.
enum Stop {
    Cancelled,
    Failed(String),
}

impl From<DownloadError> for Stop {
    fn from(e: DownloadError) -> Self {
        match e {
            DownloadError::Cancelled => Stop::Cancelled,
            DownloadError::Failed(m) => Stop::Failed(m),
        }
    }
}

fn failed(e: impl std::fmt::Display) -> Stop {
    Stop::Failed(e.to_string())
}

struct Task {
    s: AppState,
    source: SourceId,
    admin: Address,
    cancel: CancellationToken,
    data_dir: PathBuf,
    list_limits: Limits,
}

impl Task {
    /// Runs the update, records how it ended and frees `slot`.
    async fn run(self, slot: Slot) {
        let result = AssertUnwindSafe(self.update())
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(Stop::Failed("internal error".into())));
        let (outcome, rows, error) = match result {
            Ok(rows) => (LocalDataOutcome::Succeeded, Some(rows), None),
            Err(Stop::Cancelled) => {
                if let Err(e) = self.s.store.local_data_idle(self.id()).await {
                    tracing::error!(error = %e, source = self.id(), "recording a cancel failed");
                }
                (LocalDataOutcome::Cancelled, None, None)
            }
            Err(Stop::Failed(msg)) => {
                if let Err(e) = self.s.store.local_data_failed(self.id(), &msg).await {
                    tracing::error!(error = %e, source = self.id(), "recording a failure failed");
                }
                (LocalDataOutcome::Failed, None, Some(msg))
            }
        };
        self.audit(outcome, rows, error.as_deref()).await;
        *lock(&slot) = None;
        self.s.ctx.bus.publish(
            Audience::Admins,
            Event::LocalDataDone {
                source: self.id().into(),
                outcome,
                error,
            },
        );
    }

    fn id(&self) -> &'static str {
        self.source.as_str()
    }

    async fn audit(&self, outcome: LocalDataOutcome, rows: Option<u64>, error: Option<&str>) {
        let entry = AuditEntry {
            actor: hex_addr(self.admin),
            action: DONE_ACTION.into(),
            target: Some(self.id().into()),
            before: None,
            after: Some(serde_json::json!({
                "outcome": outcome,
                "rows": rows,
                "error": error,
            })),
            outcome: match outcome {
                LocalDataOutcome::Failed => AuditOutcome::Failed,
                LocalDataOutcome::Succeeded | LocalDataOutcome::Cancelled => AuditOutcome::Ok,
            },
            ip: None,
            user_agent: None,
            message: None,
            signature: None,
        };
        if let Err(e) = self.s.store.audit_append(&entry).await {
            tracing::error!(error = %e, source = self.id(), "auditing a finished update failed");
        }
    }

    fn progress(&self, phase: LocalDataPhase, bytes: u64, total_bytes: Option<u64>, rows: u64) {
        self.s.ctx.bus.publish(
            Audience::Admins,
            Event::LocalDataProgress {
                source: self.id().into(),
                phase,
                bytes,
                total_bytes,
                rows,
                files_done: None,
                files_total: None,
            },
        );
    }

    /// The update; returns the rows imported.
    async fn update(&self) -> Result<u64, Stop> {
        match list_file(self.source) {
            Some((file, kind)) => self.update_list(file, kind).await,
            // Task 4: the incremental Sourcify download and import.
            None => Err(Stop::Failed(
                "updating the signatures is not supported yet".into(),
            )),
        }
    }

    async fn update_list(&self, file: &str, kind: ListKind) -> Result<u64, Stop> {
        let path = self.data_dir.join(file);
        let part = part_path(&path);
        let res = self.fetch_and_import(kind, &path, &part).await;
        if res.is_err() {
            remove_part(&part).await;
        }
        res
    }

    async fn fetch_and_import(
        &self,
        kind: ListKind,
        path: &Path,
        part: &Path,
    ) -> Result<u64, Stop> {
        // 1. The body: a list a fresh check already fetched, or a download.
        let cached = self
            .s
            .upstream
            .cached(self.source)
            .await
            .and_then(|u| u.body);
        let (bytes, sha256, etag) = match cached {
            Some(body) => {
                if let Some(dir) = part.parent() {
                    tokio::fs::create_dir_all(dir).await.map_err(failed)?;
                }
                tokio::fs::write(part, &body).await.map_err(failed)?;
                let n = body.len() as u64;
                self.progress(LocalDataPhase::Download, n, Some(n), 0);
                (n, format!("{:x}", Sha256::digest(&body)), None)
            }
            None => {
                let client = download::client_builder(self.s.upstream.urls())
                    .build()
                    .map_err(failed)?;
                let url = self.s.upstream.urls().of(self.source);
                let got = download::download(
                    &client,
                    url,
                    part,
                    self.list_limits,
                    &self.cancel,
                    |bytes, total| self.progress(LocalDataPhase::Download, bytes, total, 0),
                )
                .await?;
                (got.bytes, got.sha256, got.etag)
            }
        };

        // 2. It must parse, with rows.
        let owned = part.to_owned();
        let (parsed, version) = tokio::task::spawn_blocking(move || parse(kind, &owned))
            .await
            .map_err(failed)?
            .map_err(|e| Stop::Failed(format!("{e:#}")))?;

        // 3. Last chance to cancel: from here on the import runs to its end.
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        tokio::fs::rename(part, path).await.map_err(failed)?;

        // 4. Replace the rows, in one transaction.
        let rows = parsed.rows();
        self.progress(LocalDataPhase::Import, bytes, Some(bytes), rows);
        let store = &self.s.store;
        let imported = match &parsed {
            Parsed::Labels { mainnet, xchain } => store
                .replace_imports(&[(MAINNET_DATASET, mainnet), (XCHAIN_DATASET, xchain)])
                .await
                .map_err(failed)?
                .iter()
                .sum(),
            Parsed::Tokens(format, rows) => store
                .replace_token_tags(format.source(), rows)
                .await
                .map_err(failed)?,
        };

        // 5. The new status.
        store
            .local_data_succeeded(
                self.id(),
                version.as_deref(),
                etag.as_deref(),
                Some(&sha256),
                None,
                i64::try_from(imported).map_err(failed)?,
            )
            .await
            .map_err(failed)?;
        Ok(imported)
    }
}
