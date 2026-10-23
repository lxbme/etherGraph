//! `import-signatures`: loads Sourcify's `signatures` Parquet export into the
//! local signature database. Only the `signature` text is read; its hash is
//! always computed here, never taken from the file.
//!
//! The Parquet read is synchronous, so it runs on the blocking pool and hands
//! batches over a channel to the async side, which inserts them: the async
//! task never blocks a runtime worker.

use std::fs::File;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use alloy_json_abi::{Event, Function};
use anyhow::Context;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::RowAccessor;
use parquet::schema::types::Type;
use sqlx::PgPool;
use tokio::sync::mpsc;

/// The only column read.
const COLUMN: &str = "signature";

/// Rows per insert batch, and so per `progress` call.
pub(crate) const BATCH_ROWS: usize = 10_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SignatureImportStats {
    /// Files fully imported.
    pub files: usize,
    pub rows_read: u64,
    /// Signatures that were new to the database.
    pub inserted: u64,
    /// Rows whose `signature` is null or not `name(types)`.
    pub skipped_invalid: u64,
}

/// Imports Sourcify `signatures` Parquet files; `progress` is called after
/// each inserted batch. When it returns `Break` the import stops there and
/// returns the stats so far: the inserted batches stay, and the file being
/// read is not counted in `files`.
pub async fn import_signatures(
    pool: &PgPool,
    files: &[PathBuf],
    progress: impl FnMut(&SignatureImportStats) -> ControlFlow<()> + Send,
) -> anyhow::Result<SignatureImportStats> {
    import_batched(pool, files, BATCH_ROWS, progress).await
}

/// [`import_signatures`] with `batch_rows` rows per batch.
pub(crate) async fn import_batched(
    pool: &PgPool,
    files: &[PathBuf],
    batch_rows: usize,
    mut progress: impl FnMut(&SignatureImportStats) -> ControlFlow<()> + Send,
) -> anyhow::Result<SignatureImportStats> {
    let mut stats = SignatureImportStats::default();
    for path in files {
        let flow = import_file(pool, path, batch_rows, &mut stats, &mut progress)
            .await
            .with_context(|| format!("importing {}", path.display()))?;
        if flow.is_break() {
            return Ok(stats);
        }
        stats.files += 1;
    }
    Ok(stats)
}

/// `name(types)` as a function or an event.
fn is_signature(text: &str) -> bool {
    Function::parse(text).is_ok() || Event::parse(text).is_ok()
}

/// One batch read from a file.
struct Batch {
    /// The valid signatures.
    texts: Vec<String>,
    rows: u64,
    invalid: u64,
}

/// Threads that ran a Parquet read (tests check it is never the async one).
#[cfg(test)]
static READER_THREADS: std::sync::Mutex<Vec<std::thread::ThreadId>> =
    std::sync::Mutex::new(Vec::new());

/// Reads one file on the blocking pool and inserts its batches as they come.
async fn import_file(
    pool: &PgPool,
    path: &Path,
    batch_rows: usize,
    stats: &mut SignatureImportStats,
    progress: &mut (impl FnMut(&SignatureImportStats) -> ControlFlow<()> + Send),
) -> anyhow::Result<ControlFlow<()>> {
    // One batch in flight while the previous one is inserted.
    let (tx, mut rx) = mpsc::channel(1);
    let owned = path.to_owned();
    let reader = tokio::task::spawn_blocking(move || read_file(&owned, batch_rows, &tx));
    let inserted = async {
        while let Some(batch) = rx.recv().await {
            let Batch {
                texts,
                rows,
                invalid,
            } = batch;
            stats.inserted += eg_store::upsert_signatures(pool, &texts).await?;
            stats.rows_read += rows;
            stats.skipped_invalid += invalid;
            if progress(stats).is_break() {
                return Ok(ControlFlow::Break(()));
            }
        }
        anyhow::Ok(ControlFlow::Continue(()))
    }
    .await;
    // Closing the channel stops a reader still running (a break or an error).
    drop(rx);
    let read = reader.await.context("the Parquet reader failed")?;
    let flow = inserted?;
    if flow.is_continue() {
        read?;
    }
    Ok(flow)
}

/// Streams `path`'s `signature` column, row group by row group, to `tx` in
/// batches of `batch_rows` rows. Blocking; stops early once `tx` is closed.
fn read_file(path: &Path, batch_rows: usize, tx: &mpsc::Sender<Batch>) -> anyhow::Result<()> {
    #[cfg(test)]
    READER_THREADS
        .lock()
        .unwrap()
        .push(std::thread::current().id());
    let reader = SerializedFileReader::new(File::open(path).context("cannot open the file")?)
        .context("not a readable Parquet file")?;
    let field = reader
        .metadata()
        .file_metadata()
        .schema()
        .get_fields()
        .iter()
        .find(|f| f.name() == COLUMN && f.is_primitive())
        .cloned()
        .with_context(|| format!("no `{COLUMN}` column"))?;
    let projection = Type::group_type_builder("schema")
        .with_fields(vec![field])
        .build()?;
    let empty = || Batch {
        texts: Vec::new(),
        rows: 0,
        invalid: 0,
    };
    let mut batch = empty();
    for row in reader.get_row_iter(Some(projection))? {
        batch.rows += 1;
        match row?.get_string(0) {
            Ok(t) if is_signature(t) => batch.texts.push(t.clone()),
            _ => batch.invalid += 1,
        }
        if batch.rows as usize == batch_rows
            && tx
                .blocking_send(std::mem::replace(&mut batch, empty()))
                .is_err()
        {
            return Ok(());
        }
    }
    if batch.rows > 0 {
        // A closed channel here means the import already stopped.
        let _ = tx.blocking_send(batch);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod parquet_fixture;

#[cfg(test)]
mod tests {
    use super::parquet_fixture::write_file;
    use super::*;
    use alloy_primitives::{B256, keccak256};
    use parquet::basic::Compression;

    const ROWS: [&str; 5] = [
        "transfer(address,uint256)",
        "Transfer(address,address,uint256)",
        "execute(((address,uint256,bytes)[],bool))",
        "not a signature",
        "transfer(address,uint256)",
    ];

    fn go(_: &SignatureImportStats) -> ControlFlow<()> {
        ControlFlow::Continue(())
    }

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!("eg-sig-{:016x}", rand::random::<u64>()));
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn two_files(dir: &Dir) -> Vec<PathBuf> {
        let (a, b) = (dir.file("a.parquet"), dir.file("b.parquet"));
        write_file(&a, &ROWS, Compression::SNAPPY, true);
        let valid: Vec<&str> = ROWS
            .iter()
            .copied()
            .filter(|r| *r != "not a signature")
            .collect();
        write_file(&b, &valid, Compression::ZSTD(Default::default()), true);
        vec![a, b]
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn import_reads_both_files_skips_invalid_and_dedups(pool: PgPool) {
        let dir = Dir::new();
        let files = two_files(&dir);
        let stats = import_signatures(&pool, &files, go).await.unwrap();
        assert_eq!(
            stats,
            SignatureImportStats {
                files: 2,
                rows_read: 9,
                inserted: 3,
                skipped_invalid: 1,
            }
        );
        assert_eq!(eg_store::signature_count(&pool).await.unwrap(), 3);
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn reimport_inserts_nothing(pool: PgPool) {
        let dir = Dir::new();
        let files = two_files(&dir);
        import_signatures(&pool, &files, go).await.unwrap();
        let again = import_signatures(&pool, &files, go).await.unwrap();
        assert_eq!(again.inserted, 0);
        assert_eq!(again.rows_read, 9);
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn imported_signatures_resolve_by_selector_and_topic(pool: PgPool) {
        let dir = Dir::new();
        import_signatures(&pool, &two_files(&dir), go)
            .await
            .unwrap();
        let by_sel = eg_store::signatures_by_selector(&pool, &[[0xa9, 0x05, 0x9c, 0xbb]])
            .await
            .unwrap();
        assert_eq!(
            by_sel[&[0xa9, 0x05, 0x9c, 0xbb]],
            vec!["transfer(address,uint256)".to_owned()]
        );
        let topic: B256 = keccak256("Transfer(address,address,uint256)");
        let by_hash = eg_store::signatures_by_hash(&pool, &[topic]).await.unwrap();
        assert_eq!(by_hash[&topic], "Transfer(address,address,uint256)");
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn a_file_without_a_signature_column_is_an_error_naming_it(pool: PgPool) {
        let dir = Dir::new();
        let bad = dir.file("no_signature.parquet");
        write_file(&bad, &ROWS, Compression::SNAPPY, false);
        let err = import_signatures(&pool, &[bad], go).await.unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("no_signature.parquet"), "{msg}");
        assert!(msg.contains("signature"), "{msg}");
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn progress_is_called_per_batch(pool: PgPool) {
        let dir = Dir::new();
        let files = two_files(&dir);
        let mut seen = Vec::new();
        let stats = import_batched(&pool, &files, 2, |s| {
            seen.push(*s);
            ControlFlow::Continue(())
        })
        .await
        .unwrap();
        // Files of 5 and 4 rows in batches of 2: 3 + 2 batches.
        assert_eq!(
            seen.iter().map(|s| s.rows_read).collect::<Vec<_>>(),
            [2, 4, 5, 7, 9]
        );
        // `files` counts finished files, so it trails the last batch's call.
        assert_eq!(
            seen.last(),
            Some(&SignatureImportStats { files: 1, ..stats })
        );
        assert_eq!(stats.files, 2);
        assert_eq!(stats.inserted, 3);
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn a_break_stops_after_the_current_batch_keeping_it(pool: PgPool) {
        let dir = Dir::new();
        let files = two_files(&dir);
        let mut calls = 0;
        let stats = import_batched(&pool, &files, 2, |_| {
            calls += 1;
            ControlFlow::Break(())
        })
        .await
        .unwrap();
        assert_eq!(calls, 1);
        // The first batch (two distinct signatures) is in; the file is not done.
        assert_eq!(
            stats,
            SignatureImportStats {
                files: 0,
                rows_read: 2,
                inserted: 2,
                skipped_invalid: 0,
            }
        );
        assert_eq!(eg_store::signature_count(&pool).await.unwrap(), 2);
    }

    /// The Parquet read runs on the blocking pool, never on the async
    /// (here current-thread) runtime's thread.
    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn the_parquet_read_runs_off_the_async_thread(pool: PgPool) {
        let dir = Dir::new();
        let files = two_files(&dir);
        let async_thread = std::thread::current().id();
        let stats = import_signatures(&pool, &files, go).await.unwrap();
        assert_eq!(stats.files, 2);
        // Other tests read concurrently; none of them reads on this thread either.
        let readers = READER_THREADS.lock().unwrap().clone();
        assert!(!readers.is_empty());
        assert!(
            !readers.contains(&async_thread),
            "a read ran on the async thread"
        );
    }
}
