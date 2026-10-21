-- NFT metadata fetched from the trace provider (Blockscout's token-instance
-- API), shared by all users. `found = false`: the provider knows no such
-- token instance, and the metadata columns are NULL. Strings are stored
-- capped (see `nft.rs`); raw metadata is never stored.
CREATE TABLE nft_meta (
    token       bytea         NOT NULL,
    token_id    numeric(78,0) NOT NULL,
    fetched_at  timestamptz   NOT NULL DEFAULT now(),
    found       boolean       NOT NULL,
    name        text,
    description text,
    image       text,
    attributes  jsonb,
    PRIMARY KEY (token, token_id)
);
