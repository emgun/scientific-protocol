CREATE TABLE IF NOT EXISTS agent_webhook_subscriptions (
  subscription_id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  actor_address TEXT NOT NULL,
  label TEXT,
  target_url TEXT NOT NULL,
  event_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  signing_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cursor_occurred_at TIMESTAMPTZ,
  cursor_event_id TEXT,
  last_enqueued_at TIMESTAMPTZ,
  last_delivery_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(event_types) = 'array'),
  CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS agent_webhook_subscriptions_agent_idx
  ON agent_webhook_subscriptions (agent_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_webhook_subscriptions_status_idx
  ON agent_webhook_subscriptions (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_webhook_deliveries (
  delivery_id BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT NOT NULL REFERENCES agent_webhook_subscriptions (subscription_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  response_status INTEGER,
  response_body TEXT,
  signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (status IN ('pending', 'retrying', 'delivered', 'failed')),
  UNIQUE (subscription_id, event_id)
);

CREATE INDEX IF NOT EXISTS agent_webhook_deliveries_due_idx
  ON agent_webhook_deliveries (status, next_attempt_at, delivery_id);

CREATE INDEX IF NOT EXISTS agent_webhook_deliveries_subscription_idx
  ON agent_webhook_deliveries (subscription_id, created_at DESC);
