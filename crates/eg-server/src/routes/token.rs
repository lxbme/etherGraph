//! `GET /api/token/{addr}`: token standard, metadata, list membership, tags
//! and whether verified source is on file. `GET /api/token/{addr}/nft/{id}`:
//! an NFT's metadata.

use axum::Json;
use axum::extract::State;
use chrono::Utc;
use eg_core::types::TransferKind;
use eg_ingest::{enqueue_fetch_nft, enqueue_tokens};
use serde::Deserialize;

use crate::auth::extract::{CurrentUser, MayStartWork};
use crate::dto::{NftMetaDto, TokenDetailDto, TokenListsDto, hex_addr};
use crate::error::ApiError;
use crate::parse::{parse_address, parse_token_id};
use crate::routes::{ApiPath, ApiQuery};
use crate::state::AppState;

/// What the caller already knows about the token from a transfer it decoded.
#[derive(Deserialize)]
pub struct TokenQuery {
    kind: Option<TransferKind>,
}

pub async fn detail(
    State(s): State<AppState>,
    user: CurrentUser,
    MayStartWork(may_start): MayStartWork,
    ApiPath(raw): ApiPath<String>,
    ApiQuery(q): ApiQuery<TokenQuery>,
) -> Result<Json<TokenDetailDto>, ApiError> {
    let addr = parse_address(&raw)?;
    let token = s.store.tokens(&[addr]).await?.into_iter().next();
    let account = s.store.accounts(&[addr]).await?.into_iter().next();
    let identified = account
        .as_ref()
        .is_some_and(|a| a.meta_fetched_at.timestamp() > 0);
    let source_verified = if identified {
        let abis = s.store.abis(&[addr]).await?;
        Some(abis.get(&addr).is_some_and(Option::is_some))
    } else {
        None
    };
    let tags = s.store.token_tags(&[addr]).await?;
    let from_source = |src: &'static str| tags.iter().filter(move |t| t.source == src);
    let mut labels: Vec<String> = from_source("eth-labels").map(|t| t.tag.clone()).collect();
    labels.sort();
    labels.dedup();

    // Only the token's own metadata: a ContractMeta run is not wanted here. TokenMeta records
    // every address it is given as ERC-20, so an address the caller says is an NFT is never queued.
    // A cross-site request (see [`MayStartWork`]) queues nothing.
    let nft_hint = matches!(q.kind, Some(TransferKind::Erc721 | TransferKind::Erc1155));
    if !nft_hint && may_start {
        match s
            .store
            .tokens_needing_meta(&[addr], s.ctx.cfg.meta_ttl)
            .await
        {
            Ok(missing) if !missing.is_empty() => {
                if let Err(e) = enqueue_tokens(&s.ctx, Some(user.id), &missing).await {
                    tracing::warn!(error = %e, address = %hex_addr(addr), "enqueueing token metadata failed");
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "checking token metadata failed"),
        }
    }

    // A stored kind wins; without a tokens row the caller's hint stands in.
    let kind = token.as_ref().map(|t| t.kind).or(q.kind);
    // An unknown standard is classified like an ERC-20.
    let trust = s.trust.get(&s.store).await.classify(
        Some(addr),
        kind.unwrap_or(TransferKind::Erc20),
        token.as_ref(),
    );
    let standard = match kind {
        Some(TransferKind::Erc20) => "erc20",
        Some(TransferKind::Erc721) => "erc721",
        Some(TransferKind::Erc1155) => "erc1155",
        _ => "unknown",
    };
    Ok(Json(TokenDetailDto {
        address: hex_addr(addr),
        standard: standard.into(),
        name: token.as_ref().and_then(|t| t.name.clone()),
        symbol: token.as_ref().and_then(|t| t.symbol.clone()),
        decimals: token.as_ref().and_then(|t| t.decimals),
        contract_name: account.and_then(|a| a.contract_name),
        identified,
        source_verified,
        lists: TokenListsDto {
            uniswap: from_source("uniswap").next().is_some(),
            coingecko: from_source("coingecko").next().is_some(),
        },
        tags: labels,
        // The first by tag order (the store sorts by address, source, tag), not by file order.
        website: from_source("eth-labels").find_map(|t| t.website.clone()),
        trust,
    }))
}

/// The cached metadata of NFT `addr` #`id` (a decimal uint256), shared by
/// all users. Without a cached row, or with an empty one past its TTL (see
/// [`eg_store::NftMetaRow::is_stale`]), the viewer's fetch job is started
/// (billed to them) and `pending` returned; its end is announced by
/// `NftReady`. A cross-site request (see [`MayStartWork`]) is served from the
/// cache, stale or not, and starts nothing.
pub async fn nft(
    State(s): State<AppState>,
    user: CurrentUser,
    MayStartWork(may_start): MayStartWork,
    ApiPath((raw_addr, raw_id)): ApiPath<(String, String)>,
) -> Result<Json<NftMetaDto>, ApiError> {
    let token = parse_address(&raw_addr)?;
    let id = parse_token_id(&raw_id)?;
    match s.store.nft_meta(token, id).await? {
        Some(row) if !may_start || !row.is_stale(Utc::now()) => {
            return Ok(Json(NftMetaDto::cached(row.meta)));
        }
        None if !may_start => return Err(ApiError::not_found("nft metadata not fetched")),
        _ => {}
    }
    let job_id = enqueue_fetch_nft(&s.ctx, Some(user.id), token, id).await?;
    Ok(Json(NftMetaDto::pending(job_id)))
}
