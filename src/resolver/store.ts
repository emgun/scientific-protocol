import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import { normalizePagination } from "../shared/pagination.js";

type Queryable = Pool | PoolClient;

export type ResolutionRunStatus = "failed" | "prepared" | "submitted";

export type ResolutionRunView = {
  claimId: string;
  claimStatus: number | null;
  confidenceBps: number;
  createdAt: string;
  evidenceHash: string;
  evidenceURI: string | null;
  failureReason: string | null;
  jobId: string | null;
  payoutAmount: string | null;
  rationaleArtifactKey: string | null;
  replicationId: string;
  requestId: string | null;
  resolutionHash: string;
  resolutionStatus: number;
  resolver: string;
  resolverType: number;
  runId: string;
  status: ResolutionRunStatus;
  submittedAt: string | null;
  txHashes: string[];
  updatedAt: string;
};

export type ResolutionRunListOptions = {
  claimId?: string;
  jobId?: string;
  limit?: number;
  offset?: number;
  replicationId?: string;
  resolver?: string;
  status?: ResolutionRunStatus;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export function parseResolutionRunTxHashes(raw: string | null | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("resolution run tx_hashes_json must be a JSON array of strings");
  }

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("resolution run tx_hashes_json must be a JSON array of strings");
  }
  return parsed;
}

export async function prepareResolverStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function insertResolutionRun(
  queryable: Queryable,
  input: {
    claimId: string;
    claimStatus?: number | null;
    confidenceBps: number;
    evidenceHash: string;
    evidenceURI?: string | null;
    jobId?: string | null;
    payoutAmount?: string | null;
    requestId?: string | null;
    rationaleArtifactKey?: string | null;
    replicationId: string;
    resolutionHash: string;
    resolutionStatus: number;
    resolver: string;
    resolverType: number;
    txHashes?: string[];
  },
): Promise<ResolutionRunView> {
  const result = await queryable.query<{ run_id: string }>(
    `
      INSERT INTO resolution_runs (
        job_id,
        claim_id,
        replication_id,
        resolver,
        status,
        resolution_status,
        claim_status,
        resolver_type,
        confidence_bps,
        resolution_hash,
        evidence_hash,
        evidence_uri,
        rationale_artifact_key,
        payout_amount,
        request_id,
        tx_hashes_json
      ) VALUES ($1, $2, $3, $4, 'prepared', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING run_id::text AS run_id
    `,
    [
      input.jobId ?? null,
      input.claimId,
      input.replicationId,
      input.resolver,
      input.resolutionStatus,
      input.claimStatus ?? null,
      input.resolverType,
      input.confidenceBps,
      input.resolutionHash,
      input.evidenceHash,
      input.evidenceURI ?? null,
      input.rationaleArtifactKey ?? null,
      input.payoutAmount ?? null,
      input.requestId ?? null,
      JSON.stringify(input.txHashes ?? []),
    ],
  );
  const runId = result.rows[0]?.run_id;
  if (!runId) {
    throw new Error("failed to insert resolution run");
  }
  const inserted = await readResolutionRun(queryable, runId);
  if (!inserted) {
    throw new Error(`inserted resolution run ${runId} was not found`);
  }
  return inserted;
}

export async function markResolutionRunSubmitted(
  queryable: Queryable,
  runId: string,
  txHashes: string[],
): Promise<ResolutionRunView> {
  await queryable.query(
    `
      UPDATE resolution_runs
      SET
        status = 'submitted',
        tx_hashes_json = $2,
        submitted_at = NOW(),
        updated_at = NOW()
      WHERE run_id = $1
    `,
    [runId, JSON.stringify(txHashes)],
  );
  const submitted = await readResolutionRun(queryable, runId);
  if (!submitted) {
    throw new Error(`resolution run ${runId} was not found after submit`);
  }
  return submitted;
}

export async function markResolutionRunFailed(
  queryable: Queryable,
  runId: string,
  failureReason: string,
): Promise<ResolutionRunView> {
  await queryable.query(
    `
      UPDATE resolution_runs
      SET
        status = 'failed',
        failure_reason = $2,
        updated_at = NOW()
      WHERE run_id = $1
    `,
    [runId, failureReason.slice(0, 2000)],
  );
  const failed = await readResolutionRun(queryable, runId);
  if (!failed) {
    throw new Error(`resolution run ${runId} was not found after failure update`);
  }
  return failed;
}

export async function readResolutionRun(
  queryable: Queryable,
  runId: string,
): Promise<ResolutionRunView | undefined> {
  const rows = await queryResolutionRuns(queryable, " WHERE run_id = $1", [runId]);
  return rows[0];
}

export async function readResolutionRunsPage(
  queryable: Queryable,
  options: ResolutionRunListOptions = {},
): Promise<PageResult<ResolutionRunView>> {
  const { whereClause, values } = buildWhereClause(options);
  return queryPage(
    queryable,
    "resolution_runs",
    whereClause,
    values,
    options,
    (innerQueryable, suffixClause, queryValues) =>
      queryResolutionRuns(innerQueryable, whereClause, queryValues, suffixClause),
  );
}

async function queryResolutionRuns(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ResolutionRunView[]> {
  const result = await queryable.query<{
    claimId: string;
    claimStatus: number | null;
    confidenceBps: number;
    createdAt: Date;
    evidenceHash: string;
    evidenceURI: string | null;
    failureReason: string | null;
    jobId: string | null;
    payoutAmount: string | null;
    rationaleArtifactKey: string | null;
    replicationId: string;
    requestId: string | null;
    resolutionHash: string;
    resolutionStatus: number;
    resolver: string;
    resolverType: number;
    runId: string;
    status: ResolutionRunStatus;
    submittedAt: Date | null;
    txHashesJson: string;
    updatedAt: Date;
  }>(
    `
      SELECT
        run_id::text AS "runId",
        job_id::text AS "jobId",
        claim_id AS "claimId",
        replication_id AS "replicationId",
        resolver,
        status,
        resolution_status AS "resolutionStatus",
        claim_status AS "claimStatus",
        resolver_type AS "resolverType",
        confidence_bps AS "confidenceBps",
        resolution_hash AS "resolutionHash",
        evidence_hash AS "evidenceHash",
        evidence_uri AS "evidenceURI",
        rationale_artifact_key AS "rationaleArtifactKey",
        payout_amount AS "payoutAmount",
        request_id::text AS "requestId",
        tx_hashes_json AS "txHashesJson",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        submitted_at AS "submittedAt",
        updated_at AS "updatedAt"
      FROM resolution_runs
      ${whereClause}
      ORDER BY run_id ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows.map((row) => {
    const { txHashesJson, ...rest } = row;
    return {
      ...rest,
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      txHashes: parseResolutionRunTxHashes(txHashesJson),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

function buildWhereClause(options: ResolutionRunListOptions): {
  values: unknown[];
  whereClause: string;
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.jobId) {
    values.push(options.jobId);
    clauses.push(`job_id::text = $${values.length}`);
  }
  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.replicationId) {
    values.push(options.replicationId);
    clauses.push(`replication_id = $${values.length}`);
  }
  if (options.resolver) {
    values.push(options.resolver);
    clauses.push(`lower(resolver) = lower($${values.length})`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }

  return {
    values,
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
  };
}

async function queryPage<T>(
  queryable: Queryable,
  tableName: "resolution_runs",
  whereClause: string,
  values: unknown[],
  options: { limit?: number; offset?: number },
  readItems: (queryable: Queryable, suffixClause: string, queryValues: unknown[]) => Promise<T[]>,
): Promise<PageResult<T>> {
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${tableName}${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const suffixClause = `
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `;
  return {
    items: await readItems(queryable, suffixClause, pageValues),
    total: Number(countResult.rows[0]?.count ?? "0"),
    limit,
    offset,
  };
}
