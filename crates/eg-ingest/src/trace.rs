//! Call traces: the completeness checks a trace must pass before it is
//! cached, per-frame decoding, and the contracts a view identifies
//! automatically.

use std::collections::{HashMap, HashSet};

use alloy_json_abi::JsonAbi;
use eg_core::source::{CallFrame, CallKind};
use eg_core::types::Address;
use eg_decode::{DecodedCall, DecodedError, decode_call, decode_error, guess_call};
use eg_store::{AccountRow, CallTraceRow, Store, StoreError, TxRow, signatures_by_selector};

use crate::authorization::{applied_delegations, authorizations, tx_nonce};
use crate::txflow::{abis_for, accounts_with_proxies, implementations};

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

/// The EIP-7702 delegate whose ABI may decode a callee's calls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameDelegate {
    pub address: Address,
    /// Read from the account's code when the trace was fetched (today's
    /// delegation, which may differ from the one at the transaction), not from
    /// the transaction's own authorization list.
    pub current: bool,
}

/// Each account the transaction's own authorization list leaves delegated
/// (`Some(delegate)`) or cleared (`None`) for its whole execution (see
/// [`applied_delegations`]).
pub fn tx_delegations(tx: &TxRow) -> HashMap<Address, Option<Address>> {
    applied_delegations(&authorizations(&tx.raw_tx), tx.from, tx_nonce(&tx.raw_tx))
        .into_iter()
        .map(|(authority, d)| (authority, (!d.is_zero()).then_some(d)))
        .collect()
}

/// The delegates of the trace's callees: the transaction's own authorization
/// list (see [`tx_delegations`]) for the accounts it sets or clears, else the
/// delegation looked up when the trace was fetched (`current`). Without the
/// transaction only the lookups are known.
pub fn trace_delegates(tx: Option<&TxRow>, row: &CallTraceRow) -> HashMap<Address, FrameDelegate> {
    let own = tx.map(tx_delegations).unwrap_or_default();
    let callees: HashSet<Address> = row.frames.iter().filter_map(|f| f.to).collect();
    let looked_up = row
        .delegates
        .iter()
        .filter(|(account, _)| !own.contains_key(*account))
        .map(|(&account, &address)| {
            let d = FrameDelegate {
                address,
                current: true,
            };
            (account, d)
        });
    let set = own
        .iter()
        .filter(|(account, _)| callees.contains(*account))
        .filter_map(|(&account, &d)| {
            let d = FrameDelegate {
                address: d?,
                current: false,
            };
            Some((account, d))
        });
    looked_up.chain(set).collect()
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
    /// The callee's delegate, when its ABI decoded the call (or, with no call
    /// decoded, the revert).
    pub via_delegate: Option<FrameDelegate>,
    /// `call` was guessed from the signature database (see
    /// [`apply_frame_guesses`]): no ABI decoded it.
    pub guessed: bool,
    /// The other candidates of a guessed `call`.
    pub alternatives: Vec<String>,
}

/// `input` decoded with the first of `candidates` that decodes it, and that
/// ABI.
fn first_call<'a>(candidates: &[&'a JsonAbi], input: &[u8]) -> Option<(DecodedCall, &'a JsonAbi)> {
    candidates
        .iter()
        .find_map(|&abi| Some((decode_call(abi, input)?, abi)))
}

/// Decodes each frame as the transaction's top-level call is: with the
/// callee's ABIs ([`abis_for`]: a proxy's implementation ABI, then its own)
/// first, then with those of the callee's EIP-7702 delegate in `delegates`
/// (see [`trace_delegates`]) only when they decode it. A DELEGATECALL's
/// callee is the code that runs, so its ABIs apply. Revert data of frames
/// with an `error` is decoded with the ABI that decoded the call; with no
/// call decoded, the callee's ABIs first, then the delegate's.
pub fn decode_frames(
    row: &CallTraceRow,
    delegates: &HashMap<Address, FrameDelegate>,
    abis: &HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
) -> Vec<DecodedFrame> {
    let implemented = implementations(accounts.values());
    row.frames
        .iter()
        .map(|f| {
            let creates = matches!(
                f.kind,
                CallKind::Create | CallKind::Create2 | CallKind::SelfDestruct
            );
            let callee = f.to.filter(|_| !creates);
            let own: Vec<&JsonAbi> = callee.map_or_else(Vec::new, |a| {
                abis_for(a, abis, accounts, &implemented).collect()
            });
            let delegate = callee.and_then(|a| delegates.get(&a)).copied();
            let delegate_abis: Vec<&JsonAbi> = delegate.map_or_else(Vec::new, |d| {
                abis_for(d.address, abis, accounts, &implemented).collect()
            });
            let mut via_delegate = None;
            let decoded = if callee.is_some() && !f.input.is_empty() {
                first_call(&own, &f.input).or_else(|| {
                    let decoded = first_call(&delegate_abis, &f.input)?;
                    via_delegate = delegate;
                    Some(decoded)
                })
            } else {
                None
            };
            let revert = f.error.as_ref().and(f.output.as_ref()).and_then(|out| {
                if let Some((_, abi)) = decoded {
                    return decode_error(Some(abi), out);
                }
                own.iter()
                    .find_map(|&abi| decode_error(Some(abi), out))
                    .or_else(|| decode_error(None, out))
                    .or_else(|| {
                        let e = delegate_abis
                            .iter()
                            .find_map(|&abi| decode_error(Some(abi), out))?;
                        via_delegate = delegate;
                        Some(e)
                    })
            });
            DecodedFrame {
                frame: f.clone(),
                call: decoded.map(|(call, _)| call),
                revert,
                via_delegate,
                guessed: false,
                alternatives: Vec::new(),
            }
        })
        .collect()
}

/// The selector of a frame's call no ABI decoded; `None` for a create or
/// self-destruct (their input is not calldata) and a decoded call.
fn undecoded_selector(d: &DecodedFrame) -> Option<[u8; 4]> {
    let f = &d.frame;
    let creates = matches!(
        f.kind,
        CallKind::Create | CallKind::Create2 | CallKind::SelfDestruct
    );
    if d.call.is_some() || creates || f.to.is_none() {
        return None;
    }
    f.input.get(..4)?.try_into().ok()
}

/// The distinct selectors of the frames' calls no ABI decoded.
pub fn frame_guess_selectors(frames: &[DecodedFrame]) -> Vec<[u8; 4]> {
    let mut out: Vec<[u8; 4]> = frames.iter().filter_map(undecoded_selector).collect();
    out.sort();
    out.dedup();
    out
}

/// Guesses each call no ABI decoded from its selector's candidates (see
/// [`eg_decode::guess_call`]), marked guessed. Runs after [`decode_frames`]
/// has tried every ABI, so a decoded call is never replaced; the revert and
/// `via_delegate` are left as decoded.
pub fn apply_frame_guesses(
    frames: &mut [DecodedFrame],
    by_selector: &HashMap<[u8; 4], Vec<String>>,
) {
    for d in frames.iter_mut() {
        let Some(g) = undecoded_selector(d)
            .and_then(|sel| by_selector.get(&sel))
            .and_then(|candidates| guess_call(&d.frame.input, candidates))
        else {
            continue;
        };
        d.call = Some(g.call);
        d.guessed = true;
        d.alternatives = g.alternatives;
    }
}

/// [`apply_frame_guesses`] with the candidates looked up in the signature
/// database in one query (none when every call decoded).
pub async fn guess_frames(store: &Store, frames: &mut [DecodedFrame]) -> Result<(), StoreError> {
    let selectors = frame_guess_selectors(frames);
    let by_selector = signatures_by_selector(store.pool(), &selectors).await?;
    apply_frame_guesses(frames, &by_selector);
    Ok(())
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
/// followed by its EIP-7702 delegate in `delegates`, in first-appearance
/// order.
pub fn auto_meta_targets(
    row: &CallTraceRow,
    delegates: &HashMap<Address, FrameDelegate>,
) -> Vec<Address> {
    let mut seen = HashSet::new();
    row.frames
        .iter()
        .zip(default_visible(&row.frames))
        .filter(|(_, visible)| *visible)
        .filter_map(|(f, _)| f.to)
        .flat_map(|to| [Some(to), delegates.get(&to).map(|d| d.address)])
        .flatten()
        .filter(|a| seen.insert(*a))
        .collect()
}

/// Loads the accounts and ABIs [`decode_frames`] needs (callees, their
/// `delegates` and proxy implementations, and the proxies implemented by
/// callees or delegates) and decodes `row`.
pub async fn decode_trace(
    store: &Store,
    row: &CallTraceRow,
    delegates: &HashMap<Address, FrameDelegate>,
) -> Result<Vec<DecodedFrame>, StoreError> {
    let mut addrs: Vec<Address> = row
        .frames
        .iter()
        .filter_map(|f| f.to)
        .chain(delegates.values().map(|d| d.address))
        .collect();
    addrs.sort();
    addrs.dedup();
    let accounts = accounts_with_proxies(store, &addrs).await?;
    addrs.extend(accounts.values().filter_map(|a| a.implementation));
    addrs.sort();
    addrs.dedup();
    let abis: HashMap<Address, JsonAbi> = store
        .abis(&addrs)
        .await?
        .into_iter()
        .filter_map(|(a, json)| Some((a, serde_json::from_str(&json?).ok()?)))
        .collect();
    Ok(decode_frames(row, delegates, &abis, &accounts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::txflow::implementation_of;
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

    /// `callee` delegated (looked up today) to `d`.
    fn looked_up(callee: Address, d: Address) -> HashMap<Address, FrameDelegate> {
        HashMap::from([(
            callee,
            FrameDelegate {
                address: d,
                current: true,
            },
        )])
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
            &[],
        );
        let delegates = looked_up(Address::repeat_byte(0x10), Address::repeat_byte(0xde));
        assert_eq!(
            auto_meta_targets(&r, &delegates),
            vec![
                Address::repeat_byte(0x10),
                Address::repeat_byte(0xde),
                Address::repeat_byte(0x13),
            ]
        );
    }

    #[test]
    fn the_transactions_own_authorizations_override_looked_up_delegates() {
        use crate::authorization::tests::{key, signed};
        let (k1, k2) = (key(1), key(2));
        let (x, y) = (
            Address::from_private_key(&k1),
            Address::from_private_key(&k2),
        );
        let z = Address::repeat_byte(0x33);
        let (d_tx, d_old, d_z) = (
            Address::repeat_byte(0xd1),
            Address::repeat_byte(0xd0),
            Address::repeat_byte(0xd3),
        );
        let mut t = tx(Some(TO), "0x01");
        // x delegates to d_tx in this tx; y clears its delegation.
        t.raw_tx = json!({"input": "0x01", "nonce": "0x0", "authorizationList": [
            signed(&k1, 1, d_tx, 0),
            signed(&k2, 1, Address::ZERO, 0),
        ]});
        let call = |path: &[u32], to| frame(path, CallKind::Call, Some(to), 0);
        let mut root = call(&[], TO);
        root.subtraces = 3;
        let r = row(
            vec![root, call(&[0], x), call(&[1], y), call(&[2], z)],
            // Looked up when the trace was fetched: today's delegations.
            &[(x, d_old), (y, d_old), (z, d_z)],
        );
        let got = trace_delegates(Some(&t), &r);
        assert_eq!(
            got,
            HashMap::from([
                (
                    x,
                    FrameDelegate {
                        address: d_tx,
                        current: false
                    }
                ),
                (
                    z,
                    FrameDelegate {
                        address: d_z,
                        current: true
                    }
                ),
            ])
        );
        // Without the transaction only the lookups are known.
        assert_eq!(trace_delegates(None, &r).len(), 3);
    }

    fn abi(json: &str) -> JsonAbi {
        serde_json::from_str(json).unwrap()
    }

    const PING: &str = r#"[{"type":"function","name":"ping","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]"#;
    const PONG: &str = r#"[{"type":"function","name":"ping","inputs":[],"outputs":[],"stateMutability":"payable"},
        {"type":"function","name":"pong","inputs":[],"outputs":[],"stateMutability":"nonpayable"},
        {"type":"error","name":"Nope","inputs":[{"name":"code","type":"uint8"}]}]"#;

    #[test]
    fn frames_decode_with_their_own_abi_first_then_the_delegates() {
        let (own_abi, del_abi) = (abi(PING), abi(PONG));
        let selector = |a: &JsonAbi, name: &str| {
            a.functions()
                .find(|f| f.name == name)
                .unwrap()
                .selector()
                .to_vec()
        };
        let (callee, delegate) = (Address::repeat_byte(0x10), Address::repeat_byte(0xde));
        let with_input = |path: &[u32], input: Vec<u8>| {
            let mut f = frame(path, CallKind::Call, Some(callee), 0);
            f.input = Bytes::from(input);
            f
        };
        let mut root = with_input(&[], selector(&own_abi, "ping"));
        root.subtraces = 3;
        // pong is only in the delegate's ABI.
        let pong = with_input(&[0], selector(&del_abi, "pong"));
        // A plain transfer to the callee: nothing decoded, the delegate unused.
        let plain = with_input(&[1], Vec::new());
        // A failed plain transfer reverting with the delegate's custom error.
        let mut nope = with_input(&[2], Vec::new());
        nope.error = Some("Reverted".into());
        let err = del_abi.errors().next().unwrap();
        let mut out = err.selector().to_vec();
        out.extend_from_slice(&U256::from(7u8).to_be_bytes::<32>());
        nope.output = Some(Bytes::from(out));
        let r = row(vec![root, pong, plain, nope], &[]);
        let abis = HashMap::from([(callee, own_abi), (delegate, del_abi)]);
        let delegates = looked_up(callee, delegate);

        let d = decode_frames(&r, &delegates, &abis, &HashMap::new());
        let name = |i: usize| d[i].call.as_ref().map(|c| c.name.as_str());
        // The callee's own ABI decodes ping: the delegate is not used.
        assert_eq!(name(0), Some("ping"));
        assert_eq!(d[0].via_delegate, None);
        assert_eq!(name(1), Some("pong"));
        assert_eq!(d[1].via_delegate, delegates.get(&callee).copied());
        assert_eq!((name(2), d[2].via_delegate), (None, None));
        assert_eq!(d[3].revert.as_ref().map(|e| e.name.as_str()), Some("Nope"));
        assert_eq!(d[3].via_delegate, delegates.get(&callee).copied());
    }

    #[test]
    fn frames_decode_with_the_delegates_abi_and_revert_without_one() {
        let abi = abi(PING);
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
        let r = row(vec![root, child], &[]);

        let plain = decode_frames(&r, &HashMap::new(), &abis, &HashMap::new());
        assert!(plain[0].call.is_none());
        let d = decode_frames(&r, &looked_up(callee, delegate), &abis, &HashMap::new());
        assert_eq!(d[0].call.as_ref().map(|c| c.name.as_str()), Some("ping"));
        assert!(d[0].revert.is_none());
        // A create's input is init code, never decoded as a call.
        assert!(d[1].call.is_none());
        assert_eq!(d[1].revert.as_ref().map(|e| e.name.as_str()), Some("Panic"));
        assert_eq!(d[1].via_delegate, None);
    }

    fn proxy(address: Address, implementation: Address) -> AccountRow {
        AccountRow {
            address,
            kind: eg_core::types::AccountKind::Contract,
            contract_name: None,
            is_proxy: true,
            implementation: Some(implementation),
            creator: None,
            creation_tx: None,
            meta_fetched_at: DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
        }
    }

    /// `transfer(to, 1_000_000)` calldata for `abi`'s `transfer`.
    fn transfer_input(abi: &JsonAbi, to: Address) -> Bytes {
        let f = abi.functions().find(|f| f.name == "transfer").unwrap();
        let mut input = f.selector().to_vec();
        input.extend_from_slice(&[0; 12]);
        input.extend_from_slice(to.as_slice());
        input.extend_from_slice(&U256::from(1_000_000u64).to_be_bytes::<32>());
        Bytes::from(input)
    }

    #[test]
    fn delegatecall_into_a_misflagged_implementation_decodes_with_its_own_abi() {
        // USDC: the proxy P delegates to its implementation I, which Etherscan
        // also flags as a proxy of S (a library it calls). S's ABI here even
        // decodes `transfer`, under other argument names: only I's own ABI
        // may be used for I.
        let (p, i, s) = (
            Address::repeat_byte(0xa0),
            Address::repeat_byte(0x43),
            Address::repeat_byte(0x80),
        );
        let imp = JsonAbi::parse(["function transfer(address to, uint256 value) returns (bool)"])
            .unwrap();
        let lib = JsonAbi::parse([
            "function transfer(address dst, uint256 wad) returns (bool)",
            "function isValidSignatureNow(address signer, bytes32 digest, bytes signature) view returns (bool)",
        ])
        .unwrap();
        let input = transfer_input(&imp, Address::repeat_byte(0x77));
        let mut root = frame(&[], CallKind::Call, Some(p), 1);
        root.input = input.clone();
        let mut inner = frame(&[0], CallKind::DelegateCall, Some(i), 0);
        inner.from = p;
        inner.input = input;
        let accounts = HashMap::from([(p, proxy(p, i)), (i, proxy(i, s))]);
        let abis = HashMap::from([(i, imp), (s, lib)]);

        assert_eq!(implementation_of(p, &accounts), Some(i));
        assert_eq!(implementation_of(i, &accounts), None);
        let d = decode_frames(
            &row(vec![root, inner], &[]),
            &HashMap::new(),
            &abis,
            &accounts,
        );
        for f in &d {
            let call = f.call.as_ref().expect("transfer decoded");
            assert_eq!(call.name, "transfer");
            assert_eq!(call.args[0].name, "to");
            assert_eq!(f.via_delegate, None);
        }
    }

    #[test]
    fn frames_fall_back_to_the_callees_own_abi() {
        // The implementation's ABI lacks `admin`; the proxy's own ABI has it,
        // and its custom error decodes the frame's revert.
        let (p, q) = (Address::repeat_byte(0x50), Address::repeat_byte(0x51));
        let own =
            JsonAbi::parse(["function admin() returns (address)", "error NotAdmin()"]).unwrap();
        let imp = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let admin = own.functions().next().unwrap().selector().to_vec();
        let not_admin = own.errors().next().unwrap().selector().to_vec();
        let mut root = frame(&[], CallKind::Call, Some(p), 0);
        root.input = Bytes::from(admin);
        root.error = Some("Reverted".into());
        root.output = Some(Bytes::from(not_admin));
        let accounts = HashMap::from([(p, proxy(p, q))]);
        let abis = HashMap::from([(p, own), (q, imp)]);

        let d = decode_frames(&row(vec![root], &[]), &HashMap::new(), &abis, &accounts);
        assert_eq!(d[0].call.as_ref().map(|c| c.name.as_str()), Some("admin"));
        assert_eq!(
            d[0].revert.as_ref().map(|e| e.name.as_str()),
            Some("NotAdmin")
        );
        assert_eq!(d[0].via_delegate, None);
    }

    #[test]
    fn a_delegatecall_into_a_real_proxy_chain_decodes_with_the_last_hop_abi() {
        // B is a proxy of C, which really is a proxy of D. The guard does
        // not follow C to D first, but D's ABI is still tried after C's own,
        // which lacks the function.
        let (b, c, d) = (
            Address::repeat_byte(0xb0),
            Address::repeat_byte(0xc0),
            Address::repeat_byte(0xd0),
        );
        let c_own = JsonAbi::parse(["function upgradeTo(address implementation)"]).unwrap();
        let d_abi = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let mut input = d_abi.functions().next().unwrap().selector().to_vec();
        input.extend_from_slice(&U256::from(42u8).to_be_bytes::<32>());
        let mut root = frame(&[], CallKind::Call, Some(b), 1);
        root.input = Bytes::from(input.clone());
        let mut inner = frame(&[0], CallKind::DelegateCall, Some(c), 0);
        inner.from = b;
        inner.input = Bytes::from(input);
        let accounts = HashMap::from([(b, proxy(b, c)), (c, proxy(c, d))]);
        let abis = HashMap::from([(c, c_own), (d, d_abi)]);

        let decoded = decode_frames(
            &row(vec![root, inner], &[]),
            &HashMap::new(),
            &abis,
            &accounts,
        );
        assert!(decoded[0].call.is_none(), "B follows one hop, to C");
        let call = decoded[1].call.as_ref().expect("decoded with D's ABI");
        assert_eq!(
            (call.name.as_str(), call.args[0].value.as_str()),
            ("foo", "42")
        );
        assert_eq!(decoded[1].via_delegate, None);
    }

    /// `transfer(0x11…11, 1000)` calldata.
    fn transfer_calldata() -> Bytes {
        let mut input = vec![0xa9, 0x05, 0x9c, 0xbb];
        input.extend_from_slice(Address::repeat_byte(0x11).into_word().as_slice());
        input.extend_from_slice(&U256::from(1000u32).to_be_bytes::<32>());
        Bytes::from(input)
    }

    fn transfer_candidates() -> HashMap<[u8; 4], Vec<String>> {
        HashMap::from([(
            [0xa9, 0x05, 0x9c, 0xbb],
            vec![
                "many_msg_babbage(bytes1)".to_owned(),
                "transfer(address,uint256)".to_owned(),
            ],
        )])
    }

    /// A root into `abi_callee` and three children with transfer calldata:
    /// a call to `bare` (no ABI), a create and a call to `bare` that reverts
    /// with the custom error of its delegate's ABI.
    fn guess_trace() -> (
        CallTraceRow,
        HashMap<Address, FrameDelegate>,
        HashMap<Address, JsonAbi>,
    ) {
        let (abi_callee, bare, delegate) = (
            Address::repeat_byte(0x10),
            Address::repeat_byte(0x20),
            Address::repeat_byte(0xde),
        );
        let with_input = |path: &[u32], kind, to, subtraces| {
            let mut f = frame(path, kind, Some(to), subtraces);
            f.input = transfer_calldata();
            f
        };
        let root = with_input(&[], CallKind::Call, abi_callee, 3);
        let call = with_input(&[0], CallKind::Call, bare, 0);
        let create = with_input(&[1], CallKind::Create, Address::repeat_byte(0x30), 0);
        let mut failed = with_input(&[2], CallKind::Call, bare, 0);
        let del_abi = abi(PONG);
        let mut out = del_abi.errors().next().unwrap().selector().to_vec();
        out.extend_from_slice(&U256::from(7u8).to_be_bytes::<32>());
        failed.error = Some("Reverted".into());
        failed.output = Some(Bytes::from(out));
        let own = JsonAbi::parse(["function transfer(address dst, uint256 wad)"]).unwrap();
        let abis = HashMap::from([(abi_callee, own), (delegate, del_abi)]);
        let r = row(vec![root, call, create, failed], &[]);
        (r, looked_up(bare, delegate), abis)
    }

    #[test]
    fn an_abi_decode_is_never_replaced_by_a_guess() {
        let (r, delegates, abis) = guess_trace();
        let mut d = decode_frames(&r, &delegates, &abis, &HashMap::new());
        apply_frame_guesses(&mut d, &transfer_candidates());
        let call = d[0].call.as_ref().unwrap();
        assert_eq!(call.args[0].name, "dst");
        assert!(!d[0].guessed && d[0].alternatives.is_empty());
    }

    #[test]
    fn an_undecoded_frame_takes_the_guess_and_is_marked_guessed() {
        let (r, delegates, abis) = guess_trace();
        let mut d = decode_frames(&r, &delegates, &abis, &HashMap::new());
        // Only the undecoded calls ask: the root has an ABI, a create's input
        // is init code.
        assert_eq!(frame_guess_selectors(&d), vec![[0xa9, 0x05, 0x9c, 0xbb]]);
        apply_frame_guesses(&mut d, &transfer_candidates());
        for i in [1, 3] {
            let call = d[i].call.as_ref().expect("guessed");
            assert_eq!(call.signature, "transfer(address,uint256)");
            assert_eq!(call.args[0].name, "");
            assert!(d[i].guessed);
            assert!(d[i].alternatives.is_empty());
        }
        assert_eq!(d[1].via_delegate, None);
        // The revert still decodes with the delegate's ABI, and says so.
        assert_eq!(d[3].revert.as_ref().map(|e| e.name.as_str()), Some("Nope"));
        assert_eq!(d[3].via_delegate, delegates.values().next().copied());
        assert!(d[2].call.is_none() && !d[2].guessed);
    }

    #[test]
    fn without_signatures_frames_do_not_change() {
        let (r, delegates, abis) = guess_trace();
        let mut d = decode_frames(&r, &delegates, &abis, &HashMap::new());
        let before = format!("{d:?}");
        apply_frame_guesses(&mut d, &HashMap::new());
        assert_eq!(format!("{d:?}"), before);
    }
}
