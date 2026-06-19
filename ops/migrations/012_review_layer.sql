CREATE TABLE IF NOT EXISTS review_tasks (
  task_id BIGSERIAL PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_artifact_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  consensus_policy JSONB NOT NULL DEFAULT '{"minSubmissions":1,"maxSubmissions":1,"requireDistinctAgents":false}'::jsonb,
  result_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS review_tasks_claim_id_idx
  ON review_tasks (claim_id, created_at DESC);

CREATE INDEX IF NOT EXISTS review_tasks_status_idx
  ON review_tasks (status, task_type, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS review_tasks_open_identity_idx
  ON review_tasks (claim_id, task_type, scope_key)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS review_task_runs (
  run_id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES review_tasks(task_id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL,
  failure_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS review_task_runs_task_id_idx
  ON review_task_runs (task_id, started_at DESC);

CREATE INDEX IF NOT EXISTS review_task_runs_agent_id_idx
  ON review_task_runs (agent_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS review_task_runs_running_identity_idx
  ON review_task_runs (task_id, COALESCE(agent_id, ''), worker_id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS review_submissions (
  submission_id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES review_tasks(task_id) ON DELETE CASCADE,
  run_id BIGINT REFERENCES review_task_runs(run_id) ON DELETE SET NULL,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  reviewer_actor TEXT NOT NULL,
  reviewer_agent_id TEXT,
  review_type TEXT NOT NULL,
  verdict TEXT NOT NULL,
  confidence_bps INTEGER NOT NULL,
  evidence_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  result_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  schema_version TEXT NOT NULL,
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_submissions_claim_id_idx
  ON review_submissions (claim_id, created_at DESC);

CREATE INDEX IF NOT EXISTS review_submissions_task_id_idx
  ON review_submissions (task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS review_submissions_agent_id_idx
  ON review_submissions (reviewer_agent_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS review_submissions_run_id_idx
  ON review_submissions (run_id)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_issues (
  issue_id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES review_submissions(submission_id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  artifact_anchor JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_issues_submission_id_idx
  ON review_issues (submission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS review_issues_status_idx
  ON review_issues (status, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS review_author_responses (
  response_id BIGSERIAL PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  responder_actor TEXT NOT NULL,
  response_artifact_key TEXT NOT NULL REFERENCES persisted_artifacts(artifact_key),
  issue_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_author_responses_claim_id_idx
  ON review_author_responses (claim_id, created_at DESC);
