//! In-memory `ChainSource` test double (feature `testing`).
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};

use crate::source::{
    CallFrame, CallGate, ChainSource, ContractCreation, ContractSource, HistoryPage, HistoryQuery,
    Priority, RawBlock, RawReceipt, RawTx, SourceError, TokenInfo, TraceSource,
};
use crate::types::{Address, Bytes, Transfer, TransferKind, TxHash, U256};

type EthCallFn = Box<dyn Fn(Address, &Bytes) -> Result<Bytes, SourceError> + Send + Sync>;
type HistoryEntry = (Vec<Transfer>, Vec<TokenInfo>);
type TxEntry = (RawTx, RawReceipt, Vec<Transfer>);

#[derive(Default)]
pub struct FakeSource {
    history: Mutex<HashMap<(Address, TransferKind), HistoryEntry>>,
    txs: Mutex<HashMap<TxHash, TxEntry>>,
    block_ts: Mutex<HashMap<u64, DateTime<Utc>>>,
    blocks: Mutex<HashMap<u64, RawBlock>>,
    statuses: Mutex<HashMap<TxHash, Option<String>>>,
    contracts: Mutex<HashMap<Address, (ContractSource, ContractCreation)>>,
    latest: Mutex<u64>,
    nonces: Mutex<HashMap<Address, u64>>,
    codes: Mutex<HashMap<Address, Bytes>>,
    balances: Mutex<HashMap<Address, U256>>,
    eth_call: Mutex<Option<EthCallFn>>,
    fail: Mutex<Option<SourceError>>,
    fail_at: Mutex<Option<(u32, SourceError)>>,
    status_fail: Mutex<Option<SourceError>>,
    calls: AtomicU32,
    status_calls: AtomicU32,
}

impl FakeSource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_history(
        &self,
        addr: Address,
        kind: TransferKind,
        transfers: Vec<Transfer>,
        tokens: Vec<TokenInfo>,
    ) {
        self.history
            .lock()
            .unwrap()
            .insert((addr, kind), (transfers, tokens));
    }

    pub fn set_latest_block(&self, b: u64) {
        *self.latest.lock().unwrap() = b;
    }

    pub fn set_nonce(&self, addr: Address, n: u64) {
        self.nonces.lock().unwrap().insert(addr, n);
    }

    pub fn set_code(&self, addr: Address, code: Bytes) {
        self.codes.lock().unwrap().insert(addr, code);
    }

    pub fn set_balance(&self, addr: Address, v: U256) {
        self.balances.lock().unwrap().insert(addr, v);
    }

    pub fn add_tx(
        &self,
        tx: RawTx,
        receipt: RawReceipt,
        internals: Vec<Transfer>,
        block_ts: DateTime<Utc>,
    ) {
        if let Some(b) = tx.block_number {
            self.block_ts.lock().unwrap().insert(b, block_ts);
        }
        self.txs
            .lock()
            .unwrap()
            .insert(tx.hash, (tx, receipt, internals));
    }

    pub fn add_block(&self, b: RawBlock) {
        self.blocks.lock().unwrap().insert(b.number, b);
    }

    pub fn set_tx_status(&self, hash: TxHash, status: Option<String>) {
        self.statuses.lock().unwrap().insert(hash, status);
    }

    pub fn add_contract(&self, src: ContractSource, creation: ContractCreation) {
        self.contracts
            .lock()
            .unwrap()
            .insert(src.address, (src, creation));
    }

    pub fn on_eth_call(
        &self,
        f: impl Fn(Address, &Bytes) -> Result<Bytes, SourceError> + Send + Sync + 'static,
    ) {
        *self.eth_call.lock().unwrap() = Some(Box::new(f));
    }

    /// The next call of any kind returns this error.
    pub fn fail_next(&self, err: SourceError) {
        *self.fail.lock().unwrap() = Some(err);
    }

    /// The `n`-th call of any kind (counted as [`FakeSource::calls`] counts) returns this error.
    pub fn fail_at(&self, n: u32, err: SourceError) {
        *self.fail_at.lock().unwrap() = Some((n, err));
    }

    /// The next `tx_status` call returns this error; other calls are unaffected.
    pub fn fail_next_tx_status(&self, err: SourceError) {
        *self.status_fail.lock().unwrap() = Some(err);
    }

    pub fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }

    /// How many `tx_status` calls were made.
    pub fn tx_status_calls(&self) -> u32 {
        self.status_calls.load(Ordering::SeqCst)
    }

    fn enter(&self) -> Result<(), SourceError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut at = self.fail_at.lock().unwrap();
            if at.as_ref().is_some_and(|(k, _)| *k == n) {
                return Err(at.take().unwrap().1);
            }
        }
        match self.fail.lock().unwrap().take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl ChainSource for FakeSource {
    async fn history_page(
        &self,
        _p: Priority,
        q: &HistoryQuery,
    ) -> Result<HistoryPage, SourceError> {
        self.enter()?;
        if u64::from(q.page) * u64::from(q.offset) > 10_000 {
            return Err(SourceError::WindowTooLarge);
        }
        let (mut transfers, tokens) = self
            .history
            .lock()
            .unwrap()
            .get(&(q.address, q.kind))
            .cloned()
            .unwrap_or_default();
        transfers.retain(|t| (q.start_block..=q.end_block).contains(&t.block_number));
        transfers.sort_by(|a, b| b.block_number.cmp(&a.block_number));
        let skip = (q.page.saturating_sub(1) as usize).saturating_mul(q.offset as usize);
        let slice: Vec<Transfer> = transfers
            .into_iter()
            .skip(skip)
            .take(q.offset as usize)
            .collect();
        Ok(HistoryPage {
            row_count: slice.len() as u32,
            min_block: slice.last().map(|t| t.block_number),
            transfers: slice,
            tokens,
        })
    }

    async fn tx(&self, _p: Priority, hash: TxHash) -> Result<Option<RawTx>, SourceError> {
        self.enter()?;
        Ok(self.txs.lock().unwrap().get(&hash).map(|e| e.0.clone()))
    }

    async fn receipt(&self, _p: Priority, hash: TxHash) -> Result<Option<RawReceipt>, SourceError> {
        self.enter()?;
        Ok(self.txs.lock().unwrap().get(&hash).map(|e| e.1.clone()))
    }

    async fn internal_txs(&self, _p: Priority, hash: TxHash) -> Result<Vec<Transfer>, SourceError> {
        self.enter()?;
        Ok(self
            .txs
            .lock()
            .unwrap()
            .get(&hash)
            .map(|e| e.2.clone())
            .unwrap_or_default())
    }

    async fn block(&self, _p: Priority, number: u64) -> Result<RawBlock, SourceError> {
        self.enter()?;
        if let Some(b) = self.blocks.lock().unwrap().get(&number) {
            return Ok(b.clone());
        }
        // Blocks only known by timestamp (via `add_tx`) get a bare header.
        let ts = self
            .block_ts
            .lock()
            .unwrap()
            .get(&number)
            .copied()
            .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
        Ok(RawBlock {
            number,
            ts,
            base_fee: None,
            gas_limit: U256::ZERO,
            gas_used: U256::ZERO,
            fee_recipient: Address::ZERO,
        })
    }

    async fn tx_status(&self, _p: Priority, hash: TxHash) -> Result<Option<String>, SourceError> {
        self.status_calls.fetch_add(1, Ordering::SeqCst);
        self.enter()?;
        if let Some(e) = self.status_fail.lock().unwrap().take() {
            return Err(e);
        }
        Ok(self.statuses.lock().unwrap().get(&hash).cloned().flatten())
    }

    async fn latest_block(&self, _p: Priority) -> Result<u64, SourceError> {
        self.enter()?;
        Ok(*self.latest.lock().unwrap())
    }

    async fn contract_source(
        &self,
        _p: Priority,
        addr: Address,
    ) -> Result<ContractSource, SourceError> {
        self.enter()?;
        Ok(self
            .contracts
            .lock()
            .unwrap()
            .get(&addr)
            .map(|e| e.0.clone())
            .unwrap_or(ContractSource {
                address: addr,
                name: None,
                abi_json: None,
                is_proxy: false,
                implementation: None,
            }))
    }

    async fn contract_creation(
        &self,
        _p: Priority,
        addrs: &[Address],
    ) -> Result<Vec<ContractCreation>, SourceError> {
        self.enter()?;
        let m = self.contracts.lock().unwrap();
        Ok(addrs
            .iter()
            .filter_map(|a| m.get(a).map(|e| e.1.clone()))
            .collect())
    }

    async fn eth_call(&self, _p: Priority, to: Address, data: Bytes) -> Result<Bytes, SourceError> {
        self.enter()?;
        match self.eth_call.lock().unwrap().as_ref() {
            Some(f) => f(to, &data),
            None => Err(SourceError::Rpc {
                code: -32000,
                message: "no eth_call handler".into(),
            }),
        }
    }

    async fn tx_count(&self, _p: Priority, addr: Address) -> Result<u64, SourceError> {
        self.enter()?;
        Ok(self.nonces.lock().unwrap().get(&addr).copied().unwrap_or(0))
    }

    async fn code(&self, _p: Priority, addr: Address) -> Result<Bytes, SourceError> {
        self.enter()?;
        Ok(self
            .codes
            .lock()
            .unwrap()
            .get(&addr)
            .cloned()
            .unwrap_or_default())
    }

    async fn balances(
        &self,
        _p: Priority,
        addrs: &[Address],
    ) -> Result<Vec<(Address, U256)>, SourceError> {
        self.enter()?;
        if addrs.len() > 20 {
            return Err(SourceError::Parse(format!(
                "balancemulti: at most 20 addresses, got {}",
                addrs.len()
            )));
        }
        let m = self.balances.lock().unwrap();
        Ok(addrs
            .iter()
            .map(|a| (*a, m.get(a).copied().unwrap_or(U256::ZERO)))
            .collect())
    }
}

/// Wraps a source (chain or trace) so that every call first takes a permit
/// from `gate`, as the Etherscan client does for each HTTP attempt: calls count toward the gate's
/// quotas and are refused like real ones when a quota is used up.
pub struct GatedSource<S> {
    inner: Arc<S>,
    gate: Arc<dyn CallGate>,
}

impl<S> GatedSource<S> {
    pub fn new(inner: Arc<S>, gate: Arc<dyn CallGate>) -> Self {
        Self { inner, gate }
    }
}

#[async_trait]
impl<S: ChainSource> ChainSource for GatedSource<S> {
    async fn history_page(
        &self,
        p: Priority,
        q: &HistoryQuery,
    ) -> Result<HistoryPage, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.history_page(p, q).await
    }

    async fn tx(&self, p: Priority, hash: TxHash) -> Result<Option<RawTx>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.tx(p, hash).await
    }

    async fn receipt(&self, p: Priority, hash: TxHash) -> Result<Option<RawReceipt>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.receipt(p, hash).await
    }

    async fn internal_txs(&self, p: Priority, hash: TxHash) -> Result<Vec<Transfer>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.internal_txs(p, hash).await
    }

    async fn block(&self, p: Priority, number: u64) -> Result<RawBlock, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.block(p, number).await
    }

    async fn block_timestamp(&self, p: Priority, block: u64) -> Result<DateTime<Utc>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.block_timestamp(p, block).await
    }

    async fn tx_status(&self, p: Priority, hash: TxHash) -> Result<Option<String>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.tx_status(p, hash).await
    }

    async fn latest_block(&self, p: Priority) -> Result<u64, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.latest_block(p).await
    }

    async fn contract_source(
        &self,
        p: Priority,
        addr: Address,
    ) -> Result<ContractSource, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.contract_source(p, addr).await
    }

    async fn contract_creation(
        &self,
        p: Priority,
        addrs: &[Address],
    ) -> Result<Vec<ContractCreation>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.contract_creation(p, addrs).await
    }

    async fn eth_call(&self, p: Priority, to: Address, data: Bytes) -> Result<Bytes, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.eth_call(p, to, data).await
    }

    async fn tx_count(&self, p: Priority, addr: Address) -> Result<u64, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.tx_count(p, addr).await
    }

    async fn code(&self, p: Priority, addr: Address) -> Result<Bytes, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.code(p, addr).await
    }

    async fn balances(
        &self,
        p: Priority,
        addrs: &[Address],
    ) -> Result<Vec<(Address, U256)>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.balances(p, addrs).await
    }
}

/// As the Blockscout client does for each request.
#[async_trait]
impl<S: TraceSource> TraceSource for GatedSource<S> {
    async fn call_trace(
        &self,
        p: Priority,
        hash: TxHash,
    ) -> Result<Option<Vec<CallFrame>>, SourceError> {
        self.gate.acquire(p).await?;
        self.inner.call_trace(p, hash).await
    }

    fn name(&self) -> &'static str {
        self.inner.name()
    }
}

/// In-memory `TraceSource`: unknown hashes have no trace (`Ok(None)`).
#[derive(Default)]
pub struct FakeTraceSource {
    traces: Mutex<HashMap<TxHash, Option<Vec<CallFrame>>>>,
    fail: Mutex<Option<SourceError>>,
    calls: AtomicUsize,
}

impl FakeTraceSource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, hash: TxHash, frames: Option<Vec<CallFrame>>) {
        self.traces.lock().unwrap().insert(hash, frames);
    }

    /// The next call returns this error.
    pub fn fail_next(&self, err: SourceError) {
        *self.fail.lock().unwrap() = Some(err);
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl TraceSource for FakeTraceSource {
    async fn call_trace(
        &self,
        _p: Priority,
        hash: TxHash,
    ) -> Result<Option<Vec<CallFrame>>, SourceError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(e) = self.fail.lock().unwrap().take() {
            return Err(e);
        }
        Ok(self.traces.lock().unwrap().get(&hash).cloned().flatten())
    }

    fn name(&self) -> &'static str {
        "fake"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{ChainSource, HistoryQuery, Priority, SourceError};
    use crate::types::{Address, B256, Transfer, TransferKind, U256};
    use chrono::{TimeZone, Utc};

    fn tr(block: u64) -> Transfer {
        Transfer {
            tx_hash: B256::ZERO,
            sub_id: "top".into(),
            kind: TransferKind::Native,
            block_number: block,
            ts: Utc.timestamp_opt(0, 0).unwrap(),
            from: Address::ZERO,
            to: Address::ZERO,
            asset: None,
            amount: U256::from(1u64),
            token_id: None,
            trace_id: None,
            log_index: None,
            call_index: None,
        }
    }

    fn q(page: u32, offset: u32) -> HistoryQuery {
        HistoryQuery {
            address: Address::ZERO,
            kind: TransferKind::Native,
            start_block: 0,
            end_block: u64::MAX,
            page,
            offset,
        }
    }

    #[tokio::test]
    async fn fake_history_window_limit() {
        let f = FakeSource::new();
        f.add_history(
            Address::ZERO,
            TransferKind::Native,
            (1..=12000).map(tr).collect(),
            vec![],
        );
        let r = f.history_page(Priority::Interactive, &q(11, 1000)).await;
        assert_eq!(r.unwrap_err(), SourceError::WindowTooLarge);
        let p = f
            .history_page(Priority::Interactive, &q(1, 1000))
            .await
            .unwrap();
        assert_eq!(p.row_count, 1000);
        assert!(
            p.transfers
                .windows(2)
                .all(|w| w[0].block_number >= w[1].block_number)
        );
        assert_eq!(p.transfers[0].block_number, 12000);
        assert_eq!(p.min_block, Some(11001));
        // exactly 10000 is still allowed
        let p10 = f
            .history_page(Priority::Interactive, &q(10, 1000))
            .await
            .unwrap();
        assert_eq!(p10.row_count, 1000);
        assert_eq!(f.calls(), 3);
    }

    #[tokio::test]
    async fn fake_history_block_range_and_paging() {
        let f = FakeSource::new();
        f.add_history(
            Address::ZERO,
            TransferKind::Native,
            (1..=100).map(tr).collect(),
            vec![],
        );
        let rq = |start, end, page, offset| HistoryQuery {
            start_block: start,
            end_block: end,
            ..q(page, offset)
        };
        let all = f
            .history_page(Priority::Background, &rq(10, 20, 1, 100))
            .await
            .unwrap();
        let blocks: Vec<u64> = all.transfers.iter().map(|t| t.block_number).collect();
        assert_eq!(blocks, (10..=20).rev().collect::<Vec<_>>());
        assert_eq!(all.min_block, Some(10));
        let p1 = f
            .history_page(Priority::Background, &rq(10, 20, 1, 5))
            .await
            .unwrap();
        let p2 = f
            .history_page(Priority::Background, &rq(10, 20, 2, 5))
            .await
            .unwrap();
        let b1: Vec<u64> = p1.transfers.iter().map(|t| t.block_number).collect();
        let b2: Vec<u64> = p2.transfers.iter().map(|t| t.block_number).collect();
        assert_eq!(b1, vec![20, 19, 18, 17, 16]);
        assert_eq!(b2, vec![15, 14, 13, 12, 11]);
        let empty = f
            .history_page(Priority::Background, &rq(200, 300, 1, 5))
            .await
            .unwrap();
        assert_eq!(empty.row_count, 0);
        assert_eq!(empty.min_block, None);
    }

    #[tokio::test]
    async fn fail_next_is_one_shot() {
        let f = FakeSource::new();
        f.fail_next(SourceError::Timeout);
        assert_eq!(
            f.latest_block(Priority::Low).await.unwrap_err(),
            SourceError::Timeout
        );
        assert_eq!(f.latest_block(Priority::Low).await.unwrap(), 0);
        assert_eq!(f.calls(), 2);
    }

    #[tokio::test]
    async fn fake_trace_source_set_fail_and_count() {
        use crate::source::{CallFrame, CallKind, TraceSource};
        let f = FakeTraceSource::new();
        let known = B256::repeat_byte(1);
        let frame = CallFrame {
            path: vec![],
            kind: CallKind::Call,
            from: Address::ZERO,
            to: Some(Address::ZERO),
            value: U256::ZERO,
            input: Default::default(),
            output: None,
            gas: 21_000,
            gas_used: Some(21_000),
            error: None,
            subtraces: 0,
        };
        f.set(known, Some(vec![frame.clone()]));
        assert_eq!(
            f.call_trace(Priority::Interactive, known).await.unwrap(),
            Some(vec![frame])
        );
        assert_eq!(
            f.call_trace(Priority::Interactive, B256::ZERO)
                .await
                .unwrap(),
            None
        );
        f.fail_next(SourceError::RateLimited);
        assert_eq!(
            f.call_trace(Priority::Interactive, known)
                .await
                .unwrap_err(),
            SourceError::RateLimited
        );
        assert!(f.call_trace(Priority::Interactive, known).await.is_ok());
        assert_eq!(f.calls(), 4);
    }
}
