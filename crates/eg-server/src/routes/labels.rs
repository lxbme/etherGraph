//! Address labels: lookup (imports plus the viewer's own), the viewer's
//! labels and their deletion.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use eg_core::types::LABEL_CATEGORIES;
use serde::Deserialize;

use crate::auth::extract::CurrentUser;
use crate::dto::{LabelDto, NewLabelDto};
use crate::error::{ApiError, invalid};
use crate::nodes::order_labels;
use crate::parse::parse_address;
use crate::routes::{ApiJson, ApiPath, ApiQuery};
use crate::state::AppState;

/// Longest label text, in characters.
const MAX_TEXT_CHARS: usize = 64;

#[derive(Deserialize)]
pub struct LabelsQuery {
    addr: String,
}

pub async fn list(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiQuery(q): ApiQuery<LabelsQuery>,
) -> Result<Json<Vec<LabelDto>>, ApiError> {
    let addr = parse_address(&q.addr)?;
    let mut rows = s.store.labels(&[addr], user.id).await?;
    order_labels(&mut rows);
    Ok(Json(rows.iter().map(LabelDto::from).collect()))
}

pub async fn create(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiJson(body): ApiJson<NewLabelDto>,
) -> Result<(StatusCode, Json<LabelDto>), ApiError> {
    let addr = parse_address(&body.address)?;
    if !LABEL_CATEGORIES.contains(&body.category.as_str()) {
        return Err(invalid(format!(
            "unknown category {:?}; expected one of {}",
            body.category,
            LABEL_CATEGORIES.join(", ")
        )));
    }
    let text = body.text.trim();
    let n = text.chars().count();
    if n == 0 || n > MAX_TEXT_CHARS {
        return Err(invalid(format!(
            "text must be 1 to {MAX_TEXT_CHARS} characters after trimming, got {n}"
        )));
    }
    let row = s
        .store
        .add_user_label(user.id, addr, text, &body.category)
        .await?;
    Ok((StatusCode::CREATED, Json(LabelDto::from(&row))))
}

/// Deletes one of the viewer's labels; an import or another user's label is
/// 404, like a missing one.
pub async fn delete(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiPath(id): ApiPath<i64>,
) -> Result<StatusCode, ApiError> {
    s.store.delete_user_label(user.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
