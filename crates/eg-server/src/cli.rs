//! Command-line data imports. Every run is written to the audit log with
//! actor `cli` (spec §7), whether it succeeds or fails.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use anyhow::Context;
use eg_store::{AuditEntry, AuditOutcome, Store};
use serde_json::{Value, json};

use crate::import_tokens::TokenFormat;

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
    let target = dataset.unwrap_or("eth-labels");
    let run = async {
        let file = open(path)?;
        Ok(match dataset {
            Some(dataset) => {
                let (imported, skipped) =
                    crate::import_labels::import_labels(store, dataset, file).await?;
                (
                    format!("imported {imported}, skipped {skipped}"),
                    json!({"imported": imported, "skipped": skipped}),
                )
            }
            None => {
                let (mainnet, xchain, skipped) =
                    crate::eth_labels::import_eth_labels(store, file).await?;
                (
                    format!("imported {mainnet} mainnet, {xchain} cross-chain, skipped {skipped}"),
                    json!({"imported": mainnet + xchain, "mainnet": mainnet,
                           "cross_chain": xchain, "skipped": skipped}),
                )
            }
        })
    };
    audited(store, "import_labels", target, path, run.await).await
}

/// Replaces the token tags of `format`'s list from the file at `path`.
/// Returns the summary line to print.
pub async fn import_tokens(
    store: &Store,
    format: TokenFormat,
    path: &Path,
) -> anyhow::Result<String> {
    let run = async {
        let file = BufReader::new(open(path)?);
        let (imported, skipped) = crate::import_tokens::import_tokens(store, format, file).await?;
        Ok((
            format!("imported {imported}, skipped {skipped}"),
            json!({"imported": imported, "skipped": skipped}),
        ))
    };
    audited(store, "import_tokens", format.source(), path, run.await).await
}

fn open(path: &Path) -> anyhow::Result<File> {
    File::open(path).with_context(|| format!("opening {}", path.display()))
}

/// Appends the run's audit row (`ok` with its counts, `failed` with the
/// error) and passes the outcome on. An import whose audit row cannot be
/// written fails.
async fn audited(
    store: &Store,
    action: &str,
    target: &str,
    path: &Path,
    outcome: anyhow::Result<(String, Value)>,
) -> anyhow::Result<String> {
    let file = path.display().to_string();
    let (status, after) = match &outcome {
        Ok((_, counts)) => {
            let mut after = json!({ "file": file });
            if let (Some(a), Some(c)) = (after.as_object_mut(), counts.as_object()) {
                a.extend(c.clone());
            }
            (AuditOutcome::Ok, after)
        }
        Err(e) => (
            AuditOutcome::Failed,
            json!({"file": file, "error": format!("{e:#}")}),
        ),
    };
    store
        .audit_append(&AuditEntry {
            actor: CLI_ACTOR.into(),
            action: action.into(),
            target: Some(target.into()),
            before: None,
            after: Some(after),
            outcome: status,
            ip: None,
            user_agent: None,
            message: None,
            signature: None,
        })
        .await
        .context("writing the audit log")?;
    outcome.map(|(summary, _)| summary)
}
