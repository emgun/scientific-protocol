ALTER TABLE replication_jobs
  ADD COLUMN IF NOT EXISTS onchain_replication_id TEXT,
  ADD COLUMN IF NOT EXISTS submission_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS submission_actor TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

ALTER TABLE replication_job_runs
  ADD COLUMN IF NOT EXISTS submission_tx_hash TEXT;

CREATE INDEX IF NOT EXISTS replication_jobs_onchain_replication_id_idx
  ON replication_jobs (onchain_replication_id);

CREATE TABLE IF NOT EXISTS resolution_runs (
  run_id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES replication_jobs(job_id) ON DELETE SET NULL,
  claim_id TEXT NOT NULL,
  replication_id TEXT NOT NULL UNIQUE,
  resolver TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution_status INTEGER NOT NULL,
  claim_status INTEGER,
  resolver_type INTEGER NOT NULL,
  confidence_bps INTEGER NOT NULL,
  resolution_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_uri TEXT,
  rationale_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  payout_amount TEXT,
  tx_hashes_json TEXT NOT NULL DEFAULT '[]',
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resolution_runs_job_id_idx
  ON resolution_runs (job_id);

CREATE INDEX IF NOT EXISTS resolution_runs_claim_id_idx
  ON resolution_runs (claim_id);

CREATE INDEX IF NOT EXISTS resolution_runs_status_idx
  ON resolution_runs (status);

CREATE TABLE IF NOT EXISTS checkpoint_publications (
  publication_id BIGSERIAL PRIMARY KEY,
  payload_id BIGINT NOT NULL REFERENCES reputation_payloads(payload_id) ON DELETE CASCADE,
  domain_id BIGINT NOT NULL,
  publisher TEXT NOT NULL,
  subject_type INTEGER NOT NULL,
  subject_actor TEXT NOT NULL,
  subject_claim_id TEXT NOT NULL,
  subject_agent_id TEXT NOT NULL,
  subject_module TEXT NOT NULL,
  score_vector_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  uri TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpoint_id TEXT,
  tx_hash TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS checkpoint_publications_payload_id_idx
  ON checkpoint_publications (payload_id);

CREATE INDEX IF NOT EXISTS checkpoint_publications_domain_id_idx
  ON checkpoint_publications (domain_id);

CREATE INDEX IF NOT EXISTS checkpoint_publications_status_idx
  ON checkpoint_publications (status);
