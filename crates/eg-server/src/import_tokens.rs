//! `import-tokens`: loads a curated token list (Uniswap or CoinGecko token-list
//! JSON, or the eth-labels tokens CSV) into `token_tags`.

use std::collections::HashMap;
use std::io::Read;

use eg_core::types::Address;
use eg_store::{Store, TokenTagRow};
use serde::Deserialize;

use crate::parse::parse_address;

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum TokenFormat {
    Uniswap,
    Coingecko,
    EthLabels,
}

impl TokenFormat {
    /// The `token_tags.source` the format writes.
    pub fn source(self) -> &'static str {
        match self {
            Self::Uniswap => "uniswap",
            Self::Coingecko => "coingecko",
            Self::EthLabels => "eth-labels",
        }
    }
}

/// Lenient like the eth-labels accounts: any case is accepted.
fn lenient_address(s: &str) -> Option<Address> {
    parse_address(&s.trim().to_ascii_lowercase()).ok()
}

#[derive(Deserialize)]
struct TokenList {
    tokens: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct ListToken {
    #[serde(rename = "chainId")]
    chain_id: u64,
    address: String,
    /// Kept only when a string: a malformed symbol or name does not drop the token.
    #[serde(default)]
    symbol: serde_json::Value,
    #[serde(default)]
    name: serde_json::Value,
}

/// A list's symbol or name: trimmed, `None` when blank or a placeholder.
fn meta_text(s: &str) -> Option<String> {
    let s = s.trim();
    let placeholder = ["", "null", "undefined", "none"]
        .iter()
        .any(|p| s.eq_ignore_ascii_case(p));
    (!placeholder).then(|| s.to_owned())
}

/// Mainnet tokens of a token-list JSON, one row per address with `tag` and
/// the entry's symbol and name.
/// Returns `(rows, skipped)`; other chains and malformed entries are skipped.
fn parse_token_list(
    reader: impl Read,
    source: &str,
    tag: &str,
) -> anyhow::Result<(Vec<TokenTagRow>, u64)> {
    let list: TokenList = serde_json::from_reader(reader)?;
    let mut rows: Vec<TokenTagRow> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut skipped = 0u64;
    for v in list.tokens {
        let token = serde_json::from_value::<ListToken>(v)
            .ok()
            .filter(|t| t.chain_id == 1)
            .and_then(|t| Some((lenient_address(&t.address)?, t)));
        match token {
            Some((a, t)) if seen.insert(a) => rows.push(TokenTagRow {
                address: a,
                source: source.into(),
                tag: tag.into(),
                website: None,
                symbol: t.symbol.as_str().and_then(meta_text),
                name: t.name.as_str().and_then(meta_text),
            }),
            _ => skipped += 1,
        }
    }
    Ok((rows, skipped))
}

#[derive(Deserialize)]
struct CsvRecord {
    address: String,
    #[serde(rename = "chainId")]
    chain_id: u64,
    label: String,
    name: String,
    symbol: String,
    website: String,
}

/// Mainnet rows of the eth-labels tokens CSV: tag = lowercased `label`, with
/// the row's symbol and name.
fn parse_eth_labels(reader: impl Read, source: &str) -> anyhow::Result<(Vec<TokenTagRow>, u64)> {
    let mut csv = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(reader);
    anyhow::ensure!(
        csv.headers()?.iter().eq([
            "address", "chainId", "label", "name", "symbol", "website", "image"
        ]),
        "CSV header must be address,chainId,label,name,symbol,website,image"
    );
    let mut rows: Vec<TokenTagRow> = Vec::new();
    let mut index: HashMap<(Address, String), usize> = HashMap::new();
    let mut skipped = 0u64;
    for rec in csv.deserialize::<CsvRecord>() {
        let parsed = rec.ok().filter(|r| r.chain_id == 1).and_then(|r| {
            let addr = lenient_address(&r.address)?;
            let tag = r.label.trim().to_ascii_lowercase();
            if matches!(tag.as_str(), "" | "null" | "undefined" | "none") {
                return None;
            }
            let site = r.website.trim();
            let website = (site.starts_with("http://") || site.starts_with("https://"))
                .then(|| site.to_owned());
            Some((addr, tag, website, meta_text(&r.symbol), meta_text(&r.name)))
        });
        let Some((address, tag, website, symbol, name)) = parsed else {
            skipped += 1;
            continue;
        };
        match index.get(&(address, tag.clone())) {
            Some(&i) => {
                // A repeated (address, tag) keeps the first non-NULL website,
                // symbol and name.
                let row = &mut rows[i];
                row.website = row.website.take().or(website);
                row.symbol = row.symbol.take().or(symbol);
                row.name = row.name.take().or(name);
                skipped += 1;
            }
            None => {
                index.insert((address, tag.clone()), rows.len());
                rows.push(TokenTagRow {
                    address,
                    source: source.into(),
                    tag,
                    website,
                    symbol,
                    name,
                });
            }
        }
    }
    Ok((rows, skipped))
}

/// Parses the list without touching the database: `(rows, skipped)`.
pub fn parse_tokens(
    format: TokenFormat,
    reader: impl Read,
) -> anyhow::Result<(Vec<TokenTagRow>, u64)> {
    let source = format.source();
    match format {
        TokenFormat::Uniswap => parse_token_list(reader, source, "default-list"),
        TokenFormat::Coingecko => parse_token_list(reader, source, "listed"),
        TokenFormat::EthLabels => parse_eth_labels(reader, source),
    }
}

/// Replaces the format's source in `token_tags`. Returns `(imported, skipped)`.
/// A parse that yields no rows is an error (a wrong file must not wipe the
/// source) and leaves the database untouched.
pub async fn import_tokens(
    store: &Store,
    format: TokenFormat,
    reader: impl Read,
) -> anyhow::Result<(u64, u64)> {
    let (rows, skipped) = parse_tokens(format, reader)?;
    anyhow::ensure!(
        !rows.is_empty(),
        "no mainnet rows parsed ({skipped} skipped); refusing to replace source {}",
        format.source()
    );
    let imported = store.replace_token_tags(format.source(), &rows).await?;
    Ok((imported, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::ValueEnum;

    const A: &str = "0x00000000000000000000000000000000000000a1";
    const B: &str = "0x00000000000000000000000000000000000000b2";

    #[test]
    fn token_list_filters_chain_dedupes_and_skips_malformed() {
        let json = format!(
            r#"{{"tokens":[
              {{"chainId":1,"address":"{a}"}},
              {{"chainId":1,"address":"{a_up}"}},
              {{"chainId":10,"address":"{b}"}},
              {{"chainId":1,"address":"nonsense"}},
              {{"chainId":1,"address":"{b}","symbol":"B"}},
              {{"address":"{b}"}}
            ]}}"#,
            a = A,
            a_up = A.to_uppercase().replace("0X", "0x"),
            b = B
        );
        let (rows, skipped) = parse_tokens(TokenFormat::Uniswap, json.as_bytes()).unwrap();
        assert_eq!(skipped, 4);
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .all(|r| r.source == "uniswap" && r.tag == "default-list" && r.website.is_none())
        );
        let (rows, _) = parse_tokens(TokenFormat::Coingecko, json.as_bytes()).unwrap();
        assert!(
            rows.iter()
                .all(|r| r.source == "coingecko" && r.tag == "listed")
        );
    }

    #[test]
    fn eth_labels_tags_websites_and_dedupe() {
        let csv = format!(
            "address,chainId,label,name,symbol,website,image\n\
             {a},1,Stablecoin,N,S,https://a.io/,x\n\
             {a},137,defi,N,S,https://a.io/,x\n\
             {a},1,defi,N,S,null,x\n\
             {a},1,defi,N,S,/token/x,x\n\
             {a},1,defi,N,S,http://late.io,x\n\
             {a},1,defi,N,S,https://other.io,x\n\
             {b},1,null,N,S,https://b.io,x\n\
             {b},1,Undefined,N,S,https://b.io,x\n\
             {b},1,NONE,N,S,https://b.io,x\n\
             {b},1,,N,S,https://b.io,x\n\
             {b},1,meme,N,S,,x\n\
             bad,1,meme,N,S,,x\n",
            a = A,
            b = B
        );
        let (rows, skipped) = parse_tokens(TokenFormat::EthLabels, csv.as_bytes()).unwrap();
        let got: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.address.to_string().to_lowercase(),
                    r.tag.as_str(),
                    r.website.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                (A.to_owned(), "stablecoin", Some("https://a.io/")),
                (A.to_owned(), "defi", Some("http://late.io")),
                (B.to_owned(), "meme", None),
            ]
        );
        assert!(rows.iter().all(|r| r.source == "eth-labels"));
        // 1 other chain, 3 repeated (address, tag), 4 placeholders, 1 bad address.
        assert_eq!(skipped, 1 + 3 + 4 + 1);
    }

    #[test]
    fn token_list_keeps_symbol_and_name() {
        let json = format!(
            r#"{{"tokens":[
              {{"chainId":1,"address":"{A}","symbol":"USDT","name":"Tether USD"}},
              {{"chainId":1,"address":"{B}","symbol":"  ","name":7}}
            ]}}"#
        );
        let (rows, skipped) = parse_tokens(TokenFormat::Coingecko, json.as_bytes()).unwrap();
        assert_eq!(skipped, 0);
        let got: Vec<_> = rows
            .iter()
            .map(|r| (r.symbol.as_deref(), r.name.as_deref()))
            .collect();
        assert_eq!(got, [(Some("USDT"), Some("Tether USD")), (None, None)]);
    }

    #[test]
    fn eth_labels_keeps_symbol_and_name() {
        let csv = format!(
            "address,chainId,label,name,symbol,website,image\n\
             {A},1,spam-token,Tether USD,USDT,,x\n\
             {A},1,meme,null,,,x\n\
             {B},1,meme,,,,x\n\
             {B},1,meme,Late,LT,,x\n"
        );
        let (rows, _) = parse_tokens(TokenFormat::EthLabels, csv.as_bytes()).unwrap();
        let got: Vec<_> = rows
            .iter()
            .map(|r| (r.tag.as_str(), r.symbol.as_deref(), r.name.as_deref()))
            .collect();
        assert_eq!(
            got,
            [
                ("spam-token", Some("USDT"), Some("Tether USD")),
                ("meme", None, None),
                // A repeated (address, tag) fills what the first row lacked.
                ("meme", Some("LT"), Some("Late")),
            ]
        );
    }

    #[test]
    fn wrong_csv_header_is_an_error() {
        assert!(parse_tokens(TokenFormat::EthLabels, "a,b\n".as_bytes()).is_err());
    }

    #[test]
    fn unknown_format_is_a_usage_error() {
        assert!(TokenFormat::from_str("bogus", true).is_err());
        assert_eq!(
            TokenFormat::from_str("eth-labels", true).unwrap(),
            TokenFormat::EthLabels
        );
    }
}
