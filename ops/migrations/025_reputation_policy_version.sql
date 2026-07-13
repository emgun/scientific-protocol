ALTER TABLE reputation_payloads
  ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'legacy-v1';
