//! Writes tiny Sourcify-shaped `signatures` Parquet files for tests. Shared
//! by the importer's unit tests and the runner's integration tests (included
//! there with `#[path]`).

use std::path::Path;
use std::sync::Arc;

use parquet::basic::Compression;
use parquet::data_type::{ByteArray, ByteArrayType, Int64Type};
use parquet::file::properties::WriterProperties;
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::parser::parse_message_type;

/// Writes a Sourcify-shaped file; `with_signature: false` leaves the column out.
pub fn write_file(path: &Path, rows: &[&str], c: Compression, with_signature: bool) {
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
                .typed::<ByteArrayType>()
                .write_batch(&bogus, None, None)
                .map(|_| ()),
            1 if with_signature => col
                .typed::<ByteArrayType>()
                .write_batch(&texts, None, None)
                .map(|_| ()),
            _ => col
                .typed::<Int64Type>()
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
