//! Import of the open `dawsbot/eth-labels` dataset (`address,chainId,label,nameTag`):
//! slug -> category mapping, per-address aggregation and the two datasets written.

use std::collections::{BTreeMap, HashSet};
use std::io::Read;

use eg_core::types::{Address, category_rank};
use eg_store::Store;
use serde::Deserialize;

use crate::parse::parse_address;

/// Longest label text, in characters.
const MAX_TEXT_CHARS: usize = 64;

/// Dataset of the rows on Ethereum mainnet (`chainId == 1`).
pub const MAINNET_DATASET: &str = "eth-labels";
/// Dataset of other-chain rows whose address has no mainnet row.
pub const XCHAIN_DATASET: &str = "eth-labels-xchain";

const CEX: &[&str] = &[
    "exchange",
    "hot-wallet",
    "cold-wallet",
    "binance",
    "binance-pegged",
    "bitget",
    "deribit",
    "bilaxy",
    "coinbase",
    "bitfinex",
    "kraken",
    "bithumb",
    "kucoin",
    "okx",
    "ftx",
    "coindcx",
    "coinsquare",
    "poloniex",
    "coinspot",
    "crypto-com",
    "gate",
    "gate-io",
    "coinw",
    "hotbit",
    "hoo-com",
    "bitvavo",
    "latoken",
    "mexc",
    "coinex",
    "gemini",
    "hitbtc",
    "upbit",
    "coinmetro",
    "altcoin-trader",
    "bitstamp",
    "btcturk",
    "gmo-coin",
    "korbit",
    "bitcoin-suisse",
    "ascendex",
    "bitvenus",
    "coinhako",
    "digifinex",
    "btse",
    "woo",
    "bitbank",
    "bitflyer",
    "bullish",
    "indodax",
    "bitmart",
    "paribu",
    "bittrex",
    "cobinhood",
    "coinbit",
    "coincheck",
    "coinjar",
    "coinlist",
    "coin-list",
    "coinone",
    "kryptono",
    "resfinex",
    "zb-com",
    "abcc",
    "azbit",
    "bgogo",
    "coinsbit",
    "difx",
    "fairdesk",
    "quadrigacx",
    "remitano",
    "topbtc",
    "yunbi",
    "allbit",
    "bigone",
    "bitkan",
    "bitmex",
    "catex",
    "cex-io",
    "coinstore",
    "delta-exchange",
    "fastex",
    "firi",
    "kanga",
    "tidex",
    "uphold",
    "wirex",
    "bitbuy",
    "blofin-exchange",
    "coinzix",
    "crex24",
    "dex-trade",
    "digital-surge",
    "etoro",
    "phemex",
    "liquid",
    "lcx-ag",
    "maskex",
    "trade-io",
    "shakepay",
    "coss-io",
    "changenow",
    "revolut",
    "nexo",
    "celsius-network",
    "blockfi",
    "bitpay",
    "coinspaid",
    "alphapo",
    "fiat-gateway",
    "bitpie",
];
const DEX: &[&str] = &[
    "dex",
    "uniswap",
    "sushiswap",
    "balancer",
    "bancor",
    "burgerswap",
    "bscswap",
    "pancakeswap",
    "kyberswap",
    "curve-finance",
    "curve-fi",
    "1inch",
    "0x-protocol",
    "0x-protocol-ecosystem",
    "airswap",
    "cow-protocol",
    "paraswap",
    "velora",
    "tokenlon",
    "trader-joe",
    "solidly",
    "camelot",
    "swipeswap",
    "pharaoh-exchange",
    "maverick",
    "saddle-finance",
    "loopring",
    "dydx",
    "idex",
    "clipper",
    "dex-ag",
    "dutchx",
    "ambient",
    "rubicon",
    "mdex",
    "openocean",
    "gammaswap",
    "ubeswap",
    "sorbet-finance",
    "switcheo",
    "dinngo",
    "mcdex",
    "hydro-protocol",
    "basin",
    "arrakis",
    "vvs-finance",
    "aster",
    "lighter",
    "gluex",
];
const DEFI: &[&str] = &[
    "defi",
    "aave",
    "compound",
    "compound-governance",
    "maker",
    "sky",
    "maker-vault-owner",
    "yearn",
    "yearn-vault",
    "pendle",
    "synthetix",
    "liquity",
    "frax-finance",
    "morpho",
    "euler",
    "gearbox-protocol",
    "convex-finance",
    "aura-finance",
    "idle-finance",
    "alchemix-finance",
    "cream-finance",
    "mstable",
    "tokemak",
    "set-protocol",
    "index-protocol",
    "spool-finance",
    "yield-farming",
    "vaults",
    "ondo-finance",
    "real-world-assets",
    "enzyme-finance",
    "reflexer-finance",
    "rari-capital",
    "olympusdao",
    "dforce",
    "pooltogether",
    "nexus-mutual",
    "abracadabra-money",
    "inverse-finance",
    "fei-protocol",
    "ribbon-finance",
    "opyn",
    "premia",
    "lyra-finance",
    "lyra",
    "gmx",
    "aevo",
    "venus",
    "venus-protocol",
    "instadapp",
    "defi-saver",
    "beefy",
    "harvest-finance",
    "zapper-fi",
    "furucombo",
    "uncx-network",
    "pareto",
    "superform",
    "solv-protocol",
    "cap-finance",
    "yield-basis",
    "vesper-finance",
    "bzx",
    "fortube",
    "unit-protocol",
    "kuma-protocol",
    "saffron-finance",
    "sablier",
    "maple",
    "ethena",
    "usual",
    "spark",
    "gravita",
    "impermax",
    "dolomite",
    "infinifi",
    "royco-protocol",
    "reserve-protocol",
    "ampleforth",
    "empty-set-dollar",
    "yam-finance",
    "value-defi",
    "augmented-finance",
    "fringe-finance",
    "jarvis-network",
    "nest-protocol",
    "alchemist-coin",
    "loans",
    "liquidity",
    "farming",
    "stake-dao",
    "asymmetry-finance",
    "treehouse",
    "redacted-cartel",
    "hakka-finance",
    "ooki",
    "sweep-protocol",
];
const BRIDGE: &[&str] = &[
    "bridge",
    "bridged-token",
    "multichain",
    "hop-protocol",
    "wormhole",
    "axelar",
    "across-protocol",
    "stargate",
    "synapse",
    "celer-network",
    "connext",
    "layer-2",
    "arbitrum",
    "arbitrum-one",
    "arbitrum-nova",
    "optimism",
    "optimism-bridge",
    "polygon",
    "scroll",
    "scroll-network",
    "zksync",
    "starknet",
    "base",
    "blast",
    "linea",
    "mantle",
    "metis-andromeda",
    "kroma",
    "taiko",
    "ink",
    "allbridge",
    "debridge",
    "layerzero",
    "nitro",
    "xy-finance",
    "interport-finance",
    "everclear",
    "rhino-fi",
    "optics",
    "omg-network",
    "cross-chain",
    "agglayer",
    "zircuit",
    "ren",
    "poa-network",
    "wbtc-merchant",
];
const MIXER: &[&str] = &[
    "mixer",
    "tornado-cash",
    "typhoon-cash",
    "typhoon-network",
    "ethereum-mixer",
];
const SCAM: &[&str] = &[
    "phish-hack",
    "scam",
    "spam-token",
    "something-fishy",
    "high-risk",
    "brand-infringement",
    "flagged-by-sec",
];
const SANCTIONED: &[&str] = &["ofac-sanctions-lists", "ofac-sanctioned", "blocked"];
const HACKER: &[&str] = &["heist", "exploit", "cpimp-attack"];
const MEV: &[&str] = &[
    "mev-bot",
    "mev-builder",
    "backrunning-bots",
    "backrunning-bot",
    "mev-relay",
];
const FUND: &[&str] = &[
    "fund",
    "wintermute",
    "alameda-research",
    "galaxy-digital",
    "a16z",
    "polychain",
    "defiance-capital",
    "venture-capital",
    "investment",
    "asset-management",
    "company-funds",
    "dao-funds",
    "otc",
    "blackrock",
    "anchorage",
    "anchorage-digital",
    "copper",
    "bitgo",
    "cobo",
    "trading",
];
const NFT: &[&str] = &[
    "nft",
    "opensea",
    "looksrare",
    "blur-io",
    "rarible",
    "superrare",
    "nifty-gateway",
    "element",
    "sudoswap",
    "marketplace",
    "art-blocks",
    "zora",
    "cryptopunks",
    "cryptokitties",
    "rtfkt",
    "gem",
];
const STAKING: &[&str] = &[
    "staking",
    "validator",
    "validator-group",
    "avs-operator",
    "actively-validated-service",
    "proposer-fee-recipient",
    "lido",
    "eigenlayer",
    "symbiotic",
    "ether-fi",
    "kelp-dao",
    "renzo-protocol",
    "liquid-staking",
    "mining",
    "miningpoolhub",
    "f2pool",
    "figment-networks",
    "ledger-by-figment",
    "chorus-one",
    "stake-fish",
    "bison-trails",
    "block-daemon",
    "mellow",
    "masternode",
];

/// Category of an eth-labels `label` slug; unlisted slugs are `other`.
pub fn slug_category(slug: &str) -> &'static str {
    let tables: [(&'static str, &[&str]); 12] = [
        ("cex", CEX),
        ("dex", DEX),
        ("defi", DEFI),
        ("bridge", BRIDGE),
        ("mixer", MIXER),
        ("scam", SCAM),
        ("sanctioned", SANCTIONED),
        ("hacker", HACKER),
        ("mev", MEV),
        ("fund", FUND),
        ("nft", NFT),
        ("staking", STAKING),
    ];
    if let Some((cat, _)) = tables.iter().find(|(_, slugs)| slugs.contains(&slug)) {
        return cat;
    }
    if slug.ends_with("-exploit") {
        return "hacker";
    }
    "other"
}

/// Category hinted by keywords in a free-text name tag, if any.
pub fn name_category(name_tag: &str) -> Option<&'static str> {
    let lower = name_tag.to_lowercase();
    if lower.contains("exploit") || lower.contains("hacker") {
        Some("hacker")
    } else if lower.contains("phish") {
        Some("scam")
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
pub struct EthLabelRow {
    pub address: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    pub label: String,
    #[serde(rename = "nameTag")]
    pub name_tag: String,
}

type Out = Vec<(Address, String, String)>;

/// `hot-wallet` -> `Hot Wallet`.
fn readable(slug: &str) -> String {
    slug.split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            cs.next()
                .map(|f| f.to_uppercase().chain(cs).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn label_text(row: &EthLabelRow) -> String {
    let tag = row.name_tag.trim();
    let text = if tag.is_empty() {
        readable(row.label.trim())
    } else {
        tag.to_owned()
    };
    if text.chars().count() > MAX_TEXT_CHARS {
        let mut cut: String = text.chars().take(MAX_TEXT_CHARS - 1).collect();
        cut.push('\u{2026}');
        cut
    } else {
        text
    }
}

fn keep_best(
    map: &mut BTreeMap<(Address, String), &'static str>,
    key: (Address, String),
    cat: &'static str,
) {
    map.entry(key)
        .and_modify(|c| {
            if category_rank(cat) < category_rank(c) {
                *c = cat;
            }
        })
        .or_insert(cat);
}

/// Splits rows into `(mainnet, xchain, skipped)`; see the task brief for the rules.
pub fn aggregate(rows: impl IntoIterator<Item = EthLabelRow>) -> (Out, Out, u64) {
    let mut main: BTreeMap<(Address, String), &'static str> = BTreeMap::new();
    let mut other: BTreeMap<(Address, String), &'static str> = BTreeMap::new();
    let mut on_mainnet: HashSet<Address> = HashSet::new();
    let mut skipped = 0u64;
    for row in rows {
        // Dataset casing is not trusted: parse the lowercase form, no checksum.
        let Ok(addr) = parse_address(&row.address.trim().to_ascii_lowercase()) else {
            skipped += 1;
            continue;
        };
        let slug_cat = slug_category(row.label.trim());
        let cat = match name_category(&row.name_tag) {
            Some(n) if category_rank(n) < category_rank(slug_cat) => n,
            _ => slug_cat,
        };
        let text = label_text(&row);
        if text.is_empty() {
            skipped += 1;
            continue;
        }
        let key = (addr, text);
        if row.chain_id == 1 {
            on_mainnet.insert(addr);
            keep_best(&mut main, key, cat);
        } else {
            keep_best(&mut other, key, cat);
        }
    }
    let flat =
        |m: BTreeMap<(Address, String), &'static str>, keep: &dyn Fn(&Address) -> bool| -> Out {
            m.into_iter()
                .filter(|((a, _), _)| keep(a))
                .map(|((a, t), c)| (a, t, c.to_owned()))
                .collect()
        };
    let mainnet = flat(main, &|_| true);
    let xchain = flat(other, &|a| !on_mainnet.contains(a));
    (mainnet, xchain, skipped)
}

/// Replaces both eth-labels datasets from the CSV. Returns
/// `(mainnet, xchain, skipped)`; malformed records count as skipped.
pub async fn import_eth_labels(
    store: &Store,
    reader: impl Read,
) -> anyhow::Result<(u64, u64, u64)> {
    let mut csv = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .from_reader(reader);
    anyhow::ensure!(
        csv.headers()?
            .iter()
            .eq(["address", "chainId", "label", "nameTag"]),
        "CSV header must be address,chainId,label,nameTag"
    );
    let mut rows = Vec::new();
    let mut malformed = 0u64;
    for rec in csv.deserialize::<EthLabelRow>() {
        match rec {
            Ok(r) => rows.push(r),
            Err(_) => malformed += 1,
        }
    }
    let (mainnet, xchain, skipped) = aggregate(rows);
    let m = store.replace_import(MAINNET_DATASET, &mainnet).await?;
    let x = store.replace_import(XCHAIN_DATASET, &xchain).await?;
    Ok((m, x, skipped + malformed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(address: &str, chain_id: u64, label: &str, name_tag: &str) -> EthLabelRow {
        EthLabelRow {
            address: address.into(),
            chain_id,
            label: label.into(),
            name_tag: name_tag.into(),
        }
    }

    const A: &str = "0x00000000000000000000000000000000000000a1";
    const B: &str = "0x00000000000000000000000000000000000000b2";

    #[test]
    fn slug_table_samples() {
        for (slug, cat) in [
            ("okx", "cex"),
            ("uniswap", "dex"),
            ("tornado-cash", "mixer"),
            ("bybit-exploit", "hacker"),
            ("ofac-sanctioned", "sanctioned"),
            ("mev-bot", "mev"),
            ("opensea", "nft"),
            ("lido", "staking"),
            ("wintermute", "fund"),
            ("take-action", "other"),
        ] {
            assert_eq!(slug_category(slug), cat, "{slug}");
        }
    }

    #[test]
    fn name_keywords_raise_only() {
        let (m, _, _) = aggregate([row(A, 1, "dex", "Fake_Phishing123")]);
        assert_eq!(m[0].2, "scam");
        let (m, _, _) = aggregate([row(A, 1, "ofac-sanctioned", "Exploiter 1")]);
        assert_eq!(m[0].2, "sanctioned");
        assert_eq!(name_category("The HACKER"), Some("hacker"));
        assert_eq!(name_category("plain"), None);
    }

    #[test]
    fn aggregate_mainnet_and_xchain() {
        let (m, x, skipped) = aggregate([
            row(A, 1, "okx", "OKX 1"),
            row(A, 8453, "okx", "OKX 1"),
            row(B, 480, "okx", "OKX: Hot Wallet 3"),
            row(B, 43114, "okx", "OKX: Hot Wallet 3"),
        ]);
        assert_eq!(skipped, 0);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].0, A.parse::<Address>().unwrap());
        assert_eq!(x.len(), 1);
        assert_eq!(x[0].0, B.parse::<Address>().unwrap());
        assert_eq!(
            (x[0].1.as_str(), x[0].2.as_str()),
            ("OKX: Hot Wallet 3", "cex")
        );
    }

    #[test]
    fn empty_name_and_long_text() {
        let long = "x".repeat(80);
        let (m, _, _) = aggregate([row(A, 1, "hot-wallet", ""), row(B, 1, "other", &long)]);
        assert_eq!(m[0].1, "Hot Wallet");
        assert_eq!(m[0].2, "cex");
        assert_eq!(m[1].1.chars().count(), 64);
        assert!(m[1].1.ends_with('\u{2026}'));
    }

    #[test]
    fn mixed_case_address_dedupes() {
        let checksummed = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
        let (m, _, skipped) = aggregate([
            row(checksummed, 1, "lido", "Lido"),
            row(&checksummed.to_lowercase(), 1, "staking", "Lido"),
            row(
                &checksummed.to_uppercase().replace("0X", "0x"),
                1,
                "lido",
                "Lido",
            ),
        ]);
        assert_eq!((m.len(), skipped), (1, 0));
    }

    #[test]
    fn bad_checksum_mixed_case_is_accepted_and_dedupes() {
        // Valid checksum is ...6045; flip the case of one letter to break it.
        let bad = "0xd8Da6BF26964aF9D7eEd9e03E53415D37aA96045";
        assert!(parse_address(bad).is_err());
        let (m, _, skipped) = aggregate([
            row(bad, 1, "lido", "Lido"),
            row(&bad.to_lowercase(), 1, "lido", "Lido"),
            row(&bad.replacen("0x", "0X", 1), 1, "lido", "Lido"),
        ]);
        assert_eq!((m.len(), skipped), (1, 0));
    }

    #[test]
    fn empty_label_and_name_is_skipped() {
        let (m, _, skipped) = aggregate([row(A, 1, "", "")]);
        assert_eq!((m.len(), skipped), (0, 1));
    }

    #[test]
    fn bad_address_counts_skipped() {
        let (m, x, skipped) = aggregate([row("nope", 1, "okx", "x"), row(A, 1, "okx", "x")]);
        assert_eq!((m.len(), x.len(), skipped), (1, 0, 1));
    }

    #[test]
    fn highest_priority_category_wins_per_key() {
        let (m, _, _) = aggregate([row(A, 1, "uniswap", "T"), row(A, 1, "tornado-cash", "T")]);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].2, "mixer");
    }
}
