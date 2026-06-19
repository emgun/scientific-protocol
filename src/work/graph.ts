import type {
  ArtifactMaintenanceTaskRunView,
  ArtifactMaintenanceTaskView,
  ReplicationJobRunView,
  ReplicationJobView,
} from "../coordinator/store.js";
import type { ReviewSubmissionView, ReviewTaskRunView, ReviewTaskView } from "../review/types.js";
import { deriveClaimWorkOrchestration } from "./orchestration.js";
import {
  agentActionsForWorkItem,
  buildArtifactMaintenanceWorkPolicy,
  buildReplicationWorkPolicy,
  buildReviewWorkPolicy,
  laneForReviewTask,
} from "./policy.js";
import { deriveClaimWorkRouting } from "./routing.js";
import { deriveClaimWorkScheduling } from "./scheduling.js";
import type {
  BuildClaimWorkGraphInput,
  BuildSourceWorkGraphInput,
  ClaimWorkGraphView,
  ClaimWorkItemView,
  ClaimWorkResultView,
  ClaimWorkRunView,
  ClaimWorkSubjectView,
  SourceWorkGraphView,
} from "./types.js";

function titleCase(input: string): string {
  return input
    .replaceAll("_", " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left);
  if (timestamps.length === 0) {
    return null;
  }
  return new Date(timestamps[0]).toISOString();
}

function shortKey(input: string, maxLength = 18): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, 8)}...${input.slice(-6)}`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    ),
  );
}

function subjectPriority(subjectType: ClaimWorkSubjectView["subjectType"]): number {
  if (subjectType === "claim" || subjectType === "source_record") {
    return 0;
  }
  if (subjectType === "claim_artifact") {
    return 1;
  }
  return 2;
}

function toReviewStatus(
  task: ReviewTaskView,
  runs: ClaimWorkRunView[],
): ClaimWorkItemView["status"] {
  if (runs.some((run) => run.status === "running")) {
    return "leased";
  }
  switch (task.status) {
    case "open":
      return "open";
    case "completed":
      return "completed";
    case "escalated":
      return "escalated";
    case "canceled":
      return "canceled";
  }
}

function toReplicationStatus(
  job: ReplicationJobView,
  runs: ClaimWorkRunView[],
): ClaimWorkItemView["status"] {
  if (runs.some((run) => run.status === "running")) {
    return "leased";
  }
  switch (job.status) {
    case "open":
      return "open";
    case "assigned":
      return "leased";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function toMaintenanceStatus(
  task: ArtifactMaintenanceTaskView,
  runs: ClaimWorkRunView[],
): ClaimWorkItemView["status"] {
  if (runs.some((run) => run.status === "running")) {
    return "leased";
  }
  switch (task.status) {
    case "open":
      return "open";
    case "assigned":
      return "leased";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

export function toClaimWorkRunView(
  run: ArtifactMaintenanceTaskRunView | ReplicationJobRunView | ReviewTaskRunView,
): ClaimWorkRunView {
  return {
    agentId: run.agentId ?? null,
    failureReason: run.failureReason ?? null,
    finishedAt: run.finishedAt ?? null,
    lastHeartbeatAt: run.lastHeartbeatAt ?? null,
    runId: run.runId,
    startedAt: run.startedAt,
    status: run.status,
    workerId: run.workerId,
  };
}

export function toReviewSubmissionResult(submission: ReviewSubmissionView): ClaimWorkResultView {
  return {
    artifactKey: submission.resultArtifactKey ?? submission.evidenceArtifactKey ?? null,
    confidenceBps: submission.confidenceBps,
    createdAt: submission.createdAt,
    label: titleCase(submission.verdict),
    summary:
      typeof submission.payload.summary === "string" && submission.payload.summary.length > 0
        ? submission.payload.summary
        : `${titleCase(submission.reviewType)} returned ${submission.verdict}.`,
    type: "review_submission",
    verdict: submission.verdict,
  };
}

export function collectClaimWorkArtifactKeys(input: {
  artifactMaintenanceTasks?: ArtifactMaintenanceTaskView[];
  derivedResults?: ClaimWorkResultView[];
  replicationJobs?: ReplicationJobView[];
  reviewSubmissions?: ReviewSubmissionView[];
  reviewTasks?: ReviewTaskView[];
}): string[] {
  return uniqueStrings([
    ...(input.reviewTasks ?? []).flatMap((task) => [
      task.resultArtifactKey ?? null,
      ...task.inputArtifactKeys,
    ]),
    ...(input.reviewSubmissions ?? []).flatMap((submission) => [
      submission.resultArtifactKey,
      submission.evidenceArtifactKey,
    ]),
    ...(input.derivedResults ?? []).map((result) => result.artifactKey),
    ...(input.replicationJobs ?? []).map((job) => job.resultArtifactKey),
    ...(input.artifactMaintenanceTasks ?? []).flatMap((task) => [
      task.artifactKey,
      task.resultArtifactKey,
    ]),
  ]);
}

function activeRun(runs: ClaimWorkRunView[]): ClaimWorkRunView | null {
  const running = runs
    .filter((run) => run.status === "running")
    .sort((left, right) => {
      const leftTs = left.lastHeartbeatAt ?? left.startedAt;
      const rightTs = right.lastHeartbeatAt ?? right.startedAt;
      return rightTs.localeCompare(leftTs);
    });
  return running[0] ?? null;
}

function reviewResult(
  task: ReviewTaskView,
  results: ClaimWorkResultView[],
  submissions: ReviewSubmissionView[],
): ClaimWorkResultView | null {
  const latest = [...results].sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
  )[0];
  if (latest) {
    return latest;
  }
  if (task.status === "completed") {
    return {
      artifactKey: task.resultArtifactKey,
      confidenceBps: null,
      createdAt: task.completedAt ?? task.updatedAt,
      label: "Completed",
      summary: "Consensus threshold was reached without a retained latest submission payload.",
      type: "review_submission",
      verdict: null,
    };
  }
  if (submissions.length > 0) {
    const recent = [...submissions].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0];
    return toReviewSubmissionResult(recent);
  }
  return null;
}

function replicationResult(job: ReplicationJobView): ClaimWorkResultView | null {
  if (job.status !== "completed") {
    return null;
  }
  return {
    artifactKey: job.resultArtifactKey,
    confidenceBps: null,
    createdAt: job.completedAt ?? job.updatedAt,
    label: job.onchainReplicationId
      ? `Replication ${job.onchainReplicationId}`
      : "Replication completed",
    summary: job.onchainReplicationId
      ? `Replication ${job.onchainReplicationId} was posted for claim ${job.claimId}.`
      : "The replication job completed and persisted a result artifact.",
    type: "replication_result",
    verdict: "completed",
  };
}

function maintenanceResult(task: ArtifactMaintenanceTaskView): ClaimWorkResultView | null {
  if (task.status !== "completed") {
    return null;
  }
  return {
    artifactKey: task.resultArtifactKey,
    confidenceBps: null,
    createdAt: task.completedAt ?? task.updatedAt,
    label: task.taskType === "repair" ? "Repair completed" : "Audit completed",
    summary:
      task.taskType === "repair"
        ? `Repair completed for artifact ${shortKey(task.artifactKey)}.`
        : `Audit report recorded for artifact ${shortKey(task.artifactKey)}.`,
    type: "artifact_report",
    verdict: task.taskType,
  };
}

function finalizeWorkItems(
  subjects: Map<string, ClaimWorkSubjectView>,
  items: Array<Omit<ClaimWorkItemView, "routing" | "scheduling">>,
): {
  items: ClaimWorkItemView[];
  subjects: ClaimWorkSubjectView[];
  summary: ClaimWorkGraphView["summary"];
} {
  const itemsWithRouting: Array<Omit<ClaimWorkItemView, "scheduling">> = items.map((item) => {
    const routing = deriveClaimWorkRouting(item, items);
    return {
      ...item,
      routing,
    };
  });

  const itemsWithScheduling: ClaimWorkItemView[] = itemsWithRouting.map((item) => ({
    ...item,
    scheduling: deriveClaimWorkScheduling(item, itemsWithRouting),
  }));

  itemsWithScheduling.sort((left, right) => {
    const leftUpdated = left.updatedAt ?? left.createdAt;
    const rightUpdated = right.updatedAt ?? right.createdAt;
    if (leftUpdated !== rightUpdated) {
      return rightUpdated.localeCompare(leftUpdated);
    }
    return left.itemId.localeCompare(right.itemId);
  });

  const participatingAgents = new Set(
    itemsWithScheduling
      .flatMap((item) => item.runs)
      .map((run) => run.agentId)
      .filter((agentId): agentId is string => typeof agentId === "string" && agentId.length > 0),
  );

  return {
    items: itemsWithScheduling,
    subjects: [...subjects.values()].sort((left, right) => {
      const leftPriority = subjectPriority(left.subjectType);
      const rightPriority = subjectPriority(right.subjectType);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.subjectId.localeCompare(right.subjectId);
    }),
    summary: {
      activeLeases: itemsWithScheduling.filter((item) => item.status === "leased").length,
      autoClaimableItems: itemsWithScheduling.filter((item) => item.scheduling.autoClaimable)
        .length,
      completedItems: itemsWithScheduling.filter((item) => item.status === "completed").length,
      dependencyBlockedItems: itemsWithScheduling.filter(
        (item) => item.scheduling.blocker === "dependency_blocked",
      ).length,
      failedItems: itemsWithScheduling.filter((item) => item.status === "failed").length,
      freshContributorItems: itemsWithScheduling.filter(
        (item) => item.scheduling.prefersFreshContributor,
      ).length,
      latestActivityAt: latestTimestamp([
        ...itemsWithScheduling.flatMap((item) => [
          item.updatedAt,
          item.completedAt,
          item.result?.createdAt ?? null,
          ...item.runs.flatMap((run) => [run.lastHeartbeatAt, run.finishedAt, run.startedAt]),
        ]),
      ]),
      minimumCoverageItems: itemsWithScheduling.filter(
        (item) => item.scheduling.needsMinimumCoverage,
      ).length,
      openItems: itemsWithScheduling.filter((item) => item.status === "open").length,
      participatingAgents: participatingAgents.size,
      reassignmentReadyItems: itemsWithScheduling.filter(
        (item) => item.scheduling.reassignmentPreferred,
      ).length,
      redundancyTargetItems: itemsWithScheduling.filter(
        (item) => item.scheduling.needsRedundantCoverage,
      ).length,
      totalItems: itemsWithScheduling.length,
      uncoveredDemand: itemsWithScheduling.reduce(
        (sum, item) => sum + item.scheduling.desiredAdditionalClaims,
        0,
      ),
      lanes: {
        evaluation: itemsWithScheduling.filter((item) => item.lane === "evaluation").length,
        execution: itemsWithScheduling.filter((item) => item.lane === "execution").length,
        maintenance: itemsWithScheduling.filter((item) => item.lane === "maintenance").length,
        synthesis: itemsWithScheduling.filter((item) => item.lane === "synthesis").length,
      },
    },
  };
}

function sourceLabel(source: BuildSourceWorkGraphInput["source"]): string {
  const title = source.sourceMetadata.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim();
  }
  return source.canonicalSourceKey;
}

export function buildClaimWorkGraph(input: BuildClaimWorkGraphInput): ClaimWorkGraphView {
  const subjects = new Map<string, ClaimWorkSubjectView>();
  const edges: ClaimWorkGraphView["edges"] = [];

  const claimSubjectId = `claim:${input.claimId}`;
  subjects.set(claimSubjectId, {
    href: `/claims/${encodeURIComponent(input.claimId)}/view`,
    label: `Claim ${input.claimId}`,
    subjectId: claimSubjectId,
    subjectType: "claim",
  });

  for (const artifact of input.artifacts) {
    const subjectId = `claim-artifact:${artifact.artifactId}`;
    subjects.set(subjectId, {
      href: artifact.uri,
      label: `Artifact ${artifact.artifactId}`,
      subjectId,
      subjectType: "claim_artifact",
    });
    edges.push({
      fromId: claimSubjectId,
      relation: "attaches",
      toId: subjectId,
    });
  }

  for (const artifactKey of collectClaimWorkArtifactKeys({
    artifactMaintenanceTasks: input.artifactMaintenanceTasks,
    reviewSubmissions: Object.values(input.reviewSubmissionsByTaskId).flat(),
    replicationJobs: input.replicationJobs,
    reviewTasks: input.reviewTasks,
  })) {
    const subjectId = `persisted-artifact:${artifactKey}`;
    if (subjects.has(subjectId)) {
      continue;
    }
    subjects.set(subjectId, {
      href: `/persisted-artifacts/${encodeURIComponent(artifactKey)}/view`,
      label: `Persisted ${shortKey(artifactKey)}`,
      subjectId,
      subjectType: "persisted_artifact",
    });
  }

  const items: Array<Omit<ClaimWorkItemView, "routing" | "scheduling">> = [];

  for (const task of input.reviewTasks) {
    const itemId = `review-task:${task.taskId}`;
    const runs = input.reviewRunsByTaskId[task.taskId] ?? [];
    const taskSubmissions = input.reviewSubmissionsByTaskId[task.taskId] ?? [];
    const taskResults = taskSubmissions.map(toReviewSubmissionResult);
    const latestResult = reviewResult(task, taskResults, taskSubmissions);
    const agentActions = agentActionsForWorkItem({
      kind: "review_task",
      sourceType: task.taskType,
    });
    const lane = laneForReviewTask(task.taskType);
    const policy = buildReviewWorkPolicy(task);
    const status = toReviewStatus(task, runs);
    const reviewItemBase = {
      activeRun: activeRun(runs),
      agentActions,
      claimId: input.claimId,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      description:
        task.taskType === "certification_synthesis_check"
          ? "Synthesizes current claim evidence into certification state."
          : `Typed agent evaluation for ${titleCase(task.taskType)}.`,
      itemId,
      kind: "review_task",
      lane,
      policy,
      relatedArtifactKeys: uniqueStrings([
        ...task.inputArtifactKeys,
        task.resultArtifactKey ?? null,
        latestResult?.artifactKey ?? null,
      ]),
      result: latestResult,
      runs,
      scopeKey: task.scopeKey,
      sourceType: task.taskType,
      status,
      subjectId: claimSubjectId,
      title: titleCase(task.taskType),
      updatedAt: task.updatedAt,
    } satisfies Omit<ClaimWorkItemView, "orchestration" | "routing" | "scheduling">;
    items.push({
      ...reviewItemBase,
      orchestration: deriveClaimWorkOrchestration({
        agentActions,
        kind: reviewItemBase.kind,
        lane,
        policy,
        runs,
        status,
        successfulContributorAgentIds: taskSubmissions
          .map((submission) => submission.reviewerAgentId ?? "")
          .filter((agentId) => agentId.length > 0),
        successfulContributionCount: taskSubmissions.length,
      }),
    });
    edges.push({ fromId: claimSubjectId, relation: "evaluates", toId: itemId });
    for (const artifactKey of task.inputArtifactKeys) {
      edges.push({
        fromId: `persisted-artifact:${artifactKey}`,
        relation: "input",
        toId: itemId,
      });
    }
    if (latestResult?.artifactKey) {
      edges.push({
        fromId: itemId,
        relation: "produces",
        toId: `persisted-artifact:${latestResult.artifactKey}`,
      });
    }
  }

  for (const job of input.replicationJobs) {
    const itemId = `replication-job:${job.jobId}`;
    const runs = input.replicationRunsByJobId[job.jobId] ?? [];
    const result = replicationResult(job);
    const agentActions = agentActionsForWorkItem({
      kind: "replication_job",
      sourceType: "replication_job",
    });
    const policy = buildReplicationWorkPolicy(job);
    const status = toReplicationStatus(job, runs);
    const replicationItemBase = {
      activeRun: activeRun(runs),
      agentActions,
      claimId: input.claimId,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      description:
        "Offchain replication brief that can produce a typed scientific replication record.",
      itemId,
      kind: "replication_job",
      lane: "execution",
      policy,
      relatedArtifactKeys: uniqueStrings([job.resultArtifactKey]),
      result,
      runs,
      scopeKey: `replication-job:${job.jobId}`,
      sourceType: "replication_job",
      status,
      subjectId: claimSubjectId,
      title: `Replication Job ${job.jobId}`,
      updatedAt: job.updatedAt,
    } satisfies Omit<ClaimWorkItemView, "orchestration" | "routing" | "scheduling">;
    items.push({
      ...replicationItemBase,
      orchestration: deriveClaimWorkOrchestration({
        agentActions,
        kind: replicationItemBase.kind,
        lane: replicationItemBase.lane,
        policy,
        runs,
        status,
        successfulContributorAgentIds: runs
          .filter((run) => run.status === "completed")
          .map((run) => run.agentId ?? "")
          .filter((agentId) => agentId.length > 0),
        successfulContributionCount: result ? 1 : 0,
      }),
    });
    edges.push({ fromId: claimSubjectId, relation: "reruns", toId: itemId });
    if (result?.artifactKey) {
      edges.push({
        fromId: itemId,
        relation: "produces",
        toId: `persisted-artifact:${result.artifactKey}`,
      });
    }
  }

  for (const task of input.artifactMaintenanceTasks) {
    const itemId = `artifact-maintenance:${task.taskId}`;
    const runs = input.artifactMaintenanceRunsByTaskId[task.taskId] ?? [];
    const subjectId = `persisted-artifact:${task.artifactKey}`;
    if (!subjects.has(subjectId)) {
      subjects.set(subjectId, {
        href: `/persisted-artifacts/${encodeURIComponent(task.artifactKey)}/view`,
        label: `Persisted ${shortKey(task.artifactKey)}`,
        subjectId,
        subjectType: "persisted_artifact",
      });
    }
    const result = maintenanceResult(task);
    const agentActions = agentActionsForWorkItem({
      kind: "artifact_maintenance",
      sourceType: task.taskType,
    });
    const policy = buildArtifactMaintenanceWorkPolicy(task);
    const status = toMaintenanceStatus(task, runs);
    const maintenanceItemBase = {
      activeRun: activeRun(runs),
      agentActions,
      claimId: input.claimId,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      description:
        task.taskType === "repair"
          ? "Repairs or re-pins a persisted artifact replica."
          : "Audits persisted artifact health across storage targets.",
      itemId,
      kind: "artifact_maintenance",
      lane: "maintenance",
      policy,
      relatedArtifactKeys: uniqueStrings([task.artifactKey, task.resultArtifactKey]),
      result,
      runs,
      scopeKey: task.targetReplicaKey ?? null,
      sourceType: task.taskType,
      status,
      subjectId,
      title: `${titleCase(task.taskType)} Artifact ${shortKey(task.artifactKey)}`,
      updatedAt: task.updatedAt,
    } satisfies Omit<ClaimWorkItemView, "orchestration" | "routing" | "scheduling">;
    items.push({
      ...maintenanceItemBase,
      orchestration: deriveClaimWorkOrchestration({
        agentActions,
        kind: maintenanceItemBase.kind,
        lane: maintenanceItemBase.lane,
        policy,
        runs,
        status,
        successfulContributorAgentIds: runs
          .filter((run) => run.status === "completed")
          .map((run) => run.agentId ?? "")
          .filter((agentId) => agentId.length > 0),
        successfulContributionCount: result ? 1 : 0,
      }),
    });
    edges.push({ fromId: subjectId, relation: "maintains", toId: itemId });
    if (result?.artifactKey) {
      edges.push({
        fromId: itemId,
        relation: "produces",
        toId: `persisted-artifact:${result.artifactKey}`,
      });
    }
  }

  const finalized = finalizeWorkItems(subjects, items);

  return {
    claimId: input.claimId,
    edges,
    items: finalized.items,
    subjects: finalized.subjects,
    summary: finalized.summary,
  };
}

export function buildSourceWorkGraph(input: BuildSourceWorkGraphInput): SourceWorkGraphView {
  const subjects = new Map<string, ClaimWorkSubjectView>();
  const edges: SourceWorkGraphView["edges"] = [];

  const sourceSubjectId = `source:${input.source.sourceId}`;
  subjects.set(sourceSubjectId, {
    href: `/sources/${encodeURIComponent(input.source.sourceId)}/view`,
    label: sourceLabel(input.source),
    subjectId: sourceSubjectId,
    subjectType: "source_record",
  });

  for (const artifactKey of uniqueStrings([
    input.source.snapshotArtifactKey,
    input.source.extractionArtifactKey,
    ...collectClaimWorkArtifactKeys({
      reviewSubmissions: Object.values(input.reviewSubmissionsByTaskId).flat(),
      reviewTasks: input.reviewTasks,
    }),
  ])) {
    const subjectId = `persisted-artifact:${artifactKey}`;
    if (subjects.has(subjectId)) {
      continue;
    }
    subjects.set(subjectId, {
      href: `/persisted-artifacts/${encodeURIComponent(artifactKey)}/view`,
      label: `Persisted ${shortKey(artifactKey)}`,
      subjectId,
      subjectType: "persisted_artifact",
    });
  }

  if (input.source.snapshotArtifactKey) {
    edges.push({
      fromId: sourceSubjectId,
      relation: "attaches",
      toId: `persisted-artifact:${input.source.snapshotArtifactKey}`,
    });
  }
  if (input.source.extractionArtifactKey) {
    edges.push({
      fromId: sourceSubjectId,
      relation: "attaches",
      toId: `persisted-artifact:${input.source.extractionArtifactKey}`,
    });
  }

  const items: Array<Omit<ClaimWorkItemView, "routing" | "scheduling">> = [];
  for (const task of input.reviewTasks) {
    const itemId = `review-task:${task.taskId}`;
    const runs = input.reviewRunsByTaskId[task.taskId] ?? [];
    const taskSubmissions = input.reviewSubmissionsByTaskId[task.taskId] ?? [];
    const taskResults = taskSubmissions.map(toReviewSubmissionResult);
    const latestResult = reviewResult(task, taskResults, taskSubmissions);
    const agentActions = agentActionsForWorkItem({
      kind: "review_task",
      sourceType: task.taskType,
    });
    const lane = laneForReviewTask(task.taskType);
    const policy = buildReviewWorkPolicy(task);
    const status = toReviewStatus(task, runs);
    const sourceItemBase = {
      activeRun: activeRun(runs),
      agentActions,
      claimId: null,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      description:
        task.taskType === "claim_extraction_synthesis_check"
          ? "Synthesizes competing extraction proposals into a publishable atomic claim candidate."
          : "Produces candidate atomic claims with source anchors, scope, and methodology.",
      itemId,
      kind: "review_task",
      lane,
      policy,
      relatedArtifactKeys: uniqueStrings([
        input.source.snapshotArtifactKey,
        input.source.extractionArtifactKey,
        ...task.inputArtifactKeys,
        task.resultArtifactKey ?? null,
        latestResult?.artifactKey ?? null,
      ]),
      result: latestResult,
      runs,
      scopeKey: task.scopeKey,
      sourceType: task.taskType,
      status,
      subjectId: sourceSubjectId,
      title: titleCase(task.taskType),
      updatedAt: task.updatedAt,
    } satisfies Omit<ClaimWorkItemView, "orchestration" | "routing" | "scheduling">;
    items.push({
      ...sourceItemBase,
      orchestration: deriveClaimWorkOrchestration({
        agentActions,
        kind: sourceItemBase.kind,
        lane,
        policy,
        runs,
        status,
        successfulContributorAgentIds: taskSubmissions
          .map((submission) => submission.reviewerAgentId ?? "")
          .filter((agentId) => agentId.length > 0),
        successfulContributionCount: taskSubmissions.length,
      }),
    });
    edges.push({ fromId: sourceSubjectId, relation: "evaluates", toId: itemId });
    for (const artifactKey of task.inputArtifactKeys) {
      edges.push({
        fromId: `persisted-artifact:${artifactKey}`,
        relation: "input",
        toId: itemId,
      });
    }
    if (latestResult?.artifactKey) {
      edges.push({
        fromId: itemId,
        relation: "produces",
        toId: `persisted-artifact:${latestResult.artifactKey}`,
      });
    }
  }

  const finalized = finalizeWorkItems(subjects, items);
  return {
    edges,
    items: finalized.items,
    sourceId: input.source.sourceId,
    subjects: finalized.subjects,
    summary: finalized.summary,
  };
}
