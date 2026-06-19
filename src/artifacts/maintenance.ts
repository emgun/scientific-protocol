import type { Pool } from "pg";
import {
  type ArtifactMaintenanceTaskRunView,
  type ArtifactMaintenanceTaskType,
  type ArtifactMaintenanceTaskView,
  claimArtifactMaintenanceTaskById,
  claimNextOpenArtifactMaintenanceTask,
  completeArtifactMaintenanceTask,
  createArtifactMaintenanceTask,
  failArtifactMaintenanceTask,
  prepareCoordinatorStore,
  readLatestPersistedArtifactAuditAt,
  readPersistedArtifact,
  readPersistedArtifactReplicas,
  readPersistedArtifactsPage,
  recordPersistedArtifactAudit,
  upsertPersistedArtifact,
  upsertPersistedArtifactReplica,
} from "../coordinator/store.js";
import { getDatabaseUrl } from "../indexer/store.js";
import {
  type ArtifactPersistenceOptions,
  auditPersistedArtifactReplicas,
  buildPrimaryArtifactReplica,
  findArtifactIpfsReplicaTarget,
  type PersistedArtifactRecord,
  type PersistedArtifactReplicaRecord,
  persistArtifactReplicaToTarget,
  persistJsonArtifact,
  readPersistedArtifactBytes,
  readPersistedArtifactReplicaBytes,
  sha256Hex,
} from "../shared/persisted-artifacts.js";
import { readEnvValue } from "../shared/secrets.js";
import { auditPersistedArtifactDurability } from "./auditing.js";

export type ArtifactMaintenanceExecutionResult = {
  completed?: boolean;
  failed?: boolean;
  idle?: boolean;
  message?: string;
  resultArtifactKey?: string | null;
  runId?: string;
  taskId?: string;
  taskType?: ArtifactMaintenanceTaskType;
  workerId: string;
};

export type ArtifactMaintenanceQueueSummary = {
  createdTaskIds: string[];
  requestedAt: string;
  totalCreated: number;
};

export type ResolvedRepairSource = {
  bytes: Buffer;
  locator: string;
  replicaKey: string;
};

export function addPrimaryReplicaIfMissing(
  artifact: Pick<PersistedArtifactRecord, "artifactKey" | "storagePath">,
  replicas: PersistedArtifactReplicaRecord[],
  options: ArtifactPersistenceOptions,
): PersistedArtifactReplicaRecord[] {
  if (replicas.some((replica) => replica.replicaKey === "primary")) {
    return replicas;
  }
  return [buildPrimaryArtifactReplica(artifact, options), ...replicas];
}

export async function resolveRepairSourceForArtifact(
  artifact: Pick<PersistedArtifactRecord, "artifactKey" | "sha256" | "storagePath">,
  replicas: PersistedArtifactReplicaRecord[],
  targetReplicaKey: string,
  options: ArtifactPersistenceOptions,
): Promise<ResolvedRepairSource> {
  const candidates = addPrimaryReplicaIfMissing(artifact, replicas, options).filter(
    (replica) => replica.replicaKey !== targetReplicaKey,
  );

  for (const replica of candidates) {
    try {
      const bytes =
        replica.replicaKey === "primary"
          ? await readPersistedArtifactBytes(artifact, options)
          : await readPersistedArtifactReplicaBytes(replica, options);
      const observedSha256 = `0x${sha256Hex(bytes)}`;
      if (observedSha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
        continue;
      }
      return {
        bytes,
        locator: replica.locator,
        replicaKey: replica.replicaKey,
      };
    } catch {
      // Try the next healthy source.
    }
  }

  throw new Error(
    `no healthy source replica available for artifact ${artifact.artifactKey} and target ${targetReplicaKey}`,
  );
}

async function runArtifactAuditTask(
  pool: Pool,
  task: ArtifactMaintenanceTaskView,
  run: ArtifactMaintenanceTaskRunView,
  options: ArtifactPersistenceOptions,
): Promise<ArtifactMaintenanceExecutionResult> {
  const summary = await auditPersistedArtifactDurability(pool, task.artifactKey, options);
  const repairTasks = [];
  for (const audit of summary.audits) {
    if (audit.status === "verified" || !audit.replicaKey || audit.replicaKey === "primary") {
      continue;
    }
    const target = findArtifactIpfsReplicaTarget(options, audit.replicaKey);
    if (!target) {
      continue;
    }
    repairTasks.push(
      await createArtifactMaintenanceTask(pool, {
        artifactKey: task.artifactKey,
        requestedBy: `artifact-audit:${task.taskId}`,
        targetProvider: audit.provider,
        targetReplicaKey: audit.replicaKey,
        taskType: "repair",
      }),
    );
  }

  const resultArtifact = await persistJsonArtifact(
    "artifact-maintenance-audit-result",
    {
      artifactKey: task.artifactKey,
      audits: summary.audits,
      healthyReplicas: summary.healthyReplicas,
      replicaCount: summary.replicaCount,
      repairTasks: repairTasks.map((repairTask) => ({
        artifactKey: repairTask.artifactKey,
        status: repairTask.status,
        targetReplicaKey: repairTask.targetReplicaKey,
        taskId: repairTask.taskId,
      })),
      runId: run.runId,
      taskId: task.taskId,
      taskType: task.taskType,
    },
    options,
  );
  await upsertPersistedArtifact(pool, resultArtifact);
  await completeArtifactMaintenanceTask(pool, {
    resultArtifactKey: resultArtifact.artifactKey,
    runId: run.runId,
    taskId: task.taskId,
  });

  return {
    completed: true,
    resultArtifactKey: resultArtifact.artifactKey,
    runId: run.runId,
    taskId: task.taskId,
    taskType: task.taskType,
    workerId: run.workerId,
  };
}

async function runArtifactRepairTask(
  pool: Pool,
  task: ArtifactMaintenanceTaskView,
  run: ArtifactMaintenanceTaskRunView,
  options: ArtifactPersistenceOptions,
): Promise<ArtifactMaintenanceExecutionResult> {
  if (!task.targetReplicaKey) {
    throw new Error(`artifact repair task ${task.taskId} is missing targetReplicaKey`);
  }

  const artifact = await readPersistedArtifact(pool, task.artifactKey);
  if (!artifact) {
    throw new Error(`persisted artifact ${task.artifactKey} not found`);
  }

  const target = findArtifactIpfsReplicaTarget(options, task.targetReplicaKey);
  if (!target) {
    throw new Error(`no configured replica target for ${task.targetReplicaKey}`);
  }

  const replicas = await readPersistedArtifactReplicas(pool, task.artifactKey);
  const source = await resolveRepairSourceForArtifact(
    artifact,
    replicas,
    task.targetReplicaKey,
    options,
  );
  const persistedRepair = await persistArtifactReplicaToTarget(artifact, source.bytes, target);
  await upsertPersistedArtifactReplica(pool, task.artifactKey, persistedRepair.replica);
  await recordPersistedArtifactAudit(pool, task.artifactKey, persistedRepair.audit);

  const verificationAudits = await auditPersistedArtifactReplicas(
    {
      ...artifact,
      replicas: [persistedRepair.replica],
    },
    options,
  );
  for (const audit of verificationAudits) {
    await recordPersistedArtifactAudit(pool, task.artifactKey, audit);
  }

  const resultArtifact = await persistJsonArtifact(
    "artifact-maintenance-repair-result",
    {
      artifactKey: task.artifactKey,
      repairedReplica: persistedRepair.replica,
      runId: run.runId,
      sourceReplicaKey: source.replicaKey,
      targetReplicaKey: task.targetReplicaKey,
      taskId: task.taskId,
      taskType: task.taskType,
      verificationAudits,
    },
    options,
  );
  await upsertPersistedArtifact(pool, resultArtifact);
  await completeArtifactMaintenanceTask(pool, {
    repairLocator: persistedRepair.replica.locator,
    repairSourceReplicaKey: source.replicaKey,
    resultArtifactKey: resultArtifact.artifactKey,
    runId: run.runId,
    taskId: task.taskId,
  });

  return {
    completed: true,
    resultArtifactKey: resultArtifact.artifactKey,
    runId: run.runId,
    taskId: task.taskId,
    taskType: task.taskType,
    workerId: run.workerId,
  };
}

export async function enqueueArtifactAuditTasks(
  pool: Pool,
  input: {
    limit?: number;
    requestedBy?: string;
    staleAfterMs?: number;
  } = {},
): Promise<ArtifactMaintenanceQueueSummary> {
  const requestedBy = input.requestedBy ?? "artifact-maintenance-scheduler";
  const staleAfterMs = input.staleAfterMs ?? 24 * 60 * 60 * 1000;
  const createdTaskIds: string[] = [];

  let offset = 0;
  const pageLimit = Math.max(1, Math.min(input.limit ?? 100, 100));
  for (;;) {
    const page = await readPersistedArtifactsPage(pool, { limit: pageLimit, offset });
    if (page.items.length === 0) {
      break;
    }

    for (const artifact of page.items) {
      const latestAuditAt = await readLatestPersistedArtifactAuditAt(pool, artifact.artifactKey);
      const isStale =
        !latestAuditAt || Date.now() - new Date(latestAuditAt).getTime() >= staleAfterMs;
      if (!isStale) {
        continue;
      }
      const task = await createArtifactMaintenanceTask(pool, {
        artifactKey: artifact.artifactKey,
        requestedBy,
        taskType: "audit",
      });
      createdTaskIds.push(task.taskId);
    }

    offset += page.items.length;
    if (page.items.length < pageLimit) {
      break;
    }
  }

  return {
    createdTaskIds,
    requestedAt: new Date().toISOString(),
    totalCreated: createdTaskIds.length,
  };
}

export async function processArtifactMaintenanceTask(
  options: {
    connectionString?: string;
    env?: NodeJS.ProcessEnv;
    persistence?: ArtifactPersistenceOptions;
    taskId?: string;
    taskType?: ArtifactMaintenanceTaskType;
    workerId?: string;
  } = {},
): Promise<ArtifactMaintenanceExecutionResult> {
  const env = options.env ?? process.env;
  const activeWorkerId =
    options.workerId ??
    readEnvValue(env, "SP_ARTIFACT_MAINTENANCE_WORKER_ID") ??
    "local-artifact-maintenance-worker";
  const agentId = readEnvValue(env, "SP_ARTIFACT_MAINTENANCE_AGENT_ID") ?? null;
  const pool = await prepareCoordinatorStore(options.connectionString ?? getDatabaseUrl(env));

  try {
    const claimed = options.taskId
      ? await claimArtifactMaintenanceTaskById(pool, {
          agentId,
          taskId: options.taskId,
          workerId: activeWorkerId,
        })
      : await claimNextOpenArtifactMaintenanceTask(pool, {
          agentId,
          taskType: options.taskType,
          workerId: activeWorkerId,
        });
    if (!claimed) {
      return { idle: true, workerId: activeWorkerId };
    }

    try {
      return claimed.task.taskType === "repair"
        ? await runArtifactRepairTask(pool, claimed.task, claimed.run, options.persistence ?? {})
        : await runArtifactAuditTask(pool, claimed.task, claimed.run, options.persistence ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failArtifactMaintenanceTask(pool, {
        failureReason: message,
        runId: claimed.run.runId,
        taskId: claimed.task.taskId,
      });
      return {
        failed: true,
        message,
        runId: claimed.run.runId,
        taskId: claimed.task.taskId,
        taskType: claimed.task.taskType,
        workerId: activeWorkerId,
      };
    }
  } finally {
    await pool.end();
  }
}
