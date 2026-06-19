CREATE TABLE IF NOT EXISTS source_records (
  source_id BIGSERIAL PRIMARY KEY,
  canonical_source_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL,
  discovery_mode TEXT NOT NULL,
  submitted_by_actor TEXT,
  submitted_by_agent_id TEXT,
  status TEXT NOT NULL,
  snapshot_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key) ON DELETE SET NULL,
  extraction_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key) ON DELETE SET NULL,
  published_claim_id TEXT REFERENCES claims(claim_id) ON DELETE SET NULL,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_records_status_idx
  ON source_records (status, created_at DESC);

CREATE INDEX IF NOT EXISTS source_records_published_claim_id_idx
  ON source_records (published_claim_id);

CREATE TABLE IF NOT EXISTS source_extraction_candidates (
  candidate_id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES source_records(source_id) ON DELETE CASCADE,
  submission_id TEXT UNIQUE,
  task_id TEXT NOT NULL,
  reviewer_agent_id TEXT,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  methodology TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL,
  anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS source_extraction_candidates_source_id_idx
  ON source_extraction_candidates (source_id, created_at DESC);

ALTER TABLE review_tasks
  ADD COLUMN IF NOT EXISTS source_id BIGINT REFERENCES source_records(source_id) ON DELETE CASCADE;

ALTER TABLE review_tasks
  ADD COLUMN IF NOT EXISTS subject_type TEXT;

ALTER TABLE review_tasks
  ADD COLUMN IF NOT EXISTS subject_id TEXT;

ALTER TABLE review_tasks
  ALTER COLUMN claim_id DROP NOT NULL;

UPDATE review_tasks
SET
  subject_type = COALESCE(subject_type, 'claim'),
  subject_id = COALESCE(subject_id, claim_id)
WHERE subject_type IS NULL OR subject_id IS NULL;

ALTER TABLE review_tasks
  ALTER COLUMN subject_type SET DEFAULT 'claim';

CREATE INDEX IF NOT EXISTS review_tasks_source_id_idx
  ON review_tasks (source_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS review_tasks_open_subject_identity_idx
  ON review_tasks (subject_type, subject_id, task_type, scope_key)
  WHERE status = 'open';

ALTER TABLE review_submissions
  ADD COLUMN IF NOT EXISTS source_id BIGINT REFERENCES source_records(source_id) ON DELETE CASCADE;

ALTER TABLE review_submissions
  ALTER COLUMN claim_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS review_submissions_source_id_idx
  ON review_submissions (source_id, created_at DESC);
