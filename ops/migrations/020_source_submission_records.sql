CREATE TABLE IF NOT EXISTS source_submission_records (
  submission_id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES source_records(source_id) ON DELETE CASCADE,
  canonical_source_key TEXT NOT NULL,
  submitted_by_actor TEXT,
  submitted_by_agent_id TEXT,
  discovery_mode TEXT NOT NULL,
  submission_outcome TEXT NOT NULL,
  raw_locator TEXT NOT NULL,
  normalized_locator TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_submission_records_source_id_idx
  ON source_submission_records (source_id, created_at DESC);
