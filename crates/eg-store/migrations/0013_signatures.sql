-- A local database of function and event signatures (imported from Sourcify's
-- export): `hash` = keccak256(text), so the 4-byte selector and the 32-byte
-- event topic both resolve here.
CREATE TABLE signatures (
  hash BYTEA PRIMARY KEY,
  text TEXT  NOT NULL
);
CREATE INDEX signatures_selector_idx ON signatures (substring(hash FROM 1 FOR 4));
