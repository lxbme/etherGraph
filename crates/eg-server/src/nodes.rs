//! Node summaries (metadata, labels, ENS, sync flags) for a set of addresses,
//! and the low-priority jobs that fill in missing metadata.

use std::collections::HashMap;

use eg_core::source::TokenInfo;
use eg_core::types::{AccountKind, Address, TransferKind};
use eg_ingest::{enqueue_meta, enqueue_names, enqueue_tokens};
use eg_store::{AccountRow, EnsRow, EnsStatus, LabelRow, Store, StoreError, SyncRow, SyncState};

use crate::dto::{LabelDto, NodeSummaryDto, hex_addr};
use crate::state::AppState;

/// Label categories that make a node hot regardless of its neighbour count.
const HOT_CATEGORIES: [&str; 2] = ["exchange", "defi"];

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
    let (accounts, ens, labels, sync) = tokio::try_join!(
        store.accounts(addrs),
        store.ens(addrs),
        store.labels(addrs),
        store.sync_rows(addrs),
    )?;
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
            summarize(
                *a,
                accounts.get(a),
                ens.get(a),
                by_addr.get(a).map_or(&[], Vec::as_slice),
                sync_by.get(a).map_or(&[], Vec::as_slice),
                degree.get(a).copied().unwrap_or(0),
                hot_threshold,
            )
        })
        .collect();
    Ok(Nodes {
        nodes,
        sync: sync_by,
        accounts,
    })
}

/// Builds one node summary; `labels` keep the store's order.
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
    let display_name = ens_name
        .clone()
        .or_else(|| labels.first().map(|l| l.text.clone()))
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

/// Enqueues Low-priority metadata, ENS and token jobs for the addresses and
/// tokens that need them. Failures are logged and never surface to the caller.
pub async fn enqueue_missing_meta(s: &AppState, addrs: &[Address], tokens: &[Address]) {
    let cfg = &s.ctx.cfg;
    let result: Result<(), StoreError> = async {
        let meta = s.store.addrs_needing_meta(addrs, cfg.meta_ttl).await?;
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
    fn hot_by_category_or_degree() {
        let hot = |l: &[LabelRow], degree| summarize(A, None, None, l, &[], degree, 500).hot;
        assert!(hot(&[label("x", "defi")], 0));
        assert!(hot(&[label("x", "exchange")], 0));
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
}
