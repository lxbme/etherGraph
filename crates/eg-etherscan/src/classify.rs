use eg_core::source::SourceError;
use serde_json::Value;

/// Classify a raw Etherscan response body; on success returns the `result` field.
pub fn classify(body: &str) -> Result<Value, SourceError> {
    let v: Value = serde_json::from_str(body).map_err(|e| SourceError::Parse(e.to_string()))?;
    let Some(obj) = v.as_object() else {
        return Err(SourceError::Parse("response is not a JSON object".into()));
    };
    let result = obj.get("result").cloned().unwrap_or(Value::Null);

    // `status` first: rate-limited proxy calls also come back in this shape.
    if let Some(status) = obj.get("status") {
        let status = status
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| status.to_string());
        return match status.as_str() {
            "1" => Ok(result),
            "0" => classify_failure(obj, result),
            other => Err(SourceError::Parse(format!("unexpected status {other:?}"))),
        };
    }
    if obj.contains_key("jsonrpc") {
        if let Some(err) = obj.get("error").filter(|e| e.is_object()) {
            return Err(SourceError::Rpc {
                code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            });
        }
        return Ok(result);
    }
    Err(SourceError::Parse(
        "response has neither status nor jsonrpc".into(),
    ))
}

fn classify_failure(
    obj: &serde_json::Map<String, Value>,
    result: Value,
) -> Result<Value, SourceError> {
    let message = obj
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result_text = match &result {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let msg = message.to_lowercase();
    let res = result_text.to_lowercase();
    let has = |hay: &str, needles: &[&str]| needles.iter().any(|n| hay.contains(n));

    if has(
        &msg,
        &["no transactions found", "no records found", "no data found"],
    ) {
        return Ok(Value::Array(vec![]));
    }
    if res.contains("daily") {
        Err(SourceError::QuotaExhausted)
    } else if has(&res, &["rate limit", "per sec"]) {
        Err(SourceError::RateLimited)
    } else if has(&res, &["invalid api key", "missing"]) {
        Err(SourceError::InvalidKey)
    } else if res.contains("result window is too large") {
        Err(SourceError::WindowTooLarge)
    } else if res.contains("timeout") {
        Err(SourceError::Timeout)
    } else {
        Err(SourceError::Upstream(format!("{message}: {result_text}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_cases() {
        let cases: Vec<(&str, Result<Value, SourceError>)> = vec![
            (
                r#"{"status":"1","message":"OK","result":[1]}"#,
                Ok(json!([1])),
            ),
            (
                r#"{"status":"0","message":"No transactions found","result":[]}"#,
                Ok(json!([])),
            ),
            (
                r#"{"status":"0","message":"NOTOK","result":"Max calls per sec rate limit reached (3/sec)"}"#,
                Err(SourceError::RateLimited),
            ),
            (
                r#"{"status":"0","message":"NOTOK","result":"Max daily rate limit reached. 100000 (100%)"}"#,
                Err(SourceError::QuotaExhausted),
            ),
            (
                r#"{"status":"0","message":"NOTOK","result":"Invalid API Key (#err2)|x"}"#,
                Err(SourceError::InvalidKey),
            ),
            (
                r#"{"status":"0","message":"NOTOK","result":"Result window is too large, PageNo x Offset size must be less than or equal to 10000"}"#,
                Err(SourceError::WindowTooLarge),
            ),
            (
                r#"{"status":"0","message":"NOTOK","result":"Query Timeout occured"}"#,
                Err(SourceError::Timeout),
            ),
            (
                r#"{"status":"0","message":"NOTOK","result":"boom"}"#,
                Err(SourceError::Upstream("NOTOK: boom".into())),
            ),
            (
                r#"{"jsonrpc":"2.0","id":1,"result":"0x10"}"#,
                Ok(json!("0x10")),
            ),
            (
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}"#,
                Err(SourceError::Rpc {
                    code: -32000,
                    message: "execution reverted".into(),
                }),
            ),
            (
                r#"{"status":"0","message":"NOTOK","jsonrpc":"2.0","result":"Max calls per sec rate limit reached (3/sec)"}"#,
                Err(SourceError::RateLimited),
            ),
            (r#"{"foo":1}"#, Err(SourceError::Parse(String::new()))),
            ("<html>", Err(SourceError::Parse(String::new()))),
        ];
        for (body, want) in cases {
            let got = classify(body);
            match (&got, &want) {
                (Err(SourceError::Parse(_)), Err(SourceError::Parse(_))) => {}
                _ => assert_eq!(got, want, "body: {body}"),
            }
        }
    }
}
