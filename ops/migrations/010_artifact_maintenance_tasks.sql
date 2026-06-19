CREATE TABLE IF NOT EXISTS artifact_maintenance_tasks (
  task_id BIGSERIAL PRIMARY KEY,
  artifact_key TEXT NOT NULL REFERENCES persisted_artifacts(artifact_key) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  target_replica_key TEXT,
  target_provider TEXT,
  assigned_worker TEXT,
  assigned_agent_id TEXT,
  assigned_at TIMESTAMPTZ,
  result_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  failure_reason TEXT,
  repair_source_replica_key TEXT,
  repair_locator TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS artifact_maintenance_tasks_artifact_key_idx
  ON artifact_maintenance_tasks (artifact_key, created_at DESC);

CREATE INDEX IF NOT EXISTS artifact_maintenance_tasks_status_idx
  ON artifact_maintenance_tasks (status, task_type, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_maintenance_tasks_open_identity_idx
  ON artifact_maintenance_tasks (
    artifact_key,
    task_type,
    COALESCE(target_replica_key, '')
  )
  WHERE status IN ('open', 'assigned');

CREATE TABLE IF NOT EXISTS artifact_maintenance_task_runs (
  run_id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES artifact_maintenance_tasks(task_id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL,
  summary_artifact_key TEXT REFERENCES persisted_artifacts(artifact_key),
  failure_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS artifact_maintenance_task_runs_task_id_idx
  ON artifact_maintenance_task_runs (task_id, started_at DESC);
