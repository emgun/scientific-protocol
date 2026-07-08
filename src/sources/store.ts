import type { Pool, PoolClient } from "pg";
import { createReadModelPool, getDatabaseUrl, migrateReadModelDb } from "../indexer/store.js";
import type {
  SourceExtractionCandidate,
  SourcePublicationCluster,
  SourcePublicationDecisionView,
  SourceRecordView,
  SourceSubmissionOutcome,
  SourceSubmissionRecordView,
} from "./types.js";

type Queryable = Pool | PoolClient;

type SourceRecordRow = {
  canonicalSourceKey: string;
  createdAt: Date;
  discoveryMode: string;
  extractionArtifactKey: string | null;
  publishedClaimId: string | null;
  snapshotArtifactKey: string | null;
  sourceId: string;
  sourceMetadata: Record<string, unknown> | null;
  sourceType: string;
  status: string;
  submittedByActor: string | null;
  submittedByAgentId: string | null;
  updatedAt: Date;
};

type SourceSubmissionRecordRow = {
  canonicalSourceKey: string;
  createdAt: Date;
  discoveryMode: string;
  normalizedLocator: string;
  rawLocator: string;
  sourceId: string;
  submissionId: string;
  submissionOutcome: string;
  submittedByActor: string | null;
  submittedByAgentId: string | null;
};

type SourceExtractionCandidateRow = {
  anchors: Array<{ label?: string; text?: string }> | null;
  candidateId: string;
  claimType: string;
  confidenceBps: number;
  createdAt: Date;
  methodology: string;
  reviewerAgentId: string | null;
  scope: string;
  sourceId: string;
  statement: string;
  submissionId: string;
  taskId: string;
};

type SourcePublicationDecisionRow = {
  competingStrengthRatio: string | null;
  createdAt: Date;
  decisionArtifactKey: string | null;
  decisionId: string;
  publishedClaimId: string | null;
  reason: string;
  shouldPublish: boolean;
  sourceId: string;
  winningCluster: SourcePublicationCluster | null;
};

function mapSourceRecordRow(row: SourceRecordRow): SourceRecordView {
  return {
    canonicalSourceKey: row.canonicalSourceKey,
    createdAt: row.createdAt.toISOString(),
    discoveryMode: row.discoveryMode as SourceRecordView["discoveryMode"],
    extractionArtifactKey: row.extractionArtifactKey,
    publishedClaimId: row.publishedClaimId,
    snapshotArtifactKey: row.snapshotArtifactKey,
    sourceId: row.sourceId,
    sourceMetadata: row.sourceMetadata ?? {},
    sourceType: row.sourceType as SourceRecordView["sourceType"],
    status: row.status as SourceRecordView["status"],
    submittedByActor: row.submittedByActor,
    submittedByAgentId: row.submittedByAgentId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSourceExtractionCandidateRow(
  row: SourceExtractionCandidateRow,
): SourceExtractionCandidate {
  return {
    anchors: Array.isArray(row.anchors)
      ? row.anchors.map((anchor) => ({
          label: String(anchor?.label ?? "source"),
          text: String(anchor?.text ?? ""),
        }))
      : [],
    candidateId: row.candidateId,
    claimType: row.claimType,
    confidenceBps: row.confidenceBps,
    createdAt: row.createdAt.toISOString(),
    methodology: row.methodology,
    reviewerAgentId: row.reviewerAgentId,
    scope: row.scope,
    statement: row.statement,
    submissionId: row.submissionId,
    taskId: row.taskId,
  };
}

function mapSourcePublicationDecisionRow(
  row: SourcePublicationDecisionRow,
): SourcePublicationDecisionView {
  return {
    competingStrengthRatio:
      row.competingStrengthRatio === null ? null : Number(row.competingStrengthRatio),
    createdAt: row.createdAt.toISOString(),
    decisionArtifactKey: row.decisionArtifactKey,
    decisionId: row.decisionId,
    publishedClaimId: row.publishedClaimId,
    reason: row.reason,
    shouldPublish: row.shouldPublish,
    sourceId: row.sourceId,
    winningCluster: row.winningCluster,
  };
}

function mapSourceSubmissionRecordRow(row: SourceSubmissionRecordRow): SourceSubmissionRecordView {
  return {
    canonicalSourceKey: row.canonicalSourceKey,
    createdAt: row.createdAt.toISOString(),
    discoveryMode: row.discoveryMode as SourceSubmissionRecordView["discoveryMode"],
    normalizedLocator: row.normalizedLocator,
    rawLocator: row.rawLocator,
    sourceId: row.sourceId,
    submissionId: row.submissionId,
    submissionOutcome: row.submissionOutcome as SourceSubmissionOutcome,
    submittedByActor: row.submittedByActor,
    submittedByAgentId: row.submittedByAgentId,
  };
}

export async function prepareSourceStore(
  connectionString = getDatabaseUrl(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function upsertSourceRecord(
  queryable: Queryable,
  input: {
    canonicalSourceKey: string;
    discoveryMode: SourceRecordView["discoveryMode"];
    extractionArtifactKey?: string | null;
    publishedClaimId?: string | null;
    snapshotArtifactKey?: string | null;
    sourceMetadata?: Record<string, unknown>;
    sourceType: SourceRecordView["sourceType"];
    status: SourceRecordView["status"];
    submittedByActor?: string | null;
    submittedByAgentId?: string | null;
  },
): Promise<SourceRecordView> {
  const result = await queryable.query<{ source_id: string }>(
    `
      INSERT INTO source_records (
        canonical_source_key,
        source_type,
        discovery_mode,
        submitted_by_actor,
        submitted_by_agent_id,
        status,
        snapshot_artifact_key,
        extraction_artifact_key,
        published_claim_id,
        source_metadata
      ) VALUES ($1, $2, $3, lower($4), $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (canonical_source_key) DO UPDATE SET
        source_type = EXCLUDED.source_type,
        discovery_mode = EXCLUDED.discovery_mode,
        submitted_by_actor = COALESCE(source_records.submitted_by_actor, EXCLUDED.submitted_by_actor),
        submitted_by_agent_id = COALESCE(source_records.submitted_by_agent_id, EXCLUDED.submitted_by_agent_id),
        status = EXCLUDED.status,
        snapshot_artifact_key = COALESCE(EXCLUDED.snapshot_artifact_key, source_records.snapshot_artifact_key),
        extraction_artifact_key = COALESCE(EXCLUDED.extraction_artifact_key, source_records.extraction_artifact_key),
        published_claim_id = COALESCE(EXCLUDED.published_claim_id, source_records.published_claim_id),
        source_metadata = COALESCE(source_records.source_metadata, '{}'::jsonb) || EXCLUDED.source_metadata,
        updated_at = NOW()
      RETURNING source_id::text AS source_id
    `,
    [
      input.canonicalSourceKey,
      input.sourceType,
      input.discoveryMode,
      input.submittedByActor ?? null,
      input.submittedByAgentId ?? null,
      input.status,
      input.snapshotArtifactKey ?? null,
      input.extractionArtifactKey ?? null,
      input.publishedClaimId ?? null,
      JSON.stringify(input.sourceMetadata ?? {}),
    ],
  );
  const sourceId = result.rows[0]?.source_id;
  if (!sourceId) {
    throw new Error("source_record_upsert_failed");
  }
  const source = await readSourceRecord(queryable, sourceId);
  if (!source) {
    throw new Error("source_record_upsert_failed");
  }
  return source;
}

export async function readSourceRecord(
  queryable: Queryable,
  sourceId: string,
): Promise<SourceRecordView | undefined> {
  const result = await queryable.query<SourceRecordRow>(
    `
      SELECT
        source_id::text AS "sourceId",
        canonical_source_key AS "canonicalSourceKey",
        source_type AS "sourceType",
        discovery_mode AS "discoveryMode",
        submitted_by_actor AS "submittedByActor",
        submitted_by_agent_id AS "submittedByAgentId",
        status,
        snapshot_artifact_key AS "snapshotArtifactKey",
        extraction_artifact_key AS "extractionArtifactKey",
        published_claim_id AS "publishedClaimId",
        source_metadata AS "sourceMetadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM source_records
      WHERE source_id = $1
    `,
    [sourceId],
  );
  const row = result.rows[0];
  return row ? mapSourceRecordRow(row) : undefined;
}

export async function readSourceByCanonicalKey(
  queryable: Queryable,
  canonicalSourceKey: string,
): Promise<SourceRecordView | undefined> {
  const result = await queryable.query<SourceRecordRow>(
    `
      SELECT
        source_id::text AS "sourceId",
        canonical_source_key AS "canonicalSourceKey",
        source_type AS "sourceType",
        discovery_mode AS "discoveryMode",
        submitted_by_actor AS "submittedByActor",
        submitted_by_agent_id AS "submittedByAgentId",
        status,
        snapshot_artifact_key AS "snapshotArtifactKey",
        extraction_artifact_key AS "extractionArtifactKey",
        published_claim_id AS "publishedClaimId",
        source_metadata AS "sourceMetadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM source_records
      WHERE canonical_source_key = $1
    `,
    [canonicalSourceKey],
  );
  const row = result.rows[0];
  return row ? mapSourceRecordRow(row) : undefined;
}

export async function readSourcesPage(
  queryable: Queryable,
  input: {
    limit?: number;
    offset?: number;
    status?: SourceRecordView["status"];
  } = {},
): Promise<{ items: SourceRecordView[]; limit: number; offset: number; total: number }> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.status) {
    values.push(input.status);
    clauses.push(`status = $${values.length}`);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const count = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM source_records ${whereClause}`,
    values,
  );
  const result = await queryable.query<SourceRecordRow>(
    `
      SELECT
        source_id::text AS "sourceId",
        canonical_source_key AS "canonicalSourceKey",
        source_type AS "sourceType",
        discovery_mode AS "discoveryMode",
        submitted_by_actor AS "submittedByActor",
        submitted_by_agent_id AS "submittedByAgentId",
        status,
        snapshot_artifact_key AS "snapshotArtifactKey",
        extraction_artifact_key AS "extractionArtifactKey",
        published_claim_id AS "publishedClaimId",
        source_metadata AS "sourceMetadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM source_records
      ${whereClause}
      ORDER BY created_at DESC, source_id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, limit, offset],
  );
  return {
    items: result.rows.map(mapSourceRecordRow),
    limit,
    offset,
    total: Number(count.rows[0]?.count ?? "0"),
  };
}

export async function markSourcePublished(
  queryable: Queryable,
  input: { publishedClaimId: string; sourceId: string },
): Promise<SourceRecordView | undefined> {
  await queryable.query(
    `
      UPDATE source_records
      SET published_claim_id = $2, status = 'published', updated_at = NOW()
      WHERE source_id = $1
    `,
    [input.sourceId, input.publishedClaimId],
  );
  return readSourceRecord(queryable, input.sourceId);
}

export async function updateSourceRecordStatus(
  queryable: Queryable,
  input: { sourceId: string; status: SourceRecordView["status"] },
): Promise<SourceRecordView | undefined> {
  await queryable.query(
    `
      UPDATE source_records
      SET status = $2, updated_at = NOW()
      WHERE source_id = $1
    `,
    [input.sourceId, input.status],
  );
  return readSourceRecord(queryable, input.sourceId);
}

export async function recordSourcePublicationDecision(
  queryable: Queryable,
  input: {
    competingStrengthRatio?: number | null;
    decisionArtifactKey?: string | null;
    publishedClaimId?: string | null;
    reason: string;
    shouldPublish: boolean;
    sourceId: string;
    winningCluster?: SourcePublicationCluster | null;
  },
): Promise<SourcePublicationDecisionView> {
  const result = await queryable.query<{ decision_id: string }>(
    `
      INSERT INTO source_publication_decisions (
        source_id,
        decision_artifact_key,
        published_claim_id,
        should_publish,
        reason,
        competing_strength_ratio,
        winning_cluster
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING decision_id::text AS decision_id
    `,
    [
      input.sourceId,
      input.decisionArtifactKey ?? null,
      input.publishedClaimId ?? null,
      input.shouldPublish,
      input.reason,
      input.competingStrengthRatio ?? null,
      input.winningCluster ? JSON.stringify(input.winningCluster) : null,
    ],
  );
  const decisionId = result.rows[0]?.decision_id;
  if (!decisionId) {
    throw new Error("source_publication_decision_insert_failed");
  }
  const page = await readSourcePublicationDecisionsPage(queryable, {
    limit: 1,
    offset: 0,
    sourceId: input.sourceId,
  });
  const decision = page.items.find((entry) => entry.decisionId === decisionId);
  if (!decision) {
    throw new Error("source_publication_decision_insert_failed");
  }
  return decision;
}

export async function insertSourceSubmissionRecord(
  queryable: Queryable,
  input: {
    canonicalSourceKey: string;
    discoveryMode: SourceRecordView["discoveryMode"];
    normalizedLocator: string;
    rawLocator: string;
    sourceId: string;
    submissionOutcome: SourceSubmissionOutcome;
    submittedByActor?: string | null;
    submittedByAgentId?: string | null;
  },
): Promise<SourceSubmissionRecordView> {
  const result = await queryable.query<{ submission_id: string }>(
    `
      INSERT INTO source_submission_records (
        source_id,
        canonical_source_key,
        submitted_by_actor,
        submitted_by_agent_id,
        discovery_mode,
        submission_outcome,
        raw_locator,
        normalized_locator
      ) VALUES ($1, $2, lower($3), $4, $5, $6, $7, $8)
      RETURNING submission_id::text AS submission_id
    `,
    [
      input.sourceId,
      input.canonicalSourceKey,
      input.submittedByActor ?? null,
      input.submittedByAgentId ?? null,
      input.discoveryMode,
      input.submissionOutcome,
      input.rawLocator,
      input.normalizedLocator,
    ],
  );
  const submissionId = result.rows[0]?.submission_id;
  if (!submissionId) {
    throw new Error("source_submission_record_insert_failed");
  }
  const submission = await readSourceSubmissionRecord(queryable, submissionId);
  if (!submission) {
    throw new Error("source_submission_record_insert_failed");
  }
  return submission;
}

export async function insertSourceExtractionCandidate(
  queryable: Queryable,
  input: SourceExtractionCandidate & { sourceId: string },
): Promise<SourceExtractionCandidate> {
  const result = await queryable.query<{ candidate_id: string }>(
    `
      INSERT INTO source_extraction_candidates (
        source_id,
        submission_id,
        task_id,
        reviewer_agent_id,
        statement,
        scope,
        claim_type,
        methodology,
        confidence_bps,
        anchors
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (submission_id) DO UPDATE SET
        reviewer_agent_id = EXCLUDED.reviewer_agent_id,
        statement = EXCLUDED.statement,
        scope = EXCLUDED.scope,
        claim_type = EXCLUDED.claim_type,
        methodology = EXCLUDED.methodology,
        confidence_bps = EXCLUDED.confidence_bps,
        anchors = EXCLUDED.anchors
      RETURNING candidate_id::text AS candidate_id
    `,
    [
      input.sourceId,
      input.submissionId,
      input.taskId,
      input.reviewerAgentId,
      input.statement,
      input.scope,
      input.claimType,
      input.methodology,
      input.confidenceBps,
      JSON.stringify(input.anchors),
    ],
  );
  const candidateId = result.rows[0]?.candidate_id;
  const candidates = await readSourceExtractionCandidates(queryable, input.sourceId);
  const candidate = candidates.find((entry) => entry.candidateId === candidateId);
  if (!candidate) {
    throw new Error("source_extraction_candidate_insert_failed");
  }
  return candidate;
}

export async function readSourceSubmissionRecord(
  queryable: Queryable,
  submissionId: string,
): Promise<SourceSubmissionRecordView | undefined> {
  const result = await queryable.query<SourceSubmissionRecordRow>(
    `
      SELECT
        submission_id::text AS "submissionId",
        source_id::text AS "sourceId",
        canonical_source_key AS "canonicalSourceKey",
        submitted_by_actor AS "submittedByActor",
        submitted_by_agent_id AS "submittedByAgentId",
        discovery_mode AS "discoveryMode",
        submission_outcome AS "submissionOutcome",
        raw_locator AS "rawLocator",
        normalized_locator AS "normalizedLocator",
        created_at AS "createdAt"
      FROM source_submission_records
      WHERE submission_id = $1
    `,
    [submissionId],
  );
  const row = result.rows[0];
  return row ? mapSourceSubmissionRecordRow(row) : undefined;
}

export async function readSourceSubmissionRecordsPage(
  queryable: Queryable,
  input: {
    limit?: number;
    offset?: number;
    sourceId: string;
  },
): Promise<{
  items: SourceSubmissionRecordView[];
  limit: number;
  offset: number;
  total: number;
}> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM source_submission_records WHERE source_id = $1`,
    [input.sourceId],
  );
  const result = await queryable.query<SourceSubmissionRecordRow>(
    `
      SELECT
        submission_id::text AS "submissionId",
        source_id::text AS "sourceId",
        canonical_source_key AS "canonicalSourceKey",
        submitted_by_actor AS "submittedByActor",
        submitted_by_agent_id AS "submittedByAgentId",
        discovery_mode AS "discoveryMode",
        submission_outcome AS "submissionOutcome",
        raw_locator AS "rawLocator",
        normalized_locator AS "normalizedLocator",
        created_at AS "createdAt"
      FROM source_submission_records
      WHERE source_id = $1
      ORDER BY created_at DESC, submission_id DESC
      LIMIT $2
      OFFSET $3
    `,
    [input.sourceId, limit, offset],
  );
  return {
    items: result.rows.map(mapSourceSubmissionRecordRow),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

export async function readSourceExtractionCandidates(
  queryable: Queryable,
  sourceId: string,
): Promise<SourceExtractionCandidate[]> {
  const result = await queryable.query<SourceExtractionCandidateRow>(
    `
      SELECT
        candidate_id::text AS "candidateId",
        source_id::text AS "sourceId",
        submission_id AS "submissionId",
        task_id AS "taskId",
        reviewer_agent_id AS "reviewerAgentId",
        statement,
        scope,
        claim_type AS "claimType",
        methodology,
        confidence_bps AS "confidenceBps",
        anchors,
        created_at AS "createdAt"
      FROM source_extraction_candidates
      WHERE source_id = $1
      ORDER BY created_at DESC, candidate_id DESC
    `,
    [sourceId],
  );
  return result.rows.map(mapSourceExtractionCandidateRow);
}

export async function readSourcePublicationDecisionsPage(
  queryable: Queryable,
  input: {
    limit?: number;
    offset?: number;
    shouldPublish?: boolean;
    sourceId?: string;
  } = {},
): Promise<{
  items: SourcePublicationDecisionView[];
  limit: number;
  offset: number;
  total: number;
}> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.sourceId) {
    values.push(input.sourceId);
    clauses.push(`source_id::text = $${values.length}`);
  }
  if (typeof input.shouldPublish === "boolean") {
    values.push(input.shouldPublish);
    clauses.push(`should_publish = $${values.length}`);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const count = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM source_publication_decisions ${whereClause}`,
    values,
  );
  const result = await queryable.query<SourcePublicationDecisionRow>(
    `
      SELECT
        decision_id::text AS "decisionId",
        source_id::text AS "sourceId",
        decision_artifact_key AS "decisionArtifactKey",
        published_claim_id AS "publishedClaimId",
        should_publish AS "shouldPublish",
        reason,
        competing_strength_ratio::text AS "competingStrengthRatio",
        winning_cluster AS "winningCluster",
        created_at AS "createdAt"
      FROM source_publication_decisions
      ${whereClause}
      ORDER BY created_at DESC, decision_id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    [...values, limit, offset],
  );
  return {
    items: result.rows.map(mapSourcePublicationDecisionRow),
    limit,
    offset,
    total: Number(count.rows[0]?.count ?? "0"),
  };
}
