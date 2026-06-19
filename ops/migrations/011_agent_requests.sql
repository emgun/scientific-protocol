CREATE TABLE IF NOT EXISTS agent_requests (
  request_id BIGSERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  actor_address TEXT NOT NULL,
  request_nonce TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  request_hash TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  outcome_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_requests_actor_nonce_idx
  ON agent_requests (action_type, lower(actor_address), request_nonce);

CREATE INDEX IF NOT EXISTS agent_requests_agent_id_idx
  ON agent_requests (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_requests_scope_key_idx
  ON agent_requests (scope_key, created_at DESC);
