ALTER TABLE replication_job_runs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

UPDATE replication_job_runs
SET last_heartbeat_at = started_at
WHERE last_heartbeat_at IS NULL;

ALTER TABLE artifact_maintenance_task_runs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

UPDATE artifact_maintenance_task_runs
SET last_heartbeat_at = started_at
WHERE last_heartbeat_at IS NULL;

ALTER TABLE review_task_runs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

UPDATE review_task_runs
SET last_heartbeat_at = started_at
WHERE last_heartbeat_at IS NULL;

CREATE INDEX IF NOT EXISTS replication_job_runs_last_heartbeat_idx
  ON replication_job_runs (status, COALESCE(last_heartbeat_at, started_at));

CREATE INDEX IF NOT EXISTS artifact_maintenance_task_runs_last_heartbeat_idx
  ON artifact_maintenance_task_runs (status, COALESCE(last_heartbeat_at, started_at));

CREATE INDEX IF NOT EXISTS review_task_runs_last_heartbeat_idx
  ON review_task_runs (status, COALESCE(last_heartbeat_at, started_at));
