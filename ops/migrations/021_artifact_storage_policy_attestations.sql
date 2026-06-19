CREATE TABLE IF NOT EXISTS persisted_artifact_storage_policies (
  artifact_key TEXT PRIMARY KEY REFERENCES persisted_artifacts(artifact_key) ON DELETE CASCADE,
  durability_class TEXT NOT NULL CHECK (durability_class IN ('A', 'B', 'C', 'D')),
  required_replica_count INTEGER NOT NULL CHECK (required_replica_count >= 0),
  required_independent_retrieval_paths INTEGER NOT NULL CHECK (
    required_independent_retrieval_paths >= 0
  ),
  requires_filecoin_or_equivalent BOOLEAN NOT NULL DEFAULT FALSE,
  repair_priority INTEGER NOT NULL DEFAULT 0 CHECK (repair_priority >= 0),
  bundle_cid TEXT,
  bundle_member_path TEXT,
  retention_until TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS persisted_artifact_storage_policies_durability_class_idx
  ON persisted_artifact_storage_policies (durability_class);

CREATE TABLE IF NOT EXISTS persisted_artifact_storage_attestations (
  attestation_id BIGSERIAL PRIMARY KEY,
  artifact_key TEXT NOT NULL REFERENCES persisted_artifacts(artifact_key) ON DELETE CASCADE,
  attestor_address TEXT NOT NULL,
  node_id TEXT,
  cid TEXT NOT NULL,
  provider TEXT NOT NULL,
  retrieval_url TEXT,
  commitment_kind TEXT NOT NULL,
  storage_class TEXT NOT NULL CHECK (storage_class IN ('A', 'B', 'C', 'D')),
  storage_started_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ,
  evidence_ref TEXT,
  signature TEXT NOT NULL,
  signed_payload_hash TEXT NOT NULL,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (artifact_key, signed_payload_hash)
);

CREATE INDEX IF NOT EXISTS persisted_artifact_storage_attestations_artifact_key_idx
  ON persisted_artifact_storage_attestations (artifact_key, created_at DESC);

CREATE INDEX IF NOT EXISTS persisted_artifact_storage_attestations_cid_idx
  ON persisted_artifact_storage_attestations (cid);

CREATE INDEX IF NOT EXISTS persisted_artifact_storage_attestations_attestor_idx
  ON persisted_artifact_storage_attestations (attestor_address);
