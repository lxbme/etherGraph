//! `GET /api/token/{addr}`: token standard, metadata, list membership, tags
//! and whether verified source is on file.

use axum::Json;
use axum::extract::State;
use eg_core::types::TransferKind;
use eg_ingest::enqueue_tokens;
use serde::Deserialize;

use crate::dto::{TokenDetailDto, TokenListsDto, hex_addr};
use crate::error::ApiError;
use crate::parse::parse_address;
use crate::routes::{ApiPath, ApiQuery};
use crate::state::AppState;

/// What the caller already knows about the token from a transfer it decoded.
#[derive(Deserialize)]
pub struct TokenQuery {
    kind: Option<TransferKind>,
}

pub async fn detail(
    State(s): State<AppState>,
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
    let nft_hint = matches!(q.kind, Some(TransferKind::Erc721 | TransferKind::Erc1155));
    if !nft_hint {
        match s
            .store
            .tokens_needing_meta(&[addr], s.ctx.cfg.meta_ttl)
            .await
        {
            Ok(missing) if !missing.is_empty() => {
                if let Err(e) = enqueue_tokens(&s.ctx, &missing).await {
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
