-- Wallet login, sessions, whitelist, settings, per-user quota, the audit log
-- and data ownership.

CREATE TABLE users (
    id            bigserial   PRIMARY KEY,
    address       bytea       NOT NULL UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    daily_quota   int         -- NULL: the default_daily_quota setting
);

CREATE TABLE whitelist (
    address  bytea       PRIMARY KEY,
    added_by text        NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now()
);

-- open_registration (bool); default_daily_quota (int; absent = the config value).
CREATE TABLE settings (
    key   text  PRIMARY KEY,
    value jsonb NOT NULL
);
INSERT INTO settings (key, value) VALUES ('open_registration', 'false');

-- Only the SHA-256 of the raw token is stored.
CREATE TABLE sessions (
    token_hash bytea       PRIMARY KEY,
    user_id    bigint      NOT NULL REFERENCES users ON DELETE CASCADE,
    kind       text        NOT NULL CHECK (kind IN ('user', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    ip         text,
    user_agent text
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE auth_nonces (
    nonce        text        PRIMARY KEY,
    purpose      text        NOT NULL CHECK (purpose IN ('login', 'admin', 'action')),
    user_id      bigint      REFERENCES users ON DELETE CASCADE,
    fields       jsonb       NOT NULL,
    payload_hash bytea,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz
);

CREATE TABLE user_quota_usage (
    user_id bigint NOT NULL REFERENCES users ON DELETE CASCADE,
    day     date   NOT NULL,
    calls   int    NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

CREATE TABLE audit_log (
    id         bigserial   PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    actor      text        NOT NULL,
    action     text        NOT NULL,
    target     text,
    before     jsonb,
    after      jsonb,
    outcome    text        NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed')),
    ip         text,
    user_agent text,
    message    text,
    signature  text
);
CREATE INDEX audit_log_at ON audit_log (at);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP;
END;
$$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- Ownership: NULL for imported labels and for system jobs.
ALTER TABLE labels ADD COLUMN owner_id bigint REFERENCES users;
ALTER TABLE workspaces ADD COLUMN owner_id bigint REFERENCES users;
CREATE INDEX workspaces_owner ON workspaces (owner_id);
ALTER TABLE jobs ADD COLUMN user_id bigint REFERENCES users;
CREATE INDEX jobs_user ON jobs (user_id);

-- A job paused on its user's daily quota is still active.
DROP INDEX jobs_active_key;
CREATE UNIQUE INDEX jobs_active_key ON jobs (key)
    WHERE status IN ('pending', 'running', 'paused_quota', 'paused_user_quota');
