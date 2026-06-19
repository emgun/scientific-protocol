import { submitPersistedReplicationResult } from "../coordinator/execution.js";
import {
  claimNextOpenReplicationJob,
  claimReplicationJobById,
  completeReplicationJob,
  failReplicationJob,
  prepareCoordinatorStore,
  upsertPersistedArtifact,
} from "../coordinator/store.js";
import { getDatabaseUrl, readArtifactsByClaim, readClaim } from "../indexer/store.js";
import {
  isMainModule,
  readBooleanEnv,
  readOptionalTrimmedEnv,
  readPositiveIntegerEnv,
  runJsonCliLoop,
} from "../shared/cli.js";
import { persistJsonArtifact } from "../shared/persisted-artifacts.js";

export async function processReplicationJob(
  options: { connectionString?: string; jobId?: string; onceWorkerId?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  completed?: boolean;
  failed?: boolean;
  idle?: boolean;
  jobId?: string;
  message?: string;
  onchainReplicationId?: string | null;
  operatorRequestId?: string;
  resultArtifactKey?: string | null;
  submissionTxHash?: string | null;
  workerId: string;
}> {
  const databaseUrl = getDatabaseUrl(env);
  const workerId =
    readOptionalTrimmedEnv(env, "SP_REPLICATION_WORKER_ID") ?? "local-replication-worker";
  const agentId = readOptionalTrimmedEnv(env, "SP_REPLICATION_AGENT_ID") ?? null;
  const activeWorkerId = options.onceWorkerId ?? workerId;
  const pool = await prepareCoordinatorStore(options.connectionString ?? databaseUrl);
  try {
    const claimed = options.jobId
      ? await claimReplicationJobById(pool, {
          agentId,
          jobId: options.jobId,
          workerId: activeWorkerId,
        })
      : await claimNextOpenReplicationJob(pool, { workerId: activeWorkerId, agentId });
    if (!claimed) {
      return { idle: true, workerId: activeWorkerId };
    }

    let operatorRequestId: string | undefined;
    try {
      const claim = await readClaim(pool, claimed.job.claimId);
      if (!claim) {
        throw new Error(`claim ${claimed.job.claimId} not found in read model`);
      }
      const artifacts = await readArtifactsByClaim(pool, claim.claimId);
      const executionManifest = {
        artifacts,
        claim,
        generatedAt: new Date().toISOString(),
        job: claimed.job,
        runId: claimed.run.runId,
        workerId: activeWorkerId,
      };
      const persisted = await persistJsonArtifact("replication-result", executionManifest, {
        env,
      });
      await upsertPersistedArtifact(pool, persisted);
      const submission = await submitPersistedReplicationResult({
        assignedAgentId: claimed.job.assignedAgentId ?? agentId,
        claimId: claimed.job.claimId,
        env,
        jobId: claimed.job.jobId,
        pool,
        resultArtifact: persisted,
        runId: claimed.run.runId,
        workerId: activeWorkerId,
      });
      operatorRequestId = submission.operatorRequestId;
      const job = await completeReplicationJob(pool, {
        evidenceHash: persisted.sha256,
        evidenceURI: persisted.storagePath,
        executionManifestHash: persisted.sha256,
        jobId: claimed.job.jobId,
        onchainReplicationId: submission.onchainReplicationId,
        requestId: submission.operatorRequestId,
        resultArtifactKey: persisted.artifactKey,
        resultHash: persisted.sha256,
        runId: claimed.run.runId,
        submissionActor: submission.submissionActor,
        submissionTxHash: submission.submissionTxHash,
      });

      return {
        completed: true,
        jobId: job.jobId,
        onchainReplicationId: job.onchainReplicationId,
        operatorRequestId: submission.operatorRequestId,
        resultArtifactKey: job.resultArtifactKey,
        submissionTxHash: job.submissionTxHash,
        workerId: activeWorkerId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !operatorRequestId &&
        error &&
        typeof error === "object" &&
        "operatorRequestId" in error
      ) {
        const candidate = (error as { operatorRequestId?: unknown }).operatorRequestId;
        if (typeof candidate === "string" && candidate.length > 0) {
          operatorRequestId = candidate;
        }
      }
      await failReplicationJob(pool, {
        failureReason: message,
        jobId: claimed.job.jobId,
        requestId: operatorRequestId,
        runId: claimed.run.runId,
      });
      return {
        failed: true,
        jobId: claimed.job.jobId,
        message,
        workerId: activeWorkerId,
      };
    }
  } finally {
    await pool.end();
  }
}

export async function startReplicationWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const once = readBooleanEnv(env, "SP_REPLICATION_WORKER_ONCE", true);
  const intervalMs = readPositiveIntegerEnv(env, "SP_REPLICATION_WORKER_INTERVAL_MS", 10_000);
  await runJsonCliLoop({ intervalMs, once, runOnce: () => processReplicationJob({}, env) });
}

if (isMainModule(import.meta.url)) {
  try {
    await startReplicationWorkerFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
