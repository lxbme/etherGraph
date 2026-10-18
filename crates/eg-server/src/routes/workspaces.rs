//! Saved canvases with optimistic concurrency on `updated_at`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;

use crate::dto::{NewWorkspaceDto, UpdateWorkspaceDto, WorkspaceDto, WorkspaceMetaDto};
use crate::error::{ApiError, invalid};
use crate::parse::parse_time;
use crate::routes::{ApiJson, ApiPath};
use crate::state::AppState;

/// Longest workspace name, in characters.
const MAX_NAME_CHARS: usize = 100;

/// Trimmed name of 1 to [`MAX_NAME_CHARS`] characters.
fn valid_name(raw: &str) -> Result<&str, ApiError> {
    let name = raw.trim();
    let n = name.chars().count();
    if n == 0 || n > MAX_NAME_CHARS {
        return Err(invalid(format!(
            "name must be 1 to {MAX_NAME_CHARS} characters after trimming, got {n}"
        )));
    }
    Ok(name)
}

fn check_state(state: &serde_json::Value) -> Result<(), ApiError> {
    if state.is_object() {
        Ok(())
    } else {
        Err(invalid("state must be a JSON object"))
    }
}

/// A client state format version, when given, is at least 1.
fn check_version(v: Option<i32>) -> Result<(), ApiError> {
    match v {
        Some(n) if n < 1 => Err(invalid(format!(
            "schema_version must be at least 1, got {n}"
        ))),
        _ => Ok(()),
    }
}

pub async fn list(State(s): State<AppState>) -> Result<Json<Vec<WorkspaceMetaDto>>, ApiError> {
    let rows = s.store.list_workspaces().await?;
    Ok(Json(rows.iter().map(WorkspaceMetaDto::from).collect()))
}

pub async fn create(
    State(s): State<AppState>,
    ApiJson(body): ApiJson<NewWorkspaceDto>,
) -> Result<(StatusCode, Json<WorkspaceDto>), ApiError> {
    let name = valid_name(&body.name)?;
    check_state(&body.state)?;
    check_version(body.schema_version)?;
    let row = s
        .store
        .create_workspace(name, body.schema_version.unwrap_or(1), &body.state)
        .await?;
    Ok((StatusCode::CREATED, Json(WorkspaceDto::from(&row))))
}

pub async fn get(
    State(s): State<AppState>,
    ApiPath(id): ApiPath<i64>,
) -> Result<Json<WorkspaceDto>, ApiError> {
    Ok(Json(WorkspaceDto::from(&s.store.get_workspace(id).await?)))
}

pub async fn update(
    State(s): State<AppState>,
    ApiPath(id): ApiPath<i64>,
    ApiJson(body): ApiJson<UpdateWorkspaceDto>,
) -> Result<Json<WorkspaceDto>, ApiError> {
    let name = valid_name(&body.name)?;
    check_state(&body.state)?;
    check_version(body.schema_version)?;
    let expected = parse_time(&body.expected_updated_at, "expected_updated_at")?;
    let row = s
        .store
        .update_workspace(id, name, body.schema_version, &body.state, expected)
        .await?;
    Ok(Json(WorkspaceDto::from(&row)))
}

pub async fn delete(
    State(s): State<AppState>,
    ApiPath(id): ApiPath<i64>,
) -> Result<StatusCode, ApiError> {
    s.store.delete_workspace(id).await?;
    Ok(StatusCode::NO_CONTENT)
}
