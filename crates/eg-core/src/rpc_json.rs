use std::str::FromStr;

use serde_json::Value;

use crate::source::{RawLog, RawReceipt, RawTx, SourceError};
use crate::types::{Address, B256, Bytes, U256};

fn perr(field: &str, msg: impl std::fmt::Display) -> SourceError {
    SourceError::Parse(format!("{field}: {msg}"))
}

fn str_field<'a>(j: &'a Value, field: &str) -> Option<&'a str> {
    j.get(field).and_then(Value::as_str)
}

fn req_str<'a>(j: &'a Value, field: &str) -> Result<&'a str, SourceError> {
    str_field(j, field).ok_or_else(|| perr(field, "missing or not a string"))
}

fn parse_quantity(field: &str, s: &str) -> Result<U256, SourceError> {
    let h = s.strip_prefix("0x").ok_or_else(|| perr(field, "missing 0x prefix"))?;
    if h.is_empty() {
        return Err(perr(field, "empty quantity"));
    }
    U256::from_str_radix(h, 16).map_err(|e| perr(field, e))
}

fn parse_u64(field: &str, s: &str) -> Result<u64, SourceError> {
    u64::try_from(parse_quantity(field, s)?).map_err(|e| perr(field, e))
}

fn parse_addr(field: &str, s: &str) -> Result<Address, SourceError> {
    Address::from_str(s).map_err(|e| perr(field, e))
}

fn parse_b256(field: &str, s: &str) -> Result<B256, SourceError> {
    B256::from_str(s).map_err(|e| perr(field, e))
}

fn parse_bytes(field: &str, s: &str) -> Result<Bytes, SourceError> {
    Bytes::from_str(s).map_err(|e| perr(field, e))
}

/// Optional field: absent or null maps to None; present-but-malformed is an error.
fn opt_str<'a>(j: &'a Value, field: &str) -> Result<Option<&'a str>, SourceError> {
    match j.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(perr(field, "not a string")),
    }
}

pub fn parse_tx(json: &Value) -> Result<RawTx, SourceError> {
    Ok(RawTx {
        hash: parse_b256("hash", req_str(json, "hash")?)?,
        from: parse_addr("from", req_str(json, "from")?)?,
        to: opt_str(json, "to")?.map(|s| parse_addr("to", s)).transpose()?,
        value: parse_quantity("value", req_str(json, "value")?)?,
        input: parse_bytes("input", opt_str(json, "input")?.unwrap_or("0x"))?,
        block_number: opt_str(json, "blockNumber")?
            .map(|s| parse_u64("blockNumber", s))
            .transpose()?,
        json: json.clone(),
    })
}

fn parse_log(j: &Value) -> Result<RawLog, SourceError> {
    let topics = match j.get("topics") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|t| {
                t.as_str()
                    .ok_or_else(|| perr("topics", "not a string"))
                    .and_then(|s| parse_b256("topics", s))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(perr("topics", "not an array")),
    };
    Ok(RawLog {
        address: parse_addr("address", req_str(j, "address")?)?,
        topics,
        data: parse_bytes("data", opt_str(j, "data")?.unwrap_or("0x"))?,
        log_index: parse_u64("logIndex", req_str(j, "logIndex")?)?,
    })
}

pub fn parse_receipt(json: &Value) -> Result<RawReceipt, SourceError> {
    let success = parse_quantity("status", req_str(json, "status")?)? == U256::from(1u8);
    let logs = match json.get("logs") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().map(parse_log).collect::<Result<_, _>>()?,
        Some(_) => return Err(perr("logs", "not an array")),
    };
    Ok(RawReceipt {
        success,
        gas_used: parse_quantity("gasUsed", req_str(json, "gasUsed")?)?,
        effective_gas_price: opt_str(json, "effectiveGasPrice")?
            .map(|s| parse_quantity("effectiveGasPrice", s))
            .transpose()?
            .unwrap_or(U256::ZERO),
        contract_address: opt_str(json, "contractAddress")?
            .map(|s| parse_addr("contractAddress", s))
            .transpose()?,
        logs,
        json: json.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_receipt_minimal() {
        let j = serde_json::json!({
            "status": "0x1", "gasUsed": "0x5208", "effectiveGasPrice": "0x3b9aca00",
            "logs": [{
                "address": "0x0000000000000000000000000000000000000001",
                "topics": [
                    "0x0000000000000000000000000000000000000000000000000000000000000001",
                    "0x0000000000000000000000000000000000000000000000000000000000000002"
                ],
                "data": "0x", "logIndex": "0x2"
            }]
        });
        let r = parse_receipt(&j).unwrap();
        assert!(r.success);
        assert_eq!(r.logs[0].log_index, 2);
        assert_eq!(r.logs[0].topics.len(), 2);
        assert_eq!(r.gas_used, U256::from(21000u64));
        assert_eq!(r.effective_gas_price, U256::from(1_000_000_000u64));
        assert!(r.contract_address.is_none());
    }

    #[test]
    fn parse_tx_basic_and_malformed() {
        let j = serde_json::json!({
            "hash": "0x0000000000000000000000000000000000000000000000000000000000000009",
            "from": "0x0000000000000000000000000000000000000001",
            "to": null, "value": "0xde0b6b3a7640000", "input": "0x", "blockNumber": "0x10"
        });
        let t = parse_tx(&j).unwrap();
        assert!(t.to.is_none());
        assert_eq!(t.value, U256::from(10u64).pow(U256::from(18u64)));
        assert_eq!(t.block_number, Some(16));
        assert!(matches!(parse_tx(&serde_json::json!({"hash": "zz"})), Err(SourceError::Parse(_))));
    }
}
