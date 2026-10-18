//! `POST /api/probe`: cached nonce, code and balance per address.

use std::collections::HashMap;

use alloy_primitives::U256;
use axum::Json;
use axum::extract::State;
use chrono::Utc;
use eg_core::source::Priority;
use eg_core::types::{AccountKind, Address, TransferKind};
use eg_ingest::billing::billed;
use eg_store::{AccountRow, StatsRow, SyncRow};

use crate::auth::extract::CurrentUser;
use crate::dto::{ProbeItemDto, ProbeRequestDto, ProbeResponseDto, hex_addr, rfc3339};
use crate::error::{ApiError, invalid};
use crate::routes::{ApiJson, parse_addresses};
use crate::state::AppState;

/// Most addresses accepted by one probe (one `balancemulti` call).
const MAX_PROBE: usize = 20;

/// Upstream calls are billed to the viewer; over their quota the probe is
/// 429 `user_quota_exhausted` (what was fetched before is kept).
pub async fn probe(
    State(s): State<AppState>,
    user: CurrentUser,
    ApiJson(req): ApiJson<ProbeRequestDto>,
) -> Result<Json<ProbeResponseDto>, ApiError> {
    let addrs = parse_addresses(&req.addresses)?;
    if addrs.len() > MAX_PROBE {
        return Err(invalid(format!(
            "at most {MAX_PROBE} addresses per probe, got {}",
            addrs.len()
        )));
    }
    let prio = match req.priority.as_deref() {
        None | Some("interactive") => Priority::Interactive,
        Some("background") => Priority::Background,
        Some(other) => {
            return Err(invalid(format!(
                "priority must be \"interactive\" or \"background\", got {other:?}"
            )));
        }
    };

    let (accounts, stats) =
        tokio::try_join!(s.store.accounts(&addrs), s.store.account_stats(&addrs))?;
    let accounts: HashMap<Address, AccountRow> =
        accounts.into_iter().map(|a| (a.address, a)).collect();
    let mut stats: HashMap<Address, StatsRow> = stats.into_iter().map(|r| (r.address, r)).collect();

    let now = Utc::now();
    let ttl = chrono::Duration::from_std(s.ctx.cfg.stale_after).unwrap_or(chrono::Duration::MAX);
    let fresh_row = |r: &StatsRow| now - r.probed_at < ttl;
    // A row cached without a balance (an earlier probe failed or the upstream
    // skipped it) is re-probed; its fresh nonce is reused.
    let stale: Vec<Address> = addrs
        .iter()
        .copied()
        .filter(|a| {
            stats
                .get(a)
                .is_none_or(|r| !fresh_row(r) || r.balance.is_none())
        })
        .collect();

    let mut calls = 0u32;
    if !stale.is_empty() {
        let mut fresh: Vec<StatsRow> = Vec::with_capacity(stale.len());
        let mut new_kinds: Vec<(Address, AccountKind)> = Vec::new();
        let mut balances: HashMap<Address, U256> = HashMap::new();
        let fetched: Result<(), ApiError> = billed(Some(user.id), async {
            for a in &stale {
                let known_kind = accounts
                    .get(a)
                    .map(|r| r.kind)
                    .filter(|k| *k != AccountKind::Unknown);
                let cached = stats.get(a);
                let is_contract = match (known_kind, cached.and_then(|r| r.is_contract)) {
                    (Some(k), _) => Some(k == AccountKind::Contract),
                    (None, Some(c)) => Some(c),
                    (None, None) => {
                        calls += 1;
                        let c = !s.ctx.source.code(prio, *a).await?.is_empty();
                        new_kinds.push((
                            *a,
                            if c {
                                AccountKind::Contract
                            } else {
                                AccountKind::Eoa
                            },
                        ));
                        Some(c)
                    }
                };
                let reuse = cached.filter(|r| fresh_row(r)).and_then(|r| r.nonce);
                let (nonce, probed_at) = match (is_contract, reuse) {
                    (Some(true), _) => (None, now),
                    // Keep the nonce's own timestamp so it still expires on time.
                    (_, Some(n)) => (Some(n), cached.map_or(now, |r| r.probed_at)),
                    _ => {
                        calls += 1;
                        (Some(s.ctx.source.tx_count(prio, *a).await?), now)
                    }
                };
                fresh.push(StatsRow {
                    address: *a,
                    nonce,
                    balance: None,
                    is_contract,
                    probed_at,
                });
            }
            calls += 1;
            balances = s
                .ctx
                .source
                .balances(prio, &stale)
                .await?
                .into_iter()
                .collect();
            Ok(())
        })
        .await;
        for r in &mut fresh {
            r.balance = balances.get(&r.address).copied();
        }
        // What was fetched before a failure is cached too, so a retry does not pay
        // for it again; rows without a balance stay stale (see above).
        // Kinds first: a failing kind write must not leave is_contract cached without it.
        s.store.set_kind_if_unknown(&new_kinds).await?;
        s.store.upsert_account_stats(&fresh).await?;
        if let Err(e) = fetched {
            tracing::warn!(
                calls,
                cached = fresh.len(),
                "probe failed upstream after partial fetch"
            );
            return Err(e);
        }
        for r in fresh {
            stats.insert(r.address, r);
        }
    }

    let (counts, sync) =
        tokio::try_join!(s.store.transfer_counts(&addrs), s.store.sync_rows(&addrs))?;
    let mut sync_by: HashMap<Address, Vec<SyncRow>> = HashMap::new();
    for r in sync {
        sync_by.entry(r.address).or_default().push(r);
    }
    let items = addrs
        .iter()
        .map(|a| {
            let st = stats.get(a);
            let rows = sync_by.get(a).map_or(&[][..], Vec::as_slice);
            let kind = match accounts.get(a).map(|r| r.kind) {
                Some(AccountKind::Eoa) => "eoa",
                Some(AccountKind::Contract) => "contract",
                _ => match st.and_then(|r| r.is_contract) {
                    Some(true) => "contract",
                    Some(false) => "eoa",
                    None => "unknown",
                },
            };
            ProbeItemDto {
                address: hex_addr(*a),
                kind: kind.to_owned(),
                nonce: st.and_then(|r| r.nonce),
                balance: st.and_then(|r| r.balance).map(|b| b.to_string()),
                local_transfers: counts.get(a).copied().unwrap_or(0),
                synced: TransferKind::ALL
                    .iter()
                    .all(|k| rows.iter().any(|r| r.kind == *k && r.to_block.is_some())),
                partial: rows.iter().any(|r| r.truncated),
                probed_at: rfc3339(st.map_or(now, |r| r.probed_at)),
            }
        })
        .collect();
    Ok(Json(ProbeResponseDto { items, calls }))
}
