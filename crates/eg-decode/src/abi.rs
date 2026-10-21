use alloy_dyn_abi::{DynSolValue, EventExt, JsonAbiExt};
use alloy_json_abi::{Event, JsonAbi};
use alloy_primitives::{Address, B256, Bytes};
use alloy_sol_types::{Panic, Revert, SolError, SolEvent};
use eg_core::source::RawLog;

use crate::transfers::{Approval, TransferEv, topic_address};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedArg {
    pub name: String,
    pub ty: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedCall {
    pub signature: String,
    pub name: String,
    pub args: Vec<DecodedArg>,
}

/// A decoded revert: `Error(string)`, `Panic(uint256)` or a custom error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedError {
    pub name: String,
    pub args: Vec<DecodedArg>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedEvent {
    pub address: Address,
    pub log_index: u64,
    pub name: Option<String>,
    pub args: Vec<DecodedArg>,
    pub topics: Vec<B256>,
    pub data: Bytes,
    /// The text signature `name` was guessed from (see
    /// [`crate::guess::guess_event`]); `None` when an ABI or a built-in event
    /// decoded the log, or nothing did.
    pub signature: Option<String>,
    /// `name` was guessed from the signature database, not decoded.
    pub guessed: bool,
}

/// Stable textual form: lowercase hex addresses, decimal integers, 0x-hex bytes,
/// `[a, b]` arrays, `(a, b)` tuples.
pub(crate) fn fmt_value(v: &DynSolValue) -> String {
    match v {
        DynSolValue::Bool(b) => b.to_string(),
        DynSolValue::Int(i, _) => i.to_string(),
        DynSolValue::Uint(u, _) => u.to_string(),
        DynSolValue::FixedBytes(w, n) => format!("0x{}", hex_str(&w[..(*n).min(32)])),
        DynSolValue::Address(a) => format!("{a:#x}"),
        DynSolValue::Function(f) => format!("0x{}", hex_str(f.as_slice())),
        DynSolValue::Bytes(b) => format!("0x{}", hex_str(b)),
        DynSolValue::String(s) => s.clone(),
        DynSolValue::Array(xs) | DynSolValue::FixedArray(xs) => {
            format!("[{}]", join(xs))
        }
        DynSolValue::Tuple(xs) => format!("({})", join(xs)),
    }
}

fn join(xs: &[DynSolValue]) -> String {
    xs.iter().map(fmt_value).collect::<Vec<_>>().join(", ")
}

fn hex_str(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn decode_call(abi: &JsonAbi, input: &[u8]) -> Option<DecodedCall> {
    let selector = input.get(..4)?;
    let func = abi
        .functions()
        .find(|f| f.selector().as_slice() == selector)?;
    let values = func.abi_decode_input(&input[4..]).ok()?;
    let args = func
        .inputs
        .iter()
        .zip(values.iter())
        .map(|(p, v)| DecodedArg {
            name: p.name.clone(),
            ty: p.ty.clone(),
            value: fmt_value(v),
        })
        .collect();
    Some(DecodedCall {
        signature: func.signature(),
        name: func.name.clone(),
        args,
    })
}

/// Decodes revert data: the built-in `Error(string)` (`0x08c379a0`) and
/// `Panic(uint256)` (`0x4e487b71`), else a custom error of `abi` with a
/// matching selector. `None` when nothing matches or the data does not decode.
pub fn decode_error(abi: Option<&JsonAbi>, output: &[u8]) -> Option<DecodedError> {
    let selector = output.get(..4)?;
    if selector == Revert::SELECTOR {
        let r = Revert::abi_decode(output).ok()?;
        return Some(DecodedError {
            name: "Error".into(),
            args: vec![arg("reason", "string", r.reason)],
        });
    }
    if selector == Panic::SELECTOR {
        let p = Panic::abi_decode(output).ok()?;
        return Some(DecodedError {
            name: "Panic".into(),
            args: vec![arg("code", "uint256", p.code.to_string())],
        });
    }
    let err = abi?
        .errors()
        .find(|e| e.selector().as_slice() == selector)?;
    let values = err.abi_decode_input(&output[4..]).ok()?;
    let args = err
        .inputs
        .iter()
        .zip(values.iter())
        .map(|(p, v)| arg(&p.name, &p.ty, fmt_value(v)))
        .collect();
    Some(DecodedError {
        name: err.name.clone(),
        args,
    })
}

fn decode_with_abi_event(ev: &Event, log: &RawLog) -> Option<Vec<DecodedArg>> {
    let dec = ev
        .decode_log_parts(log.topics.iter().copied(), &log.data)
        .ok()?;
    let (mut ind, mut body) = (dec.indexed.iter(), dec.body.iter());
    let mut args = Vec::new();
    for p in &ev.inputs {
        let v = if p.indexed { ind.next() } else { body.next() }?;
        args.push(DecodedArg {
            name: p.name.clone(),
            ty: p.ty.clone(),
            value: fmt_value(v),
        });
    }
    Some(args)
}

fn arg(name: &str, ty: &str, value: String) -> DecodedArg {
    DecodedArg {
        name: name.to_string(),
        ty: ty.to_string(),
        value,
    }
}

/// Built-in Transfer / Approval (ERC20 or ERC721 layout) and ERC1155 events.
fn decode_builtin(log: &RawLog) -> Option<(String, Vec<DecodedArg>)> {
    let t0 = log.topics.first()?;
    let addr = |i: usize| format!("{:#x}", topic_address(&log.topics[i]));
    let (name, a, b, c) = if *t0 == TransferEv::SIGNATURE_HASH {
        ("Transfer", "from", "to", "value")
    } else if *t0 == Approval::SIGNATURE_HASH {
        ("Approval", "owner", "spender", "value")
    } else {
        return decode_1155(log);
    };
    match log.topics.len() {
        3 if log.data.len() == 32 => Some((
            name.to_string(),
            vec![
                arg(a, "address", addr(1)),
                arg(b, "address", addr(2)),
                arg(
                    c,
                    "uint256",
                    alloy_primitives::U256::from_be_slice(&log.data).to_string(),
                ),
            ],
        )),
        4 => Some((
            name.to_string(),
            vec![
                arg(a, "address", addr(1)),
                arg(b, "address", addr(2)),
                arg(
                    "tokenId",
                    "uint256",
                    alloy_primitives::U256::from_be_bytes(log.topics[3].0).to_string(),
                ),
            ],
        )),
        _ => None,
    }
}

fn decode_1155(log: &RawLog) -> Option<(String, Vec<DecodedArg>)> {
    use crate::transfers::{TransferBatch, TransferSingle};
    let t0 = log.topics.first()?;
    let topics = log.topics.iter().copied();
    if *t0 == TransferSingle::SIGNATURE_HASH {
        let e = TransferSingle::decode_raw_log(topics, &log.data).ok()?;
        Some((
            "TransferSingle".to_string(),
            vec![
                arg("operator", "address", format!("{:#x}", e.operator)),
                arg("from", "address", format!("{:#x}", e.from)),
                arg("to", "address", format!("{:#x}", e.to)),
                arg("id", "uint256", e.id.to_string()),
                arg("value", "uint256", e.value.to_string()),
            ],
        ))
    } else if *t0 == TransferBatch::SIGNATURE_HASH {
        let e = TransferBatch::decode_raw_log(topics, &log.data).ok()?;
        let list = |v: &[alloy_primitives::U256]| {
            format!(
                "[{}]",
                v.iter()
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        Some((
            "TransferBatch".to_string(),
            vec![
                arg("operator", "address", format!("{:#x}", e.operator)),
                arg("from", "address", format!("{:#x}", e.from)),
                arg("to", "address", format!("{:#x}", e.to)),
                arg("ids", "uint256[]", list(&e.ids)),
                arg("values", "uint256[]", list(&e.values)),
            ],
        ))
    } else {
        None
    }
}

/// With an ABI, matches topic0 against its non-anonymous events; otherwise (or on
/// no match) falls back to the built-in events; else `name` is `None`.
pub fn decode_event(abi: Option<&JsonAbi>, log: &RawLog) -> DecodedEvent {
    let mut name = None;
    let mut args = Vec::new();
    if let (Some(abi), Some(t0)) = (abi, log.topics.first())
        && let Some(ev) = abi.events().find(|e| !e.anonymous && e.selector() == *t0)
        && let Some(a) = decode_with_abi_event(ev, log)
    {
        name = Some(ev.name.clone());
        args = a;
    }
    if name.is_none()
        && let Some((n, a)) = decode_builtin(log)
    {
        name = Some(n);
        args = a;
    }
    DecodedEvent {
        address: log.address,
        log_index: log.log_index,
        name,
        args,
        topics: log.topics.clone(),
        data: log.data.clone(),
        signature: None,
        guessed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;
    use alloy_sol_types::{Panic, Revert, SolError};

    const ERC20_ABI: &str = r#"[
      {"type":"function","name":"transfer","stateMutability":"nonpayable",
       "inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],
       "outputs":[{"name":"","type":"bool"}]},
      {"type":"event","name":"Transfer","anonymous":false,"inputs":[
       {"name":"from","type":"address","indexed":true},
       {"name":"to","type":"address","indexed":true},
       {"name":"value","type":"uint256","indexed":false}]}
    ]"#;

    fn erc20_log() -> RawLog {
        RawLog {
            address: Address::repeat_byte(9),
            topics: vec![
                TransferEv::SIGNATURE_HASH,
                Address::repeat_byte(1).into_word(),
                Address::repeat_byte(2).into_word(),
            ],
            data: Bytes::from(U256::from(77u8).to_be_bytes::<32>().to_vec()),
            log_index: 4,
        }
    }

    #[test]
    fn decode_call_with_abi() {
        let abi: JsonAbi = serde_json::from_str(ERC20_ABI).unwrap();
        let mut input = vec![0xa9, 0x05, 0x9c, 0xbb];
        input.extend_from_slice(Address::repeat_byte(0xab).into_word().as_slice());
        input.extend_from_slice(&U256::from(1000u32).to_be_bytes::<32>());
        let c = decode_call(&abi, &input).unwrap();
        assert_eq!(c.name, "transfer");
        assert_eq!(c.signature, "transfer(address,uint256)");
        assert_eq!(c.args.len(), 2);
        assert_eq!(c.args[0].name, "to");
        assert_eq!(
            c.args[0].value,
            format!("{:#x}", Address::repeat_byte(0xab))
        );
        assert_eq!(c.args[1].value, "1000");
    }

    #[test]
    fn decode_call_unknown_selector_none() {
        let abi: JsonAbi = serde_json::from_str(ERC20_ABI).unwrap();
        assert!(decode_call(&abi, &[1, 2, 3, 4, 0, 0]).is_none());
        assert!(decode_call(&abi, &[1]).is_none());
    }

    const ERRORS_ABI: &str = r#"[
      {"type":"error","name":"InsufficientBalance",
       "inputs":[{"name":"available","type":"uint256"},{"name":"required","type":"uint256"}]}
    ]"#;

    #[test]
    fn decodes_error_string() {
        let out = Revert::from("nope").abi_encode();
        let e = decode_error(None, &out).unwrap();
        assert_eq!(e.name, "Error");
        assert_eq!(e.args, vec![arg("reason", "string", "nope".into())]);
    }

    #[test]
    fn decodes_panic_code() {
        let out = Panic::from(0x11u64).abi_encode();
        let e = decode_error(None, &out).unwrap();
        assert_eq!(e.name, "Panic");
        assert_eq!(e.args, vec![arg("code", "uint256", "17".into())]);
    }

    #[test]
    fn decodes_custom_error_from_abi() {
        let abi: JsonAbi = serde_json::from_str(ERRORS_ABI).unwrap();
        let err = abi.errors().next().unwrap();
        let mut out = err.selector().to_vec();
        out.extend_from_slice(&U256::from(3u8).to_be_bytes::<32>());
        out.extend_from_slice(&U256::from(10u8).to_be_bytes::<32>());
        let e = decode_error(Some(&abi), &out).unwrap();
        assert_eq!(e.name, "InsufficientBalance");
        assert_eq!(
            e.args,
            vec![
                arg("available", "uint256", "3".into()),
                arg("required", "uint256", "10".into()),
            ]
        );
        // Without the ABI the selector is unknown.
        assert!(decode_error(None, &out).is_none());
    }

    #[test]
    fn unknown_selector_is_none() {
        let abi: JsonAbi = serde_json::from_str(ERRORS_ABI).unwrap();
        assert!(decode_error(Some(&abi), &[0xde, 0xad, 0xbe, 0xef, 0, 0]).is_none());
        assert!(decode_error(Some(&abi), &[]).is_none());
        assert!(decode_error(None, &[0x08, 0xc3]).is_none());
        // The Error(string) selector with data that does not decode.
        assert!(decode_error(None, &[0x08, 0xc3, 0x79, 0xa0, 1]).is_none());
    }

    #[test]
    fn decode_event_builtin_fallback() {
        let e = decode_event(None, &erc20_log());
        assert_eq!(e.name.as_deref(), Some("Transfer"));
        assert_eq!(e.args.len(), 3);
        assert_eq!(e.args[2].value, "77");
        assert_eq!(e.log_index, 4);
    }

    #[test]
    fn decode_event_with_abi_and_unknown() {
        let abi: JsonAbi = serde_json::from_str(ERC20_ABI).unwrap();
        let e = decode_event(Some(&abi), &erc20_log());
        assert_eq!(e.name.as_deref(), Some("Transfer"));
        assert_eq!(e.args[0].name, "from");
        assert_eq!(e.args[2].name, "value");
        assert_eq!(e.args[2].value, "77");

        let unknown = RawLog {
            address: Address::ZERO,
            topics: vec![B256::repeat_byte(0xee)],
            data: Bytes::new(),
            log_index: 0,
        };
        let e = decode_event(Some(&abi), &unknown);
        assert!(e.name.is_none() && e.args.is_empty());
    }
}
