import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import { normalizePagination } from "../shared/pagination.js";

type Queryable = Pool | PoolClient;

export type CheckpointPublicationStatus = "failed" | "prepared" | "submitted";

export type CheckpointPublicationView = {
  checkpointId: string | null;
  createdAt: string;
  domainId: number;
  failureReason: string | null;
  payloadHash: string;
  payloadId: string;
  publicationId: string;
  publishedAt: string | null;
  publisher: string;
  requestId: string | null;
  scoreVectorHash: string;
  status: CheckpointPublicationStatus;
  subjectActor: string;
  subjectAgentId: string;
  subjectClaimId: string;
  subjectModule: string;
  subjectType: number;
  txHash: string | null;
  updatedAt: string;
  uri: string;
};

export type CheckpointPublicationListOptions = {
  domainId?: number;
  limit?: number;
  offset?: number;
  payloadId?: string;
  status?: CheckpointPublicationStatus;
  subjectActor?: string;
  subjectAgentId?: string;
  subjectType?: number;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export async function prepareCheckpointStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function insertCheckpointPublication(
  queryable: Queryable,
  input: {
    domainId: number;
    payloadHash: string;
    payloadId: string;
    publisher: string;
    requestId?: string | null;
    scoreVectorHash: string;
    subjectActor: string;
    subjectAgentId: string;
    subjectClaimId: string;
    subjectModule: string;
    subjectType: number;
    uri: string;
  },
): Promise<CheckpointPublicationView> {
  const result = await queryable.query<{ publication_id: string }>(
    `
      INSERT INTO checkpoint_publications (
        payload_id,
        domain_id,
        publisher,
        subject_type,
        subject_actor,
        subject_claim_id,
        subject_agent_id,
        subject_module,
        score_vector_hash,
        payload_hash,
        uri,
        request_id,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'prepared')
      RETURNING publication_id::text AS publication_id
    `,
    [
      input.payloadId,
      input.domainId,
      input.publisher,
      input.subjectType,
      input.subjectActor,
      input.subjectClaimId,
      input.subjectAgentId,
      input.subjectModule,
      input.scoreVectorHash,
      input.payloadHash,
      input.uri,
      input.requestId ?? null,
    ],
  );
  const publicationId = result.rows[0]?.publication_id;
  if (!publicationId) {
    throw new Error("failed to insert checkpoint publication");
  }
  const inserted = await readCheckpointPublication(queryable, publicationId);
  if (!inserted) {
    throw new Error(`inserted checkpoint publication ${publicationId} was not found`);
  }
  return inserted;
}

export async function markCheckpointPublicationSubmitted(
  queryable: Queryable,
  publicationId: string,
  checkpointId: string,
  txHash: string,
): Promise<CheckpointPublicationView> {
  await queryable.query(
    `
      UPDATE checkpoint_publications
      SET
        status = 'submitted',
        checkpoint_id = $2,
        tx_hash = $3,
        published_at = NOW(),
        updated_at = NOW()
      WHERE publication_id = $1
    `,
    [publicationId, checkpointId, txHash],
  );
  const submitted = await readCheckpointPublication(queryable, publicationId);
  if (!submitted) {
    throw new Error(`checkpoint publication ${publicationId} was not found after submit`);
  }
  return submitted;
}

export async function markCheckpointPublicationFailed(
  queryable: Queryable,
  publicationId: string,
  failureReason: string,
): Promise<CheckpointPublicationView> {
  await queryable.query(
    `
      UPDATE checkpoint_publications
      SET
        status = 'failed',
        failure_reason = $2,
        updated_at = NOW()
      WHERE publication_id = $1
    `,
    [publicationId, failureReason.slice(0, 2000)],
  );
  const failed = await readCheckpointPublication(queryable, publicationId);
  if (!failed) {
    throw new Error(`checkpoint publication ${publicationId} was not found after failure update`);
  }
  return failed;
}

export async function readCheckpointPublication(
  queryable: Queryable,
  publicationId: string,
): Promise<CheckpointPublicationView | undefined> {
  const rows = await queryCheckpointPublications(queryable, " WHERE publication_id = $1", [
    publicationId,
  ]);
  return rows[0];
}

export async function readCheckpointPublicationsPage(
  queryable: Queryable,
  options: CheckpointPublicationListOptions = {},
): Promise<PageResult<CheckpointPublicationView>> {
  const { whereClause, values } = buildWhereClause(options);
  return queryPage(
    queryable,
    whereClause,
    values,
    options,
    (innerQueryable, suffixClause, queryValues) =>
      queryCheckpointPublications(innerQueryable, whereClause, queryValues, suffixClause),
  );
}

async function queryCheckpointPublications(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<CheckpointPublicationView[]> {
  const result = await queryable.query<{
    checkpointId: string | null;
    createdAt: Date;
    domainId: number;
    failureReason: string | null;
    payloadHash: string;
    payloadId: string;
    publicationId: string;
    publishedAt: Date | null;
    publisher: string;
    requestId: string | null;
    scoreVectorHash: string;
    status: CheckpointPublicationStatus;
    subjectActor: string;
    subjectAgentId: string;
    subjectClaimId: string;
    subjectModule: string;
    subjectType: number;
    txHash: string | null;
    updatedAt: Date;
    uri: string;
  }>(
    `
      SELECT
        publication_id::text AS "publicationId",
        payload_id::text AS "payloadId",
        domain_id AS "domainId",
        publisher,
        subject_type AS "subjectType",
        subject_actor AS "subjectActor",
        subject_claim_id AS "subjectClaimId",
        subject_agent_id AS "subjectAgentId",
        subject_module AS "subjectModule",
        score_vector_hash AS "scoreVectorHash",
        payload_hash AS "payloadHash",
        uri,
        request_id::text AS "requestId",
        status,
        checkpoint_id AS "checkpointId",
        tx_hash AS "txHash",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        published_at AS "publishedAt",
        updated_at AS "updatedAt"
      FROM checkpoint_publications
      ${whereClause}
      ORDER BY publication_id ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function buildWhereClause(options: CheckpointPublicationListOptions): {
  values: unknown[];
  whereClause: string;
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.payloadId) {
    values.push(options.payloadId);
    clauses.push(`payload_id::text = $${values.length}`);
  }
  if (options.domainId !== undefined) {
    values.push(options.domainId);
    clauses.push(`domain_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }
  if (options.subjectType !== undefined) {
    values.push(options.subjectType);
    clauses.push(`subject_type = $${values.length}`);
  }
  if (options.subjectActor) {
    values.push(options.subjectActor);
    clauses.push(`lower(subject_actor) = lower($${values.length})`);
  }
  if (options.subjectAgentId) {
    values.push(options.subjectAgentId);
    clauses.push(`subject_agent_id = $${values.length}`);
  }

  return {
    values,
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
  };
}

async function queryPage<T>(
  queryable: Queryable,
  whereClause: string,
  values: unknown[],
  options: { limit?: number; offset?: number },
  readItems: (queryable: Queryable, suffixClause: string, queryValues: unknown[]) => Promise<T[]>,
): Promise<PageResult<T>> {
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM checkpoint_publications${whereClause}`,
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
