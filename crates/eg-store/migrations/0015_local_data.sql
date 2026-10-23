-- The last import of each local dataset (a source id fixed in code). A
-- failure keeps the last success's fields; `state` is idle | running | failed.
CREATE TABLE local_data (
    source      text PRIMARY KEY,
    version     text,
    etag        text,
    sha256      text,
    manifest    jsonb,
    imported_at timestamptz,
    rows        bigint,
    state       text NOT NULL DEFAULT 'idle',
    error       text,
    error_at    timestamptz,
    started_by  text
);
