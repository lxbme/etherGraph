-- The symbol and name a curated list gives a token (impersonation detection).
ALTER TABLE token_tags ADD COLUMN symbol text, ADD COLUMN name text;
