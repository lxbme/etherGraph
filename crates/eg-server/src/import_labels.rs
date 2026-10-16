//! `import-labels`: loads a `address,text,category` CSV as one dataset.

use std::io::Read;

use eg_core::types::{Address, LABEL_CATEGORIES};
use eg_store::Store;
use serde::Deserialize;

use crate::parse::parse_address;

/// Longest label text, in characters.
const MAX_TEXT_CHARS: usize = 64;

#[derive(Deserialize)]
struct Record {
    address: String,
    text: String,
    category: String,
}

/// Replaces the dataset's labels with the CSV rows. Unknown categories become
/// `other`; rows with a bad address, empty or over-long text, or a malformed
/// record are skipped. Returns `(imported, skipped)`.
pub async fn import_labels(
    store: &Store,
    dataset: &str,
    reader: impl Read,
) -> anyhow::Result<(u64, u64)> {
    let mut csv = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(reader);
    // A wrong header is a usage error, not something to skip row by row.
    anyhow::ensure!(
        csv.headers()?.iter().eq(["address", "text", "category"]),
        "CSV header must be address,text,category"
    );
    let mut rows: Vec<(Address, String, String)> = Vec::new();
    let mut skipped = 0u64;
    for rec in csv.deserialize::<Record>() {
        let row = rec.ok().and_then(|r| {
            let addr = parse_address(&r.address).ok()?;
            let n = r.text.chars().count();
            if n == 0 || n > MAX_TEXT_CHARS {
                return None;
            }
            let category = r.category.to_ascii_lowercase();
            let category = if LABEL_CATEGORIES.contains(&category.as_str()) {
                category
            } else {
                "other".to_owned()
            };
            Some((addr, r.text, category))
        });
        match row {
            Some(r) => rows.push(r),
            None => skipped += 1,
        }
    }
    let imported = store.replace_import(dataset, &rows).await?;
    Ok((imported, skipped))
}
