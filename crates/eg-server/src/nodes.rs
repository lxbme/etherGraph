//! Node summaries (metadata, labels, ENS, sync flags) for a set of addresses,
//! and the low-priority jobs that fill in missing metadata.

use std::collections::HashMap;

use eg_core::source::TokenInfo;
use eg_core::types::{AccountKind, Address, TransferKind, category_rank};
use eg_ingest::{enqueue_meta, enqueue_names, enqueue_tokens};
use eg_store::{
    AccountRow, EnsRow, EnsStatus, LabelRow, StatsRow, Store, StoreError, SyncRow, SyncState,
};

use crate::dto::{LabelDto, NodeSummaryDto, hex_addr};
use crate::state::AppState;

/// Label categories that make a node hot regardless of its neighbour count.
const HOT_CATEGORIES: [&str; 3] = ["cex", "dex", "defi"];

pub struct Nodes {
    /// One summary per input address, in input order.
    pub nodes: Vec<NodeSummaryDto>,
    /// Sync coverage rows per address (missing when the address has none).
    pub sync: HashMap<Address, Vec<SyncRow>>,
    pub accounts: HashMap<Address, AccountRow>,
}

/// Loads metadata for `addrs` and summarizes each one. `degree[a]` is the
/// number of neighbours known for `a` (returned plus omitted); absent means 0.
pub async fn load_nodes(
    store: &Store,
    addrs: &[Address],
    degree: &HashMap<Address, u64>,
    hot_threshold: u64,
) -> Result<Nodes, StoreError> {
    let (accounts, ens, labels, sync, stats) = tokio::try_join!(
        store.accounts(addrs),
        store.ens(addrs),
        store.labels(addrs),
        store.sync_rows(addrs),
        store.account_stats(addrs),
    )?;
    let stats: HashMap<Address, StatsRow> = stats.into_iter().map(|r| (r.address, r)).collect();
    let accounts: HashMap<Address, AccountRow> =
        accounts.into_iter().map(|a| (a.address, a)).collect();
    let ens: HashMap<Address, EnsRow> = ens.into_iter().map(|e| (e.address, e)).collect();
    let mut by_addr: HashMap<Address, Vec<LabelRow>> = HashMap::new();
    for l in labels {
        by_addr.entry(l.address).or_default().push(l);
    }
    let mut sync_by: HashMap<Address, Vec<SyncRow>> = HashMap::new();
    for r in sync {
        sync_by.entry(r.address).or_default().push(r);
    }
    let nodes = addrs
        .iter()
        .map(|a| {
            let mut n = summarize(
                *a,
                accounts.get(a),
                ens.get(a),
                by_addr.get(a).map_or(&[], Vec::as_slice),
                sync_by.get(a).map_or(&[], Vec::as_slice),
                degree.get(a).copied().unwrap_or(0),
                hot_threshold,
            );
            if let Some(st) = stats.get(a) {
                n.nonce = st.nonce;
                n.balance = st.balance.map(|b| b.to_string());
            }
            n
        })
        .collect();
    Ok(Nodes {
        nodes,
        sync: sync_by,
        accounts,
    })
}

/// Orders labels by source (user, mainnet dataset, other imports, xchain),
/// then category severity, then id. The first label is the primary one.
pub fn order_labels(labels: &mut [LabelRow]) {
    labels.sort_by_key(|l| {
        let source = match l.source.as_str() {
            "user" => 0,
            "import:eth-labels" => 1,
            "import:eth-labels-xchain" => 3,
            _ => 2,
        };
        (source, category_rank(&l.category), l.id)
    });
}

/// Builds one node summary; `labels` are re-ordered with [`order_labels`].
pub fn summarize(
    addr: Address,
    account: Option<&AccountRow>,
    ens: Option<&EnsRow>,
    labels: &[LabelRow],
    sync: &[SyncRow],
    degree: u64,
    hot_threshold: u64,
) -> NodeSummaryDto {
    let ens_name = ens
        .filter(|e| e.status == EnsStatus::Ok)
        .and_then(|e| e.name.clone());
    let contract_name = account.and_then(|a| a.contract_name.clone());
    let mut labels = labels.to_vec();
    order_labels(&mut labels);
    let label = labels.first();
    let display_name = ens_name
        .clone()
        .or_else(|| label.map(|l| l.text.clone()))
        .or_else(|| contract_name.clone());
    let kind = match account.map(|a| a.kind) {
        Some(AccountKind::Eoa) => "eoa",
        Some(AccountKind::Contract) => "contract",
        Some(AccountKind::Unknown) | None => "unknown",
    };
    let hot = labels
        .iter()
        .any(|l| HOT_CATEGORIES.contains(&l.category.as_str()))
        || degree > hot_threshold;
    let synced = TransferKind::ALL
        .iter()
        .all(|k| sync.iter().any(|r| r.kind == *k && r.to_block.is_some()));
    NodeSummaryDto {
        address: hex_addr(addr),
        kind: kind.to_owned(),
        display_name,
        ens: ens_name,
        contract_name,
        labels: labels.iter().map(LabelDto::from).collect(),
        partial: sync.iter().any(|r| r.truncated),
        syncing: sync.iter().any(|r| r.state == SyncState::Syncing),
        synced,
        hot,
        identified: account.is_some_and(|a| a.meta_fetched_at.timestamp() > 0),
        nonce: None,
        balance: None,
    }
}

/// Token rows keyed by address; skips the query for an empty list.
pub async fn token_map(
    store: &Store,
    addrs: &[Address],
) -> Result<HashMap<Address, TokenInfo>, StoreError> {
    if addrs.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(store
        .tokens(addrs)
        .await?
        .into_iter()
        .map(|t| (t.address, t))
        .collect())
}

/// Enqueues Low-priority metadata jobs for the `meta_addrs` and ENS and token
/// jobs for the `addrs` and `tokens` that need them. Failures are logged and
/// never surface to the caller.
pub async fn enqueue_missing_meta(
    s: &AppState,
    meta_addrs: &[Address],
    addrs: &[Address],
    tokens: &[Address],
) {
    let cfg = &s.ctx.cfg;
    let result: Result<(), StoreError> = async {
        let meta = s.store.addrs_needing_meta(meta_addrs, cfg.meta_ttl).await?;
        if !meta.is_empty() {
            enqueue_meta(&s.ctx, &meta).await?;
        }
        let names = s.store.addrs_needing_ens(addrs, cfg.ens_ttl).await?;
        if !names.is_empty() {
            enqueue_names(&s.ctx, &names).await?;
        }
        let missing = s.store.tokens_needing_meta(tokens, cfg.meta_ttl).await?;
        if !missing.is_empty() {
            enqueue_tokens(&s.ctx, &missing).await?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tracing::warn!(error = %e, "enqueueing metadata jobs failed");
    }
}

/// Enqueues Low-priority ENS resolution only (no contract or token metadata),
/// for callers that list many addresses at once. Failures are logged.
pub async fn enqueue_missing_names(s: &AppState, addrs: &[Address]) {
    let result: Result<(), StoreError> = async {
        let names = s.store.addrs_needing_ens(addrs, s.ctx.cfg.ens_ttl).await?;
        if !names.is_empty() {
            enqueue_names(&s.ctx, &names).await?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tracing::warn!(error = %e, "enqueueing ENS jobs failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    const A: Address = Address::repeat_byte(0xa);

    fn label(text: &str, category: &str) -> LabelRow {
        LabelRow {
            id: 1,
            address: A,
            text: text.into(),
            category: category.into(),
            source: "user".into(),
            created_at: Utc::now(),
        }
    }

    fn account(name: Option<&str>) -> AccountRow {
        AccountRow {
            address: A,
            kind: AccountKind::Eoa,
            contract_name: name.map(Into::into),
            is_proxy: false,
            implementation: None,
            creator: None,
            creation_tx: None,
            meta_fetched_at: Utc::now(),
        }
    }

    fn ens(name: &str, status: EnsStatus) -> EnsRow {
        EnsRow {
            address: A,
            name: Some(name.into()),
            status,
            resolved_at: Utc::now(),
        }
    }

    fn row(kind: TransferKind, to_block: Option<u64>) -> SyncRow {
        SyncRow {
            address: A,
            kind,
            from_block: to_block,
            to_block,
            truncated: false,
            state: SyncState::Ok,
            last_synced_at: None,
        }
    }

    #[test]
    fn display_name_priority() {
        let acct = account(Some("Vault"));
        let labels = [label("first", "other"), label("second", "other")];
        let ok = ens("a.eth", EnsStatus::Ok);
        let n = |e: Option<&EnsRow>, l: &[LabelRow], a: Option<&AccountRow>| {
            summarize(A, a, e, l, &[], 0, 500).display_name
        };
        assert_eq!(n(Some(&ok), &labels, Some(&acct)).as_deref(), Some("a.eth"));
        let off = ens("b.eth", EnsStatus::Offchain);
        assert_eq!(
            n(Some(&off), &labels, Some(&acct)).as_deref(),
            Some("first")
        );
        assert_eq!(n(None, &[], Some(&acct)).as_deref(), Some("Vault"));
        assert_eq!(n(None, &[], None), None);
        let s = summarize(A, None, Some(&off), &[], &[], 0, 500);
        assert_eq!((s.ens, s.kind.as_str()), (None, "unknown"));
    }

    #[test]
    fn display_name_prefers_user_label_over_imported() {
        let mut imported = label("Binance 14", "cex");
        imported.source = "import:etherscan".into();
        let mine = label("my hot wallet", "other");
        let labels = [imported.clone(), mine];
        let s = summarize(A, None, None, &labels, &[], 0, 500);
        assert_eq!(s.display_name.as_deref(), Some("my hot wallet"));
        // ENS still wins; with only imported labels the first one is used.
        let ok = ens("a.eth", EnsStatus::Ok);
        let s = summarize(A, None, Some(&ok), &labels, &[], 0, 500);
        assert_eq!(s.display_name.as_deref(), Some("a.eth"));
        let s = summarize(A, None, None, &[imported], &[], 0, 500);
        assert_eq!(s.display_name.as_deref(), Some("Binance 14"));
    }

    #[test]
    fn hot_by_category_or_degree() {
        let hot = |l: &[LabelRow], degree| summarize(A, None, None, l, &[], degree, 500).hot;
        assert!(hot(&[label("x", "defi")], 0));
        assert!(hot(&[label("x", "cex")], 0));
        assert!(hot(&[label("x", "dex")], 0));
        assert!(!hot(&[label("x", "bridge")], 500));
        assert!(hot(&[], 501));
    }

    #[test]
    fn sync_flags() {
        let mut rows: Vec<SyncRow> = TransferKind::ALL
            .iter()
            .map(|k| row(*k, Some(10)))
            .collect();
        let s = summarize(A, None, None, &[], &rows, 0, 500);
        assert!(s.synced && !s.partial && !s.syncing);
        rows[2].to_block = None;
        rows[3].truncated = true;
        rows[4].state = SyncState::Syncing;
        let s = summarize(A, None, None, &[], &rows, 0, 500);
        assert!(!s.synced && s.partial && s.syncing);
        let s = summarize(A, None, None, &[], &rows[..4], 0, 500);
        assert!(!s.synced);
    }

    fn src(id: i64, text: &str, category: &str, source: &str) -> LabelRow {
        let mut l = label(text, category);
        l.id = id;
        l.source = source.into();
        l
    }

    fn mixed() -> Vec<LabelRow> {
        vec![
            src(1, "x-cex", "cex", "import:eth-labels-xchain"),
            src(2, "m-other", "other", "import:eth-labels"),
            src(3, "m-cex", "cex", "import:eth-labels"),
            src(4, "mine", "other", "user"),
        ]
    }

    #[test]
    fn order_labels_user_then_mainnet_then_xchain() {
        let mut l = mixed();
        order_labels(&mut l);
        let got: Vec<_> = l.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(got, ["mine", "m-cex", "m-other", "x-cex"]);
    }

    #[test]
    fn display_name_and_category_follow_ordered_labels() {
        let s = summarize(A, None, None, &mixed(), &[], 0, 500);
        assert_eq!(s.display_name.as_deref(), Some("mine"));
        assert_eq!(s.labels[0].text, "mine");
        assert_eq!(s.labels[1].category, "cex");
    }

    #[test]
    fn hot_categories() {
        let hot = |c| summarize(A, None, None, &[label("x", c)], &[], 0, 500).hot;
        assert!(hot("cex") && hot("dex") && hot("defi"));
        assert!(!hot("exchange") && !hot("bridge"));
    }
}
