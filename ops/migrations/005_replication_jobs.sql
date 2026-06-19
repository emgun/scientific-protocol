CREATE TABLE IF NOT EXISTS persisted_artifacts (
  artifact_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS replication_jobs (
  job_id BIGSERIAL PRIMARY KEY,
  claim_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  spec_uri TEXT,
  assigned_worker TEXT,
  assigned_agent_id TEXT,
  assigned_at TIMESTAMPTZ,
  result_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  result_hash TEXT,
  evidence_hash TEXT,
  evidence_uri TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS replication_jobs_claim_id_idx ON replication_jobs (claim_id);
CREATE INDEX IF NOT EXISTS replication_jobs_status_idx ON replication_jobs (status);
CREATE INDEX IF NOT EXISTS replication_jobs_assigned_worker_idx ON replication_jobs (assigned_worker);

CREATE TABLE IF NOT EXISTS replication_job_runs (
  run_id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES replication_jobs(job_id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL,
  execution_manifest_hash TEXT,
  result_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  result_hash TEXT,
  evidence_hash TEXT,
  evidence_uri TEXT,
  failure_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS replication_job_runs_job_id_idx ON replication_job_runs (job_id);
