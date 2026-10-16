use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolEvent;
use chrono::{DateTime, Utc};
use eg_core::source::RawLog;
use eg_core::types::{Transfer, TransferKind, TxHash, assign_sub_ids};

pub(crate) mod ev {
    use alloy_sol_types::sol;

    sol! {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    }
}
pub(crate) use ev::{Approval, Transfer as TransferEv, TransferBatch, TransferSingle};

pub(crate) fn topic_address(t: &B256) -> Address {
    Address::from_word(*t)
}

/// Decodes ERC20/721/1155 transfer events into core transfers, ordered by log
/// index (batch entries keep array order), with content-based sub ids assigned.
pub fn decode_transfer_logs(
    logs: &[RawLog],
    tx_hash: TxHash,
    block: u64,
    ts: DateTime<Utc>,
) -> Vec<Transfer> {
    let mut sorted: Vec<&RawLog> = logs.iter().collect();
    sorted.sort_by_key(|l| l.log_index);

    let mut out = Vec::new();
    for log in sorted {
        let Some(topic0) = log.topics.first() else {
            continue;
        };
        let mk = |kind, from, to, amount, token_id| Transfer {
            tx_hash,
            sub_id: String::new(),
            kind,
            block_number: block,
            ts,
            from,
            to,
            asset: Some(log.address),
            amount,
            token_id,
            trace_id: None,
            log_index: Some(log.log_index),
        };
        if *topic0 == TransferEv::SIGNATURE_HASH {
            match log.topics.len() {
                3 if log.data.len() == 32 => out.push(mk(
                    TransferKind::Erc20,
                    topic_address(&log.topics[1]),
                    topic_address(&log.topics[2]),
                    U256::from_be_slice(&log.data),
                    None,
                )),
                4 => out.push(mk(
                    TransferKind::Erc721,
                    topic_address(&log.topics[1]),
                    topic_address(&log.topics[2]),
                    U256::from(1u8),
                    Some(U256::from_be_bytes(log.topics[3].0)),
                )),
                _ => {}
            }
        } else if *topic0 == TransferSingle::SIGNATURE_HASH {
            if let Ok(ev) = TransferSingle::decode_raw_log(log.topics.iter().copied(), &log.data) {
                out.push(mk(
                    TransferKind::Erc1155,
                    ev.from,
                    ev.to,
                    ev.value,
                    Some(ev.id),
                ));
            }
        } else if *topic0 == TransferBatch::SIGNATURE_HASH
            && let Ok(ev) = TransferBatch::decode_raw_log(log.topics.iter().copied(), &log.data)
            && ev.ids.len() == ev.values.len()
        {
            for (id, value) in ev.ids.iter().zip(ev.values.iter()) {
                out.push(mk(TransferKind::Erc1155, ev.from, ev.to, *value, Some(*id)));
            }
        }
    }
    assign_sub_ids(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::Bytes;
    use alloy_sol_types::SolValue;

    fn ts() -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(0, 0).unwrap()
    }
    fn word(a: Address) -> B256 {
        a.into_word()
    }

    #[test]
    fn erc20_transfer_log() {
        let (a, b, token) = (
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            Address::repeat_byte(9),
        );
        let log = RawLog {
            address: token,
            topics: vec![TransferEv::SIGNATURE_HASH, word(a), word(b)],
            data: Bytes::from(U256::MAX.to_be_bytes::<32>().to_vec()),
            log_index: 3,
        };
        let v = decode_transfer_logs(&[log], B256::repeat_byte(7), 5, ts());
        assert_eq!(v.len(), 1);
        let t = &v[0];
        assert_eq!(t.kind, TransferKind::Erc20);
        assert_eq!((t.from, t.to, t.asset), (a, b, Some(token)));
        assert_eq!(t.amount, U256::MAX);
        assert_eq!(t.token_id, None);
        assert_eq!(t.log_index, Some(3));
        assert_eq!(t.trace_id, None);
        assert_eq!(t.block_number, 5);
        assert!(t.sub_id.starts_with("erc20:"));
    }

    #[test]
    fn erc721_transfer_log() {
        let (a, b, token) = (
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            Address::repeat_byte(9),
        );
        let log = RawLog {
            address: token,
            topics: vec![
                TransferEv::SIGNATURE_HASH,
                word(a),
                word(b),
                B256::from(U256::from(42u8)),
            ],
            data: Bytes::new(),
            log_index: 0,
        };
        let v = decode_transfer_logs(&[log], B256::ZERO, 1, ts());
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].kind, TransferKind::Erc721);
        assert_eq!(v[0].amount, U256::from(1u8));
        assert_eq!(v[0].token_id, Some(U256::from(42u8)));
    }

    #[test]
    fn erc1155_batch_expands() {
        let (op, a, b, token) = (
            Address::repeat_byte(4),
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            Address::repeat_byte(9),
        );
        let ids = vec![U256::from(1u8), U256::from(2u8)];
        let values = vec![U256::from(10u8), U256::from(20u8)];
        let data = (ids.clone(), values.clone()).abi_encode_params();
        let log = RawLog {
            address: token,
            topics: vec![TransferBatch::SIGNATURE_HASH, word(op), word(a), word(b)],
            data: Bytes::from(data.clone()),
            log_index: 1,
        };
        let v = decode_transfer_logs(std::slice::from_ref(&log), B256::ZERO, 1, ts());
        assert_eq!(v.len(), 2);
        assert!(v.iter().all(|t| t.kind == TransferKind::Erc1155));
        assert_eq!(v[0].token_id, Some(U256::from(1u8)));
        assert_eq!(v[0].amount, U256::from(10u8));
        assert_eq!(v[1].token_id, Some(U256::from(2u8)));
        assert_eq!(v[1].amount, U256::from(20u8));

        // mismatched lengths are ignored
        let bad = (ids, vec![U256::from(10u8)]).abi_encode_params();
        let log2 = RawLog {
            data: Bytes::from(bad),
            ..log
        };
        assert!(decode_transfer_logs(&[log2], B256::ZERO, 1, ts()).is_empty());
    }

    #[test]
    fn erc1155_single_and_ordering() {
        let (op, a, b, token) = (
            Address::repeat_byte(4),
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            Address::repeat_byte(9),
        );
        let single = RawLog {
            address: token,
            topics: vec![TransferSingle::SIGNATURE_HASH, word(op), word(a), word(b)],
            data: Bytes::from((U256::from(7u8), U256::from(3u8)).abi_encode_params()),
            log_index: 9,
        };
        let erc20 = RawLog {
            address: token,
            topics: vec![TransferEv::SIGNATURE_HASH, word(a), word(b)],
            data: Bytes::from(U256::from(1u8).to_be_bytes::<32>().to_vec()),
            log_index: 2,
        };
        let v = decode_transfer_logs(&[single, erc20], B256::ZERO, 1, ts());
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].kind, TransferKind::Erc20);
        assert_eq!(v[1].kind, TransferKind::Erc1155);
        assert_eq!(v[1].token_id, Some(U256::from(7u8)));
        assert_eq!(v[1].amount, U256::from(3u8));
    }

    #[test]
    fn non_transfer_log_ignored() {
        let a = Address::repeat_byte(1);
        let approval = RawLog {
            address: a,
            topics: vec![Approval::SIGNATURE_HASH, word(a), word(a)],
            data: Bytes::from(vec![0u8; 32]),
            log_index: 0,
        };
        // ERC20 Transfer with bad data length and bad topic count
        let bad_data = RawLog {
            address: a,
            topics: vec![TransferEv::SIGNATURE_HASH, word(a), word(a)],
            data: Bytes::from(vec![0u8; 31]),
            log_index: 1,
        };
        let bad_topics = RawLog {
            address: a,
            topics: vec![TransferEv::SIGNATURE_HASH, word(a)],
            data: Bytes::from(vec![0u8; 32]),
            log_index: 2,
        };
        let empty = RawLog {
            address: a,
            topics: vec![],
            data: Bytes::new(),
            log_index: 3,
        };
        assert!(
            decode_transfer_logs(
                &[approval, bad_data, bad_topics, empty],
                B256::ZERO,
                1,
                ts()
            )
            .is_empty()
        );
    }
}
