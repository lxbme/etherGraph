CREATE TABLE transfers (
    tx_hash      bytea         NOT NULL,
    sub_id       text          NOT NULL,
    kind         smallint      NOT NULL,
    block_number bigint        NOT NULL,
    ts           timestamptz   NOT NULL,
    from_addr    bytea         NOT NULL,
    to_addr      bytea         NOT NULL,
    asset        bytea,
    amount       numeric(78,0) NOT NULL,
    token_id     numeric(78,0),
    trace_id     text,
    log_index    bigint,
    PRIMARY KEY (tx_hash, sub_id)
);
CREATE INDEX transfers_from_ts ON transfers (from_addr, ts);
CREATE INDEX transfers_to_ts ON transfers (to_addr, ts);
CREATE INDEX transfers_asset_ts ON transfers (asset, ts);

CREATE TABLE transactions (
    hash         bytea         PRIMARY KEY,
    block_number bigint        NOT NULL,
    ts           timestamptz   NOT NULL,
    from_addr    bytea         NOT NULL,
    to_addr      bytea,
    value        numeric(78,0) NOT NULL,
    selector     bytea,
    success      boolean       NOT NULL,
    gas_used     numeric(78,0) NOT NULL,
    fee          numeric(78,0) NOT NULL,
    raw_tx       jsonb         NOT NULL,
    raw_receipt  jsonb         NOT NULL
);

CREATE TABLE accounts (
    address         bytea       PRIMARY KEY,
    kind            text        NOT NULL CHECK (kind IN ('eoa', 'contract', 'unknown')),
    contract_name   text,
    is_proxy        boolean     NOT NULL DEFAULT false,
    implementation  bytea,
    creator         bytea,
    creation_tx     bytea,
    meta_fetched_at timestamptz
);

CREATE TABLE abis (
    address    bytea       PRIMARY KEY,
    abi        jsonb,
    fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tokens (
    address  bytea    PRIMARY KEY,
    kind     smallint NOT NULL,
    name     text,
    symbol   text,
    decimals smallint
);

CREATE TABLE labels (
    id         bigserial   PRIMARY KEY,
    address    bytea       NOT NULL,
    text       text        NOT NULL,
    category   text        NOT NULL,
    source     text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX labels_address ON labels (address);

CREATE TABLE ens_names (
    address     bytea       PRIMARY KEY,
    name        text,
    status      text        NOT NULL,
    resolved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE address_sync (
    address        bytea       NOT NULL,
    kind           smallint    NOT NULL,
    from_block     bigint,
    to_block       bigint,
    truncated      boolean     NOT NULL DEFAULT false,
    state          text        NOT NULL CHECK (state IN ('syncing', 'ok', 'failed')),
    last_synced_at timestamptz,
    PRIMARY KEY (address, kind)
);

CREATE TABLE workspaces (
    id             bigserial   PRIMARY KEY,
    name           text        NOT NULL,
    schema_version int         NOT NULL,
    state          jsonb       NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
    id               bigserial   PRIMARY KEY,
    key              text        NOT NULL,
    kind             text        NOT NULL,
    params           jsonb       NOT NULL,
    priority         smallint    NOT NULL,
    status           text        NOT NULL,
    progress         jsonb,
    attempts         int         NOT NULL DEFAULT 0,
    error            text,
    cancel_requested boolean     NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_active_key ON jobs (key)
    WHERE status IN ('pending', 'running', 'paused_quota');
CREATE INDEX jobs_status_priority_created ON jobs (status, priority, created_at);

CREATE TABLE quota_usage (
    day   date PRIMARY KEY,
    calls int  NOT NULL DEFAULT 0
);
