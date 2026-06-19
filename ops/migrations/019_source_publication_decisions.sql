CREATE TABLE IF NOT EXISTS source_publication_decisions (
  decision_id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES source_records(source_id) ON DELETE CASCADE,
  decision_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key) ON DELETE SET NULL,
  published_claim_id TEXT REFERENCES claims(claim_id) ON DELETE SET NULL,
  should_publish BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  competing_strength_ratio NUMERIC,
  winning_cluster JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_publication_decisions_source_id_idx
  ON source_publication_decisions (source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS source_publication_decisions_published_claim_id_idx
  ON source_publication_decisions (published_claim_id);
