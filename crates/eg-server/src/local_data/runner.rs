//! Updates of the local datasets, one at a time, in the background. A list:
//! download to `<path>.part`, check it parses, rename, replace the rows; a
//! failed or cancelled update leaves the tables as they were. Sourcify: only
//! the files new or changed since the last import, each fetched, imported
//! (only adding) and recorded in turn, so a cancel or a failure keeps what was
//! done. Admins see the progress on their event streams; every task ends with
//! a status row, an audit row and a [`Event::LocalDataDone`].

use std::ops::ControlFlow;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use eg_core::types::Address;
use eg_ingest::{Audience, Event, LocalDataOutcome, LocalDataPhase};
use eg_store::{AuditEntry, AuditOutcome, ImportRow, Store, StoreError, TokenTagRow};
use futures::FutureExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::download::{
    self, DownloadError, LIST_LIMITS, Limits, PROGRESS_EVERY, SOURCIFY_LIMITS, part_path,
    remove_part,
};
use super::sources::{SIGNATURES_PREFIX, SourceId, valid_signature_key};
use super::upstream::{RemoteFile, Upstream};
use crate::dto::hex_addr;
use crate::eth_labels::{MAINNET_DATASET, XCHAIN_DATASET, parse_eth_labels};
use crate::import_signatures::{BATCH_ROWS, import_batched};
use crate::import_tokens::{TokenFormat, parse_token_rows, token_list_version};
use crate::state::AppState;

/// Where downloads go when nothing else is configured: `data/` relative to
/// the working directory.
pub const DEFAULT_DATA_DIR: &str = "data";

/// The audit action of a finished task.
pub const DONE_ACTION: &str = "local_data_update_done";

/// The Sourcify files' directory under the data dir.
const SIGNATURES_DIR: &str = "signatures";

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
    signature_batch_rows: usize,
}

impl Runner {
    /// A runner downloading under `data_dir`.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            slot: Slot::default(),
            data_dir: data_dir.into(),
            list_limits: LIST_LIMITS,
            signature_batch_rows: BATCH_ROWS,
        }
    }

    /// The list sources' size cap and timeout instead of [`LIST_LIMITS`] (tests).
    pub fn with_list_limits(mut self, cap: u64, timeout: std::time::Duration) -> Self {
        self.list_limits = Limits { cap, timeout };
        self
    }

    /// Signatures inserted per batch, and so per cancel check (tests).
    pub fn with_signature_batch_rows(mut self, rows: usize) -> Self {
        self.signature_batch_rows = rows;
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
            signature_batch_rows: self.signature_batch_rows,
        };
        let slot = self.slot.clone();
        tokio::spawn(task.run(slot));
        Ok(())
    }

    /// At startup: removes the partial downloads (`*.part`) a previous
    /// process left in the download directories; returns how many.
    pub async fn remove_parts(&self) -> usize {
        let mut n = 0;
        for dir in PART_DIRS {
            n += remove_parts_in(&self.data_dir.join(dir)).await;
        }
        if n > 0 {
            tracing::info!(files = n, "removed partial local data downloads");
        }
        n
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

/// The directories under the data dir that downloads go to.
const PART_DIRS: [&str; 3] = ["eth-labels", "tokens", SIGNATURES_DIR];

/// Removes every `*.part` file directly in `dir` (none there, or no `dir`:
/// nothing); returns how many.
async fn remove_parts_in(dir: &Path) -> usize {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return 0;
    };
    let mut n = 0;
    while let Ok(Some(e)) = entries.next_entry().await {
        let path = e.path();
        if path.extension().is_some_and(|x| x == "part") && path.is_file() {
            remove_part(&path).await;
            n += 1;
        }
    }
    n
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
    signature_batch_rows: usize,
}

/// A fully imported Sourcify file, as the manifest records it (the ETag
/// verbatim, quotes kept).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct ManifestFile {
    key: String,
    etag: String,
    size: u64,
}

impl From<&RemoteFile> for ManifestFile {
    fn from(f: &RemoteFile) -> Self {
        Self {
            key: f.key.clone(),
            etag: f.etag.clone(),
            size: f.size,
        }
    }
}

/// Where a Sourcify update stands, for its progress events: files and bytes
/// of this run's files, rows read so far.
#[derive(Default)]
struct SigRun {
    files_done: u32,
    files_total: u32,
    bytes_done: u64,
    bytes_total: u64,
    rows: u64,
}

/// `<path>.etag`: the ETag of the downloaded file at `path`.
fn etag_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".etag");
    PathBuf::from(p)
}

/// Whether `path` holds `file` from an earlier download: same size, and the
/// same ETag beside it.
async fn kept(path: &Path, file: &RemoteFile) -> bool {
    let size = tokio::fs::metadata(path).await.map(|m| m.len()).ok();
    let etag = tokio::fs::read_to_string(etag_path(path)).await.ok();
    size == Some(file.size) && etag.as_deref() == Some(file.etag.as_str())
}

/// Removes `path` and its ETag, if there.
async fn forget(path: &Path) {
    for p in [path.to_owned(), etag_path(path)] {
        if let Err(e) = tokio::fs::remove_file(&p).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(error = %e, path = %p.display(), "removing a signature file failed");
        }
    }
}

impl Task {
    /// Runs the update, records how it ended and frees `slot`.
    async fn run(self, slot: Slot) {
        let result = match AssertUnwindSafe(self.update()).catch_unwind().await {
            Ok(result) => result,
            Err(_) => {
                // A panic skipped the update's own cleanup.
                self.remove_own_parts().await;
                Err(Stop::Failed("internal error".into()))
            }
        };
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

    /// Removes this source's partial downloads: a list's `.part`, or every
    /// one in the signatures directory (only one task runs at a time).
    async fn remove_own_parts(&self) {
        match list_file(self.source) {
            Some((file, _)) => remove_part(&part_path(&self.data_dir.join(file))).await,
            None => {
                remove_parts_in(&self.data_dir.join(SIGNATURES_DIR)).await;
            }
        }
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
        self.publish(phase, bytes, total_bytes, rows, None);
    }

    /// A Sourcify progress event: `run` plus the current file's `bytes`
    /// downloaded and `rows` read.
    fn sig_progress(&self, phase: LocalDataPhase, run: &SigRun, bytes: u64, rows: u64) {
        self.publish(
            phase,
            run.bytes_done + bytes,
            Some(run.bytes_total),
            run.rows + rows,
            Some((run.files_done, run.files_total)),
        );
    }

    fn publish(
        &self,
        phase: LocalDataPhase,
        bytes: u64,
        total_bytes: Option<u64>,
        rows: u64,
        files: Option<(u32, u32)>,
    ) {
        self.s.ctx.bus.publish(
            Audience::Admins,
            Event::LocalDataProgress {
                source: self.id().into(),
                phase,
                bytes,
                total_bytes,
                rows,
                files_done: files.map(|f| f.0),
                files_total: files.map(|f| f.1),
            },
        );
    }

    /// The update; returns the rows imported.
    async fn update(&self) -> Result<u64, Stop> {
        match list_file(self.source) {
            Some((file, kind)) => self.update_list(file, kind).await,
            None => self.update_signatures().await,
        }
    }

    /// Fetches and imports, file by file, the listed files whose `(key,
    /// etag)` the manifest lacks; each is added to the manifest once fully
    /// imported. Returns the signature count.
    async fn update_signatures(&self) -> Result<u64, Stop> {
        let listed = self
            .s
            .upstream
            .refresh(self.source)
            .await
            .map_err(Stop::Failed)?
            .files
            .unwrap_or_default();
        if listed.is_empty() {
            return Err(failed("the listing has no signature files"));
        }
        // The imported files still listed with the same ETag; the rest is fetched.
        let mut manifest: Vec<ManifestFile> = self
            .stored_manifest()
            .await?
            .into_iter()
            .filter(|m| listed.iter().any(|f| f.key == m.key && f.etag == m.etag))
            .collect();
        let todo: Vec<&RemoteFile> = listed
            .iter()
            .filter(|f| !manifest.iter().any(|m| m.key == f.key))
            .collect();
        let mut run = SigRun {
            files_total: todo.len() as u32,
            bytes_total: todo.iter().map(|f| f.size).sum(),
            ..SigRun::default()
        };
        let client = download::client_builder(self.s.upstream.urls())
            .build()
            .map_err(failed)?;
        let dir = self.data_dir.join(SIGNATURES_DIR);
        for (i, file) in todo.iter().enumerate() {
            if self.cancel.is_cancelled() {
                return Err(Stop::Cancelled);
            }
            let path = self.fetch_signatures(&client, &dir, file, &mut run).await?;
            self.import_signature_file(&path, &mut run).await?;
            manifest.push(ManifestFile::from(*file));
            manifest.sort_by(|a, b| a.key.cmp(&b.key));
            let rows = self.record_signatures(&manifest).await?;
            if i + 1 == todo.len() {
                return Ok(rows);
            }
            // Recording the file marked the source idle; it still runs.
            self.s
                .store
                .local_data_running(self.id(), &hex_addr(self.admin))
                .await
                .map_err(failed)?;
        }
        // Nothing new: the manifest may still have lost unlisted files.
        self.record_signatures(&manifest).await
    }

    /// The stored manifest; an unreadable one counts as empty (everything is
    /// imported again, which only adds).
    async fn stored_manifest(&self) -> Result<Vec<ManifestFile>, Stop> {
        let rows = self.s.store.local_data_all().await.map_err(failed)?;
        Ok(rows
            .into_iter()
            .find(|r| r.source == self.id())
            .and_then(|r| r.manifest)
            .and_then(|m| serde_json::from_value(m).ok())
            .unwrap_or_default())
    }

    /// Records `manifest` and the signature count as the last import.
    async fn record_signatures(&self, manifest: &[ManifestFile]) -> Result<u64, Stop> {
        let store = &self.s.store;
        let rows = eg_store::signature_count(store.pool())
            .await
            .map_err(failed)?;
        let manifest = serde_json::to_value(manifest).map_err(failed)?;
        store
            .local_data_succeeded(self.id(), None, None, None, Some(&manifest), rows)
            .await
            .map_err(failed)?;
        u64::try_from(rows).map_err(failed)
    }

    /// `file` under `dir`: kept from an earlier download when its size and
    /// ETag match, else downloaded (to `.part`, then renamed) with its ETag
    /// written beside it.
    async fn fetch_signatures(
        &self,
        client: &reqwest::Client,
        dir: &Path,
        file: &RemoteFile,
        run: &mut SigRun,
    ) -> Result<PathBuf, Stop> {
        // The listing keeps only valid keys; checked again where one becomes a path.
        let name = file
            .key
            .strip_prefix(SIGNATURES_PREFIX)
            .filter(|_| valid_signature_key(&file.key))
            .ok_or_else(|| failed("an invalid signature file key"))?;
        let path = dir.join(name);
        if kept(&path, file).await {
            run.bytes_done += file.size;
            return Ok(path);
        }
        forget(&path).await;
        let part = part_path(&path);
        let url = format!("{}/{}", self.s.upstream.urls().sourcify_files, file.key);
        let got = download::download(
            client,
            &url,
            &part,
            SOURCIFY_LIMITS,
            &self.cancel,
            |bytes, _| self.sig_progress(LocalDataPhase::Download, run, bytes, 0),
        )
        .await?;
        if let Err(e) = tokio::fs::rename(&part, &path).await {
            remove_part(&part).await;
            return Err(failed(e));
        }
        tokio::fs::write(etag_path(&path), &file.etag)
            .await
            .map_err(failed)?;
        run.bytes_done += got.bytes;
        Ok(path)
    }

    /// Imports `path` on the blocking pool, checking for a cancel after
    /// every batch. A file that fails to import is removed, so the next
    /// update fetches it again.
    async fn import_signature_file(&self, path: &Path, run: &mut SigRun) -> Result<(), Stop> {
        self.sig_progress(LocalDataPhase::Import, run, 0, 0);
        let mut reported = Instant::now();
        let at_start = &*run;
        let res = import_batched(
            self.s.store.pool(),
            &[path.to_owned()],
            self.signature_batch_rows,
            |s| {
                if reported.elapsed() >= PROGRESS_EVERY {
                    self.sig_progress(LocalDataPhase::Import, at_start, 0, s.rows_read);
                    reported = Instant::now();
                }
                if self.cancel.is_cancelled() {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            },
        )
        .await;
        let stats = match res {
            Ok(stats) => stats,
            Err(e) => {
                forget(path).await;
                return Err(Stop::Failed(format!("{e:#}")));
            }
        };
        run.rows += stats.rows_read;
        if stats.files == 0 {
            return Err(Stop::Cancelled);
        }
        run.files_done += 1;
        Ok(())
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

        // 5. The new status, and the upstream as imported, so the status
        // that follows compares against it.
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
        self.s
            .upstream
            .record(
                self.source,
                Upstream {
                    version,
                    etag,
                    size: Some(bytes),
                    ..Upstream::default()
                },
            )
            .await;
        Ok(imported)
    }
}
