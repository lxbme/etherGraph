use std::collections::HashSet;
use std::str::FromStr;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use eg_core::rpc_json::{parse_receipt, parse_tx};
use eg_core::source::{
    ChainSource, ContractCreation, ContractSource, HistoryPage, HistoryQuery, Priority, RawReceipt,
    RawTx, SourceError, TokenInfo,
};
use eg_core::types::{Address, Bytes, Transfer, TransferKind, TxHash, U256, assign_sub_ids};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::client::EtherscanClient;
use crate::dto::{CreationRow, InternalRow, SourceCodeRow, TokenRow, TxRow};

const NOT_VERIFIED: &str = "Contract source code not verified";

pub struct EtherscanSource {
    client: EtherscanClient,
}

fn perr(field: &str, msg: impl std::fmt::Display) -> SourceError {
    SourceError::Parse(format!("{field}: {msg}"))
}

fn dec_u64(field: &str, s: &str) -> Result<u64, SourceError> {
    s.parse().map_err(|e| perr(field, e))
}

fn dec_u256(field: &str, s: &str) -> Result<U256, SourceError> {
    U256::from_str_radix(s, 10).map_err(|e| perr(field, e))
}

fn addr(field: &str, s: &str) -> Result<Address, SourceError> {
    Address::from_str(s).map_err(|e| perr(field, e))
}

fn txhash(field: &str, s: &str) -> Result<TxHash, SourceError> {
    TxHash::from_str(s).map_err(|e| perr(field, e))
}

fn ts(field: &str, s: &str) -> Result<DateTime<Utc>, SourceError> {
    let secs = i64::try_from(dec_u64(field, s)?).map_err(|e| perr(field, e))?;
    DateTime::from_timestamp(secs, 0).ok_or_else(|| perr(field, "timestamp out of range"))
}

fn hex_u64(field: &str, v: &Value) -> Result<u64, SourceError> {
    let s = v.as_str().ok_or_else(|| perr(field, "not a string"))?;
    let h = s
        .strip_prefix("0x")
        .ok_or_else(|| perr(field, "missing 0x prefix"))?;
    u64::from_str_radix(h, 16).map_err(|e| perr(field, e))
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_owned())
}

/// `to`, falling back to `contractAddress` for contract creations.
fn recipient(to: &str, contract: &str) -> Result<Address, SourceError> {
    if to.is_empty() {
        addr("contractAddress", contract)
    } else {
        addr("to", to)
    }
}

fn rows<T: DeserializeOwned>(v: Value) -> Result<Vec<T>, SourceError> {
    serde_json::from_value(v).map_err(|e| SourceError::Parse(e.to_string()))
}

fn map_tx(r: &TxRow) -> Result<Transfer, SourceError> {
    Ok(Transfer {
        tx_hash: txhash("hash", &r.hash)?,
        sub_id: String::new(),
        kind: TransferKind::Native,
        block_number: dec_u64("blockNumber", &r.block_number)?,
        ts: ts("timeStamp", &r.time_stamp)?,
        from: addr("from", &r.from)?,
        to: recipient(&r.to, &r.contract_address)?,
        asset: None,
        amount: dec_u256("value", &r.value)?,
        token_id: None,
        trace_id: None,
        log_index: None,
    })
}

fn map_internal(r: &InternalRow, fallback_hash: Option<TxHash>) -> Result<Transfer, SourceError> {
    let tx_hash = if r.hash.is_empty() {
        fallback_hash.ok_or_else(|| perr("hash", "missing"))?
    } else {
        txhash("hash", &r.hash)?
    };
    Ok(Transfer {
        tx_hash,
        sub_id: String::new(),
        kind: TransferKind::Internal,
        block_number: dec_u64("blockNumber", &r.block_number)?,
        ts: ts("timeStamp", &r.time_stamp)?,
        from: addr("from", &r.from)?,
        to: recipient(&r.to, &r.contract_address)?,
        asset: None,
        amount: dec_u256("value", &r.value)?,
        token_id: None,
        trace_id: non_empty(&r.trace_id),
        log_index: None,
    })
}

fn map_token(kind: TransferKind, r: &TokenRow) -> Result<Transfer, SourceError> {
    let (amount, token_id) = match kind {
        TransferKind::Erc20 => (dec_u256("value", &r.value)?, None),
        TransferKind::Erc721 => (U256::from(1u8), Some(dec_u256("tokenID", &r.token_id)?)),
        _ => (
            dec_u256("tokenValue", &r.token_value)?,
            Some(dec_u256("tokenID", &r.token_id)?),
        ),
    };
    Ok(Transfer {
        tx_hash: txhash("hash", &r.hash)?,
        sub_id: String::new(),
        kind,
        block_number: dec_u64("blockNumber", &r.block_number)?,
        ts: ts("timeStamp", &r.time_stamp)?,
        from: addr("from", &r.from)?,
        to: addr("to", &r.to)?,
        asset: Some(addr("contractAddress", &r.contract_address)?),
        amount,
        token_id,
        trace_id: None,
        log_index: non_empty(&r.log_index)
            .map(|s| dec_u64("logIndex", &s))
            .transpose()?,
    })
}

impl EtherscanSource {
    pub fn new(client: EtherscanClient) -> Self {
        Self { client }
    }

    async fn rpc(
        &self,
        p: Priority,
        action: &str,
        extra: &[(&str, String)],
    ) -> Result<Value, SourceError> {
        let mut params = vec![
            ("module", "proxy".to_owned()),
            ("action", action.to_owned()),
        ];
        params.extend(extra.iter().cloned());
        self.client.call(p, &params).await
    }
}

#[async_trait]
impl ChainSource for EtherscanSource {
    async fn history_page(
        &self,
        p: Priority,
        q: &HistoryQuery,
    ) -> Result<HistoryPage, SourceError> {
        let action = match q.kind {
            TransferKind::Native => "txlist",
            TransferKind::Internal => "txlistinternal",
            TransferKind::Erc20 => "tokentx",
            TransferKind::Erc721 => "tokennfttx",
            TransferKind::Erc1155 => "token1155tx",
        };
        let result = self
            .client
            .call(
                p,
                &[
                    ("module", "account".to_owned()),
                    ("action", action.to_owned()),
                    ("address", format!("{:#x}", q.address)),
                    ("startblock", q.start_block.to_string()),
                    ("endblock", q.end_block.to_string()),
                    ("page", q.page.to_string()),
                    ("offset", q.offset.to_string()),
                    ("sort", "desc".to_owned()),
                ],
            )
            .await?;

        let mut transfers = Vec::new();
        let mut tokens = Vec::new();
        let mut seen = HashSet::new();
        let row_count;
        let mut min_block: Option<u64> = None;
        let mut note_block = |s: &str| -> Result<(), SourceError> {
            let b = dec_u64("blockNumber", s)?;
            min_block = Some(min_block.map_or(b, |m| m.min(b)));
            Ok(())
        };

        match q.kind {
            TransferKind::Native => {
                let rs: Vec<TxRow> = rows(result)?;
                row_count = rs.len();
                for r in &rs {
                    note_block(&r.block_number)?;
                    if r.is_error != "1" {
                        transfers.push(map_tx(r)?);
                    }
                }
            }
            TransferKind::Internal => {
                let rs: Vec<InternalRow> = rows(result)?;
                row_count = rs.len();
                for r in &rs {
                    note_block(&r.block_number)?;
                    if r.is_error != "1" {
                        transfers.push(map_internal(r, None)?);
                    }
                }
            }
            kind => {
                let rs: Vec<TokenRow> = rows(result)?;
                row_count = rs.len();
                for r in &rs {
                    note_block(&r.block_number)?;
                    let t = map_token(kind, r)?;
                    if kind == TransferKind::Erc20 && seen.insert(r.contract_address.clone()) {
                        tokens.push(TokenInfo {
                            address: addr("contractAddress", &r.contract_address)?,
                            kind,
                            name: non_empty(&r.token_name),
                            symbol: non_empty(&r.token_symbol),
                            decimals: non_empty(&r.token_decimal)
                                .map(|s| s.parse::<u8>().map_err(|e| perr("tokenDecimal", e)))
                                .transpose()?,
                        });
                    }
                    transfers.push(t);
                }
            }
        }
        assign_sub_ids(&mut transfers);
        Ok(HistoryPage {
            transfers,
            tokens,
            row_count: u32::try_from(row_count).map_err(|e| perr("row_count", e))?,
            min_block,
        })
    }

    async fn tx(&self, p: Priority, hash: TxHash) -> Result<Option<RawTx>, SourceError> {
        let v = self
            .rpc(
                p,
                "eth_getTransactionByHash",
                &[("txhash", format!("{hash:#x}"))],
            )
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        parse_tx(&v).map(Some)
    }

    async fn receipt(&self, p: Priority, hash: TxHash) -> Result<Option<RawReceipt>, SourceError> {
        let v = self
            .rpc(
                p,
                "eth_getTransactionReceipt",
                &[("txhash", format!("{hash:#x}"))],
            )
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        parse_receipt(&v).map(Some)
    }

    async fn internal_txs(&self, p: Priority, hash: TxHash) -> Result<Vec<Transfer>, SourceError> {
        let result = self
            .client
            .call(
                p,
                &[
                    ("module", "account".to_owned()),
                    ("action", "txlistinternal".to_owned()),
                    ("txhash", format!("{hash:#x}")),
                ],
            )
            .await?;
        let rs: Vec<InternalRow> = rows(result)?;
        let mut out = Vec::new();
        for r in rs.iter().filter(|r| r.is_error != "1") {
            out.push(map_internal(r, Some(hash))?);
        }
        assign_sub_ids(&mut out);
        Ok(out)
    }

    async fn block_timestamp(&self, p: Priority, block: u64) -> Result<DateTime<Utc>, SourceError> {
        let v = self
            .rpc(
                p,
                "eth_getBlockByNumber",
                &[
                    ("tag", format!("{block:#x}")),
                    ("boolean", "false".to_owned()),
                ],
            )
            .await?;
        let t = v
            .get("timestamp")
            .ok_or_else(|| perr("timestamp", "block not found"))?;
        let secs = i64::try_from(hex_u64("timestamp", t)?).map_err(|e| perr("timestamp", e))?;
        DateTime::from_timestamp(secs, 0).ok_or_else(|| perr("timestamp", "out of range"))
    }

    async fn latest_block(&self, p: Priority) -> Result<u64, SourceError> {
        hex_u64("result", &self.rpc(p, "eth_blockNumber", &[]).await?)
    }

    async fn contract_source(
        &self,
        p: Priority,
        a: Address,
    ) -> Result<ContractSource, SourceError> {
        let result = self
            .client
            .call(
                p,
                &[
                    ("module", "contract".to_owned()),
                    ("action", "getsourcecode".to_owned()),
                    ("address", format!("{a:#x}")),
                ],
            )
            .await?;
        let row = rows::<SourceCodeRow>(result)?
            .into_iter()
            .next()
            .ok_or_else(|| perr("getsourcecode", "empty result"))?;
        Ok(ContractSource {
            address: a,
            name: non_empty(&row.contract_name),
            abi_json: (!row.abi.is_empty() && row.abi != NOT_VERIFIED).then_some(row.abi),
            is_proxy: row.proxy == "1",
            implementation: non_empty(&row.implementation)
                .map(|s| addr("Implementation", &s))
                .transpose()?,
        })
    }

    async fn contract_creation(
        &self,
        p: Priority,
        addrs: &[Address],
    ) -> Result<Vec<ContractCreation>, SourceError> {
        assert!(
            addrs.len() <= 5,
            "contract_creation takes at most 5 addresses, got {}",
            addrs.len()
        );
        let list = addrs
            .iter()
            .map(|a| format!("{a:#x}"))
            .collect::<Vec<_>>()
            .join(",");
        let result = self
            .client
            .call(
                p,
                &[
                    ("module", "contract".to_owned()),
                    ("action", "getcontractcreation".to_owned()),
                    ("contractaddresses", list),
                ],
            )
            .await?;
        rows::<CreationRow>(result)?
            .iter()
            .map(|r| {
                Ok(ContractCreation {
                    address: addr("contractAddress", &r.contract_address)?,
                    creator: addr("contractCreator", &r.contract_creator)?,
                    tx_hash: txhash("txHash", &r.tx_hash)?,
                })
            })
            .collect()
    }

    async fn eth_call(&self, p: Priority, to: Address, data: Bytes) -> Result<Bytes, SourceError> {
        let v = self
            .rpc(
                p,
                "eth_call",
                &[
                    ("to", format!("{to:#x}")),
                    ("data", format!("{data}")),
                    ("tag", "latest".to_owned()),
                ],
            )
            .await?;
        let s = v.as_str().ok_or_else(|| perr("result", "not a string"))?;
        Bytes::from_str(s).map_err(|e| perr("result", e))
    }
}
