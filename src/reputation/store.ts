import type { Pool, PoolClient } from "pg";
import { prepareCoordinatorStore } from "../coordinator/store.js";
import { normalizePagination } from "../shared/pagination.js";

type Queryable = Pool | PoolClient;

export type LeaderboardEntryView = {
  checkpointCount: number;
  claimCount: number;
  domainId: number;
  fraudulentClaimCount: number;
  payloadId: string;
  rank: number;
  refutedClaimCount: number;
  replicationCount: number;
  score: string;
  subjectActor: string;
  supportedClaimCount: number;
};

export type ReputationPayloadView = {
  artifactKey: string;
  createdAt: string;
  cursorBlock: number | null;
  cutoffBlock: number;
  domainId: number;
  entryCount: number;
  payloadHash: string;
  payloadId: string;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export async function prepareReputationStore(
  connectionString?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  return prepareCoordinatorStore(connectionString, env);
}

export async function insertReputationPayload(
  client: PoolClient,
  input: {
    artifactKey: string;
    cursorBlock: number | null;
    cutoffBlock: number;
    domainId: number;
    entryCount: number;
    payloadHash: string;
  },
): Promise<ReputationPayloadView> {
  const result = await client.query<{ payload_id: string }>(
    `
      INSERT INTO reputation_payloads (
        domain_id,
        cutoff_block,
        cursor_block,
        payload_hash,
        artifact_key,
        entry_count
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING payload_id
    `,
    [
      input.domainId,
      input.cutoffBlock,
      input.cursorBlock,
      input.payloadHash,
      input.artifactKey,
      input.entryCount,
    ],
  );
  const payloadId = result.rows[0]?.payload_id;
  if (!payloadId) {
    throw new Error("failed to insert reputation payload");
  }
  const inserted = await readReputationPayload(client, String(payloadId));
  if (!inserted) {
    throw new Error(`inserted reputation payload ${payloadId} was not found`);
  }
  return inserted;
}

export async function replaceLeaderboardEntries(
  client: PoolClient,
  payloadId: string,
  entries: Array<{
    checkpointCount: number;
    claimCount: number;
    domainId: number;
    fraudulentClaimCount: number;
    rank: number;
    refutedClaimCount: number;
    replicationCount: number;
    score: bigint;
    subjectActor: string;
    supportedClaimCount: number;
  }>,
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `
        INSERT INTO reputation_leaderboard_entries (
          payload_id,
          domain_id,
          rank,
          subject_actor,
          score,
          claim_count,
          supported_claim_count,
          refuted_claim_count,
          fraudulent_claim_count,
          replication_count,
          checkpoint_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        payloadId,
        entry.domainId,
        entry.rank,
        entry.subjectActor,
        entry.score.toString(),
        entry.claimCount,
        entry.supportedClaimCount,
        entry.refutedClaimCount,
        entry.fraudulentClaimCount,
        entry.replicationCount,
        entry.checkpointCount,
      ],
    );
  }
}

export async function readLatestReputationPayload(
  queryable: Queryable,
  domainId: number,
): Promise<ReputationPayloadView | undefined> {
  const rows = await queryReputationPayloads(
    queryable,
    " WHERE domain_id = $1",
    [domainId],
    " LIMIT 1",
  );
  return rows[0];
}

export async function readReputationPayload(
  queryable: Queryable,
  payloadId: string,
): Promise<ReputationPayloadView | undefined> {
  const rows = await queryReputationPayloads(queryable, " WHERE payload_id = $1", [payloadId]);
  return rows[0];
}

export async function readDomainLeaderboard(
  queryable: Queryable,
  domainId: number,
  options: { limit?: number; offset?: number } = {},
): Promise<PageResult<LeaderboardEntryView>> {
  const latestPayload = await readLatestReputationPayload(queryable, domainId);
  if (!latestPayload) {
    return {
      items: [],
      total: 0,
      limit: normalizePagination(options).limit,
      offset: normalizePagination(options).offset,
    };
  }

  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM reputation_leaderboard_entries
      WHERE payload_id = $1
    `,
    [latestPayload.payloadId],
  );
  const rows = await queryLeaderboardEntries(
    queryable,
    " WHERE payload_id = $1",
    [latestPayload.payloadId, limit, offset],
    " LIMIT $2 OFFSET $3",
  );
  return {
    items: rows,
    total: Number(countResult.rows[0]?.count ?? "0"),
    limit,
    offset,
  };
}

async function queryReputationPayloads(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ReputationPayloadView[]> {
  const result = await queryable.query<{
    artifactKey: string;
    createdAt: Date;
    cursorBlock: number | null;
    cutoffBlock: number;
    domainId: number;
    entryCount: number;
    payloadHash: string;
    payloadId: string;
  }>(
    `
      SELECT
        payload_id::text AS "payloadId",
        domain_id::int AS "domainId",
        cutoff_block::int AS "cutoffBlock",
        cursor_block::int AS "cursorBlock",
        payload_hash AS "payloadHash",
        artifact_key AS "artifactKey",
        entry_count AS "entryCount",
        created_at AS "createdAt"
      FROM reputation_payloads
      ${whereClause}
      ORDER BY created_at DESC, payload_id DESC
      ${suffixClause}
    `,
    values,
  );
  return result.rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

async function queryLeaderboardEntries(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<LeaderboardEntryView[]> {
  const result = await queryable.query<LeaderboardEntryView>(
    `
      SELECT
        payload_id::text AS "payloadId",
        domain_id::int AS "domainId",
        rank,
        subject_actor AS "subjectActor",
        score::text AS "score",
        claim_count AS "claimCount",
        supported_claim_count AS "supportedClaimCount",
        refuted_claim_count AS "refutedClaimCount",
        fraudulent_claim_count AS "fraudulentClaimCount",
        replication_count AS "replicationCount",
        checkpoint_count AS "checkpointCount"
      FROM reputation_leaderboard_entries
      ${whereClause}
      ORDER BY rank ASC, lower(subject_actor) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}
