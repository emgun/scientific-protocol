ALTER TABLE public_write_requests
  ADD COLUMN IF NOT EXISTS execution_lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS public_write_requests_execution_lease_idx
  ON public_write_requests (execution_lease_expires_at)
  WHERE execution_lease_expires_at IS NOT NULL;
