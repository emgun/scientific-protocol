CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  uri TEXT NOT NULL,
  budget_balance TEXT NOT NULL,
  reserved_budget TEXT NOT NULL,
  spend_limit TEXT NOT NULL,
  active BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_controllers (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  controller TEXT NOT NULL,
  authorized BOOLEAN NOT NULL,
  PRIMARY KEY (agent_id, controller)
);

CREATE TABLE IF NOT EXISTS forecasts (
  forecast_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  forecaster TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  commitment_hash TEXT NOT NULL,
  stake_amount TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  reveal_deadline INTEGER NOT NULL,
  revealed BOOLEAN NOT NULL,
  settled BOOLEAN NOT NULL,
  direction INTEGER NOT NULL,
  confidence_bps INTEGER NOT NULL,
  final_status INTEGER,
  matched BOOLEAN,
  payout_amount TEXT
);

CREATE TABLE IF NOT EXISTS challenges (
  challenge_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  replication_id TEXT NOT NULL,
  challenger TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_uri TEXT NOT NULL,
  bond_amount TEXT NOT NULL,
  status INTEGER NOT NULL,
  resolution_hash TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  payout_amount TEXT,
  refunded_amount TEXT
);

CREATE TABLE IF NOT EXISTS appeals (
  appeal_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  replication_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  appellant TEXT NOT NULL,
  reason INTEGER NOT NULL,
  filing_hash TEXT NOT NULL,
  uri TEXT NOT NULL,
  status INTEGER NOT NULL,
  adjudication_hash TEXT,
  adjudication_uri TEXT,
  bond_amount TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  adjudicated_at INTEGER,
  refunded_amount TEXT
);

CREATE INDEX IF NOT EXISTS forecasts_claim_id_idx ON forecasts (claim_id);
CREATE INDEX IF NOT EXISTS challenges_claim_id_idx ON challenges (claim_id);
CREATE INDEX IF NOT EXISTS appeals_claim_id_idx ON appeals (claim_id);
