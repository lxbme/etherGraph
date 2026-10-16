//! Fund-flow view of one stored transaction, assembled at read time.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use alloy_json_abi::JsonAbi;
use eg_core::rpc_json::parse_receipt;
use eg_core::source::{RawLog, RawReceipt};
use eg_core::types::{Address, Bytes, Transfer, TransferKind, TxHash, U256};
use eg_decode::{DecodedCall, DecodedEvent, decode_call, decode_event};
use eg_store::{AccountRow, Store, StoreError, TxRow};
use serde::{Serialize, Serializer};

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
    pub participants: Vec<Address>,
    pub flows: Vec<Flow>,
    pub events: Vec<DecodedEvent>,
    pub completeness: Completeness,
}

/// The ABI to decode `addr`'s calls and events with: a proxy's implementation
/// ABI when known, else the address's own.
fn abi_for<'a>(
    addr: Address,
    abis: &'a HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
) -> Option<&'a JsonAbi> {
    accounts
        .get(&addr)
        .filter(|a| a.is_proxy)
        .and_then(|a| a.implementation)
        .and_then(|i| abis.get(&i))
        .or_else(|| abis.get(&addr))
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

/// Every address a transaction touches, deduplicated in this order: sender,
/// recipient, created contract (receipt `contractAddress`), the endpoints of
/// `transfers`, then log emitters. `receipt` is the parsed `raw_receipt`.
fn participants<'a>(
    tx: &TxRow,
    receipt: Option<&RawReceipt>,
    transfers: impl IntoIterator<Item = (&'a Address, &'a Address)>,
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
    .filter(|a| seen.insert(*a))
    .collect()
}

pub fn build_tx_flow(
    tx: &TxRow,
    transfers: &[Transfer],
    abis: &HashMap<Address, JsonAbi>,
    accounts: &HashMap<Address, AccountRow>,
) -> TxFlow {
    let call = tx.to.and_then(|to| {
        let abi = abi_for(to, abis, accounts)?;
        decode_call(abi, &input_of(tx)?)
    });

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
    internal.sort_by_key(|t| trace_key(t));

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
    let participants = participants(tx, receipt.as_ref(), flows.iter().map(|f| (&f.from, &f.to)));
    let logs: &[RawLog] = receipt.as_ref().map_or(&[], |r| &r.logs);
    let events = logs
        .iter()
        .map(|l| decode_event(abi_for(l.address, abis, accounts), l))
        .collect();

    TxFlow {
        tx: tx.clone(),
        call,
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
    // A superset of the flow's participants (it includes zero-value transfers),
    // used to load the accounts and ABIs the flow decodes with.
    let receipt = parse_receipt(&tx.raw_receipt).ok();
    let participants = participants(
        &tx,
        receipt.as_ref(),
        transfers.iter().map(|t| (&t.from, &t.to)),
    );
    let accounts: HashMap<Address, AccountRow> = store
        .accounts(&participants)
        .await?
        .into_iter()
        .map(|a| (a.address, a))
        .collect();
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
    Ok(Some(build_tx_flow(&tx, &transfers, &abis, &accounts)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use eg_core::types::AccountKind;
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
}
