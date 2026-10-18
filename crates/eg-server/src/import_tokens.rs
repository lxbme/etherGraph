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
}

/// Mainnet tokens of a token-list JSON, one row per address with `tag`.
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
        let addr = serde_json::from_value::<ListToken>(v)
            .ok()
            .filter(|t| t.chain_id == 1)
            .and_then(|t| lenient_address(&t.address));
        match addr {
            Some(a) if seen.insert(a) => rows.push(TokenTagRow {
                address: a,
                source: source.into(),
                tag: tag.into(),
                website: None,
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
    website: String,
}

/// Mainnet rows of the eth-labels tokens CSV: tag = lowercased `label`.
fn parse_eth_labels(reader: impl Read) -> anyhow::Result<(Vec<TokenTagRow>, u64)> {
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
            Some((addr, tag, website))
        });
        let Some((address, tag, website)) = parsed else {
            skipped += 1;
            continue;
        };
        match index.get(&(address, tag.clone())) {
            Some(&i) => {
                // A repeated (address, tag) keeps the first non-NULL website.
                if rows[i].website.is_none() {
                    rows[i].website = website;
                }
                skipped += 1;
            }
            None => {
                index.insert((address, tag.clone()), rows.len());
                rows.push(TokenTagRow {
                    address,
                    source: "eth-labels".into(),
                    tag,
                    website,
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
    match format {
        TokenFormat::Uniswap => parse_token_list(reader, "uniswap", "default-list"),
        TokenFormat::Coingecko => parse_token_list(reader, "coingecko", "listed"),
        TokenFormat::EthLabels => parse_eth_labels(reader),
    }
}

/// Replaces the format's source in `token_tags`. Returns `(imported, skipped)`.
pub async fn import_tokens(
    store: &Store,
    format: TokenFormat,
    reader: impl Read,
) -> anyhow::Result<(u64, u64)> {
    let (rows, skipped) = parse_tokens(format, reader)?;
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
