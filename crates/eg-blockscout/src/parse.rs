//! Blockscout `/transactions/{hash}/raw-trace` bodies: a Parity-style flat
//! list of frames (`type` call/create/suicide, `traceAddress`, hex quantities);
//! and `/tokens/{addr}/instances/{id}` bodies (an NFT's metadata).
use eg_core::source::{CallFrame, CallKind, NftAttribute, NftMetadata, SourceError};
use eg_core::types::{Address, Bytes, U256};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFrame {
    #[serde(rename = "type")]
    kind: String,
    action: RawAction,
    result: Option<RawResult>,
    error: Option<String>,
    #[serde(default)]
    subtraces: u32,
    trace_address: Vec<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAction {
    call_type: Option<String>,
    creation_method: Option<String>,
    from: Option<Address>,
    to: Option<Address>,
    gas: Option<String>,
    input: Option<Bytes>,
    init: Option<Bytes>,
    value: Option<U256>,
    // suicide frames
    address: Option<Address>,
    refund_address: Option<Address>,
    balance: Option<U256>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawResult {
    gas_used: Option<String>,
    output: Option<Bytes>,
    // create frames
    address: Option<Address>,
    code: Option<Bytes>,
}

/// Parses a raw-trace body into frames sorted by `path`. Missing `result`,
/// `gas`, `value` or `input` are tolerated; unknown call types read as `Call`.
pub fn parse_raw_trace(body: &str) -> Result<Vec<CallFrame>, SourceError> {
    let raw: Vec<RawFrame> =
        serde_json::from_str(body).map_err(|e| SourceError::Parse(format!("raw-trace: {e}")))?;
    let mut frames = raw.into_iter().map(frame).collect::<Result<Vec<_>, _>>()?;
    frames.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(frames)
}

fn frame(r: RawFrame) -> Result<CallFrame, SourceError> {
    let a = r.action;
    let gas_used = r
        .result
        .as_ref()
        .and_then(|res| res.gas_used.as_deref())
        .map(hex_u64)
        .transpose()?;
    let gas = a.gas.as_deref().map(hex_u64).transpose()?.unwrap_or(0);
    let missing = |field: &str| SourceError::Parse(format!("raw-trace: frame without {field}"));
    let (kind, from, to, value, input, output) = match r.kind.as_str() {
        "create" => {
            let kind = match a.creation_method.as_deref() {
                Some("create2") => CallKind::Create2,
                _ => CallKind::Create,
            };
            let res = r.result.as_ref();
            (
                kind,
                a.from.ok_or_else(|| missing("from"))?,
                res.and_then(|res| res.address),
                a.value,
                a.init,
                res.and_then(|res| res.code.clone()),
            )
        }
        "suicide" | "selfdestruct" => (
            CallKind::SelfDestruct,
            a.address.or(a.from).ok_or_else(|| missing("address"))?,
            a.refund_address.or(a.to),
            a.balance.or(a.value),
            None,
            None,
        ),
        _ => {
            let kind = match a.call_type.as_deref() {
                Some("staticcall") => CallKind::StaticCall,
                Some("delegatecall") => CallKind::DelegateCall,
                Some("callcode") => CallKind::CallCode,
                _ => CallKind::Call,
            };
            (
                kind,
                a.from.ok_or_else(|| missing("from"))?,
                a.to,
                a.value,
                a.input,
                r.result.and_then(|res| res.output),
            )
        }
    };
    Ok(CallFrame {
        path: r.trace_address,
        kind,
        from,
        to,
        value: value.unwrap_or_default(),
        input: input.unwrap_or_default(),
        output,
        gas,
        gas_used,
        error: r.error,
        subtraces: r.subtraces,
    })
}

#[derive(Deserialize)]
struct RawInstance {
    image_url: Option<Value>,
    metadata: Option<Value>,
}

/// Parses a token-instance body: `metadata.name`, `metadata.description`,
/// `metadata.attributes`, and `image_url` (Blockscout's copy of the image)
/// falling back to `metadata.image`. Fields of an unexpected type, and
/// attributes that are not `{trait_type?, value}` objects with a string,
/// number or boolean value, are left out; `metadata: null` gives empty
/// metadata.
pub fn parse_token_instance(body: &str) -> Result<NftMetadata, SourceError> {
    let raw: RawInstance = serde_json::from_str(body)
        .map_err(|e| SourceError::Parse(format!("token instance: {e}")))?;
    let meta = raw.metadata.unwrap_or(Value::Null);
    let text = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let attributes = meta
        .get("attributes")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(attribute).collect())
        .unwrap_or_default();
    Ok(NftMetadata {
        name: text(meta.get("name")),
        description: text(meta.get("description")),
        image: text(raw.image_url.as_ref()).or_else(|| text(meta.get("image"))),
        attributes,
    })
}

fn attribute(v: &Value) -> Option<NftAttribute> {
    let value = match v.get("value")? {
        Value::String(s) => s.clone(),
        n @ (Value::Number(_) | Value::Bool(_)) => n.to_string(),
        _ => return None,
    };
    Some(NftAttribute {
        trait_type: v
            .get("trait_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        value,
    })
}

fn hex_u64(s: &str) -> Result<u64, SourceError> {
    let digits = s.strip_prefix("0x").unwrap_or(s);
    if digits.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(digits, 16)
        .map_err(|e| SourceError::Parse(format!("raw-trace: bad quantity {s:?}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_quantities() {
        assert_eq!(hex_u64("0x36a6d").unwrap(), 0x36a6d);
        assert_eq!(hex_u64("0x0").unwrap(), 0);
        assert_eq!(hex_u64("0x").unwrap(), 0);
        assert!(matches!(hex_u64("0xzz"), Err(SourceError::Parse(_))));
    }
}
