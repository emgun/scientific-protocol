import {
  type ReferenceArtifactMaintenanceAgentResult,
  runReferenceArtifactMaintenanceAgentOnce,
} from "../artifacts/reference-agent.js";
import {
  type ReferenceReplicationAgentRunResult,
  runReferenceReplicationAgentOnce,
} from "../coordinator/reference-agent.js";
import type { ArtifactMaintenanceTaskType } from "../coordinator/store.js";
import {
  type ReferenceReviewAgentRunResult,
  runReferenceReviewAgentOnce,
} from "../review/reference-agent.js";
import type { ReviewTaskType } from "../review/types.js";
import type { ScientificProtocolClient } from "../sdk/client.js";
import type { ClaimWorkItemView } from "../sdk/types.js";
import type { AgentRequestSigner } from "../shared/agent-request-envelope.js";
import type { ArtifactPersistenceOptions } from "../shared/persisted-artifacts.js";
import { compareClaimWorkItemsForSelection } from "./selection.js";

type WorkAgentClient = Pick<
  ScientificProtocolClient,
  "getClaim" | "getClaimReview" | "getPersistedArtifact" | "getWorkItem" | "listWorkItems"
> & {
  agent: Pick<
    ScientificProtocolClient["agent"],
    "claimWorkItem" | "heartbeatWorkItem" | "submitWorkResults"
  >;
};

export type ReferenceWorkAgentOptions = {
  actorAddress?: string;
  agentId: string;
  capabilities?: string[];
  claimId?: string;
  client: WorkAgentClient;
  kinds?: ClaimWorkItemView["kind"][];
  limit?: number;
  persistence?: ArtifactPersistenceOptions;
  signer: AgentRequestSigner;
  sourceId?: string;
  taskId?: string;
  workerId: string;
  workItemId?: string;
};

export type ReferenceWorkAgentRunResult = {
  completed?: boolean;
  idle?: boolean;
  itemId?: string;
  kind?: ClaimWorkItemView["kind"];
  message?: string;
  result?:
    | ReferenceArtifactMaintenanceAgentResult
    | ReferenceReplicationAgentRunResult
    | ReferenceReviewAgentRunResult;
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

function itemMatchesCapabilities(item: ClaimWorkItemView, capabilities?: string[]): boolean {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.length === 0) {
    return true;
  }
  const capabilitySet = new Set(normalized);
  return (item.policy?.requiredCapabilities ?? []).every((capability: string) =>
    capabilitySet.has(capability),
  );
}

function agentCanAdvanceWorkItem(item: ClaimWorkItemView, agentId?: string): boolean {
  if (!agentId || item.policy?.requireDistinctAgents !== true) {
    return true;
  }
  return !item.runs.some(
    (run: { agentId?: string; status?: string }) =>
      run.agentId === agentId && (run.status === "completed" || run.status === "running"),
  );
}

function isSupportedKind(kind: ClaimWorkItemView["kind"]): boolean {
  return kind === "artifact_maintenance" || kind === "replication_job" || kind === "review_task";
}

export function selectWorkItemForAgent(
  items: ClaimWorkItemView[],
  options: {
    agentId?: string;
    capabilities?: string[];
    kinds?: ClaimWorkItemView["kind"][];
    workItemId?: string;
  } = {},
): ClaimWorkItemView | null {
  const allowedKinds = options.kinds?.length ? new Set(options.kinds) : null;
  const matching = items
    .filter((item) => item.scheduling.autoClaimable)
    .filter((item) => isSupportedKind(item.kind))
    .filter((item) => (allowedKinds ? allowedKinds.has(item.kind) : true))
    .filter((item) => !options.workItemId || item.itemId === options.workItemId)
    .filter((item) => itemMatchesCapabilities(item, options.capabilities))
    .filter((item) => agentCanAdvanceWorkItem(item, options.agentId))
    .sort(compareClaimWorkItemsForSelection);
  return matching[0] ?? null;
}

export async function runReferenceWorkAgentOnce(
  options: ReferenceWorkAgentOptions,
): Promise<ReferenceWorkAgentRunResult> {
  const query = options.workItemId
    ? undefined
    : {
        claimId: options.claimId,
        claimable: true,
        limit: options.limit ?? 20,
        offset: 0,
        sourceId: options.sourceId,
        status: "open" as const,
      };
  const items = options.workItemId
    ? [
        await options.client
          .getWorkItem(options.workItemId, { claimId: options.claimId })
          .then((detail) => detail.item),
      ]
    : (await options.client.listWorkItems(query)).items;

  const selected = selectWorkItemForAgent(
    items.filter((item): item is ClaimWorkItemView => item !== undefined),
    {
      agentId: options.agentId,
      capabilities: options.capabilities,
      kinds: options.kinds,
      workItemId: options.workItemId,
    },
  );

  if (!selected) {
    return {
      idle: true,
      message:
        options.workItemId && items.length > 0
          ? "requested work item is not compatible with this agent configuration"
          : "no compatible open work item available",
      workerId: options.workerId,
    };
  }

  if (selected.kind === "review_task") {
    const result = await runReferenceReviewAgentOnce({
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      capabilities: options.capabilities,
      client: options.client,
      limit: options.limit,
      signer: options.signer,
      taskId: selected.itemId.slice("review-task:".length),
      taskType: selected.sourceType as ReviewTaskType,
      workerId: options.workerId,
    });
    return {
      completed: result.completed,
      idle: result.idle,
      itemId: selected.itemId,
      kind: selected.kind,
      message: result.message,
      result,
      workerId: options.workerId,
    };
  }

  if (selected.kind === "replication_job") {
    const result = await runReferenceReplicationAgentOnce({
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      capabilities: options.capabilities,
      client: options.client,
      jobId: selected.itemId.slice("replication-job:".length),
      limit: options.limit,
      signer: options.signer,
      workerId: options.workerId,
    });
    return {
      completed: result.completed,
      idle: result.idle,
      itemId: selected.itemId,
      kind: selected.kind,
      message: result.message,
      result,
      workerId: options.workerId,
    };
  }

  const result = await runReferenceArtifactMaintenanceAgentOnce({
    actorAddress: options.actorAddress,
    agentId: options.agentId,
    capabilities: options.capabilities,
    client: options.client,
    limit: options.limit,
    persistence: options.persistence,
    signer: options.signer,
    taskId: selected.itemId.slice("artifact-maintenance:".length),
    taskType: selected.sourceType as ArtifactMaintenanceTaskType,
    workerId: options.workerId,
  });
  return {
    completed: result.completed,
    idle: result.idle,
    itemId: selected.itemId,
    kind: selected.kind,
    message: result.message,
    result,
    workerId: options.workerId,
  };
}
