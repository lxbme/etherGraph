-- Validated call traces, shared by all users (public chain data, kept for
-- good: history does not change). `frames` holds the CallFrame list,
-- `delegates` the EIP-7702 delegated callees as {account: delegate}.
CREATE TABLE call_traces (
    tx_hash    bytea       PRIMARY KEY,
    frames     jsonb       NOT NULL,
    delegates  jsonb       NOT NULL DEFAULT '{}',
    source     text        NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now()
);
