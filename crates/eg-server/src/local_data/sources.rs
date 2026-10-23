//! The five local data sources, fixed in code: ids, upstream URLs and the
//! host and key allowlists.

/// Hosts a request or a redirect may go to.
pub const ALLOWED_HOSTS: [&str; 4] = [
    "raw.githubusercontent.com",
    "tokens.uniswap.org",
    "tokens.coingecko.com",
    "export.sourcify.dev",
];

/// Every Sourcify signature file lives under this prefix.
pub const SIGNATURES_PREFIX: &str = "v2/signatures/";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SourceId {
    EthLabels,
    TokensUniswap,
    TokensCoingecko,
    TokensEthLabels,
    SignaturesSourcify,
}

impl SourceId {
    pub const ALL: [SourceId; 5] = [
        SourceId::EthLabels,
        SourceId::TokensUniswap,
        SourceId::TokensCoingecko,
        SourceId::TokensEthLabels,
        SourceId::SignaturesSourcify,
    ];

    /// The id used in the database, the API and the UI.
    pub fn as_str(self) -> &'static str {
        match self {
            SourceId::EthLabels => "eth_labels",
            SourceId::TokensUniswap => "tokens_uniswap",
            SourceId::TokensCoingecko => "tokens_coingecko",
            SourceId::TokensEthLabels => "tokens_eth_labels",
            SourceId::SignaturesSourcify => "signatures_sourcify",
        }
    }

    pub fn parse(id: &str) -> Option<SourceId> {
        Self::ALL.into_iter().find(|s| s.as_str() == id)
    }
}

/// Whether `key` is a Sourcify signature file key: `^v2/signatures/[A-Za-z0-9_.-]+\.parquet$`.
pub fn valid_signature_key(key: &str) -> bool {
    let Some(name) = key.strip_prefix(SIGNATURES_PREFIX) else {
        return false;
    };
    name.ends_with(".parquet")
        && name.len() > ".parquet".len()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// The upstream URLs; [`Urls::default`] is the real set, tests point them at
/// a mock server with [`Urls::with_base`].
#[derive(Clone, Debug)]
pub struct Urls {
    pub eth_labels: String,
    pub tokens_uniswap: String,
    pub tokens_coingecko: String,
    pub tokens_eth_labels: String,
    /// The Sourcify listing, query included.
    pub sourcify_list: String,
    /// Sourcify files are fetched from `<sourcify_files>/<Key>`.
    pub sourcify_files: String,
}

impl Default for Urls {
    fn default() -> Self {
        Self {
            eth_labels:
                "https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/accounts.csv"
                    .into(),
            tokens_uniswap: "https://tokens.uniswap.org".into(),
            tokens_coingecko: "https://tokens.coingecko.com/uniswap/all.json".into(),
            tokens_eth_labels:
                "https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/tokens.csv".into(),
            sourcify_list: "https://export.sourcify.dev/?prefix=v2/signatures/".into(),
            sourcify_files: "https://export.sourcify.dev".into(),
        }
    }
}

impl Urls {
    /// Everything under `base` (no trailing slash): `/labels.csv`,
    /// `/uniswap.json`, `/coingecko.json`, `/tokens.csv`, the listing at
    /// `/list?prefix=v2/signatures/` and the files at `/<Key>`.
    pub fn with_base(base: &str) -> Self {
        Self {
            eth_labels: format!("{base}/labels.csv"),
            tokens_uniswap: format!("{base}/uniswap.json"),
            tokens_coingecko: format!("{base}/coingecko.json"),
            tokens_eth_labels: format!("{base}/tokens.csv"),
            sourcify_list: format!("{base}/list?prefix={SIGNATURES_PREFIX}"),
            sourcify_files: base.to_owned(),
        }
    }

    /// The single URL of a non-Sourcify source.
    pub fn of(&self, id: SourceId) -> &str {
        match id {
            SourceId::EthLabels => &self.eth_labels,
            SourceId::TokensUniswap => &self.tokens_uniswap,
            SourceId::TokensCoingecko => &self.tokens_coingecko,
            SourceId::TokensEthLabels => &self.tokens_eth_labels,
            SourceId::SignaturesSourcify => &self.sourcify_list,
        }
    }

    fn all(&self) -> [&str; 6] {
        [
            &self.eth_labels,
            &self.tokens_uniswap,
            &self.tokens_coingecko,
            &self.tokens_eth_labels,
            &self.sourcify_list,
            &self.sourcify_files,
        ]
    }

    /// The hosts a redirect may lead to: those of these URLs (the
    /// [`ALLOWED_HOSTS`] for the real set).
    pub fn hosts(&self) -> Vec<String> {
        self.all()
            .into_iter()
            .filter_map(|u| reqwest::Url::parse(u).ok()?.host_str().map(str::to_owned))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_urls_stay_on_the_allowlist() {
        let hosts = Urls::default().hosts();
        assert_eq!(hosts.len(), 6);
        assert!(hosts.iter().all(|h| ALLOWED_HOSTS.contains(&h.as_str())));
    }

    #[test]
    fn signature_keys_are_confined_to_the_prefix() {
        assert!(valid_signature_key("v2/signatures/s_0_1.parquet"));
        for bad in [
            "../x.parquet",
            "v2/other/a.parquet",
            "https://evil/a.parquet",
            "v2/signatures/../a.parquet",
            "v2/signatures/a/b.parquet",
            "v2/signatures/.parquet",
            "v2/signatures/a.csv",
            "/v2/signatures/a.parquet",
        ] {
            assert!(!valid_signature_key(bad), "{bad}");
        }
    }

    #[test]
    fn ids_round_trip() {
        for s in SourceId::ALL {
            assert_eq!(SourceId::parse(s.as_str()), Some(s));
        }
    }
}
