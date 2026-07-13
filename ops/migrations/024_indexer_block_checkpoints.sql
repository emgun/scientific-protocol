CREATE TABLE IF NOT EXISTS indexer_block_checkpoints (
  name TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (name, block_number)
);

CREATE INDEX IF NOT EXISTS indexer_block_checkpoints_latest_idx
  ON indexer_block_checkpoints (name, block_number DESC);
