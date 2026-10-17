CREATE TABLE account_stats (
    address     bytea         PRIMARY KEY,
    nonce       bigint,
    balance     numeric(78,0),
    is_contract boolean,
    probed_at   timestamptz   NOT NULL
);

CREATE TABLE job_owners (
    job_id   bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    batch_id text
);
CREATE UNIQUE INDEX job_owners_uniq ON job_owners (job_id, COALESCE(batch_id, ''));
CREATE INDEX job_owners_batch ON job_owners (batch_id);
