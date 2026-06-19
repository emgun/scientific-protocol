CREATE TABLE IF NOT EXISTS demo_scenarios (
  scenario_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  domain_id BIGINT NOT NULL,
  eyebrow TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  why_it_matters TEXT,
  proof_point TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS demo_scenarios_claim_id_idx
  ON demo_scenarios (claim_id);
