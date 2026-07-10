CREATE TABLE IF NOT EXISTS source_publication_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id BIGINT NOT NULL REFERENCES source_records(source_id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  publication_mode TEXT NOT NULL CHECK (publication_mode IN ('auto', 'manual')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claim_ready', 'completed', 'reconciliation_required')
  ),
  claim_id TEXT,
  transaction_hashes JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id)
);

CREATE INDEX IF NOT EXISTS source_publication_attempts_status_idx
  ON source_publication_attempts (status, updated_at);
