import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { readPositiveIntegerEnv } from "../shared/cli.js";
import type { DeploymentFile } from "../shared/deployment.js";
import { normalizePagination } from "../shared/pagination.js";
import type {
  AgentControllerView,
  AgentView,
  AppealView,
  ArtifactView,
  ChallengeView,
  CheckpointView,
  ClaimView,
  ForecastView,
  ReadModel,
  ReplicationView,
  ResolutionDecisionView,
} from "../shared/read-model.js";
import { readEnvValue } from "../shared/secrets.js";

export const DEFAULT_DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/scientific_protocol";
export const DEFAULT_MIGRATIONS_PATH = fileURLToPath(
  new URL("../../ops/migrations", import.meta.url),
);
const MIGRATION_LOCK_ID = 7_346_120_119;

type MetadataRow = {
  key: string;
  value: string;
};

type IndexerStateRow = {
  name: string;
  last_processed_block: number;
};

type IndexerRuntimeStateRow = {
  name: string;
  status: string;
  last_started_at: Date | null;
  last_finished_at: Date | null;
  last_success_at: Date | null;
  last_error_at: Date | null;
  last_error_message: string | null;
  updated_at: Date;
};

type Queryable = Pool | PoolClient;

export const DEFAULT_INDEXER_CURSOR_NAME = "read_model";
export const READ_MODEL_SYNC_LOCK_ID = 4_242_001;

export class ReadModelSyncInProgressError extends Error {
  constructor() {
    super("read model sync is already in progress");
    this.name = "ReadModelSyncInProgressError";
  }
}

export type IndexerRuntimeStatus = {
  name: string;
  status: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export type ClaimListOptions = {
  author?: string;
  domainId?: number;
  limit?: number;
  offset?: number;
  status?: number;
};

export type AgentListOptions = {
  active?: boolean;
  limit?: number;
  offset?: number;
  operator?: string;
};

export type ForecastListOptions = {
  agentId?: string;
  claimId?: string;
  finalStatus?: number;
  forecaster?: string;
  limit?: number;
  offset?: number;
  revealed?: boolean;
  settled?: boolean;
};

export type ChallengeListOptions = {
  agentId?: string;
  challenger?: string;
  claimId?: string;
  limit?: number;
  offset?: number;
  replicationId?: string;
  status?: number;
};

export type AppealListOptions = {
  appellant?: string;
  challengeId?: string;
  claimId?: string;
  limit?: number;
  offset?: number;
  reason?: number;
  replicationId?: string;
  status?: number;
};

export type ArtifactListOptions = {
  artifactType?: number;
  claimId?: string;
  claimIds?: string[];
  limit?: number;
  offset?: number;
  submitter?: string;
};

export type ReplicationListOptions = {
  agentId?: string;
  claimId?: string;
  claimIds?: string[];
  confidenceBps?: number;
  limit?: number;
  offset?: number;
  outcome?: number;
  replicator?: string;
  resolutionStatus?: number;
  resolverType?: number;
};

export type CheckpointListOptions = {
  claimId?: string;
  domainId?: number;
  limit?: number;
  offset?: number;
  subjectActor?: string;
  subjectAgentId?: string;
  subjectModule?: string;
  subjectType?: number;
};

export type AgentControllerListOptions = {
  agentId?: string;
  authorized?: boolean;
  controller?: string;
  limit?: number;
  offset?: number;
};

export type ReadModelCounts = {
  agentControllers: number;
  agents: number;
  appeals: number;
  artifacts: number;
  challenges: number;
  checkpoints: number;
  claims: number;
  forecasts: number;
  replications: number;
};

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return readEnvValue(env, "SP_DATABASE_URL") ?? DEFAULT_DATABASE_URL;
}

export function resolveDatabasePoolConfig(
  connectionString = getDatabaseUrl(),
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  return {
    connectionString,
    connectionTimeoutMillis: readPositiveIntegerEnv(
      env,
      "SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS",
      10_000,
      { min: 0 },
    ),
    idleTimeoutMillis: readPositiveIntegerEnv(env, "SP_DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000, {
      min: 0,
    }),
    max: readPositiveIntegerEnv(env, "SP_DATABASE_POOL_MAX", 10),
  };
}

export function createReadModelPool(
  connectionString = getDatabaseUrl(),
  env: NodeJS.ProcessEnv = process.env,
): Pool {
  return new Pool(resolveDatabasePoolConfig(connectionString, env));
}

export async function prepareReadModelStore(
  connectionString = getDatabaseUrl(),
  migrationsPath = DEFAULT_MIGRATIONS_PATH,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool, migrationsPath);
  return pool;
}

export async function migrateReadModelDb(
  pool: Pool,
  migrationsPath = DEFAULT_MIGRATIONS_PATH,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");

    const applied = await client.query<{ checksum: string | null; version: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const appliedVersions = new Map(applied.rows.map((row) => [row.version, row.checksum]));

    const files = (await readdir(migrationsPath)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const sql = await readFile(path.join(migrationsPath, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const appliedChecksum = appliedVersions.get(file);
      if (appliedVersions.has(file)) {
        if (appliedChecksum && appliedChecksum !== checksum) {
          throw new Error(`migration checksum mismatch: ${file}`);
        }
        if (!appliedChecksum) {
          await client.query("UPDATE schema_migrations SET checksum = $2 WHERE version = $1", [
            file,
            checksum,
          ]);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

export async function ensureReadModelBaseState(
  pool: Pool,
  deployment: DeploymentFile,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const metadata = await client.query<MetadataRow>(
      `
        SELECT key, value
        FROM metadata
        WHERE key IN ('chainId', 'deploymentBlock')
      `,
    );
    const metadataMap = new Map(metadata.rows.map((row) => [row.key, row.value]));

    const existingChainId = metadataMap.get("chainId");
    if (existingChainId !== undefined && Number(existingChainId) !== Number(deployment.chainId)) {
      throw new Error(
        `read model chainId mismatch: expected ${deployment.chainId}, found ${existingChainId}; reset the database before reusing it`,
      );
    }

    const existingDeploymentBlock = metadataMap.get("deploymentBlock");
    if (
      existingDeploymentBlock !== undefined &&
      Number(existingDeploymentBlock) !== Number(deployment.deploymentBlock)
    ) {
      throw new Error(
        `read model deploymentBlock mismatch: expected ${deployment.deploymentBlock}, found ${existingDeploymentBlock}; reset the database before reusing it`,
      );
    }

    await setMetadataValues(client, {
      chainId: String(deployment.chainId),
      deploymentBlock: String(deployment.deploymentBlock),
    });
    await client.query(
      `
        INSERT INTO indexer_state (name, last_processed_block)
        VALUES ($1, $2)
        ON CONFLICT (name) DO NOTHING
      `,
      [DEFAULT_INDEXER_CURSOR_NAME, Math.max(0, Number(deployment.deploymentBlock) - 1)],
    );
    await client.query(
      `
        INSERT INTO indexer_runtime_state (name, status)
        VALUES ($1, 'idle')
        ON CONFLICT (name) DO NOTHING
      `,
      [DEFAULT_INDEXER_CURSOR_NAME],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acquireReadModelSyncLock(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [READ_MODEL_SYNC_LOCK_ID],
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      throw new ReadModelSyncInProgressError();
    }

    return client;
  } catch (error) {
    if (!(error instanceof ReadModelSyncInProgressError)) {
      client.release();
    }
    throw error;
  }
}

export async function releaseReadModelSyncLock(client: PoolClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [READ_MODEL_SYNC_LOCK_ID]);
  } finally {
    client.release();
  }
}

export async function markSyncStarted(
  client: PoolClient,
  name = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<void> {
  await client.query(
    `
      INSERT INTO indexer_runtime_state (
        name,
        status,
        last_started_at,
        last_error_message,
        updated_at
      ) VALUES ($1, 'syncing', NOW(), NULL, NOW())
      ON CONFLICT (name)
      DO UPDATE SET
        status = 'syncing',
        last_started_at = NOW(),
        last_error_message = NULL,
        updated_at = NOW()
    `,
    [name],
  );
}

export async function markSyncSucceeded(
  client: PoolClient,
  name = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<void> {
  await client.query(
    `
      INSERT INTO indexer_runtime_state (
        name,
        status,
        last_finished_at,
        last_success_at,
        last_error_message,
        updated_at
      ) VALUES ($1, 'idle', NOW(), NOW(), NULL, NOW())
      ON CONFLICT (name)
      DO UPDATE SET
        status = 'idle',
        last_finished_at = NOW(),
        last_success_at = NOW(),
        last_error_message = NULL,
        updated_at = NOW()
    `,
    [name],
  );
}

export async function markSyncFailed(
  queryable: Queryable,
  errorMessage: string,
  name = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<void> {
  await queryable.query(
    `
      INSERT INTO indexer_runtime_state (
        name,
        status,
        last_finished_at,
        last_error_at,
        last_error_message,
        updated_at
      ) VALUES ($1, 'failed', NOW(), NOW(), $2, NOW())
      ON CONFLICT (name)
      DO UPDATE SET
        status = 'failed',
        last_finished_at = NOW(),
        last_error_at = NOW(),
        last_error_message = EXCLUDED.last_error_message,
        updated_at = NOW()
    `,
    [name, errorMessage.slice(0, 2000)],
  );
}

export async function readIndexerRuntimeStatus(
  queryable: Queryable,
  name = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<IndexerRuntimeStatus | null> {
  const result = await queryable.query<IndexerRuntimeStateRow>(
    `
      SELECT
        name,
        status,
        last_started_at,
        last_finished_at,
        last_success_at,
        last_error_at,
        last_error_message,
        updated_at
      FROM indexer_runtime_state
      WHERE name = $1
    `,
    [name],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    name: row.name,
    status: row.status,
    lastStartedAt: row.last_started_at?.toISOString() ?? null,
    lastFinishedAt: row.last_finished_at?.toISOString() ?? null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
    lastErrorMessage: row.last_error_message,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function readSyncCursor(
  queryable: Queryable,
  cursorName = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<number | null> {
  const result = await queryable.query<IndexerStateRow>(
    `
      SELECT name, last_processed_block
      FROM indexer_state
      WHERE name = $1
    `,
    [cursorName],
  );
  return result.rows[0]?.last_processed_block ?? null;
}

export async function writeSyncCursor(
  client: PoolClient,
  lastProcessedBlock: number,
  blockHash?: string,
  cursorName = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<void> {
  await client.query(
    `
      INSERT INTO indexer_state (name, last_processed_block)
      VALUES ($1, $2)
      ON CONFLICT (name)
      DO UPDATE SET
        last_processed_block = EXCLUDED.last_processed_block,
        updated_at = NOW()
    `,
    [cursorName, lastProcessedBlock],
  );
  if (blockHash) {
    await client.query(
      `
        INSERT INTO indexer_block_checkpoints (name, block_number, block_hash)
        VALUES ($1, $2, lower($3))
        ON CONFLICT (name, block_number)
        DO UPDATE SET block_hash = EXCLUDED.block_hash, recorded_at = NOW()
      `,
      [cursorName, lastProcessedBlock, blockHash],
    );
  }
}

export async function readIndexerBlockCheckpoint(
  queryable: Queryable,
  blockNumber: number,
  cursorName = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<string | null> {
  const result = await queryable.query<{ block_hash: string }>(
    `SELECT block_hash FROM indexer_block_checkpoints WHERE name = $1 AND block_number = $2`,
    [cursorName, blockNumber],
  );
  return result.rows[0]?.block_hash ?? null;
}

export async function recordIndexerBlockCheckpoint(
  queryable: Queryable,
  blockNumber: number,
  blockHash: string,
  cursorName = DEFAULT_INDEXER_CURSOR_NAME,
): Promise<void> {
  await queryable.query(
    `
      INSERT INTO indexer_block_checkpoints (name, block_number, block_hash)
      VALUES ($1, $2, lower($3))
      ON CONFLICT (name, block_number) DO NOTHING
    `,
    [cursorName, blockNumber, blockHash],
  );
}

export async function updateReadModelMetadata(
  client: PoolClient,
  metadata: ReadModel["metadata"],
): Promise<void> {
  await setMetadataValues(client, {
    chainId: String(metadata.chainId),
    indexedAt: metadata.indexedAt,
    deploymentBlock: String(metadata.deploymentBlock),
    latestBlock: String(metadata.latestBlock),
  });
}

export async function upsertClaim(client: PoolClient, claim: ClaimView): Promise<void> {
  await client.query(
    `
      INSERT INTO claims (
        claim_id,
        author,
        domain_id,
        metadata_hash,
        resolution_module,
        status,
        revision_of_claim_id,
        created_at_block
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (claim_id)
      DO UPDATE SET
        author = EXCLUDED.author,
        domain_id = EXCLUDED.domain_id,
        metadata_hash = EXCLUDED.metadata_hash,
        resolution_module = EXCLUDED.resolution_module,
        status = EXCLUDED.status,
        revision_of_claim_id = EXCLUDED.revision_of_claim_id,
        created_at_block = EXCLUDED.created_at_block
    `,
    [
      claim.claimId,
      claim.author,
      claim.domainId,
      claim.metadataHash,
      claim.resolutionModule,
      claim.status,
      claim.revisionOfClaimId,
      claim.createdAtBlock,
    ],
  );
}

export async function updateClaimStatus(
  client: PoolClient,
  claimId: string,
  status: number,
): Promise<void> {
  const result = await client.query(
    `
      UPDATE claims
      SET status = $2
      WHERE claim_id = $1
    `,
    [claimId, status],
  );
  if (result.rowCount === 0) {
    throw new Error(`claim ${claimId} was not present when applying ClaimStatusUpdated`);
  }
}

export async function insertArtifact(client: PoolClient, artifact: ArtifactView): Promise<void> {
  await client.query(
    `
      INSERT INTO artifacts (
        artifact_id,
        claim_id,
        artifact_type,
        content_digest,
        uri,
        submitter
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (artifact_id) DO NOTHING
    `,
    [
      artifact.artifactId,
      artifact.claimId,
      artifact.artifactType,
      artifact.contentDigest,
      artifact.uri,
      artifact.submitter,
    ],
  );
}

export async function upsertReplicationSubmission(
  client: PoolClient,
  replication: ReplicationView,
): Promise<void> {
  await client.query(
    `
      INSERT INTO replications (
        replication_id,
        claim_id,
        replicator,
        agent_id,
        result_hash,
        outcome,
        resolution_status,
        confidence_bps,
        resolver_type,
        resolution_hash,
        evidence_hash,
        evidence_uri
      ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      ON CONFLICT (replication_id)
      DO UPDATE SET
        claim_id = EXCLUDED.claim_id,
        replicator = EXCLUDED.replicator,
        agent_id = EXCLUDED.agent_id,
        result_hash = EXCLUDED.result_hash
    `,
    [
      replication.replicationId,
      replication.claimId,
      replication.replicator,
      replication.agentId,
      replication.resultHash,
    ],
  );
}

export async function applyReplicationResolution(
  client: PoolClient,
  replicationId: string,
  resolution: Pick<
    ReplicationView,
    | "outcome"
    | "resolutionStatus"
    | "confidenceBps"
    | "resolverType"
    | "resolutionHash"
    | "evidenceHash"
    | "evidenceURI"
  >,
): Promise<void> {
  const result = await client.query(
    `
      UPDATE replications
      SET
        outcome = $2,
        resolution_status = $3,
        confidence_bps = $4,
        resolver_type = $5,
        resolution_hash = $6,
        evidence_hash = $7,
        evidence_uri = $8
      WHERE replication_id = $1
    `,
    [
      replicationId,
      resolution.outcome,
      resolution.resolutionStatus,
      resolution.confidenceBps,
      resolution.resolverType,
      resolution.resolutionHash,
      resolution.evidenceHash,
      resolution.evidenceURI,
    ],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `replication ${replicationId} was not present when applying ReplicationResolved`,
    );
  }
}

export async function insertCheckpoint(
  client: PoolClient,
  checkpoint: CheckpointView,
): Promise<void> {
  await client.query(
    `
      INSERT INTO checkpoints (
        checkpoint_id,
        domain_id,
        subject_type,
        subject_actor,
        subject_claim_id,
        subject_agent_id,
        subject_module,
        score_vector_hash,
        payload_hash,
        uri
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (checkpoint_id) DO NOTHING
    `,
    [
      checkpoint.checkpointId,
      checkpoint.domainId,
      checkpoint.subjectType,
      checkpoint.subjectActor,
      checkpoint.subjectClaimId,
      checkpoint.subjectAgentId,
      checkpoint.subjectModule,
      checkpoint.scoreVectorHash,
      checkpoint.payloadHash,
      checkpoint.uri,
    ],
  );
}

export async function upsertAgent(client: PoolClient, agent: AgentView): Promise<void> {
  await client.query(
    `
      INSERT INTO agents (
        agent_id,
        operator,
        metadata_hash,
        uri,
        budget_balance,
        reserved_budget,
        spend_limit,
        active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (agent_id)
      DO UPDATE SET
        operator = EXCLUDED.operator,
        metadata_hash = EXCLUDED.metadata_hash,
        uri = EXCLUDED.uri,
        budget_balance = EXCLUDED.budget_balance,
        reserved_budget = EXCLUDED.reserved_budget,
        spend_limit = EXCLUDED.spend_limit,
        active = EXCLUDED.active
    `,
    [
      agent.agentId,
      agent.operator,
      agent.metadataHash,
      agent.uri,
      agent.budgetBalance,
      agent.reservedBudget,
      agent.spendLimit,
      agent.active,
    ],
  );
}

export async function upsertAgentController(
  client: PoolClient,
  controller: AgentControllerView,
): Promise<void> {
  await client.query(
    `
      INSERT INTO agent_controllers (
        agent_id,
        controller,
        authorized
      ) VALUES ($1, $2, $3)
      ON CONFLICT (agent_id, controller)
      DO UPDATE SET
        authorized = EXCLUDED.authorized
    `,
    [controller.agentId, controller.controller, controller.authorized],
  );
}

export async function upsertForecast(client: PoolClient, forecast: ForecastView): Promise<void> {
  await client.query(
    `
      INSERT INTO forecasts (
        forecast_id,
        claim_id,
        forecaster,
        agent_id,
        commitment_hash,
        stake_amount,
        committed_at,
        reveal_deadline,
        revealed,
        settled,
        direction,
        confidence_bps,
        effective_decision_id_at_commit,
        resolution_decision_id,
        final_status,
        matched,
        payout_amount
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (forecast_id)
      DO UPDATE SET
        claim_id = EXCLUDED.claim_id,
        forecaster = EXCLUDED.forecaster,
        agent_id = EXCLUDED.agent_id,
        commitment_hash = EXCLUDED.commitment_hash,
        stake_amount = EXCLUDED.stake_amount,
        committed_at = EXCLUDED.committed_at,
        reveal_deadline = EXCLUDED.reveal_deadline,
        revealed = EXCLUDED.revealed,
        settled = EXCLUDED.settled,
        direction = EXCLUDED.direction,
        confidence_bps = EXCLUDED.confidence_bps,
        effective_decision_id_at_commit = COALESCE(
          forecasts.effective_decision_id_at_commit,
          EXCLUDED.effective_decision_id_at_commit
        ),
        resolution_decision_id = COALESCE(
          forecasts.resolution_decision_id,
          EXCLUDED.resolution_decision_id
        ),
        final_status = COALESCE(forecasts.final_status, EXCLUDED.final_status),
        matched = COALESCE(forecasts.matched, EXCLUDED.matched),
        payout_amount = COALESCE(forecasts.payout_amount, EXCLUDED.payout_amount)
    `,
    [
      forecast.forecastId,
      forecast.claimId,
      forecast.forecaster,
      forecast.agentId,
      forecast.commitmentHash,
      forecast.stakeAmount,
      forecast.committedAt,
      forecast.revealDeadline,
      forecast.revealed,
      forecast.settled,
      forecast.direction,
      forecast.confidenceBps,
      forecast.effectiveDecisionIdAtCommit,
      forecast.resolutionDecisionId,
      forecast.finalStatus,
      forecast.matched,
      forecast.payoutAmount,
    ],
  );
}

export async function insertResolutionDecision(
  client: PoolClient,
  decision: ResolutionDecisionView,
): Promise<void> {
  await client.query(
    `
      INSERT INTO resolution_decisions (
        decision_id, claim_id, replication_id, resolution_module, status, claim_status,
        confidence_bps, resolution_hash, evidence_hash, resolver_type, created_at, actor
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (decision_id) DO NOTHING
    `,
    [
      decision.decisionId,
      decision.claimId,
      decision.replicationId,
      decision.resolutionModule,
      decision.status,
      decision.claimStatus,
      decision.confidenceBps,
      decision.resolutionHash,
      decision.evidenceHash,
      decision.resolverType,
      decision.createdAt,
      decision.actor,
    ],
  );
}

export async function markEffectiveResolutionDecision(
  client: PoolClient,
  claimId: string,
  decisionId: string,
): Promise<void> {
  await client.query("UPDATE resolution_decisions SET effective = FALSE WHERE claim_id = $1", [
    claimId,
  ]);
  const result = await client.query(
    "UPDATE resolution_decisions SET effective = TRUE WHERE claim_id = $1 AND decision_id = $2",
    [claimId, decisionId],
  );
  if (result.rowCount !== 1) {
    throw new Error(`effective resolution decision ${decisionId} missing for claim ${claimId}`);
  }
}

export async function applyForecastSettlement(
  client: PoolClient,
  forecastId: string,
  resolutionDecisionId: string | null,
  finalStatus: number,
  matched: boolean,
  payoutAmount: string,
): Promise<void> {
  const result = await client.query(
    `
      UPDATE forecasts
      SET
        resolution_decision_id = NULLIF($2, '0'),
        final_status = $3,
        matched = $4,
        payout_amount = $5,
        settled = TRUE
      WHERE forecast_id = $1
    `,
    [forecastId, resolutionDecisionId, finalStatus, matched, payoutAmount],
  );
  if (result.rowCount === 0) {
    throw new Error(`forecast ${forecastId} was not present when applying ForecastSettled`);
  }
}

export async function upsertChallenge(client: PoolClient, challenge: ChallengeView): Promise<void> {
  await client.query(
    `
      INSERT INTO challenges (
        challenge_id,
        claim_id,
        replication_id,
        challenger,
        agent_id,
        evidence_hash,
        evidence_uri,
        bond_amount,
        status,
        resolution_hash,
        created_at,
        resolved_at,
        payout_amount,
        refunded_amount
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (challenge_id)
      DO UPDATE SET
        claim_id = EXCLUDED.claim_id,
        replication_id = EXCLUDED.replication_id,
        challenger = EXCLUDED.challenger,
        agent_id = EXCLUDED.agent_id,
        evidence_hash = EXCLUDED.evidence_hash,
        evidence_uri = EXCLUDED.evidence_uri,
        bond_amount = EXCLUDED.bond_amount,
        status = EXCLUDED.status,
        resolution_hash = EXCLUDED.resolution_hash,
        created_at = EXCLUDED.created_at,
        resolved_at = EXCLUDED.resolved_at,
        payout_amount = COALESCE(challenges.payout_amount, EXCLUDED.payout_amount),
        refunded_amount = COALESCE(challenges.refunded_amount, EXCLUDED.refunded_amount)
    `,
    [
      challenge.challengeId,
      challenge.claimId,
      challenge.replicationId,
      challenge.challenger,
      challenge.agentId,
      challenge.evidenceHash,
      challenge.evidenceURI,
      challenge.bondAmount,
      challenge.status,
      challenge.resolutionHash,
      challenge.createdAt,
      challenge.resolvedAt,
      challenge.payoutAmount,
      challenge.refundedAmount,
    ],
  );
}

export async function applyChallengeResolution(
  client: PoolClient,
  challengeId: string,
  status: number,
  resolutionHash: string,
  payoutAmount: string,
): Promise<void> {
  const result = await client.query(
    `
      UPDATE challenges
      SET
        status = $2,
        resolution_hash = $3,
        payout_amount = $4
      WHERE challenge_id = $1
    `,
    [challengeId, status, resolutionHash, payoutAmount],
  );
  if (result.rowCount === 0) {
    throw new Error(`challenge ${challengeId} was not present when applying ChallengeResolved`);
  }
}

export async function applyChallengeWithdrawal(
  client: PoolClient,
  challengeId: string,
  refundedAmount: string,
): Promise<void> {
  const result = await client.query(
    `
      UPDATE challenges
      SET refunded_amount = $2
      WHERE challenge_id = $1
    `,
    [challengeId, refundedAmount],
  );
  if (result.rowCount === 0) {
    throw new Error(`challenge ${challengeId} was not present when applying ChallengeWithdrawn`);
  }
}

export async function upsertAppeal(client: PoolClient, appeal: AppealView): Promise<void> {
  await client.query(
    `
      INSERT INTO appeals (
        appeal_id,
        claim_id,
        replication_id,
        challenge_id,
        appellant,
        reason,
        filing_hash,
        uri,
        status,
        adjudication_hash,
        adjudication_uri,
        bond_amount,
        created_at,
        adjudicated_at,
        refunded_amount
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (appeal_id)
      DO UPDATE SET
        claim_id = EXCLUDED.claim_id,
        replication_id = EXCLUDED.replication_id,
        challenge_id = EXCLUDED.challenge_id,
        appellant = EXCLUDED.appellant,
        reason = EXCLUDED.reason,
        filing_hash = EXCLUDED.filing_hash,
        uri = EXCLUDED.uri,
        status = EXCLUDED.status,
        adjudication_hash = EXCLUDED.adjudication_hash,
        adjudication_uri = EXCLUDED.adjudication_uri,
        bond_amount = EXCLUDED.bond_amount,
        created_at = EXCLUDED.created_at,
        adjudicated_at = EXCLUDED.adjudicated_at,
        refunded_amount = COALESCE(appeals.refunded_amount, EXCLUDED.refunded_amount)
    `,
    [
      appeal.appealId,
      appeal.claimId,
      appeal.replicationId,
      appeal.challengeId,
      appeal.appellant,
      appeal.reason,
      appeal.filingHash,
      appeal.uri,
      appeal.status,
      appeal.adjudicationHash,
      appeal.adjudicationURI,
      appeal.bondAmount,
      appeal.createdAt,
      appeal.adjudicatedAt,
      appeal.refundedAmount,
    ],
  );
}

export async function applyAppealAdjudication(
  client: PoolClient,
  appealId: string,
  status: number,
  adjudicationHash: string,
  adjudicationURI: string,
  refundedAmount: string,
): Promise<void> {
  const result = await client.query(
    `
      UPDATE appeals
      SET
        status = $2,
        adjudication_hash = $3,
        adjudication_uri = $4,
        refunded_amount = $5
      WHERE appeal_id = $1
    `,
    [appealId, status, adjudicationHash, adjudicationURI, refundedAmount],
  );
  if (result.rowCount === 0) {
    throw new Error(`appeal ${appealId} was not present when applying AppealAdjudicated`);
  }
}

export async function readMetadata(queryable: Queryable): Promise<ReadModel["metadata"]> {
  const rows = await queryable.query<MetadataRow>("SELECT key, value FROM metadata");
  const metadata = new Map(rows.rows.map((row) => [row.key, row.value]));

  return {
    chainId: Number(metadata.get("chainId") ?? "0"),
    indexedAt: metadata.get("indexedAt") ?? "",
    deploymentBlock: Number(metadata.get("deploymentBlock") ?? "0"),
    latestBlock: Number(metadata.get("latestBlock") ?? "0"),
  };
}

export async function readReadModelCounts(queryable: Queryable): Promise<ReadModelCounts> {
  const counts = await Promise.all([
    countTable(queryable, "claims"),
    countTable(queryable, "artifacts"),
    countTable(queryable, "replications"),
    countTable(queryable, "checkpoints"),
    countTable(queryable, "agents"),
    countTable(queryable, "agent_controllers"),
    countTable(queryable, "forecasts"),
    countTable(queryable, "challenges"),
    countTable(queryable, "appeals"),
  ]);

  return {
    claims: counts[0],
    artifacts: counts[1],
    replications: counts[2],
    checkpoints: counts[3],
    agents: counts[4],
    agentControllers: counts[5],
    forecasts: counts[6],
    challenges: counts[7],
    appeals: counts[8],
  };
}

export async function readReadModel(pool: Pool): Promise<ReadModel> {
  return {
    metadata: await readMetadata(pool),
    claims: await readClaims(pool),
    artifacts: await readAllArtifacts(pool),
    replications: await readAllReplications(pool),
    checkpoints: await readAllCheckpoints(pool),
    agents: await readAgents(pool),
    agentControllers: await readAllAgentControllers(pool),
    forecasts: await readAllForecasts(pool),
    challenges: await readAllChallenges(pool),
    appeals: await readAllAppeals(pool),
  };
}

export async function readClaims(pool: Pool): Promise<ClaimView[]> {
  return queryClaims(pool);
}

export async function readClaimsPage(
  pool: Pool,
  options: ClaimListOptions = {},
): Promise<PageResult<ClaimView>> {
  const { whereClause, values } = buildClaimWhereClause(options);
  return queryPage(
    pool,
    "claims",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryClaims(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readClaim(pool: Pool, claimId: string): Promise<ClaimView | undefined> {
  const result = await queryClaims(pool, "WHERE claim_id = $1", [claimId]);
  return result[0];
}

export async function readArtifactsByClaim(pool: Pool, claimId: string): Promise<ArtifactView[]> {
  return queryArtifacts(pool, "WHERE claim_id = $1", [claimId]);
}

export async function readArtifactsPage(
  pool: Pool,
  options: ArtifactListOptions = {},
): Promise<PageResult<ArtifactView>> {
  const { whereClause, values } = buildArtifactWhereClause(options);
  return queryPage(
    pool,
    "artifacts",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryArtifacts(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readReplicationsByClaim(
  pool: Pool,
  claimId: string,
): Promise<ReplicationView[]> {
  return queryReplications(pool, "WHERE claim_id = $1", [claimId]);
}

export async function readReplicationsPage(
  pool: Pool,
  options: ReplicationListOptions = {},
): Promise<PageResult<ReplicationView>> {
  const { whereClause, values } = buildReplicationWhereClause(options);
  return queryPage(
    pool,
    "replications",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryReplications(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readCheckpointsByClaim(
  pool: Pool,
  claimId: string,
): Promise<CheckpointView[]> {
  return queryCheckpoints(pool, "WHERE subject_claim_id = $1", [claimId]);
}

export async function readCheckpointsPage(
  pool: Pool,
  options: CheckpointListOptions = {},
): Promise<PageResult<CheckpointView>> {
  const { whereClause, values } = buildCheckpointWhereClause(options);
  return queryPage(
    pool,
    "checkpoints",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryCheckpoints(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readCheckpointsByActor(pool: Pool, actor: string): Promise<CheckpointView[]> {
  return queryCheckpoints(pool, "WHERE lower(subject_actor) = lower($1)", [actor]);
}

export async function readAllArtifacts(pool: Pool): Promise<ArtifactView[]> {
  return queryArtifacts(pool);
}

export async function readAllReplications(pool: Pool): Promise<ReplicationView[]> {
  return queryReplications(pool);
}

export async function readAllCheckpoints(pool: Pool): Promise<CheckpointView[]> {
  return queryCheckpoints(pool);
}

export async function readAgents(pool: Pool): Promise<AgentView[]> {
  return queryAgents(pool);
}

export async function readAgentsPage(
  pool: Pool,
  options: AgentListOptions = {},
): Promise<PageResult<AgentView>> {
  const { whereClause, values } = buildAgentWhereClause(options);
  return queryPage(
    pool,
    "agents",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryAgents(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readAgent(pool: Pool, agentId: string): Promise<AgentView | undefined> {
  const result = await queryAgents(pool, "WHERE agent_id = $1", [agentId]);
  return result[0];
}

export async function readAgentControllers(
  pool: Pool,
  agentId: string,
): Promise<AgentControllerView[]> {
  return queryAgentControllers(pool, "WHERE agent_id = $1", [agentId]);
}

export async function readAgentControllersPage(
  pool: Pool,
  options: AgentControllerListOptions = {},
): Promise<PageResult<AgentControllerView>> {
  const { whereClause, values } = buildAgentControllerWhereClause(options);
  return queryPage(
    pool,
    "agent_controllers",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryAgentControllers(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readAllAgentControllers(pool: Pool): Promise<AgentControllerView[]> {
  return queryAgentControllers(pool);
}

export async function readForecastsByClaim(pool: Pool, claimId: string): Promise<ForecastView[]> {
  return queryForecasts(pool, "WHERE claim_id = $1", [claimId]);
}

export async function readForecast(
  pool: Pool,
  forecastId: string,
): Promise<ForecastView | undefined> {
  const result = await queryForecasts(pool, "WHERE forecast_id = $1", [forecastId]);
  return result[0];
}

export async function readAllForecasts(pool: Pool): Promise<ForecastView[]> {
  return queryForecasts(pool);
}

export async function readForecastsPage(
  pool: Pool,
  options: ForecastListOptions = {},
): Promise<PageResult<ForecastView>> {
  const { whereClause, values } = buildForecastWhereClause(options);
  return queryPage(
    pool,
    "forecasts",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryForecasts(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readChallengesByClaim(pool: Pool, claimId: string): Promise<ChallengeView[]> {
  return queryChallenges(pool, "WHERE claim_id = $1", [claimId]);
}

export async function readChallenge(
  pool: Pool,
  challengeId: string,
): Promise<ChallengeView | undefined> {
  const result = await queryChallenges(pool, "WHERE challenge_id = $1", [challengeId]);
  return result[0];
}

export async function readAllChallenges(pool: Pool): Promise<ChallengeView[]> {
  return queryChallenges(pool);
}

export async function readChallengesPage(
  pool: Pool,
  options: ChallengeListOptions = {},
): Promise<PageResult<ChallengeView>> {
  const { whereClause, values } = buildChallengeWhereClause(options);
  return queryPage(
    pool,
    "challenges",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryChallenges(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readAppealsByClaim(pool: Pool, claimId: string): Promise<AppealView[]> {
  return queryAppeals(pool, "WHERE claim_id = $1", [claimId]);
}

export async function readAllAppeals(pool: Pool): Promise<AppealView[]> {
  return queryAppeals(pool);
}

export async function readAppealsPage(
  pool: Pool,
  options: AppealListOptions = {},
): Promise<PageResult<AppealView>> {
  const { whereClause, values } = buildAppealWhereClause(options);
  return queryPage(
    pool,
    "appeals",
    whereClause,
    values,
    options,
    (queryable, limitOffsetClause, queryValues) =>
      queryAppeals(queryable, whereClause, queryValues, limitOffsetClause),
  );
}

async function setMetadataValues(
  client: PoolClient,
  values: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(values);
  for (const [key, value] of entries) {
    await client.query(
      `
        INSERT INTO metadata (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `,
      [key, value],
    );
  }
}

async function queryClaims(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ClaimView[]> {
  const result = await queryable.query<ClaimView>(
    `
      SELECT
        claim_id AS "claimId",
        author,
        domain_id AS "domainId",
        metadata_hash AS "metadataHash",
        resolution_module AS "resolutionModule",
        status,
        revision_of_claim_id AS "revisionOfClaimId",
        created_at_block AS "createdAtBlock"
      FROM claims
      ${whereClause}
      ORDER BY CAST(claim_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

function buildClaimWhereClause(options: ClaimListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.author) {
    values.push(options.author);
    clauses.push(`lower(author) = lower($${values.length})`);
  }
  if (options.domainId !== undefined) {
    values.push(options.domainId);
    clauses.push(`domain_id = $${values.length}`);
  }
  if (options.status !== undefined) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildArtifactWhereClause(options: ArtifactListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.claimIds && options.claimIds.length > 0) {
    values.push(options.claimIds);
    clauses.push(`claim_id = ANY($${values.length}::text[])`);
  }
  if (options.artifactType !== undefined) {
    values.push(options.artifactType);
    clauses.push(`artifact_type = $${values.length}`);
  }
  if (options.submitter) {
    values.push(options.submitter);
    clauses.push(`lower(submitter) = lower($${values.length})`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

async function queryArtifacts(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ArtifactView[]> {
  const result = await queryable.query<ArtifactView>(
    `
      SELECT
        artifact_id AS "artifactId",
        claim_id AS "claimId",
        artifact_type AS "artifactType",
        content_digest AS "contentDigest",
        uri,
        submitter
      FROM artifacts
      ${whereClause}
      ORDER BY CAST(artifact_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

async function queryReplications(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ReplicationView[]> {
  const result = await queryable.query<ReplicationView>(
    `
      SELECT
        replication_id AS "replicationId",
        claim_id AS "claimId",
        replicator,
        agent_id AS "agentId",
        result_hash AS "resultHash",
        outcome,
        resolution_status AS "resolutionStatus",
        confidence_bps AS "confidenceBps",
        resolution_decision_id AS "resolutionDecisionId",
        resolver_type AS "resolverType",
        resolution_hash AS "resolutionHash",
        evidence_hash AS "evidenceHash",
        evidence_uri AS "evidenceURI"
      FROM replications
      ${whereClause}
      ORDER BY CAST(replication_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

async function queryCheckpoints(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<CheckpointView[]> {
  const result = await queryable.query<CheckpointView>(
    `
      SELECT
        checkpoint_id AS "checkpointId",
        domain_id AS "domainId",
        subject_type AS "subjectType",
        subject_actor AS "subjectActor",
        subject_claim_id AS "subjectClaimId",
        subject_agent_id AS "subjectAgentId",
        subject_module AS "subjectModule",
        score_vector_hash AS "scoreVectorHash",
        payload_hash AS "payloadHash",
        uri
      FROM checkpoints
      ${whereClause}
      ORDER BY CAST(checkpoint_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

async function queryAgents(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<AgentView[]> {
  const result = await queryable.query<AgentView>(
    `
      SELECT
        agent_id AS "agentId",
        operator,
        metadata_hash AS "metadataHash",
        uri,
        budget_balance AS "budgetBalance",
        reserved_budget AS "reservedBudget",
        spend_limit AS "spendLimit",
        active
      FROM agents
      ${whereClause}
      ORDER BY CAST(agent_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

function buildAgentWhereClause(options: AgentListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.operator) {
    values.push(options.operator);
    clauses.push(`lower(operator) = lower($${values.length})`);
  }
  if (options.active !== undefined) {
    values.push(options.active);
    clauses.push(`active = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildAgentControllerWhereClause(options: AgentControllerListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.controller) {
    values.push(options.controller);
    clauses.push(`lower(controller) = lower($${values.length})`);
  }
  if (options.authorized !== undefined) {
    values.push(options.authorized);
    clauses.push(`authorized = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildForecastWhereClause(options: ForecastListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.forecaster) {
    values.push(options.forecaster);
    clauses.push(`lower(forecaster) = lower($${values.length})`);
  }
  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.revealed !== undefined) {
    values.push(options.revealed);
    clauses.push(`revealed = $${values.length}`);
  }
  if (options.settled !== undefined) {
    values.push(options.settled);
    clauses.push(`settled = $${values.length}`);
  }
  if (options.finalStatus !== undefined) {
    values.push(options.finalStatus);
    clauses.push(`final_status = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildReplicationWhereClause(options: ReplicationListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.claimIds && options.claimIds.length > 0) {
    values.push(options.claimIds);
    clauses.push(`claim_id = ANY($${values.length}::text[])`);
  }
  if (options.replicator) {
    values.push(options.replicator);
    clauses.push(`lower(replicator) = lower($${values.length})`);
  }
  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.outcome !== undefined) {
    values.push(options.outcome);
    clauses.push(`outcome = $${values.length}`);
  }
  if (options.resolutionStatus !== undefined) {
    values.push(options.resolutionStatus);
    clauses.push(`resolution_status = $${values.length}`);
  }
  if (options.resolverType !== undefined) {
    values.push(options.resolverType);
    clauses.push(`resolver_type = $${values.length}`);
  }
  if (options.confidenceBps !== undefined) {
    values.push(options.confidenceBps);
    clauses.push(`confidence_bps = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildChallengeWhereClause(options: ChallengeListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.replicationId) {
    values.push(options.replicationId);
    clauses.push(`replication_id = $${values.length}`);
  }
  if (options.challenger) {
    values.push(options.challenger);
    clauses.push(`lower(challenger) = lower($${values.length})`);
  }
  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.status !== undefined) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildAppealWhereClause(options: AppealListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.replicationId) {
    values.push(options.replicationId);
    clauses.push(`replication_id = $${values.length}`);
  }
  if (options.challengeId) {
    values.push(options.challengeId);
    clauses.push(`challenge_id = $${values.length}`);
  }
  if (options.appellant) {
    values.push(options.appellant);
    clauses.push(`lower(appellant) = lower($${values.length})`);
  }
  if (options.reason !== undefined) {
    values.push(options.reason);
    clauses.push(`reason = $${values.length}`);
  }
  if (options.status !== undefined) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildCheckpointWhereClause(options: CheckpointListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`subject_claim_id = $${values.length}`);
  }
  if (options.domainId !== undefined) {
    values.push(options.domainId);
    clauses.push(`domain_id = $${values.length}`);
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
  if (options.subjectModule) {
    values.push(options.subjectModule);
    clauses.push(`lower(subject_module) = lower($${values.length})`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

async function queryPage<T>(
  queryable: Queryable,
  tableName:
    | "appeals"
    | "agents"
    | "agent_controllers"
    | "artifacts"
    | "challenges"
    | "checkpoints"
    | "claims"
    | "forecasts"
    | "replications",
  whereClause: string,
  values: unknown[],
  options: { limit?: number; offset?: number },
  readItems: (
    queryable: Queryable,
    limitOffsetClause: string,
    queryValues: unknown[],
  ) => Promise<T[]>,
): Promise<PageResult<T>> {
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${tableName}${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const limitOffsetClause = `
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `;

  return {
    items: await readItems(queryable, limitOffsetClause, pageValues),
    total: Number(countResult.rows[0]?.count ?? "0"),
    limit,
    offset,
  };
}

async function countTable(
  queryable: Queryable,
  tableName:
    | "agent_controllers"
    | "agents"
    | "appeals"
    | "artifacts"
    | "challenges"
    | "checkpoints"
    | "claims"
    | "forecasts"
    | "replications",
): Promise<number> {
  const result = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${tableName}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function queryAgentControllers(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<AgentControllerView[]> {
  const result = await queryable.query<AgentControllerView>(
    `
      SELECT
        agent_id AS "agentId",
        controller,
        authorized
      FROM agent_controllers
      ${whereClause}
      ORDER BY CAST(agent_id AS INTEGER) ASC, lower(controller) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

async function queryForecasts(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ForecastView[]> {
  const result = await queryable.query<ForecastView>(
    `
      SELECT
        forecast_id AS "forecastId",
        claim_id AS "claimId",
        forecaster,
        agent_id AS "agentId",
        commitment_hash AS "commitmentHash",
        stake_amount AS "stakeAmount",
        committed_at AS "committedAt",
        reveal_deadline AS "revealDeadline",
        revealed,
        settled,
        direction,
        confidence_bps AS "confidenceBps",
        effective_decision_id_at_commit AS "effectiveDecisionIdAtCommit",
        resolution_decision_id AS "resolutionDecisionId",
        final_status AS "finalStatus",
        matched,
        payout_amount AS "payoutAmount"
      FROM forecasts
      ${whereClause}
      ORDER BY CAST(forecast_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

async function queryChallenges(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ChallengeView[]> {
  const result = await queryable.query<ChallengeView>(
    `
      SELECT
        challenge_id AS "challengeId",
        claim_id AS "claimId",
        replication_id AS "replicationId",
        challenger,
        agent_id AS "agentId",
        evidence_hash AS "evidenceHash",
        evidence_uri AS "evidenceURI",
        bond_amount AS "bondAmount",
        status,
        resolution_hash AS "resolutionHash",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt",
        payout_amount AS "payoutAmount",
        refunded_amount AS "refundedAmount"
      FROM challenges
      ${whereClause}
      ORDER BY CAST(challenge_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}

async function queryAppeals(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<AppealView[]> {
  const result = await queryable.query<AppealView>(
    `
      SELECT
        appeal_id AS "appealId",
        claim_id AS "claimId",
        replication_id AS "replicationId",
        challenge_id AS "challengeId",
        appellant,
        reason,
        filing_hash AS "filingHash",
        uri,
        status,
        adjudication_hash AS "adjudicationHash",
        adjudication_uri AS "adjudicationURI",
        bond_amount AS "bondAmount",
        created_at AS "createdAt",
        adjudicated_at AS "adjudicatedAt",
        refunded_amount AS "refundedAmount"
      FROM appeals
      ${whereClause}
      ORDER BY CAST(appeal_id AS INTEGER) ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows;
}
