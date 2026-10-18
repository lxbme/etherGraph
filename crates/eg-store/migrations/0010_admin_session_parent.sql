-- An admin-mode session belongs to the login session that entered it: a new
-- login never resumes an older admin-mode cookie, and ending the login
-- session ends its admin mode. Admin sessions from before (unbound) can no
-- longer be used and are dropped.
DELETE FROM sessions WHERE kind = 'admin';
ALTER TABLE sessions ADD COLUMN parent bytea REFERENCES sessions (token_hash) ON DELETE CASCADE;
CREATE INDEX sessions_parent ON sessions (parent);
