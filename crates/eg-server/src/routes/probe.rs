//! `POST /api/probe`: cached nonce, code and balance per address.

use std::collections::HashMap;
use std::time::SystemTime;

use alloy_primitives::U256;
use axum::Json;
use axum::extract::State;
use chrono::{DateTime, Utc};
use eg_core::source::Priority;
use eg_core::types::{AccountKind, Address, TransferKind};
use eg_store::{AccountRow, StatsRow, SyncRow};

use crate::dto::{ProbeItemDto, ProbeRequestDto, ProbeResponseDto, hex_addr, rfc3339};
use crate::error::{ApiError, invalid};
use crate::routes::{ApiJson, parse_addresses};
use crate::state::AppState;

/// Most addresses accepted by one probe (one `balancemulti` call).
const MAX_PROBE: usize = 20;

pub async fn probe(
    State(s): State<AppState>,
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
    let mut accounts: HashMap<Address, AccountRow> =
        accounts.into_iter().map(|a| (a.address, a)).collect();
    let mut stats: HashMap<Address, StatsRow> = stats.into_iter().map(|r| (r.address, r)).collect();

    let now = Utc::now();
    let ttl = chrono::Duration::from_std(s.ctx.cfg.stale_after).unwrap_or(chrono::Duration::MAX);
    let stale: Vec<Address> = addrs
        .iter()
        .copied()
        .filter(|a| stats.get(a).is_none_or(|r| now - r.probed_at >= ttl))
        .collect();

    let mut calls = 0u32;
    if !stale.is_empty() {
        let mut fresh: Vec<StatsRow> = Vec::with_capacity(stale.len());
        let mut new_contracts: Vec<Address> = Vec::new();
        for a in &stale {
            let known_kind = accounts
                .get(a)
                .map(|r| r.kind)
                .filter(|k| *k != AccountKind::Unknown);
            let cached = stats.get(a).and_then(|r| r.is_contract);
            let is_contract = match (known_kind, cached) {
                (Some(k), _) => Some(k == AccountKind::Contract),
                (None, Some(c)) => Some(c),
                (None, None) => {
                    calls += 1;
                    let c = !s.ctx.source.code(prio, *a).await?.is_empty();
                    if c {
                        new_contracts.push(*a);
                    }
                    Some(c)
                }
            };
            let nonce = if is_contract == Some(true) {
                None
            } else {
                calls += 1;
                Some(s.ctx.source.tx_count(prio, *a).await?)
            };
            fresh.push(StatsRow {
                address: *a,
                nonce,
                balance: None,
                is_contract,
                probed_at: now,
            });
        }
        calls += 1;
        let balances: HashMap<Address, U256> = s
            .ctx
            .source
            .balances(prio, &stale)
            .await?
            .into_iter()
            .collect();
        for r in &mut fresh {
            r.balance = balances.get(&r.address).copied();
        }
        s.store.upsert_account_stats(&fresh).await?;
        mark_contracts(&s, &new_contracts, &mut accounts).await?;
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

/// Records `contract` on accounts that are unknown or have no row yet. A new
/// row gets the epoch as `meta_fetched_at` so the metadata job still runs.
async fn mark_contracts(
    s: &AppState,
    addrs: &[Address],
    accounts: &mut HashMap<Address, AccountRow>,
) -> Result<(), ApiError> {
    let mut rows = Vec::new();
    for a in addrs {
        let row = match accounts.get(a) {
            Some(r) if r.kind != AccountKind::Unknown => continue,
            Some(r) => AccountRow {
                kind: AccountKind::Contract,
                ..r.clone()
            },
            None => AccountRow {
                address: *a,
                kind: AccountKind::Contract,
                contract_name: None,
                is_proxy: false,
                implementation: None,
                creator: None,
                creation_tx: None,
                meta_fetched_at: DateTime::<Utc>::from(SystemTime::UNIX_EPOCH),
            },
        };
        rows.push(row);
    }
    if rows.is_empty() {
        return Ok(());
    }
    s.store.upsert_accounts(&rows).await?;
    for r in rows {
        accounts.insert(r.address, r);
    }
    Ok(())
}
