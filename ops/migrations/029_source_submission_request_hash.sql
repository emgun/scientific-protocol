ALTER TABLE source_submission_records
  ADD COLUMN IF NOT EXISTS request_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS source_submission_records_request_hash_idx
  ON source_submission_records (request_hash)
  WHERE request_hash IS NOT NULL;
