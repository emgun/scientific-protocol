CREATE TABLE IF NOT EXISTS reputation_payloads (
  payload_id BIGSERIAL PRIMARY KEY,
  domain_id BIGINT NOT NULL,
  cutoff_block BIGINT NOT NULL,
  cursor_block BIGINT,
  payload_hash TEXT NOT NULL UNIQUE,
  artifact_key TEXT NOT NULL REFERENCES persisted_artifacts(artifact_key),
  entry_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reputation_payloads_domain_created_idx
  ON reputation_payloads (domain_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reputation_leaderboard_entries (
  payload_id BIGINT NOT NULL REFERENCES reputation_payloads(payload_id) ON DELETE CASCADE,
  domain_id BIGINT NOT NULL,
  rank INTEGER NOT NULL,
  subject_actor TEXT NOT NULL,
  score BIGINT NOT NULL,
  claim_count INTEGER NOT NULL,
  supported_claim_count INTEGER NOT NULL,
  refuted_claim_count INTEGER NOT NULL,
  fraudulent_claim_count INTEGER NOT NULL,
  replication_count INTEGER NOT NULL,
  checkpoint_count INTEGER NOT NULL,
  PRIMARY KEY (payload_id, subject_actor)
);

CREATE INDEX IF NOT EXISTS reputation_leaderboard_domain_rank_idx
  ON reputation_leaderboard_entries (domain_id, rank ASC);
