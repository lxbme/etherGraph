//! `import-signatures`: loads Sourcify's `signatures` Parquet export into the
//! local signature database. Only the `signature` text is read; its hash is
//! always computed here, never taken from the file.

use std::fs::File;
use std::path::{Path, PathBuf};

use alloy_json_abi::{Event, Function};
use anyhow::Context;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::RowAccessor;
use parquet::schema::types::Type;
use sqlx::PgPool;

/// The only column read.
const COLUMN: &str = "signature";

/// Rows per insert batch, and so per `progress` call.
const BATCH_ROWS: usize = 10_000;

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

/// Imports Sourcify `signatures` Parquet files; `progress` is called after each batch (future admin UI hook).
pub async fn import_signatures(
    pool: &PgPool,
    files: &[PathBuf],
    progress: impl FnMut(&SignatureImportStats),
) -> anyhow::Result<SignatureImportStats> {
    import_batched(pool, files, BATCH_ROWS, progress).await
}

async fn import_batched(
    pool: &PgPool,
    files: &[PathBuf],
    batch_rows: usize,
    mut progress: impl FnMut(&SignatureImportStats),
) -> anyhow::Result<SignatureImportStats> {
    let mut stats = SignatureImportStats::default();
    for path in files {
        import_file(pool, path, batch_rows, &mut stats, &mut progress)
            .await
            .with_context(|| format!("importing {}", path.display()))?;
        stats.files += 1;
    }
    Ok(stats)
}

/// `name(types)` as a function or an event.
fn is_signature(text: &str) -> bool {
    Function::parse(text).is_ok() || Event::parse(text).is_ok()
}

/// Streams one file's `signature` column, row group by row group.
async fn import_file(
    pool: &PgPool,
    path: &Path,
    batch_rows: usize,
    stats: &mut SignatureImportStats,
    progress: &mut impl FnMut(&SignatureImportStats),
) -> anyhow::Result<()> {
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
    let mut texts: Vec<String> = Vec::new();
    let mut in_batch = 0usize;
    for row in reader.get_row_iter(Some(projection))? {
        in_batch += 1;
        stats.rows_read += 1;
        match row?.get_string(0) {
            Ok(t) if is_signature(t) => texts.push(t.clone()),
            _ => stats.skipped_invalid += 1,
        }
        if in_batch == batch_rows {
            flush(pool, &mut texts, &mut in_batch, stats, progress).await?;
        }
    }
    if in_batch > 0 {
        flush(pool, &mut texts, &mut in_batch, stats, progress).await?;
    }
    Ok(())
}

async fn flush(
    pool: &PgPool,
    texts: &mut Vec<String>,
    in_batch: &mut usize,
    stats: &mut SignatureImportStats,
    progress: &mut impl FnMut(&SignatureImportStats),
) -> anyhow::Result<()> {
    stats.inserted += eg_store::upsert_signatures(pool, texts).await?;
    texts.clear();
    *in_batch = 0;
    progress(stats);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{B256, keccak256};
    use parquet::basic::Compression;
    use parquet::data_type::ByteArray;
    use parquet::file::properties::WriterProperties;
    use parquet::file::writer::SerializedFileWriter;
    use parquet::schema::parser::parse_message_type;
    use std::sync::Arc;

    const ROWS: [&str; 5] = [
        "transfer(address,uint256)",
        "Transfer(address,address,uint256)",
        "execute(((address,uint256,bytes)[],bool))",
        "not a signature",
        "transfer(address,uint256)",
    ];

    /// Writes a Sourcify-shaped file; `with_signature: false` leaves the column out.
    fn write_file(path: &std::path::Path, rows: &[&str], c: Compression, with_signature: bool) {
        let sig_col = if with_signature {
            "required binary signature (UTF8);"
        } else {
            ""
        };
        let schema = parse_message_type(&format!(
            "message schema {{ required binary signature_hash_32; {sig_col} \
             required int64 created_at (TIMESTAMP(MICROS,true)); }}"
        ))
        .unwrap();
        let props = Arc::new(WriterProperties::builder().set_compression(c).build());
        let mut w = SerializedFileWriter::new(
            std::fs::File::create(path).unwrap(),
            Arc::new(schema),
            props,
        )
        .unwrap();
        let mut rg = w.next_row_group().unwrap();
        // Hashes in the file are deliberately wrong: the importer must not trust them.
        let bogus: Vec<ByteArray> = rows.iter().map(|_| vec![7u8; 32].into()).collect();
        let texts: Vec<ByteArray> = rows.iter().map(|r| ByteArray::from(r.as_bytes())).collect();
        let times = vec![1_700_000_000_000_000i64; rows.len()];
        let mut i = 0;
        while let Some(mut col) = rg.next_column().unwrap() {
            match i {
                0 => col
                    .typed::<parquet::data_type::ByteArrayType>()
                    .write_batch(&bogus, None, None)
                    .map(|_| ()),
                1 if with_signature => col
                    .typed::<parquet::data_type::ByteArrayType>()
                    .write_batch(&texts, None, None)
                    .map(|_| ()),
                _ => col
                    .typed::<parquet::data_type::Int64Type>()
                    .write_batch(&times, None, None)
                    .map(|_| ()),
            }
            .unwrap();
            col.close().unwrap();
            i += 1;
        }
        rg.close().unwrap();
        w.close().unwrap();
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
        let stats = import_signatures(&pool, &files, |_| {}).await.unwrap();
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
        import_signatures(&pool, &files, |_| {}).await.unwrap();
        let again = import_signatures(&pool, &files, |_| {}).await.unwrap();
        assert_eq!(again.inserted, 0);
        assert_eq!(again.rows_read, 9);
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn imported_signatures_resolve_by_selector_and_topic(pool: PgPool) {
        let dir = Dir::new();
        import_signatures(&pool, &two_files(&dir), |_| {})
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
        let err = import_signatures(&pool, &[bad], |_| {}).await.unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("no_signature.parquet"), "{msg}");
        assert!(msg.contains("signature"), "{msg}");
    }

    #[sqlx::test(migrations = "../eg-store/migrations")]
    async fn progress_is_called_per_batch(pool: PgPool) {
        let dir = Dir::new();
        let files = two_files(&dir);
        let mut seen = Vec::new();
        let stats = import_batched(&pool, &files, 2, |s| seen.push(*s))
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
}
