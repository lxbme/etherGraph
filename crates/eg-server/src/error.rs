//! API error type and its mapping from store / source errors.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use eg_core::source::SourceError;
use eg_store::StoreError;

use crate::dto::{ErrorBody, ErrorDetail};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", msg)
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    }
}

/// 400 `invalid_input`.
pub fn invalid(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_input", msg)
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error: ErrorDetail {
                code: self.code.to_owned(),
                message: self.message,
            },
        };
        (self.status, Json(body)).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => ApiError::not_found("not found"),
            StoreError::Conflict => ApiError::new(StatusCode::CONFLICT, "conflict", "conflict"),
            // Database and corrupt-data details stay in the log, not the response.
            StoreError::Db(_) | StoreError::Invalid(_) => {
                tracing::error!(error = %e, "store error");
                ApiError::internal()
            }
        }
    }
}

impl From<SourceError> for ApiError {
    fn from(e: SourceError) -> Self {
        match e {
            SourceError::QuotaExhausted => ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "quota_exhausted",
                "daily Etherscan quota exhausted",
            ),
            // Source errors never carry the API key (transports strip URLs).
            other => ApiError::new(StatusCode::BAD_GATEWAY, "upstream_error", other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn render(e: ApiError) -> (StatusCode, serde_json::Value) {
        let resp = e.into_response();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn body_shape() {
        let (status, v) = render(invalid("bad address")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            v,
            serde_json::json!({"error": {"code": "invalid_input", "message": "bad address"}})
        );
    }

    #[test]
    fn store_mapping() {
        let m = |e: StoreError| {
            let a = ApiError::from(e);
            (a.status, a.code)
        };
        assert_eq!(
            m(StoreError::NotFound),
            (StatusCode::NOT_FOUND, "not_found")
        );
        assert_eq!(m(StoreError::Conflict), (StatusCode::CONFLICT, "conflict"));
        assert_eq!(
            m(StoreError::Invalid("bad row".into())),
            (StatusCode::INTERNAL_SERVER_ERROR, "internal")
        );
        let db = ApiError::from(StoreError::Db(sqlx::Error::Configuration(
            "password=secret".into(),
        )));
        assert_eq!(
            (db.status, db.code),
            (StatusCode::INTERNAL_SERVER_ERROR, "internal")
        );
        assert!(!db.message.contains("secret"));
    }

    #[test]
    fn source_mapping() {
        let m = |e: SourceError| {
            let a = ApiError::from(e);
            (a.status, a.code)
        };
        assert_eq!(
            m(SourceError::QuotaExhausted),
            (StatusCode::TOO_MANY_REQUESTS, "quota_exhausted")
        );
        for e in [
            SourceError::RateLimited,
            SourceError::InvalidKey,
            SourceError::Timeout,
            SourceError::Network("x".into()),
            SourceError::Upstream("x".into()),
            SourceError::Parse("x".into()),
        ] {
            assert_eq!(m(e), (StatusCode::BAD_GATEWAY, "upstream_error"));
        }
    }
}
