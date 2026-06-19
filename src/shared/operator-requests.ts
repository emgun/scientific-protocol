import { getBytes, type Signer, verifyMessage } from "ethers";
import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import { normalizePagination } from "./pagination.js";
import { sha256Hex } from "./sha256.js";

type Queryable = Pool | PoolClient;

export type OperatorRequestActionType =
  | "checkpoint_publication"
  | "replication_submission"
  | "resolution_submission";

export type OperatorRequestStatus = "failed" | "prepared" | "submitted";

export type OperatorRequestEnvelope = {
  actionType: OperatorRequestActionType;
  chainId: number;
  issuedAt: string;
  operatorAddress: string;
  requestNonce: number;
  scopeKey: string;
  payload: Record<string, unknown>;
};

export type OperatorRequestView = {
  actionType: OperatorRequestActionType;
  chainId: number;
  createdAt: string;
  failureReason: string | null;
  operatorAddress: string;
  payloadArtifactKey: string | null;
  requestHash: string;
  requestId: string;
  requestNonce: string;
  scopeKey: string;
  signature: string;
  status: OperatorRequestStatus;
  submissionReference: string | null;
  submittedAt: string | null;
  updatedAt: string;
};

export type OperatorRequestListOptions = {
  actionType?: OperatorRequestActionType;
  limit?: number;
  offset?: number;
  operatorAddress?: string;
  scopeKey?: string;
  status?: OperatorRequestStatus;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  return JSON.stringify(value);
}

export async function prepareOperatorRequestStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function reserveOperatorRequestNonce(
  pool: Pool,
  input: {
    actionType: OperatorRequestActionType;
    operatorAddress: string;
  },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO operator_request_nonces (action_type, operator_address, next_nonce)
        VALUES ($1, lower($2), 0)
        ON CONFLICT (action_type, operator_address) DO NOTHING
      `,
      [input.actionType, input.operatorAddress],
    );
    const nonceResult = await client.query<{ next_nonce: string }>(
      `
        SELECT next_nonce::text AS next_nonce
        FROM operator_request_nonces
        WHERE action_type = $1
          AND operator_address = lower($2)
        FOR UPDATE
      `,
      [input.actionType, input.operatorAddress],
    );
    const reservedNonce = Number(nonceResult.rows[0]?.next_nonce ?? "0");
    await client.query(
      `
        UPDATE operator_request_nonces
        SET
          next_nonce = $3,
          updated_at = NOW()
        WHERE action_type = $1
          AND operator_address = lower($2)
      `,
      [input.actionType, input.operatorAddress, reservedNonce + 1],
    );
    await client.query("COMMIT");
    return reservedNonce;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function buildOperatorRequestEnvelope(input: {
  actionType: OperatorRequestActionType;
  chainId: number;
  operatorAddress: string;
  payload: Record<string, unknown>;
  requestNonce: number;
  scopeKey: string;
}): OperatorRequestEnvelope {
  return {
    actionType: input.actionType,
    chainId: input.chainId,
    issuedAt: new Date().toISOString(),
    operatorAddress: input.operatorAddress,
    payload: input.payload,
    requestNonce: input.requestNonce,
    scopeKey: input.scopeKey,
  };
}

export function hashOperatorRequestEnvelope(envelope: OperatorRequestEnvelope): string {
  return `0x${sha256Hex(stableSerialize(envelope))}`;
}

export async function signOperatorRequestEnvelope(
  signer: Signer,
  envelope: OperatorRequestEnvelope,
): Promise<{ requestHash: string; signature: string }> {
  const requestHash = hashOperatorRequestEnvelope(envelope);
  const signature = await signer.signMessage(getBytes(requestHash));
  const recovered = verifyMessage(getBytes(requestHash), signature);
  if (recovered.toLowerCase() !== envelope.operatorAddress.toLowerCase()) {
    throw new Error(
      `operator request signature mismatch: expected ${envelope.operatorAddress}, recovered ${recovered}`,
    );
  }
  return { requestHash, signature };
}

export async function insertOperatorRequest(
  queryable: Queryable,
  input: {
    actionType: OperatorRequestActionType;
    chainId: number;
    operatorAddress: string;
    payloadArtifactKey?: string | null;
    requestHash: string;
    requestNonce: number;
    scopeKey: string;
    signature: string;
  },
): Promise<OperatorRequestView> {
  const result = await queryable.query<{ request_id: string }>(
    `
      INSERT INTO operator_requests (
        action_type,
        operator_address,
        request_nonce,
        chain_id,
        scope_key,
        request_hash,
        signature,
        payload_artifact_key,
        status
      ) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, 'prepared')
      RETURNING request_id::text AS request_id
    `,
    [
      input.actionType,
      input.operatorAddress,
      input.requestNonce,
      input.chainId,
      input.scopeKey,
      input.requestHash,
      input.signature,
      input.payloadArtifactKey ?? null,
    ],
  );
  const requestId = result.rows[0]?.request_id;
  if (!requestId) {
    throw new Error("failed to insert operator request");
  }
  const inserted = await readOperatorRequest(queryable, requestId);
  if (!inserted) {
    throw new Error(`inserted operator request ${requestId} was not found`);
  }
  return inserted;
}

export async function markOperatorRequestSubmitted(
  queryable: Queryable,
  requestId: string,
  submissionReference: string,
): Promise<OperatorRequestView> {
  await queryable.query(
    `
      UPDATE operator_requests
      SET
        status = 'submitted',
        submission_reference = $2,
        submitted_at = NOW(),
        updated_at = NOW()
      WHERE request_id = $1
    `,
    [requestId, submissionReference],
  );
  const submitted = await readOperatorRequest(queryable, requestId);
  if (!submitted) {
    throw new Error(`operator request ${requestId} was not found after submit`);
  }
  return submitted;
}

export async function markOperatorRequestFailed(
  queryable: Queryable,
  requestId: string,
  failureReason: string,
): Promise<OperatorRequestView> {
  await queryable.query(
    `
      UPDATE operator_requests
      SET
        status = 'failed',
        failure_reason = $2,
        updated_at = NOW()
      WHERE request_id = $1
    `,
    [requestId, failureReason.slice(0, 2000)],
  );
  const failed = await readOperatorRequest(queryable, requestId);
  if (!failed) {
    throw new Error(`operator request ${requestId} was not found after failure update`);
  }
  return failed;
}

export async function readOperatorRequest(
  queryable: Queryable,
  requestId: string,
): Promise<OperatorRequestView | undefined> {
  const rows = await queryOperatorRequests(queryable, " WHERE request_id = $1", [requestId]);
  return rows[0];
}

export async function readOperatorRequestsPage(
  queryable: Queryable,
  options: OperatorRequestListOptions = {},
): Promise<PageResult<OperatorRequestView>> {
  const { whereClause, values } = buildWhereClause(options);
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM operator_requests${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const suffixClause = `
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `;
  return {
    items: await queryOperatorRequests(queryable, whereClause, pageValues, suffixClause),
    total: Number(countResult.rows[0]?.count ?? "0"),
    limit,
    offset,
  };
}

async function queryOperatorRequests(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<OperatorRequestView[]> {
  const result = await queryable.query<{
    actionType: OperatorRequestActionType;
    chainId: number;
    createdAt: Date;
    failureReason: string | null;
    operatorAddress: string;
    payloadArtifactKey: string | null;
    requestHash: string;
    requestId: string;
    requestNonce: string;
    scopeKey: string;
    signature: string;
    status: OperatorRequestStatus;
    submissionReference: string | null;
    submittedAt: Date | null;
    updatedAt: Date;
  }>(
    `
      SELECT
        request_id::text AS "requestId",
        action_type AS "actionType",
        operator_address AS "operatorAddress",
        request_nonce::text AS "requestNonce",
        chain_id AS "chainId",
        scope_key AS "scopeKey",
        request_hash AS "requestHash",
        signature,
        payload_artifact_key AS "payloadArtifactKey",
        status,
        submission_reference AS "submissionReference",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        submitted_at AS "submittedAt",
        updated_at AS "updatedAt"
      FROM operator_requests
      ${whereClause}
      ORDER BY request_id ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function buildWhereClause(options: OperatorRequestListOptions): {
  values: unknown[];
  whereClause: string;
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.actionType) {
    values.push(options.actionType);
    clauses.push(`action_type = $${values.length}`);
  }
  if (options.operatorAddress) {
    values.push(options.operatorAddress);
    clauses.push(`lower(operator_address) = lower($${values.length})`);
  }
  if (options.scopeKey) {
    values.push(options.scopeKey);
    clauses.push(`scope_key = $${values.length}`);
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
