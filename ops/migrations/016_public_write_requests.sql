CREATE TABLE IF NOT EXISTS public_write_requests (
  request_id BIGSERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,
  actor_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS public_write_requests_actor_nonce_idx
  ON public_write_requests (action_type, lower(actor_address), request_nonce);

CREATE INDEX IF NOT EXISTS public_write_requests_scope_key_idx
  ON public_write_requests (scope_key, created_at DESC);
