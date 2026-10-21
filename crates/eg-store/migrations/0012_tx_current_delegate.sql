-- The EIP-7702 delegate a transaction's recipient has today, read from its
-- code (the delegation designator) when the tx's top-level call decodes no
-- other way. `to_delegate_checked_at` set: looked up; `to_current_delegate`
-- null then means none was found.
ALTER TABLE transactions
    ADD COLUMN to_current_delegate bytea,
    ADD COLUMN to_delegate_checked_at timestamptz;
