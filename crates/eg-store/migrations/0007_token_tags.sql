-- Curated token-list membership and tags (Uniswap, CoinGecko, eth-labels).
CREATE TABLE token_tags (
    address bytea NOT NULL,
    source  text  NOT NULL,
    tag     text  NOT NULL,
    website text,
    PRIMARY KEY (address, source, tag)
);
