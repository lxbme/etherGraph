//! Command-line data imports. Every run is written to the audit log with
//! actor `cli` (spec §7): a successful import is committed in one
//! transaction with its `ok` row, so it never takes effect unrecorded; a
//! run that fails (nothing changed) gets a `failed` row.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::Context;
use eg_store::{AuditEntry, AuditOutcome, Store, StoreTx};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::eth_labels::{MAINNET_DATASET, XCHAIN_DATASET, parse_eth_labels};
use crate::import_labels::parse_labels;
use crate::import_tokens::{TokenFormat, parse_token_rows, token_list_version};

/// The audit actor of command-line operations.
pub const CLI_ACTOR: &str = "cli";

/// Replaces imported labels from the CSV at `path`: the `simple` dataset
/// `dataset`, or both eth-labels datasets when `dataset` is `None`. Returns
/// the summary line to print.
pub async fn import_labels(
    store: &Store,
    dataset: Option<&str>,
    path: &Path,
) -> anyhow::Result<String> {
    let target = dataset.unwrap_or(MAINNET_DATASET);
    let run = Run::new("import_labels", target, path);
    let outcome = async {
        let file = open(path)?;
        let sha256 = sha256_file(path)?;
        let mut tx = store.begin().await?;
        let (summary, counts) = match dataset {
            Some(dataset) => {
                let (rows, skipped) = parse_labels(file)?;
                let imported = tx.replace_imports(&[(dataset, &rows)]).await?[0];
                (
                    format!("imported {imported}, skipped {skipped}"),
                    json!({"imported": imported, "skipped": skipped}),
                )
            }
            None => {
                let (mainnet, xchain, skipped) = parse_eth_labels(file)?;
                let counts = tx
                    .replace_imports(&[(MAINNET_DATASET, &mainnet), (XCHAIN_DATASET, &xchain)])
                    .await?;
                let (mainnet, xchain) = (counts[0], counts[1]);
                (
                    format!("imported {mainnet} mainnet, {xchain} cross-chain, skipped {skipped}"),
                    json!({"imported": mainnet + xchain, "mainnet": mainnet,
                           "cross_chain": xchain, "skipped": skipped}),
                )
            }
        };
        let rows = counts["imported"].as_i64().unwrap_or_default();
        run.commit(tx, counts).await?;
        // Only the eth-labels import is a tracked dataset; `simple` ones are not.
        if dataset.is_none() {
            record(store, "eth_labels", None, Some(&sha256), rows).await;
        }
        Ok(summary)
    };
    run.finish(store, outcome.await).await
}

/// Replaces the token tags of `format`'s list from the file at `path`.
/// Returns the summary line to print.
pub async fn import_tokens(
    store: &Store,
    format: TokenFormat,
    path: &Path,
) -> anyhow::Result<String> {
    let run = Run::new("import_tokens", format.source(), path);
    let outcome = async {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let (rows, skipped) = parse_token_rows(format, bytes.as_slice())?;
        let mut tx = store.begin().await?;
        let imported = tx.replace_token_tags(format.source(), &rows).await?;
        run.commit(tx, json!({"imported": imported, "skipped": skipped}))
            .await?;
        // The CSV carries no list version.
        let version = match format {
            TokenFormat::EthLabels => None,
            _ => token_list_version(&bytes),
        };
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        record(
            store,
            format.local_source(),
            version.as_deref(),
            Some(&sha256),
            i64::try_from(imported)?,
        )
        .await;
        Ok(format!("imported {imported}, skipped {skipped}"))
    };
    run.finish(store, outcome.await).await
}

/// Records a finished command-line import in `local_data`. The import is
/// already committed, so a failure here is logged, not returned.
pub async fn record(
    store: &Store,
    source: &str,
    version: Option<&str>,
    sha256: Option<&str>,
    rows: i64,
) {
    if let Err(e) = store
        .local_data_succeeded(source, version, None, sha256, None, rows)
        .await
    {
        tracing::error!(error = %e, source, "recording the import status failed");
    }
}

/// The hex SHA-256 of the file at `path`.
fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let mut file = open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn open(path: &Path) -> anyhow::Result<File> {
    File::open(path).with_context(|| format!("opening {}", path.display()))
}

/// One import's audit record.
struct Run {
    action: &'static str,
    target: String,
    file: String,
}

impl Run {
    fn new(action: &'static str, target: &str, path: &Path) -> Self {
        Self {
            action,
            target: target.to_owned(),
            file: path.display().to_string(),
        }
    }

    fn entry(&self, outcome: AuditOutcome, mut after: Value) -> AuditEntry {
        if let Some(a) = after.as_object_mut() {
            a.insert("file".into(), self.file.clone().into());
        }
        AuditEntry {
            actor: CLI_ACTOR.into(),
            action: self.action.into(),
            target: Some(self.target.clone()),
            before: None,
            after: Some(after),
            outcome,
            ip: None,
            user_agent: None,
            message: None,
            signature: None,
        }
    }

    /// Appends the `ok` row with `counts` to the import's transaction and
    /// commits both.
    async fn commit(&self, mut tx: StoreTx, counts: Value) -> anyhow::Result<()> {
        tx.audit_append(&self.entry(AuditOutcome::Ok, counts))
            .await
            .context("writing the audit log")?;
        tx.commit().await?;
        Ok(())
    }

    /// Records a failed run (its transaction was rolled back) and passes
    /// the outcome on.
    async fn finish(
        &self,
        store: &Store,
        outcome: anyhow::Result<String>,
    ) -> anyhow::Result<String> {
        if let Err(e) = &outcome {
            let failed = self.entry(AuditOutcome::Failed, json!({"error": format!("{e:#}")}));
            if let Err(err) = store.audit_append(&failed).await {
                tracing::error!(error = %err, "auditing a failed import failed");
            }
        }
        outcome
    }
}
