CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  domain_id INTEGER NOT NULL,
  metadata_hash TEXT NOT NULL,
  resolution_module TEXT NOT NULL,
  status INTEGER NOT NULL,
  revision_of_claim_id TEXT,
  created_at_block INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  artifact_type INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  uri TEXT NOT NULL,
  submitter TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replications (
  replication_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  replicator TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  outcome INTEGER,
  resolution_status INTEGER,
  confidence_bps INTEGER,
  resolver_type INTEGER,
  resolution_hash TEXT,
  evidence_hash TEXT,
  evidence_uri TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  domain_id INTEGER NOT NULL,
  subject_type INTEGER NOT NULL,
  subject_actor TEXT NOT NULL,
  subject_claim_id TEXT NOT NULL,
  subject_agent_id TEXT NOT NULL,
  subject_module TEXT NOT NULL,
  score_vector_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  uri TEXT NOT NULL
);
