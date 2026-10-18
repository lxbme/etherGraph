//! Token trust levels: listed (Uniswap or CoinGecko list), scam (eth-labels
//! `spam-token` or a `scam` label), suspicious (copies a listed token's symbol
//! or name) and unknown.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use eg_core::source::TokenInfo;
use eg_core::types::{Address, TransferKind};
use eg_store::{ListedTokenRow, Store, StoreError};
use unicode_normalization::UnicodeNormalization;

use crate::dto::{ImpersonatedDto, TrustDto, hex_addr};

/// How long a loaded index is served before it is reloaded.
pub const TRUST_TTL: Duration = Duration::from_secs(60);

/// Shortest normalized name that is matched (shorter names collide too often).
const MIN_NAME_LEN: usize = 4;

/// Latin look-alike of a Cyrillic or Greek letter; other characters unchanged.
fn confusable(c: char) -> char {
    match c {
        // Cyrillic lowercase.
        'а' => 'a',
        'е' => 'e',
        'о' => 'o',
        'р' => 'p',
        'с' => 'c',
        'у' => 'y',
        'х' => 'x',
        'і' => 'i',
        'ј' => 'j',
        'ѕ' => 's',
        'ԁ' => 'd',
        // Cyrillic capitals.
        'А' => 'A',
        'В' => 'B',
        'Е' => 'E',
        'К' => 'K',
        'М' => 'M',
        'Н' => 'H',
        'О' => 'O',
        'Р' => 'P',
        'С' => 'C',
        'Т' => 'T',
        'Х' => 'X',
        'У' => 'Y',
        'І' => 'I',
        'Ј' => 'J',
        'Ѕ' => 'S',
        // Greek capitals.
        'Α' => 'A',
        'Β' => 'B',
        'Ε' => 'E',
        'Ζ' => 'Z',
        'Η' => 'H',
        'Ι' => 'I',
        'Κ' => 'K',
        'Μ' => 'M',
        'Ν' => 'N',
        'Ο' => 'O',
        'Ρ' => 'P',
        'Τ' => 'T',
        'Υ' => 'Y',
        'Χ' => 'X',
        // Greek lowercase.
        'ο' => 'o',
        'ν' => 'v',
        'ρ' => 'p',
        _ => c,
    }
}

/// NFKC, Cyrillic/Greek look-alikes mapped to Latin, lowercased, and only
/// `[a-z0-9]` kept: `"USDТ"` (Cyrillic Т) and `"U S D T."` both give `"usdt"`.
pub fn normalize_symbol(s: &str) -> String {
    s.nfkc()
        .map(confusable)
        .map(|c| c.to_ascii_lowercase())
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// The `by_norm` keys of a symbol and a name.
fn norm_keys<'a>(
    symbol: Option<&'a str>,
    name: Option<&'a str>,
) -> impl Iterator<Item = String> + 'a {
    let symbol = symbol.map(normalize_symbol).filter(|k| !k.is_empty());
    let name = name
        .map(normalize_symbol)
        .filter(|k| k.len() >= MIN_NAME_LEN);
    symbol.into_iter().chain(name)
}

/// A listed token, as an impersonation target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedRef {
    pub address: Address,
    pub symbol: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScamReason {
    /// eth-labels tags the token `spam-token`.
    SpamToken,
    /// The address has a label of category `scam`.
    ScamLabel,
}

impl ScamReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SpamToken => "spam-token",
            Self::ScamLabel => "scam-label",
        }
    }
}

#[derive(Debug, Default)]
pub struct TrustIndex {
    /// Tokens on the Uniswap or CoinGecko list.
    pub listed: HashMap<Address, ListedRef>,
    /// Listed tokens by normalized symbol and by normalized name (≥ 4 chars).
    pub by_norm: HashMap<String, ListedRef>,
    /// Scam tokens and why; a `spam-token` tag wins over a `scam` label.
    pub scam: HashMap<Address, ScamReason>,
    /// ERC-20 rows of `tokens` that classify as suspicious or scam.
    pub flagged: HashSet<Address>,
}

impl TrustIndex {
    /// `listed` holds the Uniswap and CoinGecko rows; `erc20` every ERC-20
    /// row of `tokens` (for `flagged`).
    pub fn build(
        listed: &[ListedTokenRow],
        spam_tokens: &[Address],
        scam_labels: &[Address],
        erc20: &[TokenInfo],
    ) -> Self {
        let is_uniswap = |r: &ListedTokenRow| r.source == "uniswap";
        let uniswap: HashSet<Address> = listed
            .iter()
            .filter(|r| is_uniswap(r))
            .map(|r| r.address)
            .collect();
        let mut idx = Self::default();
        for r in listed {
            // The Uniswap row describes a token on both lists.
            if is_uniswap(r) || !uniswap.contains(&r.address) {
                idx.listed.insert(
                    r.address,
                    ListedRef {
                        address: r.address,
                        symbol: r.symbol.clone(),
                        name: r.name.clone(),
                    },
                );
            }
        }
        // Lower ranks win a key: Uniswap-listed first, then the lowest address.
        let rank = |a: Address| (!uniswap.contains(&a), a);
        for r in listed {
            for key in norm_keys(r.symbol.as_deref(), r.name.as_deref()) {
                let wins = idx
                    .by_norm
                    .get(&key)
                    .is_none_or(|held| rank(r.address) < rank(held.address));
                if wins {
                    idx.by_norm.insert(key, idx.listed[&r.address].clone());
                }
            }
        }
        for &a in scam_labels {
            idx.scam.insert(a, ScamReason::ScamLabel);
        }
        for &a in spam_tokens {
            idx.scam.insert(a, ScamReason::SpamToken);
        }
        idx.flagged = erc20
            .iter()
            .filter(|t| {
                let level = idx
                    .classify(Some(t.address), TransferKind::Erc20, Some(t))
                    .level;
                matches!(level.as_str(), "suspicious" | "scam")
            })
            .map(|t| t.address)
            .collect();
        idx
    }

    pub async fn load(store: &Store) -> Result<Self, StoreError> {
        let listed = store.listed_tokens().await?;
        let spam = store
            .token_tag_addresses("eth-labels", "spam-token")
            .await?;
        let scam = store.addresses_with_category("scam").await?;
        let erc20 = store.tokens_of_kind(TransferKind::Erc20).await?;
        Ok(Self::build(&listed, &spam, &scam, &erc20))
    }

    /// ETH is listed and NFTs are unknown; otherwise listed, scam, suspicious
    /// (the normalized symbol, or name of ≥ 4 chars, matches a listed token)
    /// or unknown, in that order.
    pub fn classify(
        &self,
        asset: Option<Address>,
        kind: TransferKind,
        info: Option<&TokenInfo>,
    ) -> TrustDto {
        let Some(addr) = asset else {
            return TrustDto::listed();
        };
        if matches!(kind, TransferKind::Erc721 | TransferKind::Erc1155) {
            return TrustDto::unknown();
        }
        if self.listed.contains_key(&addr) {
            return TrustDto::listed();
        }
        if let Some(reason) = self.scam.get(&addr) {
            return TrustDto::scam(reason.as_str());
        }
        let copied = info.and_then(|t| {
            norm_keys(t.symbol.as_deref(), t.name.as_deref()).find_map(|k| self.by_norm.get(&k))
        });
        match copied {
            Some(r) => TrustDto::suspicious(ImpersonatedDto {
                address: hex_addr(r.address),
                symbol: r.symbol.clone(),
                name: r.name.clone(),
            }),
            None => TrustDto::unknown(),
        }
    }
}

/// The trust index, reloaded on use once older than its TTL. A failed load is
/// logged and the previous index (empty at first) is served.
pub struct TrustCache {
    ttl: Duration,
    state: tokio::sync::Mutex<(Option<Instant>, Arc<TrustIndex>)>,
}

impl Default for TrustCache {
    fn default() -> Self {
        Self::new(TRUST_TTL)
    }
}

impl TrustCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            state: tokio::sync::Mutex::new((None, Arc::default())),
        }
    }

    pub async fn get(&self, store: &Store) -> Arc<TrustIndex> {
        let mut state = self.state.lock().await;
        let fresh = state.0.is_some_and(|at| at.elapsed() < self.ttl);
        if !fresh {
            match TrustIndex::load(store).await {
                Ok(idx) => *state = (Some(Instant::now()), Arc::new(idx)),
                Err(e) => tracing::warn!(error = %e, "loading the token trust index failed"),
            }
        }
        state.1.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDT: Address = Address::repeat_byte(0x55);
    const FAKE: Address = Address::repeat_byte(0xfa);
    const DAI_UNI: Address = Address::repeat_byte(0x02);
    const DAI_CG: Address = Address::repeat_byte(0x01);

    fn listed(
        a: Address,
        source: &str,
        symbol: Option<&str>,
        name: Option<&str>,
    ) -> ListedTokenRow {
        ListedTokenRow {
            address: a,
            source: source.into(),
            symbol: symbol.map(Into::into),
            name: name.map(Into::into),
        }
    }

    fn info(a: Address, kind: TransferKind, symbol: Option<&str>, name: Option<&str>) -> TokenInfo {
        TokenInfo {
            address: a,
            kind,
            name: name.map(Into::into),
            symbol: symbol.map(Into::into),
            decimals: Some(18),
        }
    }

    fn erc20(a: Address, symbol: &str, name: &str) -> TokenInfo {
        info(a, TransferKind::Erc20, Some(symbol), Some(name))
    }

    fn index() -> TrustIndex {
        TrustIndex::build(
            &[
                listed(USDT, "uniswap", Some("USDT"), Some("Tether USD")),
                listed(USDT, "coingecko", Some("USDT"), Some("Tether")),
            ],
            &[],
            &[],
            &[],
        )
    }

    fn level(t: &TrustDto) -> &str {
        t.level.as_str()
    }

    #[test]
    fn normalize_symbol_folds_look_alikes_case_and_punctuation() {
        assert_eq!(normalize_symbol("USDT"), "usdt");
        assert_eq!(normalize_symbol("USD\u{0422}"), "usdt", "Cyrillic Т");
        assert_eq!(normalize_symbol("U S D T."), "usdt");
        assert_eq!(normalize_symbol("US\u{200b}DT"), "usdt", "zero-width space");
        assert_eq!(normalize_symbol("狗狗"), "");
        assert_eq!(
            normalize_symbol("\u{ff35}\u{ff33}\u{ff24}\u{ff34}"),
            "usdt",
            "fullwidth"
        );
        assert_eq!(
            normalize_symbol("\u{0391}\u{0392}\u{0395}"),
            "abe",
            "Greek capitals"
        );
        assert_eq!(
            normalize_symbol("\u{0441}\u{0440}\u{0435}"),
            "cpe",
            "Cyrillic lowercase"
        );
    }

    #[test]
    fn eth_is_listed_and_nfts_are_unknown() {
        let idx = index();
        assert_eq!(
            level(&idx.classify(None, TransferKind::Native, None)),
            "listed"
        );
        let nft = info(FAKE, TransferKind::Erc721, Some("USDT"), None);
        assert_eq!(
            idx.classify(Some(FAKE), TransferKind::Erc721, Some(&nft)),
            TrustDto::unknown()
        );
    }

    #[test]
    fn a_listed_token_is_listed() {
        let t = erc20(USDT, "USDT", "Tether USD");
        let got = index().classify(Some(USDT), TransferKind::Erc20, Some(&t));
        assert_eq!(got, TrustDto::listed());
    }

    #[test]
    fn copying_a_listed_symbol_is_suspicious() {
        let t = erc20(FAKE, "USDT", "Free Money");
        let got = index().classify(Some(FAKE), TransferKind::Erc20, Some(&t));
        assert_eq!(level(&got), "suspicious");
        assert_eq!(
            got.impersonates,
            Some(ImpersonatedDto {
                address: hex_addr(USDT),
                symbol: Some("USDT".into()),
                name: Some("Tether USD".into()),
            })
        );
        assert_eq!(got.reason, None);
        let cyr = erc20(FAKE, "USD\u{0422}", "x");
        let got = index().classify(Some(FAKE), TransferKind::Erc20, Some(&cyr));
        assert_eq!(level(&got), "suspicious");
    }

    #[test]
    fn copying_a_listed_name_is_suspicious() {
        let t = erc20(FAKE, "XYZ", "Tether USD");
        let got = index().classify(Some(FAKE), TransferKind::Erc20, Some(&t));
        assert_eq!(level(&got), "suspicious");
        assert_eq!(got.impersonates.unwrap().address, hex_addr(USDT));
    }

    #[test]
    fn a_listed_spam_token_stays_listed() {
        let idx = TrustIndex::build(
            &[listed(USDT, "coingecko", Some("USDT"), None)],
            &[USDT],
            &[USDT],
            &[],
        );
        let t = erc20(USDT, "USDT", "Tether USD");
        assert_eq!(
            idx.classify(Some(USDT), TransferKind::Erc20, Some(&t)),
            TrustDto::listed()
        );
    }

    #[test]
    fn unlisted_spam_and_scam_labels_are_scam() {
        let spam = Address::repeat_byte(0x10);
        let labeled = Address::repeat_byte(0x11);
        let both = Address::repeat_byte(0x12);
        let idx = TrustIndex::build(
            &[listed(USDT, "uniswap", Some("USDT"), None)],
            &[spam, both],
            &[labeled, both],
            &[],
        );
        let reason = |a: Address| {
            let t = erc20(a, "USDT", "Tether USD");
            let got = idx.classify(Some(a), TransferKind::Erc20, Some(&t));
            assert_eq!(level(&got), "scam");
            assert_eq!(got.impersonates, None);
            got.reason
        };
        assert_eq!(reason(spam).as_deref(), Some("spam-token"));
        assert_eq!(reason(labeled).as_deref(), Some("scam-label"));
        assert_eq!(reason(both).as_deref(), Some("spam-token"));
    }

    #[test]
    fn without_metadata_or_a_latin_symbol_it_is_unknown() {
        let idx = TrustIndex::build(
            &[
                listed(USDT, "uniswap", Some("USDT"), None),
                // A non-Latin listed symbol normalizes to "" and is never a key.
                listed(DAI_UNI, "uniswap", Some("狗狗"), Some("狗狗币")),
            ],
            &[],
            &[],
            &[],
        );
        assert_eq!(
            idx.classify(Some(FAKE), TransferKind::Erc20, None),
            TrustDto::unknown()
        );
        let t = erc20(FAKE, "狗狗", "狗狗币");
        assert_eq!(
            idx.classify(Some(FAKE), TransferKind::Erc20, Some(&t)),
            TrustDto::unknown()
        );
        assert!(!idx.by_norm.contains_key(""));
    }

    #[test]
    fn short_names_are_not_matched() {
        let idx = TrustIndex::build(
            &[listed(USDT, "uniswap", Some("USDT"), Some("Abc"))],
            &[],
            &[],
            &[],
        );
        let t = erc20(FAKE, "QQQ", "ABC");
        assert_eq!(
            idx.classify(Some(FAKE), TransferKind::Erc20, Some(&t)),
            TrustDto::unknown()
        );
    }

    #[test]
    fn a_collision_keeps_the_uniswap_token_then_the_lowest_address() {
        let idx = TrustIndex::build(
            &[
                listed(DAI_CG, "coingecko", Some("DAI"), None),
                listed(DAI_UNI, "uniswap", Some("DAI"), None),
                listed(Address::repeat_byte(0x09), "coingecko", Some("ZZZ"), None),
                listed(Address::repeat_byte(0x08), "coingecko", Some("ZZZ"), None),
            ],
            &[],
            &[],
            &[],
        );
        assert_eq!(idx.by_norm["dai"].address, DAI_UNI);
        assert_eq!(idx.by_norm["zzz"].address, Address::repeat_byte(0x08));
    }

    #[test]
    fn listed_refs_prefer_the_uniswap_row() {
        let idx = TrustIndex::build(
            &[
                listed(USDT, "coingecko", Some("USDT"), Some("Tether")),
                listed(USDT, "uniswap", Some("USDT"), Some("Tether USD")),
            ],
            &[],
            &[],
            &[],
        );
        assert_eq!(idx.listed[&USDT].name.as_deref(), Some("Tether USD"));
        // Both lists' names are keys.
        assert_eq!(idx.by_norm["tether"].address, USDT);
        assert_eq!(idx.by_norm["tetherusd"].address, USDT);
    }

    #[test]
    fn flagged_holds_the_suspicious_and_scam_erc20_tokens() {
        let spam = Address::repeat_byte(0x10);
        let plain = Address::repeat_byte(0x11);
        let idx = TrustIndex::build(
            &[listed(USDT, "uniswap", Some("USDT"), Some("Tether USD"))],
            &[spam],
            &[],
            &[
                erc20(USDT, "USDT", "Tether USD"),
                erc20(FAKE, "USDT", "x"),
                erc20(spam, "SPAM", "Spam"),
                erc20(plain, "PLN", "Plain"),
            ],
        );
        assert_eq!(idx.flagged, HashSet::from([FAKE, spam]));
    }
}
