use std::sync::{Arc, Mutex};

use alloy_primitives::{Address, B256, Bytes, U256, address};
use alloy_sol_types::{SolCall, SolValue, sol};
use eg_core::source::{ContractCreation, ContractSource, Priority, SourceError};
use eg_core::testing::FakeSource;
use eg_core::types::AccountKind;
use eg_decode::encode_reverse;
use eg_ingest::config::IngestConfig;
use eg_ingest::handlers::{ContractMetaHandler, ResolveNamesHandler, TokenMetaHandler};
use eg_ingest::{Event, EventBus, JobCtx, JobError, JobHandler};
use eg_store::{EnsStatus, JobKind, NewJob, Store};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::Notify;

sol! {
    interface M3 {
        struct Call3 { address target; bool allowFailure; bytes callData; }
        struct Res { bool success; bytes returnData; }
        function aggregate3(Call3[] calldata calls) external payable returns (Res[] memory returnData);
    }
}

struct Env {
    ctx: JobCtx,
    fake: Arc<FakeSource>,
}

fn env(pool: PgPool) -> Env {
    let fake = Arc::new(FakeSource::new());
    let ctx = JobCtx {
        store: Store::from_pool(pool),
        source: fake.clone(),
        bus: EventBus::new(),
        cfg: Arc::new(IngestConfig::default()),
        wake: Arc::new(Notify::new()),
    };
    Env { ctx, fake }
}

async fn run(e: &Env, h: &dyn JobHandler, kind: JobKind, params: Value) -> Result<(), JobError> {
    e.ctx
        .store
        .enqueue(&NewJob {
            key: format!("t:{params}"),
            kind,
            params,
            priority: eg_core::source::Priority::Low,
            user_id: None,
        })
        .await
        .unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    h.run(&job, &e.ctx).await
}

fn a(n: u8) -> Address {
    Address::repeat_byte(n)
}

fn add_contract(e: &Env, addr: Address, name: &str, imp: Option<Address>) {
    e.fake.add_contract(
        ContractSource {
            address: addr,
            name: Some(name.into()),
            abi_json: Some("[]".into()),
            is_proxy: imp.is_some(),
            implementation: imp,
        },
        ContractCreation {
            address: addr,
            creator: a(0xee),
            tx_hash: B256::repeat_byte(0x42),
        },
    );
}

fn agg_ret(items: Vec<(bool, Vec<u8>)>) -> Bytes {
    let r: Vec<M3::Res> = items
        .into_iter()
        .map(|(success, d)| M3::Res {
            success,
            returnData: d.into(),
        })
        .collect();
    M3::aggregate3Call::abi_encode_returns(&r).into()
}

fn sub_calls(data: &Bytes) -> Vec<M3::Call3> {
    M3::aggregate3Call::abi_decode(data).unwrap().calls
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn contract_meta_classifies_eoa_and_contract(pool: PgPool) {
    let e = env(pool);
    add_contract(&e, a(1), "Foo", None);
    let addrs: Vec<Address> = (1..=6).map(a).collect();
    let list: Vec<String> = addrs.iter().map(|x| format!("{x:#x}")).collect();
    let mut rx = e.ctx.bus.subscribe();
    run(
        &e,
        &ContractMetaHandler,
        JobKind::ContractMeta,
        json!({"addresses": list}),
    )
    .await
    .unwrap();
    // 2 creation calls (5 + 1) + 1 contract_source
    assert_eq!(e.fake.calls(), 3);
    let rows = e.ctx.store.accounts(&addrs).await.unwrap();
    assert_eq!(rows.len(), 6);
    let c = rows.iter().find(|r| r.address == a(1)).unwrap();
    assert_eq!(c.kind, AccountKind::Contract);
    assert_eq!(c.contract_name.as_deref(), Some("Foo"));
    assert_eq!(c.creator, Some(a(0xee)));
    assert_eq!(c.creation_tx, Some(B256::repeat_byte(0x42)));
    assert!(
        rows.iter()
            .filter(|r| r.address != a(1))
            .all(|r| r.kind == AccountKind::Eoa && r.contract_name.is_none())
    );
    let abis = e.ctx.store.abis(&[a(1), a(2)]).await.unwrap();
    assert_eq!(abis.get(&a(1)).unwrap().as_deref(), Some("[]"));
    assert!(!abis.contains_key(&a(2)));
    match rx.try_recv().unwrap() {
        Event::MetaUpdated { addresses } => assert_eq!(addresses.len(), 6),
        other => panic!("unexpected {other:?}"),
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn proxy_enqueues_implementation(pool: PgPool) {
    let e = env(pool);
    add_contract(&e, a(1), "Proxy", Some(a(9)));
    run(
        &e,
        &ContractMetaHandler,
        JobKind::ContractMeta,
        json!({"addresses": [format!("{:#x}", a(1))]}),
    )
    .await
    .unwrap();
    let acc = e.ctx.store.accounts(&[a(1)]).await.unwrap();
    assert!(acc[0].is_proxy);
    assert_eq!(acc[0].implementation, Some(a(9)));
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE kind = $1 AND params::text LIKE $2")
            .bind(JobKind::ContractMeta.as_str())
            .bind(format!("%{:#x}%", a(9)))
            .fetch_one(e.ctx.store.pool())
            .await
            .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn invalid_params_rejected(pool: PgPool) {
    let e = env(pool);
    let r = run(
        &e,
        &TokenMetaHandler,
        JobKind::TokenMeta,
        json!({"addresses": []}),
    )
    .await;
    assert!(matches!(r, Err(JobError::Invalid(_))));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn token_meta_bytes32_symbol(pool: PgPool) {
    let e = env(pool);
    let tok = address!("0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2");
    e.fake.on_eth_call(|_to, data| {
        let calls = sub_calls(data);
        assert_eq!(calls.len(), 3);
        assert!(calls.iter().all(|c| c.allowFailure));
        let mut mkr = b"MKR".to_vec();
        mkr.resize(32, 0);
        let mut dec = vec![0u8; 32];
        dec[31] = 18;
        Ok(agg_ret(vec![
            (true, dec),
            (true, mkr),
            (true, "Maker".abi_encode()),
        ]))
    });
    run(
        &e,
        &TokenMetaHandler,
        JobKind::TokenMeta,
        json!({"tokens": [format!("{tok:#x}")]}),
    )
    .await
    .unwrap();
    let t = e.ctx.store.tokens(&[tok]).await.unwrap();
    assert_eq!(t[0].symbol.as_deref(), Some("MKR"));
    assert_eq!(t[0].name.as_deref(), Some("Maker"));
    assert_eq!(t[0].decimals, Some(18));
    assert_eq!(t[0].kind, eg_core::types::TransferKind::Erc20);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn token_meta_failed_subcall_and_empty_string(pool: PgPool) {
    let e = env(pool);
    let tok = a(5);
    e.fake.on_eth_call(|_to, _data| {
        Ok(agg_ret(vec![
            (false, vec![]),
            (true, "".abi_encode()),
            (true, "Name".abi_encode()),
        ]))
    });
    run(
        &e,
        &TokenMetaHandler,
        JobKind::TokenMeta,
        json!({"tokens": [format!("{tok:#x}")]}),
    )
    .await
    .unwrap();
    let t = e.ctx.store.tokens(&[tok]).await.unwrap();
    assert_eq!(t[0].decimals, None);
    assert_eq!(t[0].symbol, None);
    assert_eq!(t[0].name.as_deref(), Some("Name"));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn token_meta_batches_by_third(pool: PgPool) {
    let e = env(pool);
    let sizes = Arc::new(Mutex::new(Vec::new()));
    let s2 = sizes.clone();
    e.fake.on_eth_call(move |_to, data| {
        let n = sub_calls(data).len();
        s2.lock().unwrap().push(n);
        Ok(agg_ret(vec![(false, vec![]); n]))
    });
    let toks: Vec<String> = (1..=40u8).map(|i| format!("{:#x}", a(i))).collect();
    // 100 / 3 = 33 tokens per call -> 33 + 7
    run(
        &e,
        &TokenMetaHandler,
        JobKind::TokenMeta,
        json!({"tokens": toks}),
    )
    .await
    .unwrap();
    assert_eq!(*sizes.lock().unwrap(), vec![99, 21]);
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn names_offchain_and_none(pool: PgPool) {
    let e = env(pool);
    let (x, y, z) = (a(1), a(2), a(3));
    e.fake.on_eth_call(move |to, data| {
        assert_eq!(to, IngestConfig::default().multicall3);
        let calls = sub_calls(data);
        assert_eq!(calls[0].callData, encode_reverse(x));
        assert!(calls.iter().all(|c| c.allowFailure));
        let ok = ("vitalik.eth".to_string(), a(0), a(0)).abi_encode_params();
        let offchain = vec![0x55, 0x6f, 0x18, 0x30, 0, 0];
        Ok(agg_ret(vec![
            (true, ok),
            (false, vec![]),
            (false, offchain),
        ]))
    });
    let mut rx = e.ctx.bus.subscribe();
    let list: Vec<String> = [x, y, z].iter().map(|v| format!("{v:#x}")).collect();
    run(
        &e,
        &ResolveNamesHandler,
        JobKind::ResolveNames,
        json!({"addresses": list}),
    )
    .await
    .unwrap();
    let rows = e.ctx.store.ens(&[x, y, z]).await.unwrap();
    let st = |ad: Address| rows.iter().find(|r| r.address == ad).unwrap();
    assert_eq!(st(x).status, EnsStatus::Ok);
    assert_eq!(st(x).name.as_deref(), Some("vitalik.eth"));
    assert_eq!(st(y).status, EnsStatus::None);
    assert_eq!(st(z).status, EnsStatus::Offchain);
    match rx.try_recv().unwrap() {
        Event::NamesResolved { items } => assert_eq!(items.len(), 3),
        other => panic!("unexpected {other:?}"),
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn names_batch_rpc_error_marks_error(pool: PgPool) {
    let e = env(pool);
    e.fake.fail_next(SourceError::Rpc {
        code: 3,
        message: "execution reverted".into(),
    });
    let list = vec![format!("{:#x}", a(1)), format!("{:#x}", a(2))];
    run(
        &e,
        &ResolveNamesHandler,
        JobKind::ResolveNames,
        json!({"addresses": list}),
    )
    .await
    .unwrap();
    let rows = e.ctx.store.ens(&[a(1), a(2)]).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.status == EnsStatus::Error));
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn names_network_error_propagates(pool: PgPool) {
    let e = env(pool);
    e.fake.fail_next(SourceError::Network("down".into()));
    let r = run(
        &e,
        &ResolveNamesHandler,
        JobKind::ResolveNames,
        json!({"addresses": [format!("{:#x}", a(1))]}),
    )
    .await;
    assert!(matches!(r, Err(JobError::Source(SourceError::Network(_)))));
}

/// Delegates to `FakeSource`, failing `contract_source` for one address once
/// and counting `contract_source` calls per address.
struct FlakySource {
    inner: Arc<FakeSource>,
    fail_for: Address,
    failed: Mutex<bool>,
    source_calls: Mutex<Vec<Address>>,
}

#[async_trait::async_trait]
impl eg_core::source::ChainSource for FlakySource {
    async fn history_page(
        &self,
        p: Priority,
        q: &eg_core::source::HistoryQuery,
    ) -> Result<eg_core::source::HistoryPage, SourceError> {
        self.inner.history_page(p, q).await
    }
    async fn tx(
        &self,
        p: Priority,
        h: B256,
    ) -> Result<Option<eg_core::source::RawTx>, SourceError> {
        self.inner.tx(p, h).await
    }
    async fn receipt(
        &self,
        p: Priority,
        h: B256,
    ) -> Result<Option<eg_core::source::RawReceipt>, SourceError> {
        self.inner.receipt(p, h).await
    }
    async fn internal_txs(
        &self,
        p: Priority,
        h: B256,
    ) -> Result<Vec<eg_core::types::Transfer>, SourceError> {
        self.inner.internal_txs(p, h).await
    }
    async fn block(&self, p: Priority, b: u64) -> Result<eg_core::source::RawBlock, SourceError> {
        self.inner.block(p, b).await
    }
    async fn tx_status(&self, p: Priority, h: B256) -> Result<Option<String>, SourceError> {
        self.inner.tx_status(p, h).await
    }
    async fn latest_block(&self, p: Priority) -> Result<u64, SourceError> {
        self.inner.latest_block(p).await
    }
    async fn contract_source(
        &self,
        p: Priority,
        a: Address,
    ) -> Result<ContractSource, SourceError> {
        self.source_calls.lock().unwrap().push(a);
        if a == self.fail_for && !std::mem::replace(&mut *self.failed.lock().unwrap(), true) {
            return Err(SourceError::Timeout);
        }
        self.inner.contract_source(p, a).await
    }
    async fn contract_creation(
        &self,
        p: Priority,
        a: &[Address],
    ) -> Result<Vec<ContractCreation>, SourceError> {
        self.inner.contract_creation(p, a).await
    }
    async fn eth_call(&self, p: Priority, to: Address, d: Bytes) -> Result<Bytes, SourceError> {
        self.inner.eth_call(p, to, d).await
    }
    async fn tx_count(&self, p: Priority, a: Address) -> Result<u64, SourceError> {
        self.inner.tx_count(p, a).await
    }
    async fn code(&self, p: Priority, a: Address) -> Result<Bytes, SourceError> {
        self.inner.code(p, a).await
    }
    async fn balances(
        &self,
        p: Priority,
        a: &[Address],
    ) -> Result<Vec<(Address, U256)>, SourceError> {
        self.inner.balances(p, a).await
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn contract_meta_partial_failure_keeps_progress_and_retry_skips_done(pool: PgPool) {
    let mut e = env(pool);
    for (i, n) in [(1u8, "A"), (2, "B"), (3, "C")] {
        add_contract(&e, a(i), n, None);
    }
    let flaky = Arc::new(FlakySource {
        inner: e.fake.clone(),
        fail_for: a(2),
        failed: Mutex::new(false),
        source_calls: Mutex::new(Vec::new()),
    });
    e.ctx.source = flaky.clone();
    let list: Vec<String> = (1..=3).map(|i| format!("{:#x}", a(i))).collect();
    let mut rx = e.ctx.bus.subscribe();

    let r = run(
        &e,
        &ContractMetaHandler,
        JobKind::ContractMeta,
        json!({"addresses": list}),
    )
    .await;
    assert!(matches!(r, Err(JobError::Source(SourceError::Timeout))));
    let rows = e.ctx.store.accounts(&[a(1), a(2), a(3)]).await.unwrap();
    let mut got: Vec<_> = rows
        .iter()
        .map(|r| (r.address, r.contract_name.clone().unwrap()))
        .collect();
    got.sort();
    assert_eq!(got, vec![(a(1), "A".to_string()), (a(3), "C".to_string())]);
    match rx.try_recv().unwrap() {
        Event::MetaUpdated { addresses } => assert_eq!(addresses, vec![a(1), a(3)]),
        other => panic!("unexpected {other:?}"),
    }

    // Retry (same params, new job key): only the failed address is redone.
    flaky.source_calls.lock().unwrap().clear();
    let list: Vec<String> = (1..=3).map(|i| format!("{:#x}", a(i))).collect();
    e.ctx
        .store
        .enqueue(&NewJob {
            key: "retry".into(),
            kind: JobKind::ContractMeta,
            params: json!({"addresses": list}),
            priority: eg_core::source::Priority::Low,
            user_id: None,
        })
        .await
        .unwrap();
    let job = e.ctx.store.claim_next().await.unwrap().unwrap();
    ContractMetaHandler.run(&job, &e.ctx).await.unwrap();
    assert_eq!(*flaky.source_calls.lock().unwrap(), vec![a(2)]);
    assert_eq!(
        e.ctx
            .store
            .accounts(&[a(1), a(2), a(3)])
            .await
            .unwrap()
            .len(),
        3
    );
}

async fn meta_fetched(e: &Env, tok: Address) -> Option<chrono::DateTime<chrono::Utc>> {
    sqlx::query_scalar("SELECT meta_fetched_at FROM tokens WHERE address = $1")
        .bind(tok.as_slice().to_vec())
        .fetch_one(e.ctx.store.pool())
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn token_meta_keeps_nft_kind_and_publishes_meta_updated(pool: PgPool) {
    use eg_core::source::TokenInfo;
    use eg_core::types::TransferKind;
    let e = env(pool);
    let nft = a(0x21);
    e.ctx
        .store
        .upsert_tokens(&[TokenInfo {
            address: nft,
            kind: TransferKind::Erc721,
            name: Some("Punk".into()),
            symbol: None,
            decimals: None,
        }])
        .await
        .unwrap();
    // decimals() reverts on an NFT; symbol() answers.
    e.fake.on_eth_call(|_to, _data| {
        Ok(agg_ret(vec![
            (false, vec![]),
            (true, "PNK".abi_encode()),
            (false, vec![]),
        ]))
    });
    let mut rx = e.ctx.bus.subscribe();
    run(
        &e,
        &TokenMetaHandler,
        JobKind::TokenMeta,
        json!({"tokens": [format!("{nft:#x}")]}),
    )
    .await
    .unwrap();
    let t = e.ctx.store.tokens(&[nft]).await.unwrap();
    assert_eq!(t[0].kind, TransferKind::Erc721);
    assert_eq!(t[0].name.as_deref(), Some("Punk"));
    assert_eq!(t[0].symbol.as_deref(), Some("PNK"));
    assert_eq!(t[0].decimals, None);
    assert!(meta_fetched(&e, nft).await.is_some());
    let ttl = IngestConfig::default().meta_ttl;
    assert!(
        e.ctx
            .store
            .tokens_needing_meta(&[nft], ttl)
            .await
            .unwrap()
            .is_empty()
    );
    match rx.try_recv().unwrap() {
        Event::MetaUpdated { addresses } => assert_eq!(addresses, vec![nft]),
        other => panic!("unexpected {other:?}"),
    }
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn token_meta_undecodable_batch_marks_attempted(pool: PgPool) {
    let e = env(pool);
    let (x, y) = (a(0x31), a(0x32));
    e.fake
        .on_eth_call(|_to, _data| Ok(Bytes::from_static(b"garbage")));
    run(
        &e,
        &TokenMetaHandler,
        JobKind::TokenMeta,
        json!({"tokens": [format!("{x:#x}"), format!("{y:#x}")]}),
    )
    .await
    .unwrap();
    let rows = e.ctx.store.tokens(&[x, y]).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|t| t.decimals.is_none() && t.symbol.is_none() && t.name.is_none())
    );
    assert!(meta_fetched(&e, x).await.is_some());
    assert!(meta_fetched(&e, y).await.is_some());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn names_skip_addresses_resolved_within_ttl(pool: PgPool) {
    use eg_store::EnsRow;
    let e = env(pool);
    let (fresh, stale) = (a(1), a(2));
    e.ctx
        .store
        .upsert_ens(&[EnsRow {
            address: fresh,
            name: Some("fresh.eth".into()),
            status: EnsStatus::Ok,
            resolved_at: chrono::Utc::now(),
        }])
        .await
        .unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    e.fake.on_eth_call(move |_to, data| {
        let calls = sub_calls(data);
        s2.lock().unwrap().push(calls.len());
        Ok(agg_ret(vec![(false, vec![]); calls.len()]))
    });
    let list = vec![format!("{fresh:#x}"), format!("{stale:#x}")];
    run(
        &e,
        &ResolveNamesHandler,
        JobKind::ResolveNames,
        json!({"addresses": list}),
    )
    .await
    .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![1]);
    let rows = e.ctx.store.ens(&[fresh, stale]).await.unwrap();
    assert_eq!(rows[0].name.as_deref(), Some("fresh.eth"));
    assert_eq!(rows[1].status, EnsStatus::None);

    // A duplicate job for already-resolved addresses makes no call at all.
    let calls = e.fake.calls();
    run(
        &e,
        &ResolveNamesHandler,
        JobKind::ResolveNames,
        json!({"addresses": [format!("{fresh:#x}")]}),
    )
    .await
    .unwrap();
    assert_eq!(e.fake.calls(), calls);
}
