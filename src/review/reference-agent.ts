import { randomUUID } from "node:crypto";
import type { ScientificProtocolClient } from "../sdk/client.js";
import { ScientificProtocolApiError } from "../sdk/client.js";
import type {
  ClaimDetailResponse,
  ClaimWorkItemView,
  ReviewSubmissionView,
  ReviewTaskRunView,
  ReviewTaskView,
  SourceDetailResponse,
} from "../sdk/types.js";
import {
  type AgentRequestSigner,
  createSignedAgentRequest,
} from "../shared/agent-request-envelope.js";
import { decideSourceAutoPublication } from "../sources/canonicalize.js";
import { evaluateReviewTask, type ReviewTaskEvaluationInput } from "./evaluate.js";
import type { ClaimReviewState, ReviewTaskType } from "./types.js";

type ReviewAgentClient = Pick<
  ScientificProtocolClient,
  "getClaim" | "getClaimReview" | "getWorkItem" | "listWorkItems"
> &
  Partial<Pick<ScientificProtocolClient, "getReviewTask" | "getSource" | "listReviewTasks">> & {
    agent: Pick<
      ScientificProtocolClient["agent"],
      "claimWorkItem" | "heartbeatWorkItem" | "submitWorkResults"
    >;
  };

type ReviewTaskCandidate = {
  canClaim: boolean;
  claimId: string | null;
  createdAt: string;
  itemId: string;
  requiredCapabilities: string[];
  sourceId: string | null;
  taskId: string;
  taskType: ReviewTaskType;
};

export type ReferenceReviewAgentOptions = {
  actorAddress?: string;
  agentId: string;
  capabilities?: string[];
  client: ReviewAgentClient;
  limit?: number;
  signer: AgentRequestSigner;
  taskId?: string;
  taskType?: ReviewTaskType;
  workerId: string;
};

export type ReferenceReviewAgentRunResult = {
  claimId?: string;
  completed?: boolean;
  evaluation?: {
    confidenceBps: number;
    summary: string;
    verdict: string;
  };
  idle?: boolean;
  message?: string;
  runId?: string;
  sourceId?: string;
  submissionId?: string;
  taskId?: string;
  taskType?: ReviewTaskType;
  workerId: string;
};

type SourcePreview = {
  candidateStatements: string[];
  extractedTextPreview: string;
  methodology: string;
  scope: string;
  statement: string;
  title: string;
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

export function taskMatchesCapabilities(
  task: Pick<ReviewTaskCandidate, "requiredCapabilities">,
  capabilities?: string[],
): boolean {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.length === 0) {
    return true;
  }
  const capabilitySet = new Set(normalized);
  return task.requiredCapabilities.every((capability) => capabilitySet.has(capability));
}

export function selectReviewTaskForAgent(
  tasks: ReviewTaskCandidate[],
  options: {
    capabilities?: string[];
    taskId?: string;
  } = {},
): ReviewTaskCandidate | null {
  const matching = tasks
    .filter((task) => task.canClaim)
    .filter((task) => !options.taskId || task.taskId === options.taskId)
    .filter((task) => taskMatchesCapabilities(task, options.capabilities))
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }
      return left.taskId.localeCompare(right.taskId);
    });
  return matching[0] ?? null;
}

function toReviewTaskCandidate(item: ClaimWorkItemView): ReviewTaskCandidate | null {
  if (item.kind !== "review_task") {
    return null;
  }
  return {
    canClaim: item.orchestration.canClaim,
    claimId: item.claimId,
    createdAt: item.createdAt,
    itemId: item.itemId,
    requiredCapabilities: item.policy?.requiredCapabilities ?? [],
    sourceId: null,
    taskId: item.itemId.startsWith("review-task:")
      ? item.itemId.slice("review-task:".length)
      : item.itemId,
    taskType: item.sourceType as ReviewTaskType,
  };
}

function toReviewTaskCandidateFromTask(task: ReviewTaskView): ReviewTaskCandidate {
  return {
    canClaim: task.status === "open",
    claimId: task.claimId ?? null,
    createdAt: task.createdAt,
    itemId: `review-task:${task.taskId}`,
    requiredCapabilities: task.requiredCapabilities,
    sourceId: task.sourceId ?? null,
    taskId: task.taskId,
    taskType: task.taskType,
  };
}

function isReviewTaskClaimResult(result: unknown): result is {
  run: ReviewTaskRunView;
  task: ReviewTaskView;
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
    typeof task.taskType === "string"
  );
}

function isReviewTaskSubmissionResult(result: unknown): result is {
  submission: ReviewSubmissionView;
  task: ReviewTaskView;
} {
  if (!result || typeof result !== "object") {
    return false;
  }
  const value = result as Record<string, unknown>;
  const submission = value.submission as Record<string, unknown> | undefined;
  return !!submission && typeof submission.submissionId === "string";
}

function countSupportiveReplications(claim: ClaimDetailResponse): number {
  return (claim.replications ?? []).filter(
    (replication: { outcome?: number; resolutionStatus?: number }) =>
      replication.resolutionStatus === 1 ||
      replication.resolutionStatus === 2 ||
      replication.outcome === 1 ||
      replication.outcome === 2,
  ).length;
}

function buildEvaluationInput(
  claim: ClaimDetailResponse,
  reviewState: ClaimReviewState,
): ReviewTaskEvaluationInput {
  return {
    artifactTypes: (claim.artifacts ?? []).map((artifact: { artifactType?: unknown }) =>
      Number(artifact.artifactType),
    ),
    artifactsCount: claim.artifacts?.length ?? 0,
    challengeCount: claim.challenges?.length ?? 0,
    challengesOpen:
      claim.challenges?.filter(
        (challenge: { status?: number }) => challenge.status === 0 || challenge.status === 3,
      ).length ?? 0,
    claimStatus: claim.status,
    replicationCount: claim.replications?.length ?? 0,
    reviewState,
    supportiveReplications: countSupportiveReplications(claim),
  };
}

function readSourcePreview(source: SourceDetailResponse["source"]): SourcePreview {
  const raw =
    source.sourceMetadata.preview && typeof source.sourceMetadata.preview === "object"
      ? (source.sourceMetadata.preview as Record<string, unknown>)
      : {};
  const candidateStatements = Array.isArray(raw.candidateStatements)
    ? raw.candidateStatements
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  return {
    candidateStatements,
    extractedTextPreview:
      typeof raw.extractedTextPreview === "string" ? raw.extractedTextPreview.trim() : "",
    methodology: typeof raw.methodology === "string" ? raw.methodology.trim() : "",
    scope: typeof raw.scope === "string" ? raw.scope.trim() : "",
    statement: typeof raw.statement === "string" ? raw.statement.trim() : "",
    title: typeof raw.title === "string" ? raw.title.trim() : "",
  };
}

function buildSourceExtractionPayload(source: SourceDetailResponse, _task: ReviewTaskView) {
  const preview = readSourcePreview(source.source);
  const statement =
    preview.statement || preview.candidateStatements[0] || source.source.canonicalSourceKey;
  const scope =
    preview.scope ||
    `Atomic claim extracted from ${source.source.sourceMetadata.title ?? source.source.canonicalSourceKey}.`;
  const methodology =
    preview.methodology || "Automated extraction from the canonical source snapshot.";
  const anchors = [
    ...(preview.extractedTextPreview
      ? [
          {
            label: "source_preview",
            text: preview.extractedTextPreview.slice(0, 280),
          },
        ]
      : []),
    ...(preview.title
      ? [
          {
            label: "source_title",
            text: preview.title,
          },
        ]
      : []),
  ];
  return {
    confidenceBps: statement === source.source.canonicalSourceKey ? 6_800 : 7_200,
    dimensions: {},
    issues: [],
    payload: {
      candidateClaim: {
        anchors,
        claimType: "general",
        methodology,
        scope,
        statement,
      },
    },
    summary: `Proposed atomic claim extracted from source ${source.source.sourceId}.`,
    verdict: "pass" as const,
  };
}

function buildSourceSynthesisPayload(source: SourceDetailResponse) {
  const decision = decideSourceAutoPublication(source.candidates);
  return {
    confidenceBps:
      decision.winningCluster?.averageConfidenceBps ??
      (source.candidates.length > 0 ? 6_500 : 5_500),
    dimensions: {},
    issues: [],
    payload: decision.winningCluster
      ? {
          candidateClaim: {
            anchors: [],
            claimType: decision.winningCluster.clusterKey.split("|")[2] ?? "general",
            methodology: decision.winningCluster.methodology,
            scope: decision.winningCluster.scope,
            statement: decision.winningCluster.statement,
          },
          synthesisDecision: {
            competingStrengthRatio: decision.competingStrengthRatio,
            reason: decision.reason,
            shouldPublish: decision.shouldPublish,
          },
        }
      : {
          synthesisDecision: {
            competingStrengthRatio: decision.competingStrengthRatio,
            reason: decision.reason,
            shouldPublish: decision.shouldPublish,
          },
        },
    summary: decision.reason,
    verdict: decision.shouldPublish ? ("pass" as const) : ("inconclusive" as const),
  };
}

async function listCandidateTasks(
  client: ReviewAgentClient,
  options: Pick<ReferenceReviewAgentOptions, "limit" | "taskId" | "taskType">,
): Promise<ReviewTaskCandidate[]> {
  if (options.taskId) {
    if (client.getReviewTask) {
      const detail = await client.getReviewTask(options.taskId);
      return detail.task ? [toReviewTaskCandidateFromTask(detail.task)] : [];
    }
    const detail = await client.getWorkItem(`review-task:${options.taskId}`);
    return detail.item
      ? [detail.item].map(toReviewTaskCandidate).filter((task) => task !== null)
      : [];
  }

  if (
    options.taskType === "claim_extraction_check" ||
    options.taskType === "claim_extraction_synthesis_check"
  ) {
    if (!client.listReviewTasks) {
      throw new Error("source_backed_review_tasks_require_listReviewTasks");
    }
    const page = await client.listReviewTasks({
      limit: options.limit ?? 20,
      offset: 0,
      status: "open",
      taskType: options.taskType,
    });
    return page.items.map(toReviewTaskCandidateFromTask);
  }

  const page = await client.listWorkItems({
    kind: "review_task",
    limit: options.limit ?? 20,
    offset: 0,
    status: "open",
  });
  return page.items
    .map(toReviewTaskCandidate)
    .filter(
      (task): task is ReviewTaskCandidate =>
        task !== null && (options.taskType === undefined || task.taskType === options.taskType),
    );
}

function isClaimConflict(error: unknown): boolean {
  return error instanceof ScientificProtocolApiError && error.status === 409;
}

async function claimTask(
  input: Pick<ReferenceReviewAgentOptions, "actorAddress" | "agentId" | "client" | "signer"> & {
    task: ReviewTaskCandidate;
    workerId: string;
  },
): Promise<{ run: ReviewTaskRunView; task: ReviewTaskView }> {
  const signedClaim = await createSignedAgentRequest({
    actionType: "review_task_claim",
    actorAddress: input.actorAddress,
    agentId: input.agentId,
    payload: {
      workerId: input.workerId,
    },
    requestNonce: randomUUID(),
    scopeKey: `review-task:${input.task.taskId}`,
    signer: input.signer,
  });
  const claimed = await input.client.agent.claimWorkItem(input.task.itemId, signedClaim);
  if (!isReviewTaskClaimResult(claimed.result)) {
    throw new Error("unexpected_review_work_claim_result");
  }
  return claimed.result;
}

async function heartbeatClaimedReviewRun(
  input: Pick<ReferenceReviewAgentOptions, "actorAddress" | "agentId" | "client" | "signer"> & {
    runId: string;
    taskId: string;
    workerId: string;
  },
): Promise<void> {
  const signedHeartbeat = await createSignedAgentRequest({
    actionType: "review_task_heartbeat",
    actorAddress: input.actorAddress,
    agentId: input.agentId,
    payload: {
      runId: input.runId,
      workerId: input.workerId,
    },
    requestNonce: randomUUID(),
    scopeKey: `review-task:${input.taskId}`,
    signer: input.signer,
  });
  await input.client.agent.heartbeatWorkItem(`review-task:${input.taskId}`, signedHeartbeat);
}

export async function runReferenceReviewAgentOnce(
  options: ReferenceReviewAgentOptions,
): Promise<ReferenceReviewAgentRunResult> {
  const tasks = await listCandidateTasks(options.client, options);
  const compatibleTasks = options.taskId
    ? tasks
    : tasks.filter((task) => taskMatchesCapabilities(task, options.capabilities));

  if (compatibleTasks.length === 0) {
    return {
      idle: true,
      message:
        options.taskId && tasks.length > 0
          ? "requested review task is not compatible with this agent configuration"
          : "no compatible open review task available",
      workerId: options.workerId,
    };
  }

  const preferredTask =
    options.taskId !== undefined
      ? selectReviewTaskForAgent(tasks, {
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
    let claimed: { run: ReviewTaskRunView; task: ReviewTaskView };
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

    await heartbeatClaimedReviewRun({
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      client: options.client,
      runId: claimed.run.runId,
      signer: options.signer,
      taskId: claimed.task.taskId,
      workerId: options.workerId,
    });

    const evaluation = claimed.task.claimId
      ? (() => {
          const claimId = claimed.task.claimId;
          return options.client.getClaim(claimId, { view: "full" }).then(async (claim) => {
            const reviewState = claim.review ?? (await options.client.getClaimReview(claimId));
            const base = evaluateReviewTask(claimed.task, buildEvaluationInput(claim, reviewState));
            return {
              ...base,
              payload: {},
            };
          });
        })()
      : claimed.task.sourceId
        ? (() => {
            if (!options.client.getSource) {
              throw new Error("source_backed_review_tasks_require_getSource");
            }
            return options.client.getSource(claimed.task.sourceId).then((source) => {
              if (claimed.task.taskType === "claim_extraction_check") {
                return buildSourceExtractionPayload(source, claimed.task);
              }
              if (claimed.task.taskType === "claim_extraction_synthesis_check") {
                return buildSourceSynthesisPayload(source);
              }
              throw new Error(
                `source_backed_review_task_type_not_supported:${claimed.task.taskType}`,
              );
            });
          })()
        : Promise.reject(new Error("review_task_missing_subject"));
    const resolvedEvaluation = await evaluation;
    const signedSubmission = await createSignedAgentRequest({
      actionType: "review_task_submission",
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      payload: {
        confidenceBps: resolvedEvaluation.confidenceBps,
        dimensions: resolvedEvaluation.dimensions,
        issues: resolvedEvaluation.issues,
        ...(resolvedEvaluation.payload ?? {}),
        referenceAgent: "reference-review-api-agent",
        runId: claimed.run.runId,
        summary: resolvedEvaluation.summary,
        verdict: resolvedEvaluation.verdict,
        workerId: options.workerId,
      },
      requestNonce: randomUUID(),
      scopeKey: `review-task:${claimed.task.taskId}`,
      signer: options.signer,
    });
    const submitted = await options.client.agent.submitWorkResults(
      `review-task:${claimed.task.taskId}`,
      signedSubmission,
    );
    if (!isReviewTaskSubmissionResult(submitted.result)) {
      throw new Error("unexpected_review_work_submission_result");
    }

    return {
      claimId: claimed.task.claimId ?? undefined,
      completed: true,
      evaluation: {
        confidenceBps: resolvedEvaluation.confidenceBps,
        summary: resolvedEvaluation.summary,
        verdict: resolvedEvaluation.verdict,
      },
      runId: claimed.run.runId,
      sourceId: claimed.task.sourceId ?? undefined,
      submissionId: submitted.result.submission.submissionId,
      taskId: claimed.task.taskId,
      taskType: claimed.task.taskType,
      workerId: options.workerId,
    };
  }

  return {
    idle: true,
    message: "no claimable review task remained by the time the agent attempted to claim one",
    workerId: options.workerId,
  };
}
