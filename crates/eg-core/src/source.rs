use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::types::{Address, B256, Bytes, Transfer, TransferKind, TxHash, U256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Priority {
    Interactive,
    Background,
    Low,
}

impl Priority {
    pub fn as_i16(self) -> i16 {
        match self {
            Priority::Interactive => 0,
            Priority::Background => 1,
            Priority::Low => 2,
        }
    }

    /// Unknown values map to `Low`.
    pub fn from_i16(v: i16) -> Self {
        match v {
            0 => Priority::Interactive,
            1 => Priority::Background,
            _ => Priority::Low,
        }
    }
}

#[derive(thiserror::Error, Debug, Clone, PartialEq)]
pub enum SourceError {
    #[error("rate limited")]
    RateLimited,
    #[error("daily quota exhausted")]
    QuotaExhausted,
    /// The user the call is billed to has used up their own daily quota; the
    /// server total is not exhausted.
    #[error("user daily quota exhausted")]
    UserQuotaExhausted,
    #[error("invalid api key")]
    InvalidKey,
    #[error("result window too large")]
    WindowTooLarge,
    #[error("timeout")]
    Timeout,
    #[error("network error: {0}")]
    Network(String),
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("rpc error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("parse error: {0}")]
    Parse(String),
    #[error("fixture missing: {0}")]
    FixtureMissing(String),
}

impl SourceError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            SourceError::RateLimited | SourceError::Timeout | SourceError::Network(_)
        )
    }

    /// The server's or the billed user's daily quota is used up: the work
    /// waits for the next reset instead of failing.
    pub fn is_quota(&self) -> bool {
        matches!(
            self,
            SourceError::QuotaExhausted | SourceError::UserQuotaExhausted
        )
    }
}

#[async_trait]
pub trait CallGate: Send + Sync {
    /// Returns `Err(QuotaExhausted)` when the daily quota is used up, and
    /// `Err(UserQuotaExhausted)` when the billed user's own quota is.
    async fn acquire(&self, p: Priority) -> Result<(), SourceError>;
    fn on_rate_limited(&self);
    /// The upstream reported its daily limit: stop granting permits until the
    /// quota is reset. No-op by default (test gates).
    fn on_quota_exhausted(&self) {}
}

/// Results are always ordered by block descending.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryQuery {
    pub address: Address,
    pub kind: TransferKind,
    pub start_block: u64,
    pub end_block: u64,
    pub page: u32,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenInfo {
    pub address: Address,
    pub kind: TransferKind,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryPage {
    pub transfers: Vec<Transfer>,
    pub tokens: Vec<TokenInfo>,
    pub row_count: u32,
    pub min_block: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawLog {
    pub address: Address,
    pub topics: Vec<B256>,
    pub data: Bytes,
    pub log_index: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawTx {
    pub hash: TxHash,
    pub from: Address,
    pub to: Option<Address>,
    pub value: U256,
    pub input: Bytes,
    pub block_number: Option<u64>,
    pub json: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawReceipt {
    pub success: bool,
    pub gas_used: U256,
    /// ZERO when the receipt has no effectiveGasPrice (pre-London); callers fall back to the tx gasPrice.
    pub effective_gas_price: U256,
    pub contract_address: Option<Address>,
    pub logs: Vec<RawLog>,
    pub json: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawBlock {
    pub number: u64,
    pub ts: DateTime<Utc>,
    /// `None` for pre-London blocks.
    pub base_fee: Option<U256>,
    pub gas_limit: U256,
    pub gas_used: U256,
    pub fee_recipient: Address,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractSource {
    pub address: Address,
    pub name: Option<String>,
    pub abi_json: Option<String>,
    pub is_proxy: bool,
    pub implementation: Option<Address>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractCreation {
    pub address: Address,
    pub creator: Address,
    pub tx_hash: TxHash,
}

#[async_trait]
pub trait ChainSource: Send + Sync {
    async fn history_page(&self, p: Priority, q: &HistoryQuery)
    -> Result<HistoryPage, SourceError>;
    async fn tx(&self, p: Priority, hash: TxHash) -> Result<Option<RawTx>, SourceError>;
    async fn receipt(&self, p: Priority, hash: TxHash) -> Result<Option<RawReceipt>, SourceError>;
    async fn internal_txs(&self, p: Priority, hash: TxHash) -> Result<Vec<Transfer>, SourceError>;
    async fn block(&self, p: Priority, number: u64) -> Result<RawBlock, SourceError>;
    async fn block_timestamp(&self, p: Priority, block: u64) -> Result<DateTime<Utc>, SourceError> {
        Ok(self.block(p, block).await?.ts)
    }
    /// The revert reason of a failed tx; `None` when it succeeded or Etherscan has no description.
    async fn tx_status(&self, p: Priority, hash: TxHash) -> Result<Option<String>, SourceError>;
    async fn latest_block(&self, p: Priority) -> Result<u64, SourceError>;
    async fn contract_source(
        &self,
        p: Priority,
        addr: Address,
    ) -> Result<ContractSource, SourceError>;
    /// `addrs.len() <= 5`.
    async fn contract_creation(
        &self,
        p: Priority,
        addrs: &[Address],
    ) -> Result<Vec<ContractCreation>, SourceError>;
    async fn eth_call(&self, p: Priority, to: Address, data: Bytes) -> Result<Bytes, SourceError>;
    /// The account nonce (`eth_getTransactionCount`) at `latest`.
    async fn tx_count(&self, p: Priority, addr: Address) -> Result<u64, SourceError>;
    /// The deployed bytecode (`eth_getCode`) at `latest`; empty for an EOA.
    async fn code(&self, p: Priority, addr: Address) -> Result<Bytes, SourceError>;
    /// Native balances at `latest`, in the requested order. `addrs.len() <= 20`,
    /// otherwise `SourceError::Parse`.
    async fn balances(
        &self,
        p: Priority,
        addrs: &[Address],
    ) -> Result<Vec<(Address, U256)>, SourceError>;
}

/// The EVM operation that opened a call frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallKind {
    Call,
    StaticCall,
    DelegateCall,
    CallCode,
    Create,
    Create2,
    SelfDestruct,
}

/// One frame of a transaction's call trace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallFrame {
    /// Position in the tree: `[]` is the root, `[1, 0]` the first child of
    /// the root's second child.
    pub path: Vec<u32>,
    pub kind: CallKind,
    pub from: Address,
    /// The callee; for a create, the new contract (`None` when it failed);
    /// for a self-destruct, the beneficiary.
    pub to: Option<Address>,
    pub value: U256,
    /// Calldata; for a create, the init code.
    pub input: Bytes,
    /// Return or revert data; for a create, the deployed code.
    pub output: Option<Bytes>,
    pub gas: u64,
    pub gas_used: Option<u64>,
    pub error: Option<String>,
    pub subtraces: u32,
}

/// Where call traces come from; separate from [`ChainSource`] so the trace
/// provider can be swapped independently of Etherscan.
#[async_trait]
pub trait TraceSource: Send + Sync {
    /// Frames sorted by `path` (pre-order). `None`: the source has no trace
    /// for this hash (not indexed / unknown).
    async fn call_trace(
        &self,
        p: Priority,
        hash: TxHash,
    ) -> Result<Option<Vec<CallFrame>>, SourceError>;
    /// Stored in `call_traces.source`, e.g. `"blockscout"`.
    fn name(&self) -> &'static str;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_classes() {
        assert!(SourceError::RateLimited.is_retryable());
        assert!(SourceError::Timeout.is_retryable());
        assert!(SourceError::Network("x".into()).is_retryable());
        assert!(!SourceError::InvalidKey.is_retryable());
        assert!(!SourceError::QuotaExhausted.is_retryable());
        assert!(!SourceError::UserQuotaExhausted.is_retryable());
        assert!(SourceError::QuotaExhausted.is_quota());
        assert!(SourceError::UserQuotaExhausted.is_quota());
        assert!(!SourceError::RateLimited.is_quota());
        assert!(!SourceError::Parse("x".into()).is_retryable());
    }

    #[test]
    fn call_frame_json_round_trip() {
        let f = CallFrame {
            path: vec![4, 0],
            kind: CallKind::DelegateCall,
            from: Address::repeat_byte(0x23),
            to: Some(Address::repeat_byte(0x23)),
            value: U256::from(7u64),
            input: Bytes::from(vec![0x8b, 0x95, 0xdd, 0x71]),
            output: None,
            gas: 100,
            gas_used: Some(42),
            error: Some("Reverted".into()),
            subtraces: 0,
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["kind"], "delegatecall");
        assert_eq!(serde_json::from_value::<CallFrame>(v).unwrap(), f);
        assert_eq!(
            serde_json::to_value(CallKind::StaticCall).unwrap(),
            "staticcall"
        );
        assert_eq!(serde_json::to_value(CallKind::Create2).unwrap(), "create2");
    }
}
