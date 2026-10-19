//! Call traces: the completeness checks a trace must pass before it is cached.

use std::collections::{HashMap, HashSet};

use eg_core::source::{CallFrame, CallKind};
use eg_store::TxRow;

/// Whether the transaction carries calldata (or init code).
fn has_input(tx: &TxRow) -> bool {
    match tx.raw_tx.get("input").and_then(|v| v.as_str()) {
        Some(s) => !s.trim_start_matches("0x").is_empty(),
        None => tx.selector.is_some(),
    }
}

/// Checks that `frames` is the whole trace of `tx`: one root (`path == []`)
/// whose sender, callee (a create when `tx.to` is `None`) and value match the
/// transaction, unique paths, every frame's parent present, and every
/// `subtraces` equal to its number of children (numbered `0..subtraces`).
/// An empty trace passes only for a plain transfer (no calldata, a
/// recipient); whether that recipient has code is the caller's check. The
/// error says what is wrong.
pub fn validate_trace(tx: &TxRow, frames: &[CallFrame]) -> Result<(), String> {
    if frames.is_empty() {
        return if tx.to.is_none() || has_input(tx) {
            Err("no frames".into())
        } else {
            Ok(())
        };
    }
    let mut paths = HashSet::new();
    for f in frames {
        if !paths.insert(f.path.as_slice()) {
            return Err(format!("duplicate frame {:?}", f.path));
        }
    }
    let mut roots = frames.iter().filter(|f| f.path.is_empty());
    let (Some(root), None) = (roots.next(), roots.next()) else {
        return Err("no root frame".into());
    };
    if root.from != tx.from {
        return Err(format!(
            "root from {:#x} is not the sender {:#x}",
            root.from, tx.from
        ));
    }
    match tx.to {
        Some(to) if root.to != Some(to) => {
            return Err(format!(
                "root to {} is not the recipient {to:#x}",
                root.to.map_or("none".into(), |a| format!("{a:#x}"))
            ));
        }
        None if !matches!(root.kind, CallKind::Create | CallKind::Create2) => {
            return Err(format!("root of a contract creation is a {:?}", root.kind));
        }
        _ => {}
    }
    if root.value != tx.value {
        return Err(format!(
            "root value {} is not the transaction's {}",
            root.value, tx.value
        ));
    }
    let mut children: HashMap<&[u32], u32> = HashMap::new();
    for f in frames {
        if let Some((_, parent)) = f.path.split_last() {
            if !paths.contains(parent) {
                return Err(format!("frame {:?} without its parent", f.path));
            }
            *children.entry(parent).or_default() += 1;
        }
    }
    for f in frames {
        let n = children.get(f.path.as_slice()).copied().unwrap_or(0);
        if n != f.subtraces {
            return Err(format!(
                "subtraces of {:?} is {} but {n} children are present",
                f.path, f.subtraces
            ));
        }
    }
    // With the counts right, an index past the count means a gap.
    let subtraces: HashMap<&[u32], u32> = frames
        .iter()
        .map(|f| (f.path.as_slice(), f.subtraces))
        .collect();
    for f in frames {
        if let Some((&index, parent)) = f.path.split_last()
            && index >= subtraces[parent]
        {
            return Err(format!(
                "frame {:?} out of order: a sibling is missing",
                f.path
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;
    use eg_core::types::{Address, B256, Bytes, U256};
    use serde_json::json;

    const FROM: Address = Address::repeat_byte(1);
    const TO: Address = Address::repeat_byte(2);

    fn tx(to: Option<Address>, input: &str) -> TxRow {
        TxRow {
            hash: B256::repeat_byte(9),
            block_number: 1,
            ts: DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            from: FROM,
            to,
            value: U256::from(5u8),
            selector: None,
            success: true,
            gas_used: U256::ZERO,
            fee: U256::ZERO,
            raw_tx: json!({ "input": input }),
            raw_receipt: json!({}),
            revert_reason: None,
        }
    }

    fn frame(path: &[u32], kind: CallKind, to: Option<Address>, subtraces: u32) -> CallFrame {
        CallFrame {
            path: path.to_vec(),
            kind,
            from: FROM,
            to,
            value: U256::from(5u8),
            input: Bytes::new(),
            output: None,
            gas: 0,
            gas_used: None,
            error: None,
            subtraces,
        }
    }

    #[test]
    fn empty_trace_only_for_a_plain_transfer() {
        assert_eq!(validate_trace(&tx(Some(TO), "0x"), &[]), Ok(()));
        assert!(validate_trace(&tx(Some(TO), "0x01"), &[]).is_err());
        assert!(validate_trace(&tx(None, "0x"), &[]).is_err());
    }

    #[test]
    fn creation_needs_a_create_root() {
        let created = Some(Address::repeat_byte(3));
        let create = [frame(&[], CallKind::Create2, created, 0)];
        assert_eq!(validate_trace(&tx(None, "0x6080"), &create), Ok(()));
        let call = [frame(&[], CallKind::Call, created, 0)];
        assert!(validate_trace(&tx(None, "0x6080"), &call).is_err());
        assert!(validate_trace(&tx(Some(TO), "0x6080"), &create).is_err());
    }

    #[test]
    fn sibling_gap_is_rejected() {
        let t = tx(Some(TO), "0x01");
        let child = |i| frame(&[i], CallKind::Call, Some(TO), 0);
        let ok = [frame(&[], CallKind::Call, Some(TO), 2), child(0), child(1)];
        assert_eq!(validate_trace(&t, &ok), Ok(()));
        let gap = [frame(&[], CallKind::Call, Some(TO), 2), child(0), child(2)];
        let err = validate_trace(&t, &gap).unwrap_err();
        assert!(err.contains("a sibling is missing"), "{err}");
        let two_roots = [ok[0].clone(), ok[0].clone()];
        assert!(validate_trace(&t, &two_roots).is_err());
    }
}
