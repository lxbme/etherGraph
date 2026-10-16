-- When TokenMeta last tried to read decimals/symbol/name; NULL means never.
ALTER TABLE tokens ADD COLUMN meta_fetched_at timestamptz NULL;
