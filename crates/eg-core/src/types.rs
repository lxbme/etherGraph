use std::collections::HashMap;

pub use alloy_primitives::{Address, B256, Bytes, U256};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub type TxHash = B256;

/// Transfer category; also used as the sync category.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferKind {
    Native,
    Internal,
    Erc20,
    Erc721,
    Erc1155,
}

impl TransferKind {
    pub const ALL: [TransferKind; 5] = [
        TransferKind::Native,
        TransferKind::Internal,
        TransferKind::Erc20,
        TransferKind::Erc721,
        TransferKind::Erc1155,
    ];

    pub fn as_i16(self) -> i16 {
        match self {
            TransferKind::Native => 0,
            TransferKind::Internal => 1,
            TransferKind::Erc20 => 2,
            TransferKind::Erc721 => 3,
            TransferKind::Erc1155 => 4,
        }
    }

    pub fn from_i16(v: i16) -> Option<Self> {
        Self::ALL.get(usize::try_from(v).ok()?).copied()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            TransferKind::Native => "native",
            TransferKind::Internal => "internal",
            TransferKind::Erc20 => "erc20",
            TransferKind::Erc721 => "erc721",
            TransferKind::Erc1155 => "erc1155",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub tx_hash: TxHash,
    pub sub_id: String,
    pub kind: TransferKind,
    pub block_number: u64,
    pub ts: DateTime<Utc>,
    pub from: Address,
    pub to: Address,
    pub asset: Option<Address>,
    pub amount: U256,
    pub token_id: Option<U256>,
    pub trace_id: Option<String>,
    pub log_index: Option<u64>,
    /// Position in Etherscan's per-transaction internal-call list (execution
    /// order); set only from the txhash endpoint.
    pub call_index: Option<u32>,
}

/// Assigns content-based sub ids: `top` for top-level native transfers, otherwise
/// `{kind}:{asset|eth}:{from}:{to}:{amount}:{token_id|-}:{n}` where `n` counts
/// identical transfers within the same tx in order of appearance.
pub fn assign_sub_ids(transfers: &mut [Transfer]) {
    let mut counts: HashMap<(TxHash, String), u32> = HashMap::new();
    for t in transfers.iter_mut() {
        if t.kind == TransferKind::Native {
            t.sub_id = "top".to_string();
            continue;
        }
        let asset = t
            .asset
            .map_or_else(|| "eth".to_string(), |a| format!("{a:#x}"));
        let token_id = t
            .token_id
            .map_or_else(|| "-".to_string(), |v| v.to_string());
        let key = format!(
            "{}:{}:{:#x}:{:#x}:{}:{}",
            t.kind.as_str(),
            asset,
            t.from,
            t.to,
            t.amount,
            token_id
        );
        let n = counts.entry((t.tx_hash, key.clone())).or_insert(0);
        t.sub_id = format!("{key}:{n}");
        *n += 1;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountKind {
    Eoa,
    Contract,
    Unknown,
}

pub const LABEL_CATEGORIES: [&str; 7] = [
    "exchange",
    "defi",
    "bridge",
    "mixer",
    "scam",
    "sanctioned",
    "other",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(
        kind: TransferKind,
        asset: Option<Address>,
        from: Address,
        to: Address,
        amt: u64,
    ) -> Transfer {
        Transfer {
            tx_hash: TxHash::repeat_byte(1),
            sub_id: String::new(),
            kind,
            block_number: 1,
            ts: DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
            from,
            to,
            asset,
            amount: U256::from(amt),
            token_id: None,
            trace_id: None,
            log_index: None,
            call_index: None,
        }
    }

    #[test]
    fn sub_id_top_level_is_top() {
        let mut v = vec![tr(
            TransferKind::Native,
            None,
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            5,
        )];
        assign_sub_ids(&mut v);
        assert_eq!(v[0].sub_id, "top");
    }

    #[test]
    fn sub_ids_distinguish_identical_transfers() {
        let (a, b, c, usdt) = (
            Address::repeat_byte(0xa),
            Address::repeat_byte(0xb),
            Address::repeat_byte(0xc),
            Address::repeat_byte(0xd),
        );
        let mut v = vec![
            tr(TransferKind::Erc20, Some(usdt), a, b, 100),
            tr(TransferKind::Erc20, Some(usdt), a, b, 100),
            tr(TransferKind::Erc20, Some(usdt), a, c, 100),
        ];
        assign_sub_ids(&mut v);
        assert_eq!(
            v[0].sub_id,
            format!("erc20:{usdt:#x}:{a:#x}:{b:#x}:100:-:0")
        );
        assert_eq!(
            v[1].sub_id,
            format!("erc20:{usdt:#x}:{a:#x}:{b:#x}:100:-:1")
        );
        assert!(v[2].sub_id.ends_with(":0"));
    }

    #[test]
    fn sub_ids_stable_across_subset() {
        let (a, b, c) = (
            Address::repeat_byte(1),
            Address::repeat_byte(2),
            Address::repeat_byte(3),
        );
        let x = tr(TransferKind::Internal, None, a, b, 7);
        let y = tr(TransferKind::Internal, None, a, c, 9);
        let mut full = vec![x.clone(), y, x.clone()];
        let mut sub = vec![x.clone(), x];
        assign_sub_ids(&mut full);
        assign_sub_ids(&mut sub);
        assert!(full[2].sub_id.ends_with(":1"));
        assert!(sub[1].sub_id.ends_with(":1"));
        assert_eq!(full[2].sub_id, sub[1].sub_id);
    }

    #[test]
    fn kind_roundtrip() {
        for k in TransferKind::ALL {
            assert_eq!(TransferKind::from_i16(k.as_i16()), Some(k));
            assert_eq!(TransferKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(TransferKind::from_i16(5), None);
    }
}
