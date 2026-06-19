import type { CheckpointPublicationView } from "../checkpoints/store.js";
import type { AgentRequestView } from "../shared/agent-requests.js";
import type { ClaimWorkItemView } from "../work/types.js";

export const AGENT_RUNTIME_EVENT_TYPES = [
  "agent_request.accepted",
  "agent_request.rejected",
  "checkpoint_publication.failed",
  "checkpoint_publication.prepared",
  "checkpoint_publication.submitted",
  "work_item.claimable",
  "work_item.updated",
] as const;

export type AgentRuntimeEventType = (typeof AGENT_RUNTIME_EVENT_TYPES)[number];

export type AgentRuntimeEventView = {
  agentIds: string[];
  claimId: string | null;
  eventId: string;
  eventType: AgentRuntimeEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
  scopeKey: string | null;
  summary: string;
  title: string;
};

type AgentRuntimeEventPage = {
  items: AgentRuntimeEventView[];
  limit: number;
  offset: number;
  total: number;
};

function uniqueAgentIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && value !== "0"))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function titleCase(input: string): string {
  return input
    .replaceAll("_", " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function buildWorkItemEvent(item: ClaimWorkItemView): AgentRuntimeEventView {
  const occurredAt = item.updatedAt ?? item.createdAt;
  const agentIds = uniqueAgentIds([
    item.activeRun?.agentId ?? null,
    ...item.runs.map((run) => run.agentId),
  ]);
  const eventType: AgentRuntimeEventType = item.orchestration.canClaim
    ? "work_item.claimable"
    : "work_item.updated";
  const routingReason = item.routing.rationale[0] ?? item.orchestration.statusReason;
  return {
    agentIds,
    claimId: item.claimId,
    eventId: `work-item:${item.itemId}:${occurredAt}:${eventType}`,
    eventType,
    occurredAt,
    payload: {
      claimable: item.orchestration.canClaim,
      itemId: item.itemId,
      kind: item.kind,
      lane: item.lane,
      priorityBps: item.routing.priorityBps,
      rationale: item.routing.rationale,
      recommendedAction: item.orchestration.recommendedAction,
      status: item.status,
      statusReason: item.orchestration.statusReason,
      tier: item.routing.tier,
    },
    scopeKey: item.scopeKey,
    summary: item.orchestration.canClaim
      ? `${titleCase(item.kind)} is claimable. ${routingReason}`
      : `${titleCase(item.kind)} is ${item.status}. ${routingReason}`,
    title: item.title,
  };
}

function buildAgentRequestEvent(request: AgentRequestView): AgentRuntimeEventView {
  return {
    agentIds: uniqueAgentIds([request.agentId]),
    claimId:
      typeof request.payload.claimId === "string" && request.payload.claimId.length > 0
        ? request.payload.claimId
        : null,
    eventId: `agent-request:${request.requestId}:${request.status}`,
    eventType: `agent_request.${request.status}` as AgentRuntimeEventType,
    occurredAt: request.updatedAt,
    payload: {
      actionType: request.actionType,
      actorAddress: request.actorAddress,
      outcomeDetail: request.outcomeDetail,
      payload: request.payload,
      requestId: request.requestId,
      status: request.status,
    },
    scopeKey: request.scopeKey,
    summary: request.outcomeDetail ?? `${titleCase(request.actionType)} ${request.status}.`,
    title: titleCase(request.actionType),
  };
}

function buildCheckpointPublicationEvent(
  publication: CheckpointPublicationView,
): AgentRuntimeEventView | null {
  const agentIds = uniqueAgentIds([publication.subjectAgentId]);
  if (agentIds.length === 0) {
    return null;
  }
  const occurredAt = publication.publishedAt ?? publication.updatedAt;
  const eventType = `checkpoint_publication.${publication.status}` as AgentRuntimeEventType;
  return {
    agentIds,
    claimId: null,
    eventId: `checkpoint-publication:${publication.publicationId}:${publication.status}`,
    eventType,
    occurredAt,
    payload: {
      checkpointId: publication.checkpointId,
      domainId: publication.domainId,
      failureReason: publication.failureReason,
      payloadId: publication.payloadId,
      publicationId: publication.publicationId,
      status: publication.status,
      subjectAgentId: publication.subjectAgentId,
      txHash: publication.txHash,
    },
    scopeKey: publication.requestId
      ? `checkpoint-publication:${publication.requestId}`
      : `checkpoint-publication:${publication.publicationId}`,
    summary:
      publication.status === "submitted"
        ? `Checkpoint publication ${publication.publicationId} was submitted for domain ${publication.domainId}.`
        : publication.status === "failed"
          ? `Checkpoint publication ${publication.publicationId} failed.`
          : `Checkpoint publication ${publication.publicationId} is prepared.`,
    title: `Checkpoint publication ${publication.status}`,
  };
}

export function buildAgentRuntimeEvents(input: {
  agentId?: string;
  checkpointPublications: CheckpointPublicationView[];
  claimId?: string;
  limit?: number;
  offset?: number;
  requests: AgentRequestView[];
  since?: string;
  workItems: ClaimWorkItemView[];
}): AgentRuntimeEventPage {
  const sinceTime =
    typeof input.since === "string" && input.since.length > 0
      ? new Date(input.since).getTime()
      : null;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const offset = Math.max(0, input.offset ?? 0);
  const candidateEvents = [
    ...input.workItems.map(buildWorkItemEvent),
    ...input.requests.map(buildAgentRequestEvent),
    ...input.checkpointPublications
      .map(buildCheckpointPublicationEvent)
      .filter((event): event is AgentRuntimeEventView => event !== null),
  ]
    .filter((event) => (input.claimId ? event.claimId === input.claimId : true))
    .filter((event) => (input.agentId ? event.agentIds.includes(input.agentId) : true))
    .filter((event) => {
      if (sinceTime === null) {
        return true;
      }
      return new Date(event.occurredAt).getTime() >= sinceTime;
    })
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return right.occurredAt.localeCompare(left.occurredAt);
      }
      return right.eventId.localeCompare(left.eventId);
    });

  return {
    items: candidateEvents.slice(offset, offset + limit),
    limit,
    offset,
    total: candidateEvents.length,
  };
}
