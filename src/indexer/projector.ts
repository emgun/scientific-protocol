import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { EventLog, JsonRpcProvider, Log } from "ethers";
import type { Pool, PoolClient } from "pg";
import { readBooleanEnv, readPositiveIntegerEnv } from "../shared/cli.js";
import { getContract, getProvider, getRpcUrl } from "../shared/contracts.js";
import {
  DEFAULT_DEPLOYMENT_PATH,
  type DeploymentFile,
  getDeploymentPath,
  loadDeploymentFile,
} from "../shared/deployment.js";
import { isLocalDevelopmentRpcUrl } from "../shared/env.js";
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
import {
  acquireReadModelSyncLock,
  applyAppealAdjudication,
  applyChallengeResolution,
  applyChallengeWithdrawal,
  applyForecastSettlement,
  applyReplicationResolution,
  DEFAULT_MIGRATIONS_PATH,
  ensureReadModelBaseState,
  getDatabaseUrl,
  insertArtifact,
  insertCheckpoint,
  insertResolutionDecision,
  markEffectiveResolutionDecision,
  markSyncFailed,
  markSyncStarted,
  markSyncSucceeded,
  prepareReadModelStore,
  type ReadModelCounts,
  readIndexerBlockCheckpoint,
  readMetadata,
  readReadModel,
  readReadModelCounts,
  readSyncCursor,
  recordIndexerBlockCheckpoint,
  releaseReadModelSyncLock,
  updateClaimStatus,
  updateReadModelMetadata,
  upsertAgent,
  upsertAgentController,
  upsertAppeal,
  upsertChallenge,
  upsertClaim,
  upsertForecast,
  upsertReplicationSubmission,
  writeSyncCursor,
} from "./store.js";

export const DEFAULT_READ_MODEL_PATH = `${process.cwd()}/ops/read-model.json`;

export function getReadModelPath(env: NodeJS.ProcessEnv = process.env): string {
  return readEnvValue(env, "SP_READ_MODEL_PATH") ?? DEFAULT_READ_MODEL_PATH;
}

type SyncedContracts = {
  claimRegistry: Awaited<ReturnType<typeof getContract>>;
  artifactRegistry: Awaited<ReturnType<typeof getContract>>;
  replicationRegistry: Awaited<ReturnType<typeof getContract>>;
  agentRegistry: Awaited<ReturnType<typeof getContract>>;
  checkpointRegistry: Awaited<ReturnType<typeof getContract>>;
  epistemicMarket: Awaited<ReturnType<typeof getContract>>;
  appealsRegistry: Awaited<ReturnType<typeof getContract>>;
  provider: JsonRpcProvider;
};

type ChunkEvents = {
  claimCreatedEvents: EventLog[];
  claimStatusEvents: EventLog[];
  resolutionDecisionEvents: EventLog[];
  effectiveResolutionDecisionEvents: EventLog[];
  artifactEvents: EventLog[];
  replicationSubmittedEvents: EventLog[];
  replicationResolvedEvents: EventLog[];
  agentRegisteredEvents: EventLog[];
  agentControllerEvents: EventLog[];
  agentBudgetDepositedEvents: EventLog[];
  agentBudgetReservedEvents: EventLog[];
  agentBudgetReleasedEvents: EventLog[];
  agentBudgetConsumedEvents: EventLog[];
  agentBudgetWithdrawnEvents: EventLog[];
  agentSpendLimitEvents: EventLog[];
  agentStatusEvents: EventLog[];
  checkpointEvents: EventLog[];
  forecastCommittedEvents: EventLog[];
  forecastRevealedEvents: EventLog[];
  forecastSettledEvents: EventLog[];
  challengeOpenedEvents: EventLog[];
  challengeResolvedEvents: EventLog[];
  challengeWithdrawnEvents: EventLog[];
  appealFiledEvents: EventLog[];
  appealAdjudicatedEvents: EventLog[];
};

export function getSyncBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnv(env, "SP_INDEXER_BATCH_SIZE", 1000);
}

export function getIndexerConfirmationDepth(env: NodeJS.ProcessEnv = process.env): number {
  const fallback = isLocalDevelopmentRpcUrl(getRpcUrl(env)) ? 0 : 12;
  return readPositiveIntegerEnv(env, "SP_INDEXER_CONFIRMATION_DEPTH", fallback, { min: 0 });
}

export class ReadModelReorgDetectedError extends Error {
  constructor(blockNumber: number, storedHash: string, canonicalHash: string) {
    super(
      `read model reorg detected at block ${blockNumber}: stored ${storedHash}, canonical ${canonicalHash}; rebuild is required`,
    );
    this.name = "ReadModelReorgDetectedError";
  }
}

export function getQueryRetryLimit(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnv(env, "SP_INDEXER_QUERY_RETRIES", 5, { min: 0 });
}

export function getQueryRetryDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntegerEnv(env, "SP_INDEXER_QUERY_RETRY_DELAY_MS", 1000, {
    min: 0,
  });
}

export function resolveReadModelSyncConfig(env: NodeJS.ProcessEnv = process.env): {
  databaseUrl: string;
  deploymentPath: string;
  outputPath: string;
} {
  return {
    databaseUrl: getDatabaseUrl(env),
    deploymentPath: getDeploymentPath(env),
    outputPath: getReadModelPath(env),
  };
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & {
    code?: string | number;
    error?: { code?: string | number; message?: string };
    info?: { error?: { code?: string | number; message?: string } };
    shortMessage?: string;
  };

  const messages = [
    error.message,
    candidate.shortMessage,
    candidate.error?.message,
    candidate.info?.error?.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  const codes = [candidate.code, candidate.error?.code, candidate.info?.error?.code];

  return (
    codes.includes(429) ||
    codes.includes("429") ||
    messages.includes("compute units per second") ||
    messages.includes("throughput") ||
    messages.includes("rate limit") ||
    messages.includes("too many requests")
  );
}

async function queryFilterWithRetry<T>(
  query: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const maxRetries = getQueryRetryLimit(env);
  const baseDelayMs = getQueryRetryDelayMs(env);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await query();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }

      const backoffMs = baseDelayMs * (attempt + 1);
      await delay(backoffMs);
    }
  }
}

export type ReadModelSyncSummary = {
  metadata: ReadModel["metadata"];
  counts: ReadModelCounts;
};

export type SyncReadModelOptions = {
  env?: NodeJS.ProcessEnv;
  /** Prepared pool to reuse across sync ticks; callers keep ownership and lifecycle. */
  pool?: Pool;
  /** Materialize the full read model to `outputPath`. Defaults to SP_READ_MODEL_SNAPSHOT. */
  snapshot?: boolean;
};

export async function syncReadModel(
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  outputPath = DEFAULT_READ_MODEL_PATH,
  databaseUrl = getDatabaseUrl(),
  options: SyncReadModelOptions = {},
): Promise<ReadModelSyncSummary> {
  const env = options.env ?? process.env;
  const snapshot = options.snapshot ?? readBooleanEnv(env, "SP_READ_MODEL_SNAPSHOT", false);
  const deployment = await loadDeploymentFile(deploymentPath);
  const headProvider = getProvider(getRpcUrl(env));
  let latestBlock: number;
  try {
    const chainHead = await headProvider.getBlockNumber();
    latestBlock = Math.max(
      Number(deployment.deploymentBlock) - 1,
      chainHead - getIndexerConfirmationDepth(env),
    );
  } finally {
    headProvider.destroy();
  }
  const ownsPool = !options.pool;
  const pool =
    options.pool ?? (await prepareReadModelStore(databaseUrl, DEFAULT_MIGRATIONS_PATH, env));
  let lockClient: PoolClient | null = null;
  let contracts: SyncedContracts | null = null;

  try {
    await ensureReadModelBaseState(pool, deployment);
    lockClient = await acquireReadModelSyncLock(pool);
    await markSyncStarted(lockClient);
    contracts = await loadSyncedContracts(deployment, env);

    let currentCursor = await readSyncCursor(pool);
    if (currentCursor !== null && currentCursor >= deployment.deploymentBlock) {
      const canonicalBlock = await contracts.provider.getBlock(currentCursor);
      if (!canonicalBlock?.hash) throw new Error(`unable to read canonical block ${currentCursor}`);
      const storedHash = await readIndexerBlockCheckpoint(pool, currentCursor);
      if (storedHash && storedHash.toLowerCase() !== canonicalBlock.hash.toLowerCase()) {
        throw new ReadModelReorgDetectedError(currentCursor, storedHash, canonicalBlock.hash);
      }
      if (!storedHash) {
        await recordIndexerBlockCheckpoint(pool, currentCursor, canonicalBlock.hash);
      }
    }
    let fromBlock = Math.max(
      deployment.deploymentBlock,
      (currentCursor ?? deployment.deploymentBlock - 1) + 1,
    );
    const batchSize = getSyncBatchSize(env);

    while (fromBlock <= latestBlock) {
      const toBlock = Math.min(fromBlock + batchSize - 1, latestBlock);
      const chunkEvents = await fetchChunkEvents(contracts, fromBlock, toBlock, env);
      const canonicalBlock = await contracts.provider.getBlock(toBlock);
      if (!canonicalBlock?.hash) throw new Error(`unable to read canonical block ${toBlock}`);
      await applyChunk(pool, deployment, contracts, chunkEvents, toBlock, canonicalBlock.hash);
      currentCursor = toBlock;
      fromBlock = currentCursor + 1;
    }

    if (
      (currentCursor ?? deployment.deploymentBlock - 1) >= latestBlock ||
      fromBlock > latestBlock
    ) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await updateReadModelMetadata(client, {
          chainId: Number(deployment.chainId),
          indexedAt: new Date().toISOString(),
          deploymentBlock: deployment.deploymentBlock,
          latestBlock,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    await markSyncSucceeded(lockClient);
    if (snapshot) {
      const model = await readReadModel(pool);
      await writeFile(outputPath, JSON.stringify(model, null, 2));
    }
    return {
      metadata: await readMetadata(pool),
      counts: await readReadModelCounts(pool),
    };
  } catch (error) {
    if (!(error instanceof Error && error.name === "ReadModelSyncInProgressError")) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (lockClient) {
          await markSyncFailed(lockClient, message);
        } else {
          await markSyncFailed(pool, message);
        }
      } catch {
        // Preserve the original sync failure.
      }
    }
    throw error;
  } finally {
    contracts?.provider.destroy();
    if (lockClient) {
      await releaseReadModelSyncLock(lockClient);
    }
    if (ownsPool) {
      await pool.end();
    }
  }
}

async function loadSyncedContracts(
  deployment: DeploymentFile,
  env: NodeJS.ProcessEnv,
): Promise<SyncedContracts> {
  const provider = getProvider(getRpcUrl(env));
  try {
    const [
      claimRegistry,
      artifactRegistry,
      replicationRegistry,
      agentRegistry,
      checkpointRegistry,
      epistemicMarket,
      appealsRegistry,
    ] = await Promise.all([
      getContract("ClaimRegistry", deployment.addresses.claimRegistry, provider),
      getContract("ArtifactRegistry", deployment.addresses.artifactRegistry, provider),
      getContract("ReplicationRegistry", deployment.addresses.replicationRegistry, provider),
      getContract("AgentRegistry", deployment.addresses.agentRegistry, provider),
      getContract(
        "ReputationCheckpointRegistry",
        deployment.addresses.reputationCheckpointRegistry,
        provider,
      ),
      getContract("EpistemicMarket", deployment.addresses.epistemicMarket, provider),
      getContract("AppealsRegistry", deployment.addresses.appealsRegistry, provider),
    ]);

    return {
      claimRegistry,
      artifactRegistry,
      replicationRegistry,
      agentRegistry,
      checkpointRegistry,
      epistemicMarket,
      appealsRegistry,
      provider,
    };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

async function fetchChunkEvents(
  contracts: SyncedContracts,
  fromBlock: number,
  toBlock: number,
  env: NodeJS.ProcessEnv,
): Promise<ChunkEvents> {
  const queries = [
    () =>
      contracts.claimRegistry.queryFilter(
        contracts.claimRegistry.filters.ClaimCreated(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.claimRegistry.queryFilter(
        contracts.claimRegistry.filters.ClaimStatusUpdated(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.claimRegistry.queryFilter(
        contracts.claimRegistry.filters.ResolutionDecisionRecorded(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.claimRegistry.queryFilter(
        contracts.claimRegistry.filters.EffectiveResolutionDecisionUpdated(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.artifactRegistry.queryFilter(
        contracts.artifactRegistry.filters.ArtifactAdded(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.replicationRegistry.queryFilter(
        contracts.replicationRegistry.filters.ReplicationSubmitted(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.replicationRegistry.queryFilter(
        contracts.replicationRegistry.filters.ReplicationResolved(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentRegistered(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentControllerAuthorization(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentBudgetDeposited(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentBudgetReserved(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentBudgetReleased(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentBudgetConsumed(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentBudgetWithdrawn(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentSpendLimitUpdated(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.agentRegistry.queryFilter(
        contracts.agentRegistry.filters.AgentStatusUpdated(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.checkpointRegistry.queryFilter(
        contracts.checkpointRegistry.filters.ReputationCheckpointPublished(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.epistemicMarket.queryFilter(
        contracts.epistemicMarket.filters.ForecastCommitted(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.epistemicMarket.queryFilter(
        contracts.epistemicMarket.filters.ForecastRevealed(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.epistemicMarket.queryFilter(
        contracts.epistemicMarket.filters.ForecastSettled(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.epistemicMarket.queryFilter(
        contracts.epistemicMarket.filters.ChallengeOpened(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.epistemicMarket.queryFilter(
        contracts.epistemicMarket.filters.ChallengeResolved(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.epistemicMarket.queryFilter(
        contracts.epistemicMarket.filters.ChallengeWithdrawn(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.appealsRegistry.queryFilter(
        contracts.appealsRegistry.filters.AppealFiled(),
        fromBlock,
        toBlock,
      ),
    () =>
      contracts.appealsRegistry.queryFilter(
        contracts.appealsRegistry.filters.AppealAdjudicated(),
        fromBlock,
        toBlock,
      ),
  ] satisfies Array<() => Promise<Array<Log | EventLog>>>;

  const results: EventLog[][] = [];
  for (const query of queries) {
    results.push((await queryFilterWithRetry(query, env)) as EventLog[]);
  }

  const [
    claimCreatedEvents,
    claimStatusEvents,
    resolutionDecisionEvents,
    effectiveResolutionDecisionEvents,
    artifactEvents,
    replicationSubmittedEvents,
    replicationResolvedEvents,
    agentRegisteredEvents,
    agentControllerEvents,
    agentBudgetDepositedEvents,
    agentBudgetReservedEvents,
    agentBudgetReleasedEvents,
    agentBudgetConsumedEvents,
    agentBudgetWithdrawnEvents,
    agentSpendLimitEvents,
    agentStatusEvents,
    checkpointEvents,
    forecastCommittedEvents,
    forecastRevealedEvents,
    forecastSettledEvents,
    challengeOpenedEvents,
    challengeResolvedEvents,
    challengeWithdrawnEvents,
    appealFiledEvents,
    appealAdjudicatedEvents,
  ] = results;

  return {
    claimCreatedEvents,
    claimStatusEvents,
    resolutionDecisionEvents,
    effectiveResolutionDecisionEvents,
    artifactEvents,
    replicationSubmittedEvents,
    replicationResolvedEvents,
    agentRegisteredEvents,
    agentControllerEvents,
    agentBudgetDepositedEvents,
    agentBudgetReservedEvents,
    agentBudgetReleasedEvents,
    agentBudgetConsumedEvents,
    agentBudgetWithdrawnEvents,
    agentSpendLimitEvents,
    agentStatusEvents,
    checkpointEvents,
    forecastCommittedEvents,
    forecastRevealedEvents,
    forecastSettledEvents,
    challengeOpenedEvents,
    challengeResolvedEvents,
    challengeWithdrawnEvents,
    appealFiledEvents,
    appealAdjudicatedEvents,
  };
}

async function applyChunk(
  pool: Awaited<ReturnType<typeof prepareReadModelStore>>,
  deployment: DeploymentFile,
  contracts: SyncedContracts,
  events: ChunkEvents,
  chunkEndBlock: number,
  chunkEndBlockHash: string,
): Promise<void> {
  const createdClaims: ClaimView[] = [];
  for (const event of events.claimCreatedEvents) {
    const claimRecord = await contracts.claimRegistry.getClaim(event.args.claimId);
    createdClaims.push({
      claimId: event.args.claimId.toString(),
      author: event.args.author,
      domainId: Number(event.args.domainId),
      metadataHash: event.args.metadataHash,
      resolutionModule: event.args.resolutionModule,
      status: Number(claimRecord.status),
      revisionOfClaimId:
        claimRecord.revisionOfClaimId === 0n ? null : claimRecord.revisionOfClaimId.toString(),
      createdAtBlock: event.blockNumber,
    });
  }

  const artifacts: ArtifactView[] = events.artifactEvents.map((event) => ({
    artifactId: event.args.artifactId.toString(),
    claimId: event.args.claimId.toString(),
    artifactType: Number(event.args.artifactType),
    contentDigest: event.args.contentDigest,
    uri: event.args.uri,
    submitter: event.args.submitter,
  }));

  const resolutionDecisions: ResolutionDecisionView[] = await Promise.all(
    events.resolutionDecisionEvents.map(async (event) => {
      const decision = await contracts.claimRegistry.getResolutionDecision(event.args.decisionId);
      return {
        decisionId: event.args.decisionId.toString(),
        claimId: event.args.claimId.toString(),
        replicationId: event.args.replicationId.toString(),
        resolutionModule: event.args.resolutionModule,
        status: Number(event.args.status),
        claimStatus: Number(event.args.claimStatus),
        confidenceBps: Number(event.args.confidenceBps),
        resolutionHash: event.args.resolutionHash,
        evidenceHash: event.args.evidenceHash,
        resolverType: Number(event.args.resolverType),
        createdAt: decision.createdAt.toString(),
        actor: event.args.actor,
        effective: false,
      };
    }),
  );

  const submittedReplications: ReplicationView[] = events.replicationSubmittedEvents.map(
    (event) => ({
      replicationId: event.args.replicationId.toString(),
      claimId: event.args.claimId.toString(),
      replicator: event.args.replicator,
      agentId: event.args.agentId.toString(),
      resultHash: event.args.resultHash,
      outcome: null,
      resolutionStatus: null,
      confidenceBps: null,
      resolverType: null,
      resolutionHash: null,
      evidenceHash: null,
      evidenceURI: null,
    }),
  );

  const checkpoints: CheckpointView[] = events.checkpointEvents.map((event) => ({
    checkpointId: event.args.checkpointId.toString(),
    domainId: Number(event.args.domainId),
    subjectType: Number(event.args.subjectType),
    subjectActor: event.args.subjectActor,
    subjectClaimId: event.args.subjectClaimId.toString(),
    subjectAgentId: event.args.subjectAgentId.toString(),
    subjectModule: event.args.subjectModule,
    scoreVectorHash: event.args.scoreVectorHash,
    payloadHash: event.args.payloadHash,
    uri: event.args.uri,
  }));

  const touchedAgentIds = new Set<string>();
  for (const event of events.agentRegisteredEvents) {
    touchedAgentIds.add(event.args.agentId.toString());
  }
  for (const event of events.agentControllerEvents) {
    touchedAgentIds.add(event.args.agentId.toString());
  }
  for (const event of [
    ...events.agentBudgetDepositedEvents,
    ...events.agentBudgetReservedEvents,
    ...events.agentBudgetReleasedEvents,
    ...events.agentBudgetConsumedEvents,
    ...events.agentBudgetWithdrawnEvents,
    ...events.agentSpendLimitEvents,
    ...events.agentStatusEvents,
  ]) {
    touchedAgentIds.add(event.args.agentId.toString());
  }

  const agentSnapshots: AgentView[] = await Promise.all(
    Array.from(touchedAgentIds).map(async (agentId) => {
      const record = await contracts.agentRegistry.getAgent(BigInt(agentId));
      return {
        agentId,
        operator: record.operator,
        metadataHash: record.metadataHash,
        uri: record.uri,
        budgetBalance: record.budgetBalance.toString(),
        reservedBudget: record.reservedBudget.toString(),
        spendLimit: record.spendLimit.toString(),
        active: record.active,
      };
    }),
  );

  const agentControllers: AgentControllerView[] = events.agentControllerEvents.map((event) => ({
    agentId: event.args.agentId.toString(),
    controller: event.args.controller,
    authorized: event.args.authorized,
  }));

  const touchedForecastIds = new Set<string>();
  for (const event of [
    ...events.forecastCommittedEvents,
    ...events.forecastRevealedEvents,
    ...events.forecastSettledEvents,
  ]) {
    touchedForecastIds.add(event.args.forecastId.toString());
  }

  const forecastSnapshots: ForecastView[] = await Promise.all(
    Array.from(touchedForecastIds).map(async (forecastId) => {
      const record = await contracts.epistemicMarket.getForecast(BigInt(forecastId));
      return {
        forecastId,
        claimId: record.claimId.toString(),
        forecaster: record.forecaster,
        agentId: record.agentId.toString(),
        commitmentHash: record.commitmentHash,
        stakeAmount: record.stakeAmount.toString(),
        committedAt: Number(record.committedAt),
        revealDeadline: Number(record.revealDeadline),
        revealed: record.revealed,
        settled: record.settled,
        direction: Number(record.direction),
        confidenceBps: Number(record.confidenceBps),
        effectiveDecisionIdAtCommit:
          record.effectiveDecisionIdAtCommit === 0n
            ? null
            : record.effectiveDecisionIdAtCommit.toString(),
        resolutionDecisionId:
          record.resolutionDecisionId === 0n ? null : record.resolutionDecisionId.toString(),
        finalStatus: null,
        matched: null,
        payoutAmount: null,
      };
    }),
  );

  const touchedChallengeIds = new Set<string>();
  for (const event of [
    ...events.challengeOpenedEvents,
    ...events.challengeResolvedEvents,
    ...events.challengeWithdrawnEvents,
  ]) {
    touchedChallengeIds.add(event.args.challengeId.toString());
  }

  const challengeSnapshots: ChallengeView[] = await Promise.all(
    Array.from(touchedChallengeIds).map(async (challengeId) => {
      const record = await contracts.epistemicMarket.getChallenge(BigInt(challengeId));
      return {
        challengeId,
        claimId: record.claimId.toString(),
        replicationId: record.replicationId.toString(),
        challenger: record.challenger,
        agentId: record.agentId.toString(),
        evidenceHash: record.evidenceHash,
        evidenceURI: record.evidenceURI,
        bondAmount: record.bondAmount.toString(),
        status: Number(record.status),
        resolutionHash:
          record.resolutionHash ===
          "0x0000000000000000000000000000000000000000000000000000000000000000"
            ? null
            : record.resolutionHash,
        createdAt: Number(record.createdAt),
        resolvedAt: record.resolvedAt === 0n ? null : Number(record.resolvedAt),
        payoutAmount: null,
        refundedAmount: null,
      };
    }),
  );

  const touchedAppealIds = new Set<string>();
  for (const event of [...events.appealFiledEvents, ...events.appealAdjudicatedEvents]) {
    touchedAppealIds.add(event.args.appealId.toString());
  }

  const appealSnapshots: AppealView[] = await Promise.all(
    Array.from(touchedAppealIds).map(async (appealId) => {
      const record = await contracts.appealsRegistry.getAppeal(BigInt(appealId));
      return {
        appealId,
        claimId: record.claimId.toString(),
        replicationId: record.replicationId.toString(),
        challengeId: record.challengeId.toString(),
        appellant: record.appellant,
        reason: Number(record.reason),
        filingHash: record.filingHash,
        uri: record.uri,
        status: Number(record.status),
        adjudicationHash:
          record.adjudicationHash ===
          "0x0000000000000000000000000000000000000000000000000000000000000000"
            ? null
            : record.adjudicationHash,
        adjudicationURI: record.adjudicationURI === "" ? null : record.adjudicationURI,
        bondAmount: record.bondAmount.toString(),
        createdAt: Number(record.createdAt),
        adjudicatedAt: record.adjudicatedAt === 0n ? null : Number(record.adjudicatedAt),
        refundedAmount: null,
      };
    }),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const claim of createdClaims) {
      await upsertClaim(client, claim);
    }

    for (const event of events.claimStatusEvents) {
      await updateClaimStatus(client, event.args.claimId.toString(), Number(event.args.newStatus));
    }

    for (const artifact of artifacts) {
      await insertArtifact(client, artifact);
    }

    for (const replication of submittedReplications) {
      await upsertReplicationSubmission(client, replication);
    }

    for (const event of events.replicationResolvedEvents) {
      await applyReplicationResolution(client, event.args.replicationId.toString(), {
        outcome: Number(event.args.outcome),
        resolutionStatus: Number(event.args.status),
        confidenceBps: Number(event.args.confidenceBps),
        resolverType: Number(event.args.resolverType),
        resolutionHash: event.args.resolutionHash,
        evidenceHash: event.args.evidenceHash,
        evidenceURI: event.args.evidenceURI,
      });
    }

    for (const decision of resolutionDecisions) {
      await insertResolutionDecision(client, decision);
    }
    for (const event of events.effectiveResolutionDecisionEvents) {
      await markEffectiveResolutionDecision(
        client,
        event.args.claimId.toString(),
        event.args.decisionId.toString(),
      );
    }

    for (const checkpoint of checkpoints) {
      await insertCheckpoint(client, checkpoint);
    }

    for (const agent of agentSnapshots) {
      await upsertAgent(client, agent);
    }

    for (const controller of agentControllers) {
      await upsertAgentController(client, controller);
    }

    for (const forecast of forecastSnapshots) {
      await upsertForecast(client, forecast);
    }

    for (const event of events.forecastSettledEvents) {
      await applyForecastSettlement(
        client,
        event.args.forecastId.toString(),
        event.args.resolutionDecisionId.toString(),
        Number(event.args.finalStatus),
        event.args.matched,
        event.args.payoutAmount.toString(),
      );
    }

    for (const challenge of challengeSnapshots) {
      await upsertChallenge(client, challenge);
    }

    for (const event of events.challengeResolvedEvents) {
      await applyChallengeResolution(
        client,
        event.args.challengeId.toString(),
        Number(event.args.status),
        event.args.resolutionHash,
        event.args.payoutAmount.toString(),
      );
    }

    for (const event of events.challengeWithdrawnEvents) {
      await applyChallengeWithdrawal(
        client,
        event.args.challengeId.toString(),
        event.args.refundedAmount.toString(),
      );
    }

    for (const appeal of appealSnapshots) {
      await upsertAppeal(client, appeal);
    }

    for (const event of events.appealAdjudicatedEvents) {
      await applyAppealAdjudication(
        client,
        event.args.appealId.toString(),
        Number(event.args.status),
        event.args.adjudicationHash,
        event.args.adjudicationURI,
        event.args.refundedAmount.toString(),
      );
    }

    await updateReadModelMetadata(client, {
      chainId: Number(deployment.chainId),
      indexedAt: new Date().toISOString(),
      deploymentBlock: deployment.deploymentBlock,
      latestBlock: chunkEndBlock,
    });
    await writeSyncCursor(client, chunkEndBlock, chunkEndBlockHash);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
