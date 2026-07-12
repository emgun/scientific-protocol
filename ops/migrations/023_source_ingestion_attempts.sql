CREATE TABLE IF NOT EXISTS source_ingestion_attempts (
  canonical_source_key TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  raw_locator TEXT NOT NULL,
  normalized_locator TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ingesting', 'completed', 'failed')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  source_id BIGINT REFERENCES source_records(source_id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_ingestion_attempts_status_lease_idx
  ON source_ingestion_attempts (status, lease_expires_at);
