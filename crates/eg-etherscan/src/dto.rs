//! Etherscan account-API row shapes. Every field is a string on the wire.
use serde::Deserialize;

/// `account/txlist`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRow {
    pub block_number: String,
    pub time_stamp: String,
    pub hash: String,
    pub from: String,
    #[serde(default)]
    pub to: String,
    pub value: String,
    #[serde(default)]
    pub contract_address: String,
    #[serde(default)]
    pub is_error: String,
}

/// `account/txlistinternal`; the txhash-scoped variant omits `hash`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalRow {
    pub block_number: String,
    pub time_stamp: String,
    #[serde(default)]
    pub hash: String,
    pub from: String,
    #[serde(default)]
    pub to: String,
    pub value: String,
    #[serde(default)]
    pub contract_address: String,
    #[serde(default)]
    pub trace_id: String,
    #[serde(default)]
    pub is_error: String,
}

/// `account/tokentx`, `tokennfttx`, `token1155tx`.
#[derive(Debug, Deserialize)]
pub struct TokenRow {
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    #[serde(rename = "timeStamp")]
    pub time_stamp: String,
    pub hash: String,
    pub from: String,
    pub to: String,
    #[serde(rename = "contractAddress")]
    pub contract_address: String,
    #[serde(rename = "tokenName", default)]
    pub token_name: String,
    #[serde(rename = "tokenSymbol", default)]
    pub token_symbol: String,
    #[serde(rename = "tokenDecimal", default)]
    pub token_decimal: String,
    #[serde(default)]
    pub value: String,
    #[serde(rename = "tokenID", default)]
    pub token_id: String,
    #[serde(rename = "tokenValue", default)]
    pub token_value: String,
    #[serde(rename = "logIndex", default)]
    pub log_index: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct SourceCodeRow {
    #[serde(default, rename = "ABI")]
    pub abi: String,
    #[serde(default)]
    pub contract_name: String,
    #[serde(default)]
    pub proxy: String,
    #[serde(default)]
    pub implementation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationRow {
    pub contract_address: String,
    pub contract_creator: String,
    pub tx_hash: String,
}
