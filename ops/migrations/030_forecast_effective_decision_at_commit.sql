ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS effective_decision_id_at_commit TEXT;
ALTER TABLE forecasts DROP CONSTRAINT IF EXISTS forecasts_effective_decision_id_at_commit_fkey;
ALTER TABLE forecasts
  ADD CONSTRAINT forecasts_effective_decision_id_at_commit_fkey
  FOREIGN KEY (effective_decision_id_at_commit) REFERENCES resolution_decisions(decision_id);
