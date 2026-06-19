ALTER TABLE persisted_artifact_replicas
  ADD COLUMN IF NOT EXISTS provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
