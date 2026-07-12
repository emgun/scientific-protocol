import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import {
  hashPublicWriteEnvelope,
  type PublicWriteActionType,
  type PublicWriteEnvelope,
  verifyPublicWriteEnvelope,
} from "./public-write-envelope.js";

type Queryable = Pool | PoolClient;

export type PublicWriteRequestStatus = "accepted" | "pending" | "rejected";

export type PublicWriteRequestView = {
  actionType: PublicWriteActionType;
  actorAddress: string;
  chainId: number;
  createdAt: string;
  outcomeDetail: string | null;
  payload: Record<string, unknown>;
  requestHash: string;
  requestId: string;
  requestNonce: string;
  scopeKey: string;
  signature: string;
  status: PublicWriteRequestStatus;
  updatedAt: string;
};

export async function preparePublicWriteRequestStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function insertPublicWriteRequest(
  queryable: Queryable,
  input: {
    actionType: PublicWriteActionType;
    actorAddress: string;
    chainId: number;
    outcomeDetail?: string | null;
    payload: Record<string, unknown>;
    requestHash: string;
    requestNonce: string;
    scopeKey: string;
    signature: string;
    status: PublicWriteRequestStatus;
  },
): Promise<PublicWriteRequestView> {
  const result = await queryable.query<{ request_id: string }>(
    `
      INSERT INTO public_write_requests (
        action_type,
        actor_address,
        chain_id,
        request_nonce,
        scope_key,
        request_hash,
        signature,
        payload,
        status,
        outcome_detail
      ) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
      RETURNING request_id::text AS request_id
    `,
    [
      input.actionType,
      input.actorAddress,
      input.chainId,
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
    throw new Error("public_write_request_insert_failed");
  }
  const request = await readPublicWriteRequest(queryable, requestId);
  if (!request) {
    throw new Error("public_write_request_insert_failed");
  }
  return request;
}

export async function markPublicWriteRequestAccepted(
  queryable: Queryable,
  requestId: string,
  outcomeDetail?: string | null,
): Promise<PublicWriteRequestView> {
  await queryable.query(
    `
      UPDATE public_write_requests
      SET
        status = 'accepted',
        outcome_detail = $2,
        updated_at = NOW()
      WHERE request_id = $1
    `,
    [requestId, outcomeDetail ?? null],
  );
  const request = await readPublicWriteRequest(queryable, requestId);
  if (!request) {
    throw new Error("public_write_request_not_found_after_accept");
  }
  return request;
}

export async function markPublicWriteRequestPending(
  queryable: Queryable,
  requestId: string,
  outcomeDetail: string,
): Promise<PublicWriteRequestView> {
  await queryable.query(
    `UPDATE public_write_requests SET status = 'pending', outcome_detail = $2, updated_at = NOW()
     WHERE request_id = $1`,
    [requestId, outcomeDetail.slice(0, 2000)],
  );
  const request = await readPublicWriteRequest(queryable, requestId);
  if (!request) throw new Error("public_write_request_not_found_after_pending_update");
  return request;
}

export async function markPublicWriteRequestRejected(
  queryable: Queryable,
  requestId: string,
  outcomeDetail: string,
): Promise<PublicWriteRequestView> {
  await queryable.query(
    `
      UPDATE public_write_requests
      SET
        status = 'rejected',
        outcome_detail = $2,
        updated_at = NOW()
      WHERE request_id = $1
    `,
    [requestId, outcomeDetail.slice(0, 2000)],
  );
  const request = await readPublicWriteRequest(queryable, requestId);
  if (!request) {
    throw new Error("public_write_request_not_found_after_reject");
  }
  return request;
}

export async function readPublicWriteRequest(
  queryable: Queryable,
  requestId: string,
): Promise<PublicWriteRequestView | undefined> {
  const result = await queryable.query<{
    actionType: PublicWriteActionType;
    actorAddress: string;
    chainId: number;
    createdAt: Date;
    outcomeDetail: string | null;
    payload: Record<string, unknown>;
    requestHash: string;
    requestId: string;
    requestNonce: string;
    scopeKey: string;
    signature: string;
    status: PublicWriteRequestStatus;
    updatedAt: Date;
  }>(
    `
      SELECT
        request_id::text AS "requestId",
        action_type AS "actionType",
        actor_address AS "actorAddress",
        chain_id AS "chainId",
        request_nonce AS "requestNonce",
        scope_key AS "scopeKey",
        request_hash AS "requestHash",
        signature,
        payload,
        status,
        outcome_detail AS "outcomeDetail",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM public_write_requests
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
  hashPublicWriteEnvelope,
  type PublicWriteActionType,
  type PublicWriteEnvelope,
  verifyPublicWriteEnvelope,
};
