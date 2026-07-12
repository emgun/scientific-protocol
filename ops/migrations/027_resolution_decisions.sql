CREATE TABLE IF NOT EXISTS resolution_decisions (
  decision_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  replication_id TEXT NOT NULL UNIQUE REFERENCES replications(replication_id) ON DELETE CASCADE,
  resolution_module TEXT NOT NULL,
  status INTEGER NOT NULL,
  claim_status INTEGER NOT NULL,
  confidence_bps INTEGER NOT NULL,
  resolution_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  resolver_type INTEGER NOT NULL,
  created_at NUMERIC NOT NULL,
  actor TEXT NOT NULL
);

ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS resolution_decision_id TEXT;
ALTER TABLE forecasts DROP CONSTRAINT IF EXISTS forecasts_resolution_decision_id_fkey;
ALTER TABLE forecasts
  ADD CONSTRAINT forecasts_resolution_decision_id_fkey
  FOREIGN KEY (resolution_decision_id) REFERENCES resolution_decisions(decision_id);

CREATE INDEX IF NOT EXISTS resolution_decisions_claim_id_idx
  ON resolution_decisions (claim_id, CAST(decision_id AS NUMERIC));
