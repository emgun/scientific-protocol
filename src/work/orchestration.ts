import type {
  ClaimWorkAgentActionsView,
  ClaimWorkItemKind,
  ClaimWorkLane,
  ClaimWorkOrchestrationAction,
  ClaimWorkOrchestrationView,
  ClaimWorkPolicyView,
  ClaimWorkRunView,
  ClaimWorkStatus,
} from "./types.js";

type DeriveClaimWorkOrchestrationInput = {
  agentActions: ClaimWorkAgentActionsView;
  kind: ClaimWorkItemKind;
  lane: ClaimWorkLane;
  policy: ClaimWorkPolicyView | null;
  runs: ClaimWorkRunView[];
  status: ClaimWorkStatus;
  successfulContributorAgentIds: string[];
  successfulContributionCount: number;
};

function escalationThresholdForWorkItem(
  input: Pick<DeriveClaimWorkOrchestrationInput, "kind" | "lane">,
): number {
  if (input.kind === "artifact_maintenance") {
    return 2;
  }
  if (input.lane === "synthesis") {
    return 1;
  }
  return 2;
}

function positiveOrZero(value: number): number {
  return value > 0 ? value : 0;
}

function distinctContributorCount(agentIds: string[]): number {
  return new Set(agentIds.map((agentId) => agentId.trim()).filter((agentId) => agentId.length > 0))
    .size;
}

function closedRecommendationForStatus(
  status: ClaimWorkStatus,
): ClaimWorkOrchestrationAction | null {
  if (status === "completed") {
    return "complete";
  }
  if (status === "failed" || status === "canceled") {
    return "closed";
  }
  if (status === "escalated") {
    return "escalate";
  }
  return null;
}

function statusReasonFromClosedState(status: ClaimWorkStatus): string | null {
  switch (status) {
    case "completed":
      return "work item reached a terminal completed state";
    case "failed":
      return "work item reached a terminal failed state";
    case "canceled":
      return "work item was canceled and is no longer claimable";
    case "escalated":
      return "work item has been escalated for manual or higher-trust handling";
    default:
      return null;
  }
}

export function deriveClaimWorkOrchestration(
  input: DeriveClaimWorkOrchestrationInput,
): ClaimWorkOrchestrationView {
  const activeRunCount = input.runs.filter((run) => run.status === "running").length;
  const completedRunCount = input.runs.filter((run) => run.status === "completed").length;
  const failedRuns = input.runs.filter((run) => run.status === "failed");
  const failedRunCount = failedRuns.length;
  const timedOutRunCount = failedRuns.filter(
    (run) => run.failureReason === "heartbeat_timeout",
  ).length;
  const attemptCount = input.runs.length;
  const minContributors = input.policy?.minContributors ?? 0;
  const maxContributors = input.policy?.maxContributors ?? null;
  const targetContributors = maxContributors ?? minContributors;
  const requiresDistinctContributors = input.policy?.requireDistinctAgents ?? false;
  const distinctContributors = distinctContributorCount(input.successfulContributorAgentIds);
  const distinctContributorShortfall = requiresDistinctContributors
    ? positiveOrZero(minContributors - distinctContributors)
    : 0;
  const minimumContributorsNeeded = requiresDistinctContributors
    ? distinctContributorShortfall
    : positiveOrZero(minContributors - input.successfulContributionCount);
  const targetContributorsNeeded = requiresDistinctContributors
    ? positiveOrZero(targetContributors - distinctContributors)
    : positiveOrZero(targetContributors - input.successfulContributionCount);
  const contributorsNeeded = minimumContributorsNeeded;
  const remainingContributorSlots =
    maxContributors === null
      ? null
      : positiveOrZero(maxContributors - input.successfulContributionCount - activeRunCount);
  const claimActionAvailable = input.agentActions.claim !== null;
  const canClaim =
    input.status === "open" &&
    claimActionAvailable &&
    (remainingContributorSlots === null || remainingContributorSlots > 0);
  const canReassign =
    input.status === "open" &&
    activeRunCount === 0 &&
    failedRunCount > 0 &&
    canClaim &&
    targetContributorsNeeded > 0;
  const failureThreshold = escalationThresholdForWorkItem(input);
  const shouldEscalate =
    input.status === "escalated" ||
    (input.status === "open" &&
      activeRunCount === 0 &&
      minimumContributorsNeeded > 0 &&
      (timedOutRunCount >= failureThreshold || failedRunCount >= failureThreshold + 1));
  const minimumSatisfied = minimumContributorsNeeded === 0;
  const targetSatisfied = targetContributorsNeeded === 0;

  const closedRecommendation = closedRecommendationForStatus(input.status);
  if (closedRecommendation) {
    return {
      activeRunCount,
      attemptCount,
      canClaim: false,
      canReassign: false,
      completedRunCount,
      contributorsNeeded,
      distinctContributorCount: distinctContributors,
      distinctContributorShortfall,
      failedRunCount,
      minimumContributorsNeeded,
      minimumSatisfied,
      recommendedAction: closedRecommendation,
      remainingContributorSlots,
      requiresDistinctContributors,
      shouldEscalate,
      statusReason: statusReasonFromClosedState(input.status) ?? "work item is not claimable",
      successfulContributionCount: input.successfulContributionCount,
      targetContributorsNeeded,
      targetSatisfied,
      timedOutRunCount,
    };
  }

  if (shouldEscalate) {
    return {
      activeRunCount,
      attemptCount,
      canClaim,
      canReassign,
      completedRunCount,
      contributorsNeeded,
      distinctContributorCount: distinctContributors,
      distinctContributorShortfall,
      failedRunCount,
      minimumContributorsNeeded,
      minimumSatisfied,
      recommendedAction: "escalate",
      remainingContributorSlots,
      requiresDistinctContributors,
      shouldEscalate,
      statusReason: "item exhausted its current retry path without enough successful contributions",
      successfulContributionCount: input.successfulContributionCount,
      targetContributorsNeeded,
      targetSatisfied,
      timedOutRunCount,
    };
  }

  if (activeRunCount > 0 || input.status === "leased") {
    return {
      activeRunCount,
      attemptCount,
      canClaim,
      canReassign: false,
      completedRunCount,
      contributorsNeeded,
      distinctContributorCount: distinctContributors,
      distinctContributorShortfall,
      failedRunCount,
      minimumContributorsNeeded,
      minimumSatisfied,
      recommendedAction: "wait",
      remainingContributorSlots,
      requiresDistinctContributors,
      shouldEscalate,
      statusReason: "work is currently leased to an active agent run",
      successfulContributionCount: input.successfulContributionCount,
      targetContributorsNeeded,
      targetSatisfied,
      timedOutRunCount,
    };
  }

  if (canReassign) {
    return {
      activeRunCount,
      attemptCount,
      canClaim,
      canReassign,
      completedRunCount,
      contributorsNeeded,
      distinctContributorCount: distinctContributors,
      distinctContributorShortfall,
      failedRunCount,
      minimumContributorsNeeded,
      minimumSatisfied,
      recommendedAction: "reassign",
      remainingContributorSlots,
      requiresDistinctContributors,
      shouldEscalate,
      statusReason:
        !minimumSatisfied && requiresDistinctContributors && distinctContributorShortfall > 0
          ? "previous runs ended without enough distinct contributors and the item can be reassigned"
          : !minimumSatisfied
            ? "previous runs ended without enough successful contributions and the item can be reassigned"
            : requiresDistinctContributors && targetContributorsNeeded > 0
              ? "minimum corroboration is satisfied, but a fresh distinct contributor is still useful before this work item is considered well-covered"
              : "minimum corroboration is satisfied, but another corroborating contribution is still useful before this work item is considered well-covered",
      successfulContributionCount: input.successfulContributionCount,
      targetContributorsNeeded,
      targetSatisfied,
      timedOutRunCount,
    };
  }

  if (canClaim) {
    return {
      activeRunCount,
      attemptCount,
      canClaim,
      canReassign,
      completedRunCount,
      contributorsNeeded,
      distinctContributorCount: distinctContributors,
      distinctContributorShortfall,
      failedRunCount,
      minimumContributorsNeeded,
      minimumSatisfied,
      recommendedAction: "claim",
      remainingContributorSlots,
      requiresDistinctContributors,
      shouldEscalate,
      statusReason:
        !minimumSatisfied && requiresDistinctContributors && distinctContributorShortfall > 0
          ? "item is open and still needs additional distinct contributors"
          : !minimumSatisfied
            ? "item is open and still needs additional contributions"
            : requiresDistinctContributors && targetContributorsNeeded > 0
              ? "item reached its minimum threshold but can still accept another distinct corroborating contribution"
              : targetContributorsNeeded > 0
                ? "item reached its minimum threshold but can still accept another corroborating contribution"
                : "item is open and can accept more contributions",
      successfulContributionCount: input.successfulContributionCount,
      targetContributorsNeeded,
      targetSatisfied,
      timedOutRunCount,
    };
  }

  return {
    activeRunCount,
    attemptCount,
    canClaim,
    canReassign,
    completedRunCount,
    contributorsNeeded,
    distinctContributorCount: distinctContributors,
    distinctContributorShortfall,
    failedRunCount,
    minimumContributorsNeeded,
    minimumSatisfied,
    recommendedAction: "wait",
    remainingContributorSlots,
    requiresDistinctContributors,
    shouldEscalate,
    statusReason: "item is open but currently has no available contributor slots",
    successfulContributionCount: input.successfulContributionCount,
    targetContributorsNeeded,
    targetSatisfied,
    timedOutRunCount,
  };
}
