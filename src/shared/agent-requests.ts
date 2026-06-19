import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import {
  type AgentRequestActionType,
  type AgentRequestEnvelope,
  hashAgentRequestEnvelope,
  verifyAgentRequestEnvelope,
} from "./agent-request-envelope.js";
import { normalizePagination } from "./pagination.js";

type Queryable = Pool | PoolClient;

export type AgentRequestStatus = "accepted" | "rejected";

export type AgentRequestView = {
  actionType: AgentRequestActionType;
  actorAddress: string;
  agentId: string;
  createdAt: string;
  outcomeDetail: string | null;
  payload: Record<string, unknown>;
  requestHash: string;
  requestId: string;
  requestNonce: string;
  scopeKey: string;
  signature: string;
  status: AgentRequestStatus;
  updatedAt: string;
};

export type AgentRequestListOptions = {
  actionType?: AgentRequestActionType;
  agentId?: string;
  limit?: number;
  offset?: number;
  scopeKey?: string;
  status?: AgentRequestStatus;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export async function prepareAgentRequestStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function insertAgentRequest(
  queryable: Queryable,
  input: {
    actionType: AgentRequestActionType;
    actorAddress: string;
    agentId: string;
    outcomeDetail?: string | null;
    payload: Record<string, unknown>;
    requestHash: string;
    requestNonce: string;
    scopeKey: string;
    signature: string;
    status: AgentRequestStatus;
  },
): Promise<AgentRequestView> {
  const result = await queryable.query<{ request_id: string }>(
    `
      INSERT INTO agent_requests (
        action_type,
        agent_id,
        actor_address,
        request_nonce,
        scope_key,
        request_hash,
        signature,
        payload,
        status,
        outcome_detail
      ) VALUES ($1, $2, lower($3), $4, $5, $6, $7, $8::jsonb, $9, $10)
      RETURNING request_id::text AS request_id
    `,
    [
      input.actionType,
      input.agentId,
      input.actorAddress,
      input.requestNonce,
      input.scopeKey,
      input.requestHash,
      input.signature,
      JSON.stringify(input.payload),
      input.status,
      input.outcomeDetail ?? null,
    ],
  );
  const requestId = result.rows[0]?.request_id;
  if (!requestId) {
    throw new Error("agent_request_insert_failed");
  }
  const request = await readAgentRequest(queryable, requestId);
  if (!request) {
    throw new Error("agent_request_insert_failed");
  }
  return request;
}

export async function readAgentRequest(
  queryable: Queryable,
  requestId: string,
): Promise<AgentRequestView | undefined> {
  const result = await queryable.query<{
    actionType: AgentRequestActionType;
    actorAddress: string;
    agentId: string;
    createdAt: Date;
    outcomeDetail: string | null;
    payload: Record<string, unknown>;
    requestHash: string;
    requestId: string;
    requestNonce: string;
    scopeKey: string;
    signature: string;
    status: AgentRequestStatus;
    updatedAt: Date;
  }>(
    `
      SELECT
        request_id::text AS "requestId",
        action_type AS "actionType",
        agent_id AS "agentId",
        actor_address AS "actorAddress",
        request_nonce AS "requestNonce",
        scope_key AS "scopeKey",
        request_hash AS "requestHash",
        signature,
        payload,
        status,
        outcome_detail AS "outcomeDetail",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_requests
      WHERE request_id = $1
    `,
    [requestId],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    payload: row.payload ?? {},
    updatedAt: row.updatedAt.toISOString(),
  };
}

export {
  type AgentRequestActionType,
  type AgentRequestEnvelope,
  hashAgentRequestEnvelope,
  verifyAgentRequestEnvelope,
};

export async function readAgentRequestsPage(
  queryable: Queryable,
  options: AgentRequestListOptions = {},
): Promise<PageResult<AgentRequestView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.actionType) {
    values.push(options.actionType);
    clauses.push(`action_type = $${values.length}`);
  }
  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.scopeKey) {
    values.push(options.scopeKey);
    clauses.push(`scope_key = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agent_requests${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<{
    actionType: AgentRequestActionType;
    actorAddress: string;
    agentId: string;
    createdAt: Date;
    outcomeDetail: string | null;
    payload: Record<string, unknown>;
    requestHash: string;
    requestId: string;
    requestNonce: string;
    scopeKey: string;
    signature: string;
    status: AgentRequestStatus;
    updatedAt: Date;
  }>(
    `
      SELECT
        request_id::text AS "requestId",
        action_type AS "actionType",
        agent_id AS "agentId",
        actor_address AS "actorAddress",
        request_nonce AS "requestNonce",
        scope_key AS "scopeKey",
        request_hash AS "requestHash",
        signature,
        payload,
        status,
        outcome_detail AS "outcomeDetail",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_requests
      ${whereClause}
      ORDER BY created_at DESC, request_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );

  return {
    items: result.rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      payload: row.payload ?? {},
      updatedAt: row.updatedAt.toISOString(),
    })),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}
