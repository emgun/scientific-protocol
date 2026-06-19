CREATE TABLE IF NOT EXISTS work_reward_settlements (
  settlement_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  work_kind TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  settlement_label TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  recipient TEXT NOT NULL,
  agent_id TEXT,
  amount_wei NUMERIC(78, 0) NOT NULL,
  accrued_total_wei NUMERIC(78, 0) NOT NULL,
  target_total_wei NUMERIC(78, 0) NOT NULL,
  market_pressure_bps INTEGER NOT NULL,
  quality_bps INTEGER NOT NULL,
  budget_top_up_bps INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS work_reward_settlements_item_idx
  ON work_reward_settlements (item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS work_reward_settlements_claim_idx
  ON work_reward_settlements (claim_id, work_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS work_reward_settlements_agent_idx
  ON work_reward_settlements (agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS work_reward_settlements_policy_label_idx
  ON work_reward_settlements (item_id, policy_version, settlement_label);
