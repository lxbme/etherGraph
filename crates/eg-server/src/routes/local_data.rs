//! `/api/admin/local-data`: each local dataset's last import against what
//! its upstream serves now.

use std::collections::HashMap;

use axum::Json;
use axum::extract::State;
use eg_store::LocalDataRow;

use crate::auth::extract::AdminMode;
use crate::dto::{
    LocalDataDto, LocalPartialDto, LocalSourceDto, LocalUpstreamDto, rfc3339, rfc3339_micros,
};
use crate::error::ApiError;
use crate::local_data::{SourceId, Upstream};
use crate::state::AppState;

/// `GET /api/admin/local-data`. Asks the upstreams only when the cache is
/// empty or older than 10 minutes.
pub async fn get(
    State(s): State<AppState>,
    AdminMode(_): AdminMode,
) -> Result<Json<LocalDataDto>, ApiError> {
    Ok(Json(build(&s, false).await?))
}

/// `POST /api/admin/local-data/check`: asks the upstreams now. Unsigned: it
/// changes nothing.
pub async fn check(
    State(s): State<AppState>,
    AdminMode(_): AdminMode,
) -> Result<Json<LocalDataDto>, ApiError> {
    Ok(Json(build(&s, true).await?))
}

async fn build(s: &AppState, force: bool) -> Result<LocalDataDto, ApiError> {
    let upstream = s.upstream.check(force).await;
    let rows = s.store.local_data_all().await?;
    let legacy = s.store.legacy_row_counts().await?;
    let sources: Vec<LocalSourceDto> = SourceId::ALL
        .into_iter()
        .map(|id| {
            source_dto(
                id,
                rows.iter().find(|r| r.source == id.as_str()),
                legacy.get(id.as_str()).copied().unwrap_or(0),
                upstream.get(&id),
            )
        })
        .collect();
    Ok(LocalDataDto {
        checked_at: s.upstream.checked_at().await.map(rfc3339),
        running: sources
            .iter()
            .find(|d| d.state == "running")
            .map(|d| d.source.clone()),
        sources,
        signatures_enabled: s.signatures_enabled(),
    })
}

fn source_dto(
    id: SourceId,
    row: Option<&LocalDataRow>,
    legacy: i64,
    upstream: Option<&Result<Upstream, String>>,
) -> LocalSourceDto {
    let imported = row.is_some_and(|r| r.imported_at.is_some());
    let rows = match row {
        Some(r) if imported => r.rows,
        _ => (legacy > 0).then_some(legacy),
    };
    let (up, partial) = match upstream {
        None => (unchecked(None), None),
        Some(Err(e)) => (unchecked(Some(e.clone())), None),
        Some(Ok(up)) => {
            let known = if imported { row } else { None };
            let status = if !imported && legacy == 0 {
                "not_imported"
            } else if differs(id, known, up) {
                "update"
            } else {
                "up_to_date"
            };
            (
                LocalUpstreamDto {
                    status: status.into(),
                    version: up.version.clone(),
                    files: up.files.as_ref().map(|f| f.len() as u32),
                    bytes: up.size,
                    error: None,
                },
                partial(id, known, up),
            )
        }
    };
    LocalSourceDto {
        source: id.as_str().into(),
        version: row.and_then(|r| r.version.clone()),
        imported_at: row.and_then(|r| r.imported_at).map(rfc3339_micros),
        rows,
        state: row.map_or("idle", |r| r.state.as_str()).into(),
        error: row.and_then(|r| r.error.clone()),
        error_at: row.and_then(|r| r.error_at).map(rfc3339_micros),
        upstream: up,
        partial,
    }
}

fn unchecked(error: Option<String>) -> LocalUpstreamDto {
    LocalUpstreamDto {
        status: "unchecked".into(),
        version: None,
        files: None,
        bytes: None,
        error,
    }
}

/// Whether the upstream differs from the last successful import `row` (none:
/// nothing recorded, e.g. imported by the CLI before this table existed).
fn differs(id: SourceId, row: Option<&LocalDataRow>, up: &Upstream) -> bool {
    match id {
        SourceId::EthLabels | SourceId::TokensEthLabels => {
            // No recorded ETag (a CLI import) cannot be told equal.
            match row.and_then(|r| r.etag.as_deref()) {
                Some(stored) => up.etag.as_deref() != Some(stored),
                None => true,
            }
        }
        SourceId::TokensUniswap | SourceId::TokensCoingecko => {
            row.and_then(|r| r.version.as_deref()) != up.version.as_deref()
        }
        SourceId::SignaturesSourcify => {
            let stored = manifest(row);
            let files = up.files.as_deref().unwrap_or_default();
            files.len() != stored.len() || matched(&stored, up) != files.len()
        }
    }
}

/// The `(key, etag)` pairs of a Sourcify row's manifest.
fn manifest(row: Option<&LocalDataRow>) -> HashMap<String, String> {
    row.and_then(|r| r.manifest.as_ref())
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter_map(|f| {
            Some((
                f["key"].as_str()?.to_owned(),
                f["etag"].as_str()?.to_owned(),
            ))
        })
        .collect()
}

/// How many upstream files the manifest holds with the same ETag.
fn matched(stored: &HashMap<String, String>, up: &Upstream) -> usize {
    up.files
        .iter()
        .flatten()
        .filter(|f| stored.get(&f.key) == Some(&f.etag))
        .count()
}

fn partial(id: SourceId, row: Option<&LocalDataRow>, up: &Upstream) -> Option<LocalPartialDto> {
    if id != SourceId::SignaturesSourcify {
        return None;
    }
    let total = up.files.as_ref()?.len();
    let done = matched(&manifest(row), up);
    (0 < done && done < total).then_some(LocalPartialDto {
        done: done as u32,
        total: total as u32,
    })
}
