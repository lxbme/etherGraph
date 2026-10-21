//! Cached NFT metadata (`nft_meta`), shared by all users.
use chrono::{DateTime, Utc};
use eg_core::source::{NftAttribute, NftMetadata};
use eg_core::types::{Address, U256};
use sqlx::Row;

use crate::convert::{addr_to_bytes, u256_to_bd};
use crate::{Result, Store, StoreError};

/// Longest name kept, in characters; also the cap of each attribute's
/// `trait_type` and `value`.
pub const NFT_NAME_MAX: usize = 200;
pub const NFT_DESCRIPTION_MAX: usize = 2_000;
pub const NFT_IMAGE_MAX: usize = 2_048;
pub const NFT_ATTRIBUTES_MAX: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NftMetaRow {
    pub token: Address,
    pub token_id: U256,
    /// `None`: the source knows no such token instance.
    pub meta: Option<NftMetadata>,
    pub fetched_at: DateTime<Utc>,
}

/// The first `max` characters of `s`.
fn cap(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn capped(m: &NftMetadata) -> NftMetadata {
    NftMetadata {
        name: m.name.as_deref().map(|s| cap(s, NFT_NAME_MAX)),
        description: m
            .description
            .as_deref()
            .map(|s| cap(s, NFT_DESCRIPTION_MAX)),
        image: m.image.as_deref().map(|s| cap(s, NFT_IMAGE_MAX)),
        attributes: m
            .attributes
            .iter()
            .take(NFT_ATTRIBUTES_MAX)
            .map(|a| NftAttribute {
                trait_type: a.trait_type.as_deref().map(|s| cap(s, NFT_NAME_MAX)),
                value: cap(&a.value, NFT_NAME_MAX),
            })
            .collect(),
    }
}

fn invalid(e: serde_json::Error) -> StoreError {
    StoreError::Invalid(format!("nft attributes: {e}"))
}

impl Store {
    pub async fn nft_meta(&self, token: Address, token_id: U256) -> Result<Option<NftMetaRow>> {
        let Some(r) = sqlx::query(
            "SELECT fetched_at, found, name, description, image, attributes FROM nft_meta \
             WHERE token = $1 AND token_id = $2",
        )
        .bind(addr_to_bytes(token))
        .bind(u256_to_bd(token_id))
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let meta = if r.try_get("found")? {
            let attributes: Option<serde_json::Value> = r.try_get("attributes")?;
            Some(NftMetadata {
                name: r.try_get("name")?,
                description: r.try_get("description")?,
                image: r.try_get("image")?,
                attributes: attributes
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(invalid)?
                    .unwrap_or_default(),
            })
        } else {
            None
        };
        Ok(Some(NftMetaRow {
            token,
            token_id,
            meta,
            fetched_at: r.try_get("fetched_at")?,
        }))
    }

    /// Stores `row` with its strings and attribute list cut to the caps above.
    pub async fn upsert_nft_meta(&self, row: &NftMetaRow) -> Result<()> {
        let meta = row.meta.as_ref().map(capped);
        let attributes = meta
            .as_ref()
            .map(|m| serde_json::to_value(&m.attributes))
            .transpose()
            .map_err(invalid)?;
        sqlx::query(
            "INSERT INTO nft_meta (token, token_id, fetched_at, found, name, description, image, attributes) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (token, token_id) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, \
             found = EXCLUDED.found, name = EXCLUDED.name, description = EXCLUDED.description, \
             image = EXCLUDED.image, attributes = EXCLUDED.attributes",
        )
        .bind(addr_to_bytes(row.token))
        .bind(u256_to_bd(row.token_id))
        .bind(row.fetched_at)
        .bind(meta.is_some())
        .bind(meta.as_ref().and_then(|m| m.name.clone()))
        .bind(meta.as_ref().and_then(|m| m.description.clone()))
        .bind(meta.as_ref().and_then(|m| m.image.clone()))
        .bind(attributes)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    fn meta() -> NftMetadata {
        NftMetadata {
            name: Some("Synthetic #7".into()),
            description: Some("line\nline".into()),
            image: Some("ipfs://QmSynthetic/7.png".into()),
            attributes: vec![
                NftAttribute {
                    trait_type: Some("Level".into()),
                    value: "5".into(),
                },
                NftAttribute {
                    trait_type: None,
                    value: "untyped".into(),
                },
            ],
        }
    }

    fn row(meta: Option<NftMetadata>) -> NftMetaRow {
        NftMetaRow {
            token: Address::repeat_byte(0xa7),
            token_id: U256::MAX,
            meta,
            fetched_at: DateTime::from_timestamp(1_760_000_000, 0).unwrap(),
        }
    }

    #[sqlx::test]
    async fn nft_meta_round_trip(pool: PgPool) {
        let s = Store::from_pool(pool);
        let found = row(Some(meta()));
        assert_eq!(s.nft_meta(found.token, found.token_id).await.unwrap(), None);
        s.upsert_nft_meta(&found).await.unwrap();
        assert_eq!(
            s.nft_meta(found.token, found.token_id).await.unwrap(),
            Some(found.clone())
        );
        // Another id of the same token is another row.
        assert_eq!(
            s.nft_meta(found.token, U256::from(7u64)).await.unwrap(),
            None
        );

        let missing = row(None);
        s.upsert_nft_meta(&missing).await.unwrap();
        assert_eq!(
            s.nft_meta(found.token, found.token_id).await.unwrap(),
            Some(missing)
        );
    }

    #[sqlx::test]
    async fn nft_meta_is_stored_capped(pool: PgPool) {
        let s = Store::from_pool(pool);
        let long = |c: char, n: usize| c.to_string().repeat(n);
        let attr = NftAttribute {
            trait_type: Some(long('t', 300)),
            value: long('v', 300),
        };
        let big = row(Some(NftMetadata {
            // Multi-byte characters: the caps count characters.
            name: Some(long('名', 250)),
            description: Some(long('d', 2_500)),
            image: Some(format!("https://example.org/{}", long('i', 3_000))),
            attributes: vec![attr; 60],
        }));
        s.upsert_nft_meta(&big).await.unwrap();
        let got = s
            .nft_meta(big.token, big.token_id)
            .await
            .unwrap()
            .unwrap()
            .meta
            .unwrap();
        assert_eq!(got.name.unwrap(), long('名', NFT_NAME_MAX));
        assert_eq!(
            got.description.unwrap().chars().count(),
            NFT_DESCRIPTION_MAX
        );
        let image = got.image.unwrap();
        assert_eq!(image.chars().count(), NFT_IMAGE_MAX);
        assert!(image.starts_with("https://example.org/iii"));
        assert_eq!(got.attributes.len(), NFT_ATTRIBUTES_MAX);
        assert_eq!(
            got.attributes[0],
            NftAttribute {
                trait_type: Some(long('t', NFT_NAME_MAX)),
                value: long('v', NFT_NAME_MAX),
            }
        );
    }
}
