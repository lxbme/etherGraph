//! Transaction detail parsed from the stored raw tx/receipt JSON (Etherscan
//! proxy format: `0x` hex quantities) plus the block header.

use std::str::FromStr;

use alloy_primitives::{Address, U256};
use eg_ingest::{Authorization, Delegation};
use eg_store::{BlockRow, TxRow};
use serde_json::Value;

use crate::dto::{AuthorizationDto, DelegationDto, TxDetailDto, hex_addr};

/// A `0x` hex quantity field; `None` when absent, null or malformed.
fn quantity(json: &Value, key: &str) -> Option<U256> {
    let s = json.get(key)?.as_str()?;
    U256::from_str_radix(s.strip_prefix("0x").unwrap_or(s), 16).ok()
}

fn small<T: TryFrom<U256>>(json: &Value, key: &str) -> Option<T> {
    quantity(json, key).and_then(|v| T::try_from(v).ok())
}

/// `authorizations` is the tx's parsed EIP-7702 list (`TxFlow::authorizations`)
/// and `delegations` its drawn effective delegations (`TxFlow::delegations`).
pub fn tx_detail(
    row: &TxRow,
    block: Option<&BlockRow>,
    head: Option<u64>,
    authorizations: &[Authorization],
    delegations: &[Delegation],
) -> TxDetailDto {
    let (tx, receipt) = (&row.raw_tx, &row.raw_receipt);
    let dec = |v: Option<U256>| v.map(|v| v.to_string());

    let max_fee = quantity(tx, "maxFeePerGas");
    let effective_gas_price = quantity(receipt, "effectiveGasPrice");
    let base_fee = block.and_then(|b| b.base_fee);
    let burnt_fee = base_fee.map(|b| b.saturating_mul(row.gas_used));
    // Ruling R3: every type with a fee cap (2, 3, 4), not only type 2.
    let blob_gas_used = quantity(receipt, "blobGasUsed");
    let blob_gas_price = quantity(receipt, "blobGasPrice");
    let blob_fee = blob_gas_used
        .zip(blob_gas_price)
        .map(|(used, price)| used.saturating_mul(price));
    let savings = max_fee
        .zip(effective_gas_price)
        .map(|(max, eff)| max.saturating_sub(eff).saturating_mul(row.gas_used));

    TxDetailDto {
        nonce: small(tx, "nonce").unwrap_or(0),
        tx_type: small(tx, "type").unwrap_or(0),
        position: small(tx, "transactionIndex"),
        confirmations: head
            .filter(|&h| h >= row.block_number)
            .map(|h| h - row.block_number + 1),
        gas_limit: quantity(tx, "gas").unwrap_or_default().to_string(),
        gas_used: row.gas_used.to_string(),
        gas_price: dec(quantity(tx, "gasPrice")),
        effective_gas_price: dec(effective_gas_price),
        max_fee: dec(max_fee),
        max_priority_fee: dec(quantity(tx, "maxPriorityFeePerGas")),
        base_fee: dec(base_fee),
        burnt_fee: dec(burnt_fee),
        savings: dec(savings),
        blob_gas_used: dec(blob_gas_used),
        blob_gas_price: dec(blob_gas_price),
        blob_fee: dec(blob_fee),
        access_list_len: tx
            .get("accessList")
            .and_then(Value::as_array)
            .map(|a| u32::try_from(a.len()).unwrap_or(u32::MAX)),
        contract_created: receipt
            .get("contractAddress")
            .and_then(Value::as_str)
            .and_then(|s| Address::from_str(s).ok())
            .map(hex_addr),
        revert_reason: row.revert_reason.clone(),
        input: tx
            .get("input")
            .and_then(Value::as_str)
            .unwrap_or("0x")
            .to_ascii_lowercase(),
        authorizations: authorizations.iter().map(AuthorizationDto::from).collect(),
        delegations: delegations.iter().map(DelegationDto::from).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::DelegationDto;
    use alloy_primitives::{Address, U256};
    use chrono::{TimeZone, Utc};
    use eg_ingest::Delegation;
    use serde_json::Value;

    fn quantity(v: &Value) -> U256 {
        U256::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    }

    /// A stored row built from a fixture `{ "tx": …, "receipt": … }`.
    fn row(fixture: &str) -> TxRow {
        let v: Value = serde_json::from_str(fixture).unwrap();
        let (tx, receipt) = (v["tx"].clone(), v["receipt"].clone());
        TxRow {
            hash: tx["hash"].as_str().unwrap().parse().unwrap(),
            block_number: quantity(&tx["blockNumber"]).to(),
            ts: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            from: tx["from"].as_str().unwrap().parse().unwrap(),
            to: tx["to"].as_str().map(|s| s.parse().unwrap()),
            value: quantity(&tx["value"]),
            selector: None,
            success: receipt["status"] == "0x1",
            gas_used: quantity(&receipt["gasUsed"]),
            fee: U256::ZERO,
            raw_tx: tx,
            raw_receipt: receipt,
            revert_reason: None,
        }
    }

    fn block(number: u64, base_fee: Option<u64>) -> BlockRow {
        BlockRow {
            number,
            ts: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            base_fee: base_fee.map(U256::from),
            gas_limit: U256::from(30_000_000u64),
            gas_used: U256::from(15_000_000u64),
            fee_recipient: Address::repeat_byte(0xfe),
        }
    }

    const LEGACY: &str = include_str!("../tests/data/tx_legacy.json");
    const EIP1559: &str = include_str!("../tests/data/tx_eip1559.json");
    const EIP4844: &str = include_str!("../tests/data/tx_eip4844.json");
    const CREATE: &str = include_str!("../tests/data/tx_create.json");
    const FAILED: &str = include_str!("../tests/data/tx_failed.json");

    #[test]
    fn legacy_pre_london() {
        let r = row(LEGACY);
        let d = tx_detail(&r, Some(&block(12_000_000, None)), None, &[], &[]);
        assert_eq!(d.tx_type, 0);
        assert_eq!(d.nonce, 31);
        assert_eq!(d.position, Some(60));
        assert_eq!(d.gas_limit, "21000");
        assert_eq!(d.gas_used, "21000");
        assert_eq!(d.gas_price.as_deref(), Some("80000000000"));
        assert_eq!(d.effective_gas_price.as_deref(), Some("80000000000"));
        assert_eq!(d.max_fee, None);
        assert_eq!(d.max_priority_fee, None);
        assert_eq!(d.base_fee, None);
        assert_eq!(d.burnt_fee, None);
        assert_eq!(d.savings, None);
        assert_eq!(d.access_list_len, None);
        assert_eq!(d.blob_gas_used, None);
        assert_eq!(d.blob_gas_price, None);
        assert_eq!(d.blob_fee, None);
        assert_eq!(d.contract_created, None);
        assert_eq!(d.revert_reason, None);
        assert_eq!(d.input, "0x");
    }

    #[test]
    fn legacy_without_type_field_is_type_0() {
        let mut r = row(LEGACY);
        r.raw_tx.as_object_mut().unwrap().remove("type");
        assert_eq!(tx_detail(&r, None, None, &[], &[]).tx_type, 0);
    }

    #[test]
    fn eip1559_fees() {
        let r = row(EIP1559);
        // base fee 17.23456789 gwei, tip 1.5 gwei, max fee 35 gwei, 127455 gas used:
        // effective price = 17234567890 + 1500000000 = 18734567890.
        let d = tx_detail(
            &r,
            Some(&block(19_000_000, Some(17_234_567_890))),
            None,
            &[],
            &[],
        );
        assert_eq!(d.tx_type, 2);
        assert_eq!(d.nonce, 1042);
        assert_eq!(d.position, Some(87));
        assert_eq!(d.gas_limit, "180000");
        assert_eq!(d.gas_used, "127455");
        assert_eq!(d.max_fee.as_deref(), Some("35000000000"));
        assert_eq!(d.max_priority_fee.as_deref(), Some("1500000000"));
        assert_eq!(d.effective_gas_price.as_deref(), Some("18734567890"));
        assert_eq!(d.base_fee.as_deref(), Some("17234567890"));
        // 17234567890 × 127455
        assert_eq!(d.burnt_fee.as_deref(), Some("2196631850419950"));
        // (35000000000 − 18734567890) × 127455 = 16265432110 × 127455
        assert_eq!(d.savings.as_deref(), Some("2073110649580050"));
        assert_eq!(d.access_list_len, Some(2));
        assert!(d.input.starts_with("0xa9059cbb"));
    }

    #[test]
    fn eip1559_without_block_header_has_no_base_fee() {
        let d = tx_detail(&row(EIP1559), None, None, &[], &[]);
        assert_eq!(d.base_fee, None);
        assert_eq!(d.burnt_fee, None);
        // Savings need no header.
        assert_eq!(d.savings.as_deref(), Some("2073110649580050"));
    }

    #[test]
    fn eip4844_blob_gas() {
        let r = row(EIP4844);
        let d = tx_detail(
            &r,
            Some(&block(20_000_000, Some(9_876_543_210))),
            None,
            &[],
            &[],
        );
        assert_eq!(d.tx_type, 3);
        assert_eq!(d.blob_gas_used.as_deref(), Some("262144"));
        assert_eq!(d.blob_gas_price.as_deref(), Some("1"));
        // blob_gas_used × blob_gas_price
        assert_eq!(d.blob_fee.as_deref(), Some("262144"));
        // 9876543210 × 63204
        assert_eq!(d.burnt_fee.as_deref(), Some("624237037044840"));
        // Ruling R3: savings for every type with a max fee.
        // (20000000000 − 10876543210) × 63204 = 9123456790 × 63204
        assert_eq!(d.savings.as_deref(), Some("576638962955160"));
        assert_eq!(d.access_list_len, Some(0));
    }

    #[test]
    fn blob_fee_saturates() {
        let mut r = row(EIP4844);
        let receipt = r.raw_receipt.as_object_mut().unwrap();
        receipt.insert(
            "blobGasUsed".into(),
            Value::from(format!("{:#x}", U256::MAX)),
        );
        receipt.insert("blobGasPrice".into(), Value::from("0x2"));
        let d = tx_detail(&r, None, None, &[], &[]);
        assert_eq!(d.blob_fee, Some(U256::MAX.to_string()));
    }

    #[test]
    fn contract_creation() {
        let d = tx_detail(&row(CREATE), None, None, &[], &[]);
        assert_eq!(
            d.contract_created.as_deref(),
            Some("0xe4750761f9d21ce635e3078a68306afbdc0c3310")
        );
        assert_eq!(d.nonce, 0);
        assert!(d.input.starts_with("0x6080604052"));
    }

    #[test]
    fn failed_tx_passes_revert_reason_through() {
        let mut r = row(FAILED);
        assert!(!r.success);
        r.revert_reason = Some("Ownable: caller is not the owner".into());
        let d = tx_detail(&r, None, None, &[], &[]);
        assert_eq!(
            d.revert_reason.as_deref(),
            Some("Ownable: caller is not the owner")
        );
        assert_eq!(d.gas_used, "34871");
    }

    #[test]
    fn set_code_authorizations_are_listed_in_order() {
        let mut r = row(EIP1559);
        r.raw_tx["type"] = Value::from("0x4");
        let auths = [
            Authorization {
                chain_id: U256::from(1),
                delegate: Address::repeat_byte(0xde),
                nonce: U256::from(2),
                authority: Some(Address::repeat_byte(0xa1)),
            },
            Authorization {
                chain_id: U256::ZERO,
                delegate: Address::ZERO,
                nonce: U256::from(u64::MAX),
                authority: None,
            },
        ];
        let delegations = [Delegation {
            authority: Address::repeat_byte(0xa1),
            delegate: Address::repeat_byte(0xde),
        }];
        let d = tx_detail(&r, None, None, &auths, &delegations);
        assert_eq!(d.tx_type, 4);
        assert_eq!(
            d.delegations,
            vec![DelegationDto {
                authority: format!("{:#x}", Address::repeat_byte(0xa1)),
                delegate: format!("{:#x}", Address::repeat_byte(0xde)),
            }]
        );
        assert_eq!(
            d.authorizations,
            vec![
                AuthorizationDto {
                    chain_id: "1".into(),
                    delegate: format!("{:#x}", Address::repeat_byte(0xde)),
                    nonce: "2".into(),
                    authority: Some(format!("{:#x}", Address::repeat_byte(0xa1))),
                },
                AuthorizationDto {
                    chain_id: "0".into(),
                    delegate: format!("{:#x}", Address::ZERO),
                    nonce: u64::MAX.to_string(),
                    authority: None,
                },
            ]
        );
        assert!(
            tx_detail(&row(LEGACY), None, None, &[], &[])
                .authorizations
                .is_empty()
        );
    }

    #[test]
    fn confirmations_count_the_inclusion_block() {
        let r = row(EIP1559);
        let n = r.block_number;
        assert_eq!(
            tx_detail(&r, None, Some(n + 9), &[], &[]).confirmations,
            Some(10)
        );
        assert_eq!(
            tx_detail(&r, None, Some(n), &[], &[]).confirmations,
            Some(1)
        );
        assert_eq!(
            tx_detail(&r, None, Some(n - 1), &[], &[]).confirmations,
            None
        );
        assert_eq!(tx_detail(&r, None, None, &[], &[]).confirmations, None);
    }
}
