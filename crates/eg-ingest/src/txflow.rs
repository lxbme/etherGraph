//! Fund-flow view of one stored transaction, assembled at read time.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use alloy_json_abi::JsonAbi;
use eg_core::rpc_json::parse_receipt;
use eg_core::source::{RawLog, RawReceipt};
use eg_core::types::{AccountKind, Address, Bytes, Transfer, TransferKind, TxHash, U256};
use eg_decode::{DecodedCall, DecodedEvent, decode_call, decode_event};
use eg_store::{AccountRow, Store, StoreError, TxRow};
use serde::{Serialize, Serializer};

use crate::authorization::{
    Authorization, Delegation, MAX_DELEGATIONS, applied_delegations, authorizations, tx_nonce,
};
use crate::trace::FrameDelegate;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    FundFlow,
    FullTrace,
}

fn dec<S: Serializer>(v: &U256, s: S) -> Result<S::Ok, S::Error> {
    s.collect_str(v)
}

fn dec_opt<S: Serializer>(v: &Option<U256>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(v) => s.collect_str(v),
        None => s.serialize_none(),
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Flow {
    pub seq: u32,
    pub from: Address,
    pub to: Address,
    pub asset: Option<Address>,
    #[serde(serialize_with = "dec")]
    pub amount: U256,
    #[serde(serialize_with = "dec_opt")]
    pub token_id: Option<U256>,
    pub kind: TransferKind,
    pub trace_path: Option<String>,
    pub log_index: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct TxFlow {
    pub tx: TxRow,
    pub call: Option<DecodedCall>,
    /// Set when `call` was decoded with the ABI of `to`'s EIP-7702 delegate,
    /// not with `to`'s own: its effective delegate in this transaction, or
    /// else its current one ([`TxFlow::call_via_delegate_current`]).
    pub call_via_delegate: Option<Address>,
    /// `call_via_delegate` is `to`'s current delegate (`to_current_delegate`,
    /// today's delegation), not one from this transaction's authorization
    /// list: the delegation at the transaction may have differed.
    pub call_via_delegate_current: bool,
    /// `to`'s EIP-7702 delegate read from its code (today's) when the tx was
    /// fetched, while the tx's own authorization list leaves `to` alone. Not
    /// part of the transaction, so no participant.
    pub to_current_delegate: Option<Address>,
    /// `to`'s current delegate is to be looked up (one `code` call): the
    /// call has calldata and decodes no other way, the tx's own
    /// authorization list leaves `to` alone, `to` is not a known contract and
    /// no lookup is on record.
    pub delegate_lookup_due: bool,
    /// The EIP-7702 authorization list; empty for other tx types.
    pub authorizations: Vec<Authorization>,
    /// The first [`MAX_DELEGATIONS`] effective delegations (see
    /// [`effective_delegations`]); each signer and delegate is a participant.
    pub delegations: Vec<Delegation>,
    pub participants: Vec<Address>,
    pub flows: Vec<Flow>,
    pub events: Vec<DecodedEvent>,
    pub completeness: Completeness,
}

/// The implementation `addr` delegates to as a proxy, from its account row;
/// `None` when `addr` is itself the recorded implementation of another proxy
/// in `accounts`. Etherscan flags some implementations as proxies too (USDC's
/// FiatTokenV2_2 "implements" SignatureChecker, a library it calls); followed,
/// that second hop would decode calls to the implementation with the
/// library's ABI. Only `accounts` is consulted, so the guard holds when the
/// outer proxy's row is loaded with the implementation's
/// ([`accounts_with_proxies`]).
pub fn implementation_of(
    addr: Address,
    accounts: &HashMap<Address, AccountRow>,
) -> Option<Address> {
    implementation_among(addr, accounts, &implementations(accounts.values()))
}

/// The addresses some proxy among `rows` records as its implementation (a
/// row naming itself excluded): the ones [`implementation_of`] does not
/// follow. Built once per decode, it spares a scan of every row per lookup.
pub fn implementations<'a>(rows: impl IntoIterator<Item = &'a AccountRow>) -> HashSet<Address> {
    rows.into_iter()
        .filter(|a| a.is_proxy)
        .filter_map(|a| a.implementation.filter(|i| *i != a.address))
        .collect()
}

/// [`implementation_of`] with `implemented` precomputed by [`implementations`]
/// over (at least) `accounts`' rows.
pub fn implementation_among(
    addr: Address,
    accounts: &HashMap<Address, AccountRow>,
    implemented: &HashSet<Address>,
) -> Option<Address> {
    let implementation = accounts
        .get(&addr)
        .filter(|a| a.is_proxy)
        .and_then(|a| a.implementation)?;
    (!implemented.contains(&addr)).then_some(implementation)
}

/// The account rows of `addrs`, plus those of the proxies whose recorded
/// implementation is one of them ([`Store::proxies_of`]), keyed by address.
/// Those proxies need not be among `addrs` (a call straight into USDC's
/// implementation), yet [`implementation_of`] needs them to tell a
/// misflagged implementation from a proxy, as node summaries do.
pub(crate) async fn accounts_with_proxies(
    store: &Store,
    addrs: &[Address],
) -> Result<HashMap<Address, AccountRow>, StoreError> {
    let (own, proxies) = tokio::try_join!(store.accounts(addrs), store.proxies_of(addrs))?;
    Ok(proxies
        .into_iter()
        .chain(own)
        .map(|a| (a.address, a))
        .collect())
}

/// The ABIs to decode `addr`'s calls and events with, in the order tried:
/// its implementation's ([`implementation_of`]), then its own, then that of
/// the recorded implementation the guard dropped. That last one keeps a
/// genuine chain decoding (P → Q → R: Q's own proxy ABI fails, R's decodes),
/// while a misflagged implementation's own ABI (USDC's FiatToken) wins.
/// `implemented` is [`implementations`] of `accounts`.
pub(crate) fn abis_for<'a>(
    addr: Address,
    abis: &'a HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
    implemented: &HashSet<Address>,
) -> impl Iterator<Item = &'a JsonAbi> {
    let recorded = accounts
        .get(&addr)
        .filter(|a| a.is_proxy)
        .and_then(|a| a.implementation);
    let followed = implementation_among(addr, accounts, implemented);
    let dropped = recorded.filter(|_| followed.is_none());
    followed
        .and_then(|i| abis.get(&i))
        .into_iter()
        .chain(abis.get(&addr))
        .chain(dropped.and_then(|i| abis.get(&i)))
}

/// `input` decoded with the first of [`abis_for`] `addr` that decodes it.
fn decode_call_for(
    addr: Address,
    input: &[u8],
    abis: &HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
    implemented: &HashSet<Address>,
) -> Option<DecodedCall> {
    abis_for(addr, abis, accounts, implemented).find_map(|abi| decode_call(abi, input))
}

/// The first of [`abis_for`] the log's emitter that declares its event.
fn event_abi<'a>(
    log: &RawLog,
    abis: &'a HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
    implemented: &HashSet<Address>,
) -> Option<&'a JsonAbi> {
    let topic0 = log.topics.first()?;
    abis_for(log.address, abis, accounts, implemented).find(|abi| {
        abi.events()
            .any(|e| !e.anonymous && e.selector() == *topic0)
    })
}

/// Numeric segments of a `trace_id` like `0_10_2`.
fn trace_key(t: &Transfer) -> Option<Vec<u64>> {
    t.trace_id.as_ref().map(|id| {
        id.split('_')
            .map(|p| p.parse().unwrap_or(u64::MAX))
            .collect()
    })
}

fn input_of(tx: &TxRow) -> Option<Bytes> {
    Bytes::from_str(tx.raw_tx.get("input")?.as_str()?).ok()
}

/// The tx's drawn effective delegations (the first [`MAX_DELEGATIONS`], see
/// [`crate::authorization::effective_delegations`]) and what its own list
/// does to its recipient's delegation, looked up among all entries: `None`
/// when the list leaves it alone, `Some(None)` when the list clears it,
/// `Some(Some(delegate))` when the list sets it.
fn delegations_of(
    tx: &TxRow,
    auths: &[Authorization],
) -> (Vec<Delegation>, Option<Option<Address>>) {
    let applied = applied_delegations(auths, tx.from, tx_nonce(&tx.raw_tx));
    let to_own = tx
        .to
        .and_then(|to| applied.iter().find(|(authority, _)| *authority == to))
        .map(|(_, d)| (!d.is_zero()).then_some(*d));
    let drawn = applied
        .into_iter()
        .filter(|(_, delegate)| !delegate.is_zero())
        .map(|(authority, delegate)| Delegation {
            authority,
            delegate,
        })
        .take(MAX_DELEGATIONS)
        .collect();
    (drawn, to_own)
}

/// Every address a transaction touches, deduplicated in this order: sender,
/// recipient, created contract (receipt `contractAddress`), the endpoints of
/// `transfers`, log emitters, then each EIP-7702 delegation's signer and
/// delegate. `receipt` is the parsed `raw_receipt`.
fn participants<'a>(
    tx: &TxRow,
    receipt: Option<&RawReceipt>,
    transfers: impl IntoIterator<Item = (&'a Address, &'a Address)>,
    delegations: &[Delegation],
) -> Vec<Address> {
    let mut seen = HashSet::new();
    [
        Some(tx.from),
        tx.to,
        receipt.and_then(|r| r.contract_address),
    ]
    .into_iter()
    .flatten()
    .chain(transfers.into_iter().flat_map(|(f, t)| [*f, *t]))
    .chain(
        receipt
            .into_iter()
            .flat_map(|r| r.logs.iter().map(|l| l.address)),
    )
    .chain(delegations.iter().flat_map(|d| [d.authority, d.delegate]))
    .filter(|a| seen.insert(*a))
    .collect()
}

/// The top-level call decoded with the first of these that decodes it:
/// `to`'s ABIs ([`abis_for`]), those of `to`'s effective delegate in this tx
/// (`to_own`, see [`delegations_of`]), then those of its current delegate
/// (`current`, given only when the tx's own list leaves `to` alone). The
/// delegate is returned when one decoded it.
fn top_call(
    tx: &TxRow,
    to_own: Option<Option<Address>>,
    current: Option<Address>,
    abis: &HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
    implemented: &HashSet<Address>,
) -> Option<(DecodedCall, Option<FrameDelegate>)> {
    let to = tx.to?;
    let input = input_of(tx)?;
    let delegate = |address, current| FrameDelegate { address, current };
    let tx_delegate = to_own.flatten().map(|d| delegate(d, false));
    let current_delegate = current.map(|d| delegate(d, true));
    std::iter::once((to, None))
        .chain(tx_delegate.map(|d| (d.address, Some(d))))
        .chain(current_delegate.map(|d| (d.address, Some(d))))
        .find_map(|(addr, via)| {
            Some((
                decode_call_for(addr, &input, abis, accounts, implemented)?,
                via,
            ))
        })
}

/// Whether `to`'s current delegate is to be looked up: see
/// [`TxFlow::delegate_lookup_due`]. `looked_up`: a lookup is on record.
fn delegate_lookup_due(
    tx: &TxRow,
    decoded: bool,
    to_own: Option<Option<Address>>,
    looked_up: bool,
    accounts: &HashMap<Address, AccountRow>,
) -> bool {
    let Some(to) = tx.to else {
        return false;
    };
    let contract = accounts
        .get(&to)
        .is_some_and(|a| a.kind == AccountKind::Contract);
    !decoded
        && !looked_up
        && to_own.is_none()
        && !contract
        && input_of(tx).is_some_and(|i| !i.is_empty())
}

pub fn build_tx_flow(
    tx: &TxRow,
    transfers: &[Transfer],
    abis: &HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
) -> TxFlow {
    build(
        tx,
        transfers,
        authorizations(&tx.raw_tx),
        None,
        abis,
        accounts,
    )
}

/// `current`: the recorded lookup of `to`'s current delegate (see
/// [`Store::to_current_delegate`]); `None` when not looked up.
fn build(
    tx: &TxRow,
    transfers: &[Transfer],
    auths: Vec<Authorization>,
    current: Option<Option<Address>>,
    abis: &HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
) -> TxFlow {
    let (delegations, to_own) = delegations_of(tx, &auths);
    let to_current_delegate = current.flatten().filter(|_| to_own.is_none());
    let implemented = implementations(accounts.values());
    let top = top_call(
        tx,
        to_own,
        to_current_delegate,
        abis,
        accounts,
        &implemented,
    );
    let delegate_lookup_due =
        delegate_lookup_due(tx, top.is_some(), to_own, current.is_some(), accounts);
    let (call, via) = top.unzip();
    let via = via.flatten();

    let top = transfers
        .iter()
        .filter(|t| t.kind == TransferKind::Native && !t.amount.is_zero());
    let mut tokens: Vec<&Transfer> = transfers
        .iter()
        .filter(|t| {
            matches!(
                t.kind,
                TransferKind::Erc20 | TransferKind::Erc721 | TransferKind::Erc1155
            )
        })
        .collect();
    tokens.sort_by_key(|t| t.log_index);
    let mut internal: Vec<&Transfer> = transfers
        .iter()
        .filter(|t| t.kind == TransferKind::Internal)
        .collect();
    internal.sort_by_key(|t| (t.call_index.is_none(), t.call_index, trace_key(t)));

    let flows: Vec<Flow> = top
        .chain(tokens)
        .chain(internal)
        .zip(1u32..)
        .map(|(t, seq)| Flow {
            seq,
            from: t.from,
            to: t.to,
            asset: t.asset,
            amount: t.amount,
            token_id: t.token_id,
            kind: t.kind,
            trace_path: t.trace_id.clone(),
            log_index: t.log_index,
        })
        .collect();

    let receipt = parse_receipt(&tx.raw_receipt).ok();
    let participants = participants(
        tx,
        receipt.as_ref(),
        flows.iter().map(|f| (&f.from, &f.to)),
        &delegations,
    );
    let logs: &[RawLog] = receipt.as_ref().map_or(&[], |r| &r.logs);
    let events = logs
        .iter()
        .map(|l| decode_event(event_abi(l, abis, accounts, &implemented), l))
        .collect();

    TxFlow {
        tx: tx.clone(),
        call,
        call_via_delegate: via.map(|v| v.address),
        call_via_delegate_current: via.is_some_and(|v| v.current),
        to_current_delegate,
        delegate_lookup_due,
        authorizations: auths,
        delegations,
        participants,
        flows,
        events,
        completeness: Completeness::FundFlow,
    }
}

pub async fn load_tx_flow(store: &Store, hash: TxHash) -> Result<Option<TxFlow>, StoreError> {
    let Some(tx) = store.transaction(hash).await? else {
        return Ok(None);
    };
    let transfers = store.transfers_of_tx(hash).await?;
    let current = store.to_current_delegate(hash).await?;
    // A superset of the flow's participants (it includes zero-value transfers,
    // `to`'s delegate even past the drawn delegations and its current
    // delegate), used to load the accounts and ABIs the flow decodes with.
    let receipt = parse_receipt(&tx.raw_receipt).ok();
    let auths = authorizations(&tx.raw_tx);
    let (delegations, to_own) = delegations_of(&tx, &auths);
    let mut participants = participants(
        &tx,
        receipt.as_ref(),
        transfers.iter().map(|t| (&t.from, &t.to)),
        &delegations,
    );
    for d in [to_own.flatten(), current.flatten()].into_iter().flatten() {
        if !participants.contains(&d) {
            participants.push(d);
        }
    }
    let accounts = accounts_with_proxies(store, &participants).await?;
    let mut needed = participants;
    needed.extend(accounts.values().filter_map(|a| a.implementation));
    needed.sort();
    needed.dedup();
    let abis: HashMap<Address, JsonAbi> = store
        .abis(&needed)
        .await?
        .into_iter()
        .filter_map(|(a, json)| Some((a, serde_json::from_str(&json?).ok()?)))
        .collect();
    Ok(Some(build(
        &tx, &transfers, auths, current, &abis, &accounts,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorization::tests::{key, signed};
    use crate::authorization::{Delegation, MAX_DELEGATIONS};
    use alloy_primitives::address;
    use chrono::{DateTime, Utc};
    use serde_json::json;

    const H: TxHash = TxHash::repeat_byte(9);
    const A: Address = Address::repeat_byte(0xa);
    const B: Address = Address::repeat_byte(0xb);
    const C: Address = Address::repeat_byte(0xc);
    const TOKEN: Address = Address::repeat_byte(0xd);

    fn ts() -> DateTime<Utc> {
        DateTime::from_timestamp(1_700_000_000, 0).unwrap()
    }

    fn tx(to: Option<Address>, input: &str, receipt: serde_json::Value) -> TxRow {
        TxRow {
            hash: H,
            block_number: 1,
            ts: ts(),
            from: A,
            to,
            value: U256::from(5u8),
            selector: None,
            success: true,
            gas_used: U256::from(21000u32),
            fee: U256::ZERO,
            raw_tx: json!({"input": input}),
            raw_receipt: receipt,
            revert_reason: None,
        }
    }

    fn tr(
        kind: TransferKind,
        from: Address,
        to: Address,
        amount: u64,
        trace: Option<&str>,
        log: Option<u64>,
    ) -> Transfer {
        Transfer {
            tx_hash: H,
            sub_id: String::new(),
            kind,
            block_number: 1,
            ts: ts(),
            from,
            to,
            asset: (kind == TransferKind::Erc20).then_some(TOKEN),
            amount: U256::from(amount),
            token_id: None,
            trace_id: trace.map(String::from),
            log_index: log,
            call_index: None,
        }
    }

    fn build(transfers: &[Transfer]) -> TxFlow {
        build_tx_flow(
            &tx(Some(B), "0x", json!({})),
            transfers,
            &HashMap::new(),
            &HashMap::new(),
        )
    }

    #[test]
    fn flows_order_top_then_logs_then_internal() {
        let f = build(&[
            tr(TransferKind::Internal, B, C, 1, Some("0"), None),
            tr(TransferKind::Erc20, B, C, 7, None, Some(5)),
            tr(TransferKind::Erc20, A, B, 8, None, Some(2)),
            tr(TransferKind::Native, A, B, 5, None, None),
        ]);
        let kinds: Vec<_> = f
            .flows
            .iter()
            .map(|x| (x.seq, x.kind, x.log_index))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (1, TransferKind::Native, None),
                (2, TransferKind::Erc20, Some(2)),
                (3, TransferKind::Erc20, Some(5)),
                (4, TransferKind::Internal, None),
            ]
        );
        assert_eq!(f.participants, vec![A, B, C]);
        assert!(matches!(f.completeness, Completeness::FundFlow));
    }

    #[test]
    fn zero_value_top_level_is_not_a_flow() {
        let f = build(&[tr(TransferKind::Native, A, B, 0, None, None)]);
        assert!(f.flows.is_empty());
    }

    #[test]
    fn zero_value_contract_creation_lists_created_contract() {
        let receipt = json!({
            "status": "0x1", "gasUsed": "0x5208", "contractAddress": format!("{C:#x}"), "logs": []
        });
        let mut t = tx(None, "0x6080", receipt);
        t.value = U256::ZERO;
        let top = tr(TransferKind::Native, A, C, 0, None, None);
        let f = build_tx_flow(&t, &[top], &HashMap::new(), &HashMap::new());
        assert!(f.flows.is_empty());
        assert_eq!(f.participants, vec![A, C]);
        // Without the stored transfer the receipt still names the contract.
        let f = build_tx_flow(&t, &[], &HashMap::new(), &HashMap::new());
        assert_eq!(f.participants, vec![A, C]);
    }

    #[test]
    fn log_only_emitter_is_a_participant() {
        let approval = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
        let receipt = json!({"status": "0x1", "gasUsed": "0x5208", "logs": [{
            "address": format!("{TOKEN:#x}"),
            "topics": [approval, format!("{:#x}", A.into_word()), format!("{:#x}", C.into_word())],
            "data": format!("0x{:064x}", 1), "logIndex": "0x0"
        }]});
        let f = build_tx_flow(
            &tx(Some(B), "0x", receipt),
            &[],
            &HashMap::new(),
            &HashMap::new(),
        );
        assert!(f.flows.is_empty());
        assert_eq!(f.participants, vec![A, B, TOKEN]);
        assert_eq!(f.events.len(), 1);
    }

    #[test]
    fn internal_trace_path_numeric_sort() {
        let f = build(&[
            tr(TransferKind::Internal, B, C, 1, Some("0_10"), None),
            tr(TransferKind::Internal, B, C, 2, Some("0_2"), None),
            tr(TransferKind::Internal, B, C, 3, Some("0_1_5"), None),
        ]);
        let amounts: Vec<u64> = f.flows.iter().map(|x| x.amount.to::<u64>()).collect();
        assert_eq!(amounts, vec![3, 2, 1]);
    }

    #[test]
    fn internal_call_index_beats_trace_id() {
        let mut a = tr(TransferKind::Internal, B, C, 1, Some("0_1"), None);
        a.call_index = Some(2);
        let mut b = tr(TransferKind::Internal, B, C, 2, Some("0_3"), None);
        b.call_index = Some(0);
        let mut c = tr(TransferKind::Internal, B, C, 3, Some("0_2"), None);
        c.call_index = Some(1);
        // No call_index: sorts after the indexed rows, by trace id.
        let d = tr(TransferKind::Internal, B, C, 4, Some("0_0"), None);
        let f = build(&[d, a, b, c]);
        let amounts: Vec<u64> = f.flows.iter().map(|x| x.amount.to::<u64>()).collect();
        assert_eq!(amounts, vec![2, 3, 1, 4]);
    }

    const SENDER: Address = address!("0xe461dd07cbf41b8020a2e9f50255bf85bf1c4905");
    const DELEGATE: Address = address!("0x612373d7003d694220f7800eeaf8e3924c0951d3");

    /// The single authorization of mainnet tx 0x4f85…bb8c: SENDER delegates
    /// to DELEGATE.
    fn real_auth() -> serde_json::Value {
        json!({"chainId": "0x1", "address": format!("{DELEGATE:#x}"), "nonce": "0x2", "yParity": "0x0",
            "r": "0x6d3ecfb34878c8ad3edebf5c137af1156a68e7340093454d4386ccc7465d0571",
            "s": "0x6d80a00a79df8879470ac42c6e89fba6c951d1aaa9601dfce50499993e391300"})
    }

    /// A type-4 self-call from SENDER with `auths` and calldata `foo(42)`.
    fn self_call(auths: Vec<serde_json::Value>) -> (TxRow, JsonAbi) {
        let abi = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let sel = abi.functions().next().unwrap().selector();
        let input = format!("0x{}{:064x}", hex::encode(sel), 42);
        let mut t = tx(Some(SENDER), &input, json!({}));
        t.from = SENDER;
        t.raw_tx = json!({"type": "0x4", "input": input, "authorizationList": auths});
        (t, abi)
    }

    #[test]
    fn effective_delegations_join_participants_signer_before_delegate() {
        let k = key(7);
        let kaddr = Address::from_private_key(&k);
        let other = Address::repeat_byte(0x77);
        let mut t = tx(Some(B), "0x", json!({}));
        t.raw_tx = json!({"type": "0x4", "input": "0x", "authorizationList": [
            real_auth(),
            signed(&k, 1, other, 0),
            // An entry whose signer does not recover is no participant.
            {"chainId": "0x1", "address": format!("{C:#x}"), "nonce": "0x0"},
            // k's last entry clears its delegation: neither k nor `other` joins.
            signed(&k, 1, Address::ZERO, 1),
            real_auth(),
        ]});
        let f = build_tx_flow(&t, &[], &HashMap::new(), &HashMap::new());
        // SENDER is neither from, to nor in a transfer: it joins with its delegate.
        assert_eq!(f.participants, vec![A, B, SENDER, DELEGATE]);
        assert_eq!(
            f.delegations,
            vec![Delegation {
                authority: SENDER,
                delegate: DELEGATE
            }]
        );
        let signers: Vec<_> = f.authorizations.iter().map(|a| a.authority).collect();
        assert_eq!(
            signers,
            vec![Some(SENDER), Some(kaddr), None, Some(kaddr), Some(SENDER)]
        );
        // Other tx types have none.
        let plain = build(&[]);
        assert!(plain.authorizations.is_empty());
        assert!(plain.delegations.is_empty());
        assert_eq!(plain.participants, vec![A, B]);
    }

    #[test]
    fn delegations_and_their_nodes_are_capped() {
        let n = MAX_DELEGATIONS + 4;
        let list: Vec<serde_json::Value> = (0..n)
            .map(|i| {
                signed(
                    &key(i as u8 + 1),
                    1,
                    Address::repeat_byte(0x60 + i as u8),
                    0,
                )
            })
            .collect();
        let mut t = tx(Some(B), "0x", json!({}));
        t.raw_tx = json!({"type": "0x4", "input": "0x", "authorizationList": list});
        let f = build_tx_flow(&t, &[], &HashMap::new(), &HashMap::new());
        assert_eq!(f.authorizations.len(), n);
        assert_eq!(f.delegations.len(), MAX_DELEGATIONS);
        assert_eq!(f.participants.len(), 2 + 2 * MAX_DELEGATIONS);
        assert!(
            !f.participants
                .contains(&Address::repeat_byte(0x60 + MAX_DELEGATIONS as u8))
        );
    }

    #[test]
    fn call_to_a_delegating_address_uses_the_delegate_abi() {
        let (t, abi) = self_call(vec![real_auth()]);
        // Review focus 5: before the delegate's ABI is known the call stays undecoded.
        let f = build_tx_flow(&t, &[], &HashMap::new(), &HashMap::new());
        assert!(f.call.is_none());
        assert_eq!(f.call_via_delegate, None);
        let abis = HashMap::from([(DELEGATE, abi.clone())]);
        let f = build_tx_flow(&t, &[], &abis, &HashMap::new());
        let call = f.call.unwrap();
        assert_eq!(call.name, "foo");
        assert_eq!(call.args[0].value, "42");
        assert_eq!(f.call_via_delegate, Some(DELEGATE));
        // `to`'s own ABI wins when it decodes.
        let abis = HashMap::from([(DELEGATE, abi.clone()), (SENDER, abi)]);
        let f = build_tx_flow(&t, &[], &abis, &HashMap::new());
        assert_eq!(f.call.unwrap().name, "foo");
        assert_eq!(f.call_via_delegate, None);
    }

    #[test]
    fn sponsored_call_uses_the_delegate_abi_of_to() {
        // Someone else sends the tx; `to` (SENDER) is the authority.
        let (mut t, abi) = self_call(vec![real_auth()]);
        t.from = A;
        let abis = HashMap::from([(DELEGATE, abi)]);
        let f = build_tx_flow(&t, &[], &abis, &HashMap::new());
        assert_eq!(f.call.unwrap().name, "foo");
        assert_eq!(f.call_via_delegate, Some(DELEGATE));
    }

    #[test]
    fn delegate_abi_needs_an_authorization_signed_by_to() {
        // Signed by another key: `to` did not delegate.
        let (t, abi) = self_call(vec![signed(&key(9), 1, DELEGATE, 0)]);
        let abis = HashMap::from([(DELEGATE, abi.clone())]);
        let f = build_tx_flow(&t, &[], &abis, &HashMap::new());
        assert!(f.call.is_none());
        assert_eq!(f.call_via_delegate, None);
        // A to that is not the authority.
        let (mut t, _) = self_call(vec![real_auth()]);
        t.to = Some(B);
        assert!(
            build_tx_flow(&t, &[], &abis, &HashMap::new())
                .call
                .is_none()
        );
    }

    #[test]
    fn the_last_authorization_by_to_decides_the_delegate() {
        let k = key(5);
        let me = Address::from_private_key(&k);
        let abi = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let abis = HashMap::from([(DELEGATE, abi)]);
        let flow = |auths: Vec<serde_json::Value>| {
            let (mut t, _) = self_call(auths);
            t.from = me;
            t.to = Some(me);
            build_tx_flow(&t, &[], &abis, &HashMap::new())
        };
        // Delegating, then clearing: the call runs no code, nothing to decode.
        let f = flow(vec![
            signed(&k, 1, DELEGATE, 0),
            signed(&k, 1, Address::ZERO, 1),
        ]);
        assert!(f.call.is_none());
        let f = flow(vec![
            signed(&k, 1, Address::ZERO, 0),
            signed(&k, 1, DELEGATE, 1),
        ]);
        assert_eq!(f.call_via_delegate, Some(DELEGATE));
    }

    #[test]
    fn the_sender_delegate_follows_the_nonce_chain() {
        let k = key(5);
        let me = Address::from_private_key(&k);
        let abi = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let (x, y) = (DELEGATE, Address::repeat_byte(0x79));
        let flow = |abi_of: Address| {
            let (mut t, _) = self_call(vec![signed(&k, 1, x, 2), signed(&k, 1, y, 2)]);
            t.from = me;
            t.to = Some(me);
            t.raw_tx["nonce"] = json!("0x1");
            build_tx_flow(
                &t,
                &[],
                &HashMap::from([(abi_of, abi.clone())]),
                &HashMap::new(),
            )
        };
        // Nonce 2 is spent by the first entry: X takes effect, not Y.
        let f = flow(x);
        assert_eq!(f.call_via_delegate, Some(x));
        assert_eq!(
            f.delegations,
            vec![Delegation {
                authority: me,
                delegate: x
            }]
        );
        assert_eq!(f.participants, vec![me, x]);
        assert!(flow(y).call.is_none());
    }

    #[test]
    fn the_delegate_of_to_decodes_even_past_the_drawn_delegations() {
        let mut list: Vec<serde_json::Value> = (0..MAX_DELEGATIONS)
            .map(|i| signed(&key(i as u8 + 1), 1, Address::repeat_byte(0x60), 0))
            .collect();
        list.push(real_auth());
        let (mut t, abi) = self_call(list);
        t.from = A;
        let abis = HashMap::from([(DELEGATE, abi)]);
        let f = build_tx_flow(&t, &[], &abis, &HashMap::new());
        assert_eq!(f.delegations.len(), MAX_DELEGATIONS);
        assert!(!f.participants.contains(&DELEGATE));
        assert_eq!(f.call.unwrap().name, "foo");
        assert_eq!(f.call_via_delegate, Some(DELEGATE));
    }

    /// An account that delegated before the transaction (an earlier type-4
    /// tx), and its delegate today.
    const ACCOUNT: Address = Address::repeat_byte(0x7a);
    const CURRENT: Address = Address::repeat_byte(0x7c);

    /// A type-2 self-call from ACCOUNT with calldata `foo(42)`: no
    /// authorization list.
    fn delegated_call() -> (TxRow, JsonAbi) {
        let (mut t, abi) = self_call(vec![]);
        t.from = ACCOUNT;
        t.to = Some(ACCOUNT);
        t.raw_tx = json!({"type": "0x2", "input": t.raw_tx["input"]});
        (t, abi)
    }

    /// The flow of `t` with `current` the recorded lookup of `to`'s current
    /// delegate (`None`: not looked up).
    fn with_current(
        t: &TxRow,
        current: Option<Option<Address>>,
        abis: &HashMap<Address, JsonAbi>,
        accounts: &HashMap<Address, AccountRow>,
    ) -> TxFlow {
        super::build(t, &[], authorizations(&t.raw_tx), current, abis, accounts)
    }

    #[test]
    fn a_call_to_an_account_delegated_before_this_tx_decodes_with_its_current_delegate() {
        let (t, abi) = delegated_call();
        let abis = HashMap::from([(CURRENT, abi)]);
        let none = HashMap::new();
        // Not looked up yet: undecoded, and the lookup is due.
        let f = with_current(&t, None, &abis, &none);
        assert!(f.call.is_none());
        assert!(f.delegate_lookup_due);
        // Looked up, none found: nothing more to look up.
        let f = with_current(&t, Some(None), &abis, &none);
        assert!(f.call.is_none());
        assert!(!f.delegate_lookup_due);

        let f = with_current(&t, Some(Some(CURRENT)), &abis, &none);
        let call = f.call.unwrap();
        assert_eq!(call.name, "foo");
        assert_eq!(call.args[0].value, "42");
        assert_eq!(f.call_via_delegate, Some(CURRENT));
        assert!(f.call_via_delegate_current);
        assert!(!f.delegate_lookup_due);
        assert_eq!(f.to_current_delegate, Some(CURRENT));
        // Not part of the transaction: no node of its flow.
        assert_eq!(f.participants, vec![ACCOUNT]);
    }

    #[test]
    fn the_current_delegate_is_looked_up_only_for_an_undecoded_call_to_an_account() {
        let (t, _) = delegated_call();
        let (none, no_rows) = (HashMap::new(), HashMap::new());
        // No calldata: no call to decode.
        let mut plain = t.clone();
        plain.raw_tx["input"] = json!("0x");
        assert!(!with_current(&plain, None, &none, &no_rows).delegate_lookup_due);
        // A known contract has no delegation.
        let contract = AccountRow {
            is_proxy: false,
            implementation: None,
            ..proxy_row(ACCOUNT, ACCOUNT)
        };
        let accounts = HashMap::from([(ACCOUNT, contract)]);
        assert!(!with_current(&t, None, &none, &accounts).delegate_lookup_due);
        // A contract creation has no recipient.
        let mut create = t.clone();
        create.to = None;
        assert!(!with_current(&create, None, &none, &no_rows).delegate_lookup_due);
    }

    #[test]
    fn the_txs_own_authorization_wins_over_the_current_delegate() {
        let k = key(5);
        let me = Address::from_private_key(&k);
        let own = Address::repeat_byte(0x7b);
        let abi = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let both = HashMap::from([(own, abi.clone()), (CURRENT, abi.clone())]);
        let current_only = HashMap::from([(CURRENT, abi)]);
        let flow = |auths: Vec<serde_json::Value>, abis: &HashMap<Address, JsonAbi>| {
            let (mut t, _) = self_call(auths);
            t.from = me;
            t.to = Some(me);
            with_current(&t, Some(Some(CURRENT)), abis, &HashMap::new())
        };
        let f = flow(vec![signed(&k, 1, own, 0)], &both);
        assert_eq!(f.call.unwrap().name, "foo");
        assert_eq!(f.call_via_delegate, Some(own));
        assert!(!f.call_via_delegate_current);
        // The tx decides `to`'s delegate even before that delegate's ABI is
        // known: today's delegation is not used.
        let f = flow(vec![signed(&k, 1, own, 0)], &current_only);
        assert!(f.call.is_none());
        assert_eq!(f.call_via_delegate, None);
        // A list clearing `to`'s delegation runs no code: nothing to decode.
        let f = flow(vec![signed(&k, 1, Address::ZERO, 0)], &current_only);
        assert!(f.call.is_none());
        assert!(!f.delegate_lookup_due);
        // Nor is a lookup due when the tx decides the delegate.
        let (mut t, _) = self_call(vec![signed(&k, 1, own, 0)]);
        t.from = me;
        t.to = Some(me);
        assert!(!with_current(&t, None, &current_only, &HashMap::new()).delegate_lookup_due);
    }

    #[test]
    fn tos_own_abi_wins_over_any_delegate() {
        let (t, abi) = delegated_call();
        let abis = HashMap::from([(ACCOUNT, abi.clone()), (CURRENT, abi)]);
        let f = with_current(&t, Some(Some(CURRENT)), &abis, &HashMap::new());
        assert_eq!(f.call.unwrap().name, "foo");
        assert_eq!(f.call_via_delegate, None);
        assert!(!f.call_via_delegate_current);
        // A call that decodes needs no lookup.
        assert!(!with_current(&t, None, &abis, &HashMap::new()).delegate_lookup_due);
    }

    #[test]
    fn proxy_uses_implementation_abi() {
        let abi = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let sel = abi.functions().next().unwrap().selector();
        let input = format!("0x{}{:064x}", hex::encode(sel), 42);
        let proxy = AccountRow {
            address: B,
            kind: AccountKind::Contract,
            contract_name: None,
            is_proxy: true,
            implementation: Some(C),
            creator: None,
            creation_tx: None,
            meta_fetched_at: ts(),
        };
        let accounts = HashMap::from([(B, proxy)]);
        let abis = HashMap::from([(C, abi)]);
        let t = tx(Some(B), &input, json!({}));
        let call = build_tx_flow(&t, &[], &abis, &accounts).call.unwrap();
        assert_eq!(call.name, "foo");
        assert_eq!(call.args[0].value, "42");
        // Without the account row the implementation ABI is not consulted.
        assert!(
            build_tx_flow(&t, &[], &abis, &HashMap::new())
                .call
                .is_none()
        );
    }

    fn proxy_row(address: Address, implementation: Address) -> AccountRow {
        AccountRow {
            address,
            kind: AccountKind::Contract,
            contract_name: None,
            is_proxy: true,
            implementation: Some(implementation),
            creator: None,
            creation_tx: None,
            meta_fetched_at: ts(),
        }
    }

    #[test]
    fn implementation_abi_failing_falls_back_to_own_abi() {
        // The proxy's own `admin()` and `Upgraded` are not in its
        // implementation's ABI.
        let own = JsonAbi::parse([
            "function admin() returns (address)",
            "event Upgraded(address implementation)",
        ])
        .unwrap();
        let imp = JsonAbi::parse(["function foo(uint256 x)", "event Foo(uint256 x)"]).unwrap();
        let input = format!(
            "0x{}",
            hex::encode(own.functions().next().unwrap().selector())
        );
        let upgraded = own.events().next().unwrap().selector();
        let receipt = json!({"status": "0x1", "gasUsed": "0x5208", "logs": [{
            "address": format!("{B:#x}"),
            "topics": [format!("{upgraded:#x}")],
            "data": format!("{:#x}", C.into_word()), "logIndex": "0x0"
        }]});
        let accounts = HashMap::from([(B, proxy_row(B, C))]);
        let abis = HashMap::from([(B, own), (C, imp)]);
        let f = build_tx_flow(&tx(Some(B), &input, receipt), &[], &abis, &accounts);
        assert_eq!(f.call.unwrap().name, "admin");
        assert_eq!(f.call_via_delegate, None);
        assert_eq!(f.events[0].name.as_deref(), Some("Upgraded"));
        assert_eq!(f.events[0].args[0].value, format!("{C:#x}"));
    }

    #[test]
    fn a_real_proxy_chain_still_uses_the_implementation_abi() {
        // B is a proxy of C, itself a proxy of D. B is no one's
        // implementation, so its own row is followed to C; C, B's recorded
        // implementation, is not followed to D.
        const D: Address = Address::repeat_byte(0xe);
        let accounts = HashMap::from([(B, proxy_row(B, C)), (C, proxy_row(C, D))]);
        assert_eq!(implementation_of(B, &accounts), Some(C));
        assert_eq!(implementation_of(C, &accounts), None);
        // A self-referencing row (Etherscan flags some contracts as their
        // own proxy) is not a chain.
        let own = HashMap::from([(A, proxy_row(A, A))]);
        assert_eq!(implementation_of(A, &own), Some(A));
        assert_eq!(implementation_of(D, &accounts), None);
        // The precomputed set: C and D, not A (it names itself).
        let implemented = implementations(accounts.values().chain(own.values()));
        assert_eq!(implemented, HashSet::from([C, D]));
        assert_eq!(implementation_among(B, &accounts, &implemented), Some(C));
        assert_eq!(implementation_among(C, &accounts, &implemented), None);
        assert_eq!(implementation_among(A, &own, &implemented), Some(A));

        // C's ABI wins over B's own, which decodes the same call under other
        // argument names.
        let b_abi = JsonAbi::parse(["function foo(uint256 own)"]).unwrap();
        let c_abi = JsonAbi::parse(["function foo(uint256 x)"]).unwrap();
        let sel = c_abi.functions().next().unwrap().selector();
        let input = format!("0x{}{:064x}", hex::encode(sel), 42);
        let abis = HashMap::from([(B, b_abi), (C, c_abi)]);
        let t = tx(Some(B), &input, json!({}));
        let call = build_tx_flow(&t, &[], &abis, &accounts).call.unwrap();
        assert_eq!(call.name, "foo");
        assert_eq!(call.args[0].name, "x");
    }
}
