//! Call traces: the completeness checks a trace must pass before it is
//! cached, per-frame decoding, and the contracts a view identifies
//! automatically.

use std::collections::{HashMap, HashSet};

use alloy_json_abi::JsonAbi;
use eg_core::source::{CallFrame, CallKind};
use eg_core::types::Address;
use eg_decode::{DecodedCall, DecodedError, decode_call, decode_error};
use eg_store::{AccountRow, CallTraceRow, Store, StoreError, TxRow};

use crate::txflow::abi_for;

/// Contracts identified automatically per viewed trace; the rest only on
/// request.
pub const MAX_AUTO_META: usize = 20;

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

/// One frame with its call and revert data decoded where an ABI allows.
#[derive(Clone, Debug)]
pub struct DecodedFrame {
    pub frame: CallFrame,
    /// `None` without an ABI matching the selector (or for a create or
    /// self-destruct, whose input is not calldata).
    pub call: Option<DecodedCall>,
    /// The decoded revert data of a failed frame.
    pub revert: Option<DecodedError>,
}

/// Decodes each frame with the ABI of its callee: the callee's EIP-7702
/// delegate in `row.delegates` when it has one, else the callee itself, then
/// [`abi_for`] (a proxy's implementation ABI). A DELEGATECALL's callee is the
/// code that runs, so its own ABI applies. Revert data is decoded for frames
/// with an `error`.
pub fn decode_frames(
    row: &CallTraceRow,
    abis: &HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
) -> Vec<DecodedFrame> {
    row.frames
        .iter()
        .map(|f| {
            let creates = matches!(
                f.kind,
                CallKind::Create | CallKind::Create2 | CallKind::SelfDestruct
            );
            let abi =
                f.to.filter(|_| !creates)
                    .map(|to| row.delegates.get(&to).copied().unwrap_or(to))
                    .and_then(|a| abi_for(a, abis, accounts));
            let call = abi
                .filter(|_| !f.input.is_empty())
                .and_then(|abi| decode_call(abi, &f.input));
            let revert = f
                .error
                .as_ref()
                .and(f.output.as_ref())
                .and_then(|out| decode_error(abi, out));
            DecodedFrame {
                frame: f.clone(),
                call,
                revert,
            }
        })
        .collect()
}

/// Whether each frame is shown under the default filter: neither it nor an
/// ancestor is a STATICCALL. `frames` is in pre-order, so a parent comes
/// before its children.
fn default_visible(frames: &[CallFrame]) -> Vec<bool> {
    let mut hidden: HashSet<&[u32]> = HashSet::new();
    frames
        .iter()
        .map(|f| {
            let parent_hidden = f
                .path
                .split_last()
                .is_some_and(|(_, parent)| hidden.contains(parent));
            if parent_hidden || f.kind == CallKind::StaticCall {
                hidden.insert(f.path.as_slice());
                false
            } else {
                true
            }
        })
        .collect()
}

/// The contracts a view of this trace identifies: the distinct callees of
/// the frames shown under the default filter (see [`default_visible`]), each
/// followed by its EIP-7702 delegate, in first-appearance order.
pub fn auto_meta_targets(row: &CallTraceRow) -> Vec<Address> {
    let mut seen = HashSet::new();
    row.frames
        .iter()
        .zip(default_visible(&row.frames))
        .filter(|(_, visible)| *visible)
        .filter_map(|(f, _)| f.to)
        .flat_map(|to| [Some(to), row.delegates.get(&to).copied()])
        .flatten()
        .filter(|a| seen.insert(*a))
        .collect()
}

/// Loads the accounts and ABIs [`decode_frames`] needs (callees, their
/// delegates and proxy implementations) and decodes `row`.
pub async fn decode_trace(
    store: &Store,
    row: &CallTraceRow,
) -> Result<Vec<DecodedFrame>, StoreError> {
    let mut addrs: Vec<Address> = row
        .frames
        .iter()
        .filter_map(|f| f.to)
        .chain(row.delegates.values().copied())
        .collect();
    addrs.sort();
    addrs.dedup();
    let accounts: HashMap<Address, AccountRow> = store
        .accounts(&addrs)
        .await?
        .into_iter()
        .map(|a| (a.address, a))
        .collect();
    addrs.extend(accounts.values().filter_map(|a| a.implementation));
    addrs.sort();
    addrs.dedup();
    let abis: HashMap<Address, JsonAbi> = store
        .abis(&addrs)
        .await?
        .into_iter()
        .filter_map(|(a, json)| Some((a, serde_json::from_str(&json?).ok()?)))
        .collect();
    Ok(decode_frames(row, &abis, &accounts))
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

    fn row(frames: Vec<CallFrame>, delegates: &[(Address, Address)]) -> CallTraceRow {
        CallTraceRow {
            hash: B256::repeat_byte(9),
            frames,
            delegates: delegates.iter().copied().collect(),
            source: "fake".into(),
            fetched_at: DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
        }
    }

    #[test]
    fn auto_targets_skip_static_subtrees_and_follow_delegates() {
        let a = |b| Some(Address::repeat_byte(b));
        let r = row(
            vec![
                frame(&[], CallKind::Call, a(0x10), 3),
                frame(&[0], CallKind::StaticCall, a(0x11), 1),
                frame(&[0, 0], CallKind::Call, a(0x12), 0),
                frame(&[1], CallKind::DelegateCall, a(0x13), 0),
                frame(&[2], CallKind::Call, a(0x10), 0),
            ],
            &[(Address::repeat_byte(0x10), Address::repeat_byte(0xde))],
        );
        assert_eq!(
            auto_meta_targets(&r),
            vec![
                Address::repeat_byte(0x10),
                Address::repeat_byte(0xde),
                Address::repeat_byte(0x13),
            ]
        );
    }

    #[test]
    fn frames_decode_with_the_delegates_abi_and_revert_without_one() {
        let abi: JsonAbi = serde_json::from_str(
            r#"[{"type":"function","name":"ping","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]"#,
        )
        .unwrap();
        let ping = abi.functions().next().unwrap().selector().to_vec();
        let (callee, delegate) = (Address::repeat_byte(0x10), Address::repeat_byte(0xde));
        let mut root = frame(&[], CallKind::Call, Some(callee), 1);
        root.input = Bytes::from(ping.clone());
        let mut child = frame(&[0], CallKind::Create, Some(Address::repeat_byte(0x11)), 0);
        child.input = Bytes::from(ping);
        child.error = Some("Reverted".into());
        // Panic(0x01)
        let mut out = vec![0x4e, 0x48, 0x7b, 0x71];
        out.extend_from_slice(&U256::from(1u8).to_be_bytes::<32>());
        child.output = Some(Bytes::from(out));
        let abis = HashMap::from([(delegate, abi)]);

        let plain = decode_frames(
            &row(vec![root.clone(), child.clone()], &[]),
            &abis,
            &HashMap::new(),
        );
        assert!(plain[0].call.is_none());
        let d = decode_frames(
            &row(vec![root, child], &[(callee, delegate)]),
            &abis,
            &HashMap::new(),
        );
        assert_eq!(d[0].call.as_ref().map(|c| c.name.as_str()), Some("ping"));
        assert!(d[0].revert.is_none());
        // A create's input is init code, never decoded as a call.
        assert!(d[1].call.is_none());
        assert_eq!(d[1].revert.as_ref().map(|e| e.name.as_str()), Some("Panic"));
    }
}
