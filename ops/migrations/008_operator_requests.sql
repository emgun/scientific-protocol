CREATE TABLE IF NOT EXISTS operator_request_nonces (
  action_type TEXT NOT NULL,
  operator_address TEXT NOT NULL,
  next_nonce BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (action_type, operator_address)
);

CREATE TABLE IF NOT EXISTS operator_requests (
  request_id BIGSERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,
  operator_address TEXT NOT NULL,
  request_nonce BIGINT NOT NULL,
  chain_id BIGINT NOT NULL,
  scope_key TEXT NOT NULL,
  request_hash TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  payload_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  status TEXT NOT NULL,
  submission_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (action_type, operator_address, request_nonce)
);

CREATE INDEX IF NOT EXISTS operator_requests_action_status_idx
  ON operator_requests (action_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS operator_requests_scope_idx
  ON operator_requests (scope_key, created_at DESC);

ALTER TABLE replication_jobs
  ADD COLUMN IF NOT EXISTS request_id BIGINT REFERENCES operator_requests(request_id);

ALTER TABLE replication_job_runs
  ADD COLUMN IF NOT EXISTS request_id BIGINT REFERENCES operator_requests(request_id);

ALTER TABLE resolution_runs
  ADD COLUMN IF NOT EXISTS request_id BIGINT REFERENCES operator_requests(request_id);

ALTER TABLE checkpoint_publications
  ADD COLUMN IF NOT EXISTS request_id BIGINT REFERENCES operator_requests(request_id);

CREATE INDEX IF NOT EXISTS replication_jobs_request_id_idx
  ON replication_jobs (request_id);

CREATE INDEX IF NOT EXISTS replication_job_runs_request_id_idx
  ON replication_job_runs (request_id);

CREATE INDEX IF NOT EXISTS resolution_runs_request_id_idx
  ON resolution_runs (request_id);

CREATE INDEX IF NOT EXISTS checkpoint_publications_request_id_idx
  ON checkpoint_publications (request_id);
