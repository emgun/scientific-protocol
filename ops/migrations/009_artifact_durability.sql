CREATE TABLE IF NOT EXISTS persisted_artifact_replicas (
  replica_id BIGSERIAL PRIMARY KEY,
  artifact_key TEXT NOT NULL REFERENCES persisted_artifacts(artifact_key) ON DELETE CASCADE,
  replica_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  locator TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ,
  last_check_status TEXT,
  last_check_error TEXT,
  UNIQUE (artifact_key, replica_key)
);

CREATE INDEX IF NOT EXISTS persisted_artifact_replicas_artifact_key_idx
  ON persisted_artifact_replicas (artifact_key);

CREATE TABLE IF NOT EXISTS persisted_artifact_audits (
  audit_id BIGSERIAL PRIMARY KEY,
  artifact_key TEXT NOT NULL REFERENCES persisted_artifacts(artifact_key) ON DELETE CASCADE,
  replica_key TEXT,
  provider TEXT NOT NULL,
  locator TEXT,
  check_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  observed_sha256 TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS persisted_artifact_audits_artifact_key_idx
  ON persisted_artifact_audits (artifact_key, checked_at DESC);

CREATE TABLE IF NOT EXISTS persisted_artifact_provenance (
  artifact_key TEXT PRIMARY KEY REFERENCES persisted_artifacts(artifact_key) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  ref TEXT,
  commit_hash TEXT,
  cid TEXT,
  final_url TEXT,
  derived_from_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
