import { randomUUID } from "node:crypto";
import type { ScientificProtocolClient } from "../sdk/client.js";
import { ScientificProtocolApiError } from "../sdk/client.js";
import type {
  ArtifactMaintenanceTaskRunView,
  ArtifactMaintenanceTaskView,
  ClaimWorkItemView,
  PersistedArtifactDetailResponse,
} from "../sdk/types.js";
import {
  type AgentRequestSigner,
  createSignedAgentRequest,
} from "../shared/agent-request-envelope.js";
import {
  type ArtifactPersistenceOptions,
  auditPersistedArtifactReplicas,
  findArtifactIpfsReplicaTarget,
  type PersistedArtifactRecord,
  type PersistedArtifactReplicaRecord,
  persistArtifactReplicaToTarget,
} from "../shared/persisted-artifacts.js";
import { addPrimaryReplicaIfMissing, resolveRepairSourceForArtifact } from "./maintenance.js";

type ArtifactMaintenanceAgentClient = Pick<
  ScientificProtocolClient,
  "getPersistedArtifact" | "getWorkItem" | "listWorkItems"
> & {
  agent: Pick<
    ScientificProtocolClient["agent"],
    "claimWorkItem" | "heartbeatWorkItem" | "submitWorkResults"
  >;
};

type ArtifactMaintenanceTaskCandidate = {
  canClaim: boolean;
  createdAt: string;
  itemId: string;
  requiredCapabilities: string[];
  taskId: string;
  taskType: ArtifactMaintenanceTaskView["taskType"];
};

export type ReferenceArtifactMaintenanceAgentOptions = {
  actorAddress?: string;
  agentId: string;
  capabilities?: string[];
  client: ArtifactMaintenanceAgentClient;
  limit?: number;
  persistence?: ArtifactPersistenceOptions;
  signer: AgentRequestSigner;
  taskId?: string;
  taskType?: ArtifactMaintenanceTaskView["taskType"];
  workerId: string;
};

export type ReferenceArtifactMaintenanceAgentResult = {
  artifactKey?: string;
  completed?: boolean;
  idle?: boolean;
  itemId?: string;
  message?: string;
  runId?: string;
  taskId?: string;
  taskType?: ArtifactMaintenanceTaskView["taskType"];
  workerId: string;
};

function normalizeCapabilities(input: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (input ?? [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
}

export function artifactMaintenanceTaskMatchesCapabilities(
  task: Pick<ArtifactMaintenanceTaskCandidate, "requiredCapabilities">,
  capabilities?: string[],
): boolean {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.length === 0) {
    return true;
  }
  const capabilitySet = new Set(normalized);
  return task.requiredCapabilities.every((capability) => capabilitySet.has(capability));
}

export function selectArtifactMaintenanceTaskForAgent(
  tasks: ArtifactMaintenanceTaskCandidate[],
  options: {
    capabilities?: string[];
    taskId?: string;
  } = {},
): ArtifactMaintenanceTaskCandidate | null {
  const matching = tasks
    .filter((task) => task.canClaim)
    .filter((task) => !options.taskId || task.taskId === options.taskId)
    .filter((task) => artifactMaintenanceTaskMatchesCapabilities(task, options.capabilities))
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }
      return left.taskId.localeCompare(right.taskId);
    });
  return matching[0] ?? null;
}

function toTaskCandidate(item: ClaimWorkItemView): ArtifactMaintenanceTaskCandidate | null {
  if (item.kind !== "artifact_maintenance") {
    return null;
  }
  return {
    canClaim: item.orchestration.canClaim,
    createdAt: item.createdAt,
    itemId: item.itemId,
    requiredCapabilities: item.policy?.requiredCapabilities ?? [],
    taskId: item.itemId.startsWith("artifact-maintenance:")
      ? item.itemId.slice("artifact-maintenance:".length)
      : item.itemId,
    taskType: item.sourceType as ArtifactMaintenanceTaskView["taskType"],
  };
}

function isArtifactMaintenanceClaimResult(result: unknown): result is {
  run: ArtifactMaintenanceTaskRunView;
  task: ArtifactMaintenanceTaskView;
} {
  if (!result || typeof result !== "object") {
    return false;
  }
  const value = result as Record<string, unknown>;
  const task = value.task as Record<string, unknown> | undefined;
  return (
    !!task &&
    typeof value.run === "object" &&
    typeof task.taskId === "string" &&
    typeof task.artifactKey === "string" &&
    typeof task.taskType === "string"
  );
}

function isArtifactMaintenanceSubmissionResult(result: unknown): result is { task: unknown } {
  return !!result && typeof result === "object" && "task" in result;
}

function toPersistedArtifactRecord(
  artifact: PersistedArtifactDetailResponse,
): PersistedArtifactRecord {
  return {
    artifactKey: artifact.artifactKey,
    byteLength: artifact.byteLength,
    contentType: artifact.contentType,
    kind: artifact.kind,
    sha256: artifact.sha256,
    storagePath: artifact.storagePath,
  };
}

function toPersistedArtifactReplicas(
  artifact: PersistedArtifactDetailResponse,
  persistence: ArtifactPersistenceOptions,
): PersistedArtifactReplicaRecord[] {
  return addPrimaryReplicaIfMissing(
    toPersistedArtifactRecord(artifact),
    artifact.replicas,
    persistence,
  );
}

async function listCandidateTasks(
  client: ArtifactMaintenanceAgentClient,
  options: Pick<ReferenceArtifactMaintenanceAgentOptions, "limit" | "taskId" | "taskType">,
): Promise<ArtifactMaintenanceTaskCandidate[]> {
  if (options.taskId) {
    const detail = await client.getWorkItem(`artifact-maintenance:${options.taskId}`);
    return detail.item ? [detail.item].map(toTaskCandidate).filter((task) => task !== null) : [];
  }

  const page = await client.listWorkItems({
    claimable: true,
    kind: "artifact_maintenance",
    limit: options.limit ?? 20,
    offset: 0,
    status: "open",
  });
  return page.items
    .map(toTaskCandidate)
    .filter(
      (task): task is ArtifactMaintenanceTaskCandidate =>
        task !== null && (options.taskType === undefined || task.taskType === options.taskType),
    );
}

function isClaimConflict(error: unknown): boolean {
  return error instanceof ScientificProtocolApiError && error.status === 409;
}

async function claimTask(
  input: Pick<
    ReferenceArtifactMaintenanceAgentOptions,
    "actorAddress" | "agentId" | "client" | "signer"
  > & {
    task: ArtifactMaintenanceTaskCandidate;
    workerId: string;
  },
): Promise<{ run: ArtifactMaintenanceTaskRunView; task: ArtifactMaintenanceTaskView }> {
  const signedClaim = await createSignedAgentRequest({
    actionType: "artifact_task_claim",
    actorAddress: input.actorAddress,
    agentId: input.agentId,
    payload: {
      workerId: input.workerId,
    },
    requestNonce: randomUUID(),
    scopeKey: `artifact-maintenance-task:${input.task.taskId}`,
    signer: input.signer,
  });
  const claimed = await input.client.agent.claimWorkItem(input.task.itemId, signedClaim);
  if (!isArtifactMaintenanceClaimResult(claimed.result)) {
    throw new Error("unexpected_artifact_maintenance_claim_result");
  }
  return claimed.result;
}

async function heartbeatClaimedRun(
  input: Pick<
    ReferenceArtifactMaintenanceAgentOptions,
    "actorAddress" | "agentId" | "client" | "signer"
  > & {
    runId: string;
    taskId: string;
    workerId: string;
  },
): Promise<void> {
  const signedHeartbeat = await createSignedAgentRequest({
    actionType: "artifact_task_heartbeat",
    actorAddress: input.actorAddress,
    agentId: input.agentId,
    payload: {
      runId: input.runId,
      workerId: input.workerId,
    },
    requestNonce: randomUUID(),
    scopeKey: `artifact-maintenance-task:${input.taskId}`,
    signer: input.signer,
  });
  await input.client.agent.heartbeatWorkItem(
    `artifact-maintenance:${input.taskId}`,
    signedHeartbeat,
  );
}

async function buildAuditSubmission(
  artifact: PersistedArtifactDetailResponse,
  options: ArtifactPersistenceOptions,
): Promise<Record<string, unknown>> {
  const audits = await auditPersistedArtifactReplicas(
    {
      ...toPersistedArtifactRecord(artifact),
      replicas: artifact.replicas,
    },
    options,
  );
  return {
    audits: audits.map((audit) => ({
      detail: audit.detail ?? null,
      locator: audit.locator,
      observedSha256: audit.observedSha256 ?? null,
      provider: audit.provider,
      replicaKey: audit.replicaKey,
      status: audit.status,
    })),
  };
}

async function buildRepairSubmission(
  artifact: PersistedArtifactDetailResponse,
  task: ArtifactMaintenanceTaskView,
  options: ArtifactPersistenceOptions,
): Promise<Record<string, unknown>> {
  if (!task.targetReplicaKey) {
    throw new Error(`artifact repair task ${task.taskId} is missing targetReplicaKey`);
  }
  const target = findArtifactIpfsReplicaTarget(options, task.targetReplicaKey);
  if (!target) {
    throw new Error(`no configured replica target for ${task.targetReplicaKey}`);
  }
  const source = await resolveRepairSourceForArtifact(
    toPersistedArtifactRecord(artifact),
    toPersistedArtifactReplicas(artifact, options),
    task.targetReplicaKey,
    options,
  );
  const repaired = await persistArtifactReplicaToTarget(
    toPersistedArtifactRecord(artifact),
    source.bytes,
    target,
  );
  return {
    repairSourceReplicaKey: source.replicaKey,
    repairedReplica: repaired.replica,
  };
}

export async function runReferenceArtifactMaintenanceAgentOnce(
  options: ReferenceArtifactMaintenanceAgentOptions,
): Promise<ReferenceArtifactMaintenanceAgentResult> {
  const tasks = await listCandidateTasks(options.client, options);
  const compatibleTasks = options.taskId
    ? tasks
    : tasks.filter((task) =>
        artifactMaintenanceTaskMatchesCapabilities(task, options.capabilities),
      );

  if (compatibleTasks.length === 0) {
    return {
      idle: true,
      message:
        options.taskId && tasks.length > 0
          ? "requested artifact maintenance task is not compatible with this agent configuration"
          : "no compatible open artifact maintenance task available",
      workerId: options.workerId,
    };
  }

  const preferredTask =
    options.taskId !== undefined
      ? selectArtifactMaintenanceTaskForAgent(tasks, {
          capabilities: options.capabilities,
          taskId: options.taskId,
        })
      : null;
  const candidateTasks = preferredTask
    ? [preferredTask]
    : [...compatibleTasks].sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.taskId.localeCompare(right.taskId);
      });

  for (const task of candidateTasks) {
    let claimed: { run: ArtifactMaintenanceTaskRunView; task: ArtifactMaintenanceTaskView };
    try {
      claimed = await claimTask({
        actorAddress: options.actorAddress,
        agentId: options.agentId,
        client: options.client,
        signer: options.signer,
        task,
        workerId: options.workerId,
      });
    } catch (error) {
      if (isClaimConflict(error) && !options.taskId) {
        continue;
      }
      throw error;
    }

    await heartbeatClaimedRun({
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      client: options.client,
      runId: claimed.run.runId,
      signer: options.signer,
      taskId: claimed.task.taskId,
      workerId: options.workerId,
    });

    const artifact = await options.client.getPersistedArtifact(claimed.task.artifactKey);
    const payload =
      claimed.task.taskType === "repair"
        ? await buildRepairSubmission(artifact, claimed.task, options.persistence ?? {})
        : await buildAuditSubmission(artifact, options.persistence ?? {});
    const actionType =
      claimed.task.taskType === "repair"
        ? "artifact_task_repair_submission"
        : "artifact_task_audit_submission";
    const signedSubmission = await createSignedAgentRequest({
      actionType,
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      payload: {
        ...payload,
        runId: claimed.run.runId,
        workerId: options.workerId,
      },
      requestNonce: randomUUID(),
      scopeKey: `artifact-maintenance-task:${claimed.task.taskId}`,
      signer: options.signer,
    });
    const submitted = await options.client.agent.submitWorkResults(task.itemId, signedSubmission);
    if (!isArtifactMaintenanceSubmissionResult(submitted.result)) {
      throw new Error("unexpected_artifact_maintenance_submission_result");
    }

    return {
      artifactKey: claimed.task.artifactKey,
      completed: true,
      itemId: task.itemId,
      runId: claimed.run.runId,
      taskId: claimed.task.taskId,
      taskType: claimed.task.taskType,
      workerId: options.workerId,
    };
  }

  return {
    idle: true,
    message:
      "no claimable artifact maintenance task remained by the time the agent attempted to claim one",
    workerId: options.workerId,
  };
}
