use std::str::FromStr;
use std::sync::Arc;

use async_trait::async_trait;
use eg_core::source::{CallGate, ChainSource, HistoryQuery, Priority, SourceError, TokenInfo};
use eg_core::types::{Address, TransferKind, TxHash, U256};
use eg_etherscan::{ClientStats, EtherscanClient, EtherscanSource, HttpTransport};
use wiremock::matchers::{method, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct OpenGate;

#[async_trait]
impl CallGate for OpenGate {
    async fn acquire(&self, _p: Priority) -> Result<(), SourceError> {
        Ok(())
    }
    fn on_rate_limited(&self) {}
}

const P: Priority = Priority::Interactive;

fn addr(n: u8) -> Address {
    Address::from_str(&format!("0x{n:040x}")).unwrap()
}

fn hash(n: u8) -> TxHash {
    TxHash::from_str(&format!("0x{n:064x}")).unwrap()
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

async fn serve(server: &MockServer, module: &str, action: &str, body: String) {
    Mock::given(method("GET"))
        .and(query_param("module", module))
        .and(query_param("action", action))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(server)
        .await;
}

fn source(server: &MockServer) -> EtherscanSource {
    let client = EtherscanClient::new(
        Arc::new(HttpTransport::new(&server.uri())),
        Arc::new(OpenGate),
        "k".into(),
        Arc::new(ClientStats::default()),
    );
    EtherscanSource::new(client)
}

fn query(kind: TransferKind) -> HistoryQuery {
    HistoryQuery {
        address: addr(0xa1),
        kind,
        start_block: 0,
        end_block: 99_999_999,
        page: 1,
        offset: 100,
    }
}

async fn history(
    module_action: (&str, &str),
    file: &str,
    kind: TransferKind,
) -> eg_core::source::HistoryPage {
    let server = MockServer::start().await;
    serve(&server, module_action.0, module_action.1, fixture(file)).await;
    source(&server).history_page(P, &query(kind)).await.unwrap()
}

#[tokio::test]
async fn txlist_skips_failed_keeps_zero_value_and_creation() {
    let page = history(("account", "txlist"), "txlist.json", TransferKind::Native).await;
    assert_eq!(page.transfers.len(), 3);
    assert!(page.transfers.iter().all(|t| t.sub_id == "top"));
    assert!(page.transfers.iter().all(|t| t.asset.is_none()));
    assert!(page.transfers.iter().all(|t| t.tx_hash != hash(2)));
    let create = page
        .transfers
        .iter()
        .find(|t| t.tx_hash == hash(3))
        .unwrap();
    assert_eq!(create.to, addr(0xc3));
    let zero = page
        .transfers
        .iter()
        .find(|t| t.tx_hash == hash(4))
        .unwrap();
    assert_eq!(zero.amount, U256::ZERO);
    assert_eq!(
        page.transfers[0].amount,
        U256::from(10u64).pow(U256::from(18u64))
    );
    assert_eq!(page.transfers[0].ts.timestamp(), 1_700_000_100);
}

#[tokio::test]
async fn row_count_includes_skipped_rows() {
    let page = history(("account", "txlist"), "txlist.json", TransferKind::Native).await;
    assert_eq!(page.row_count, 4);
    assert_eq!(page.min_block, Some(97));
}

#[tokio::test]
async fn internal_by_address_skips_errors_and_maps_trace() {
    let page = history(
        ("account", "txlistinternal"),
        "txlistinternal.json",
        TransferKind::Internal,
    )
    .await;
    assert_eq!(page.row_count, 3);
    assert_eq!(page.transfers.len(), 2);
    assert_eq!(page.transfers[0].trace_id.as_deref(), Some("0_1"));
    assert_eq!(page.transfers[1].trace_id, None);
    assert_eq!(page.transfers[1].to, addr(0xc3));
    assert!(page.transfers[0].sub_id.starts_with("internal:eth:"));
}

#[tokio::test]
async fn internal_txs_by_hash_uses_requested_hash() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("action", "txlistinternal"))
        .and(query_param("txhash", format!("{:#x}", hash(1))))
        .respond_with(ResponseTemplate::new(200).set_body_string(fixture("internal_by_hash.json")))
        .mount(&server)
        .await;
    let ts = source(&server).internal_txs(P, hash(1)).await.unwrap();
    assert_eq!(ts.len(), 2);
    assert!(ts.iter().all(|t| t.tx_hash == hash(1)));
    assert!(ts.iter().all(|t| t.kind == TransferKind::Internal));
}

#[tokio::test]
async fn tokentx_maps_asset_and_token_info() {
    let page = history(("account", "tokentx"), "tokentx.json", TransferKind::Erc20).await;
    let usdt = Address::from_str("0xdac17f958d2ee523a2206206994597c13d831ec7").unwrap();
    assert_eq!(page.transfers.len(), 3);
    assert_eq!(page.transfers[0].asset, Some(usdt));
    assert_eq!(page.transfers[0].log_index, Some(5));
    assert_eq!(page.transfers[2].log_index, None);
    assert_eq!(page.tokens.len(), 1);
    assert_eq!(page.tokens[0].address, usdt);
    assert_eq!(page.tokens[0].decimals, Some(6));
    assert_eq!(page.tokens[0].symbol.as_deref(), Some("USDT"));
    assert_eq!(page.tokens[0].name.as_deref(), Some("Tether USD"));
}

#[tokio::test]
async fn tokentx_identical_rows_get_distinct_sub_ids() {
    let page = history(("account", "tokentx"), "tokentx.json", TransferKind::Erc20).await;
    assert_ne!(page.transfers[0].sub_id, page.transfers[1].sub_id);
    assert!(page.transfers[0].sub_id.ends_with(":-:0"));
    assert!(page.transfers[1].sub_id.ends_with(":-:1"));
}

#[tokio::test]
async fn nft_and_1155_amounts() {
    let p721 = history(
        ("account", "tokennfttx"),
        "tokennfttx.json",
        TransferKind::Erc721,
    )
    .await;
    assert_eq!(p721.transfers[0].amount, U256::from(1u8));
    assert_eq!(p721.transfers[0].token_id, Some(U256::from(1234u64)));
    let p1155 = history(
        ("account", "token1155tx"),
        "token1155tx.json",
        TransferKind::Erc1155,
    )
    .await;
    assert_eq!(p1155.transfers[0].amount, U256::from(25u64));
    assert_eq!(p1155.transfers[0].token_id, Some(U256::from(77u64)));
    assert!(p1155.transfers[0].sub_id.contains(":77:"));
}

#[tokio::test]
async fn nft_and_1155_pages_record_token_info() {
    let p721 = history(
        ("account", "tokennfttx"),
        "tokennfttx.json",
        TransferKind::Erc721,
    )
    .await;
    assert_eq!(
        p721.tokens,
        vec![TokenInfo {
            address: addr(0xc3),
            kind: TransferKind::Erc721,
            name: Some("Punk".into()),
            symbol: Some("PNK".into()),
            decimals: None,
        }]
    );
    let p1155 = history(
        ("account", "token1155tx"),
        "token1155tx.json",
        TransferKind::Erc1155,
    )
    .await;
    assert_eq!(
        p1155.tokens,
        vec![TokenInfo {
            address: addr(0xc3),
            kind: TransferKind::Erc1155,
            name: Some("Multi".into()),
            symbol: Some("MLT".into()),
            decimals: None,
        }]
    );
}

#[tokio::test]
async fn malformed_token_decimal_is_unknown_not_an_error() {
    let row = |n: u8, dec: &str| {
        format!(
            r#"{{"blockNumber":"200","timeStamp":"1700000200","hash":"0x{n:064x}","from":"0x{:040x}","to":"0x{:040x}","contractAddress":"0x{:040x}","tokenName":"T","tokenSymbol":"T","tokenDecimal":"{dec}","value":"1","logIndex":"1"}}"#,
            0xa1, 0xb2, n
        )
    };
    let body = format!(
        r#"{{"status":"1","message":"OK","result":[{},{},{}]}}"#,
        row(1, "abc"),
        row(2, "300"),
        row(3, "6")
    );
    let server = MockServer::start().await;
    serve(&server, "account", "tokentx", body).await;
    let page = source(&server)
        .history_page(P, &query(TransferKind::Erc20))
        .await
        .unwrap();
    assert_eq!(page.transfers.len(), 3);
    let dec: Vec<(Address, Option<u8>)> = page
        .tokens
        .iter()
        .map(|t| (t.address, t.decimals))
        .collect();
    assert_eq!(
        dec,
        vec![(addr(1), None), (addr(2), None), (addr(3), Some(6))]
    );
}

#[tokio::test]
async fn unverified_contract_has_no_abi() {
    let server = MockServer::start().await;
    serve(
        &server,
        "contract",
        "getsourcecode",
        fixture("getsourcecode_unverified.json"),
    )
    .await;
    let c = source(&server).contract_source(P, addr(1)).await.unwrap();
    assert_eq!(c.abi_json, None);
    assert_eq!(c.name, None);
    assert!(!c.is_proxy);
    assert_eq!(c.implementation, None);
}

#[tokio::test]
async fn proxy_contract_reports_implementation() {
    let server = MockServer::start().await;
    serve(
        &server,
        "contract",
        "getsourcecode",
        fixture("getsourcecode_verified.json"),
    )
    .await;
    let c = source(&server).contract_source(P, addr(1)).await.unwrap();
    assert!(c.is_proxy);
    assert_eq!(c.implementation, Some(addr(0xd4)));
    assert_eq!(c.name.as_deref(), Some("FiatTokenProxy"));
    assert!(c.abi_json.unwrap().contains("constructor"));
}

#[tokio::test]
async fn contract_creation_maps_rows() {
    let server = MockServer::start().await;
    serve(
        &server,
        "contract",
        "getcontractcreation",
        fixture("getcontractcreation.json"),
    )
    .await;
    let v = source(&server)
        .contract_creation(P, &[addr(0xc3)])
        .await
        .unwrap();
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].address, addr(0xc3));
    assert_eq!(v[0].creator, addr(0xa1));
    assert_eq!(v[0].tx_hash, hash(3));
}

#[tokio::test]
#[should_panic]
async fn contract_creation_over_five_panics() {
    let server = MockServer::start().await;
    let addrs: Vec<Address> = (1..=6).map(addr).collect();
    let _ = source(&server).contract_creation(P, &addrs).await;
}

#[tokio::test]
async fn block_timestamp_parses_hex() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("action", "eth_getBlockByNumber"))
        .and(query_param("tag", "0x64"))
        .respond_with(ResponseTemplate::new(200).set_body_string(fixture("block.json")))
        .mount(&server)
        .await;
    let ts = source(&server).block_timestamp(P, 100).await.unwrap();
    assert_eq!(ts.timestamp(), 1_700_000_000);
}

#[tokio::test]
async fn latest_block_and_eth_call() {
    let server = MockServer::start().await;
    serve(
        &server,
        "proxy",
        "eth_blockNumber",
        r#"{"jsonrpc":"2.0","id":1,"result":"0x10"}"#.into(),
    )
    .await;
    Mock::given(method("POST"))
        .and(wiremock::matchers::body_string_contains("action=eth_call"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(r#"{"jsonrpc":"2.0","id":1,"result":"0xdeadbeef"}"#),
        )
        .mount(&server)
        .await;
    let s = source(&server);
    assert_eq!(s.latest_block(P).await.unwrap(), 16);
    let out = s
        .eth_call(P, addr(1), vec![0x12, 0x34].into())
        .await
        .unwrap();
    assert_eq!(out.to_vec(), vec![0xde, 0xad, 0xbe, 0xef]);
}

#[tokio::test]
async fn tx_not_found_is_none() {
    let server = MockServer::start().await;
    serve(
        &server,
        "proxy",
        "eth_getTransactionByHash",
        r#"{"jsonrpc":"2.0","id":1,"result":null}"#.into(),
    )
    .await;
    serve(
        &server,
        "proxy",
        "eth_getTransactionReceipt",
        r#"{"jsonrpc":"2.0","id":1,"result":null}"#.into(),
    )
    .await;
    let s = source(&server);
    assert!(s.tx(P, hash(9)).await.unwrap().is_none());
    assert!(s.receipt(P, hash(9)).await.unwrap().is_none());
}

#[tokio::test]
async fn tx_and_receipt_found() {
    let server = MockServer::start().await;
    let h = format!("{:#x}", hash(9));
    let tx = format!(
        r#"{{"jsonrpc":"2.0","id":1,"result":{{"hash":"{h}","from":"{:#x}","to":null,"value":"0x1","input":"0x","blockNumber":"0x10"}}}}"#,
        addr(1)
    );
    serve(&server, "proxy", "eth_getTransactionByHash", tx).await;
    serve(
        &server,
        "proxy",
        "eth_getTransactionReceipt",
        r#"{"jsonrpc":"2.0","id":1,"result":{"status":"0x1","gasUsed":"0x5208","logs":[]}}"#.into(),
    )
    .await;
    let s = source(&server);
    let t = s.tx(P, hash(9)).await.unwrap().unwrap();
    assert_eq!(t.block_number, Some(16));
    let r = s.receipt(P, hash(9)).await.unwrap().unwrap();
    assert!(r.success);
}
