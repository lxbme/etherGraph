CREATE TABLE blocks (
    number bigint PRIMARY KEY,
    ts timestamptz NOT NULL,
    base_fee numeric(78,0),
    gas_limit numeric(78,0) NOT NULL,
    gas_used numeric(78,0) NOT NULL,
    fee_recipient bytea NOT NULL
);
ALTER TABLE transactions ADD COLUMN revert_reason text;
