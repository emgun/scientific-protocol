CREATE TABLE IF NOT EXISTS indexer_state (
  name TEXT PRIMARY KEY,
  last_processed_block INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
