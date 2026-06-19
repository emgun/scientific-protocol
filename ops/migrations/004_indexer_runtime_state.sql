CREATE TABLE IF NOT EXISTS indexer_runtime_state (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
