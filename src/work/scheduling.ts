import type { ClaimWorkItemView, ClaimWorkSchedulingView } from "./types.js";

type WorkItemWithoutScheduling = Omit<ClaimWorkItemView, "scheduling">;

function positiveOrZero(value: number): number {
  return value > 0 ? value : 0;
}

function strategyForItem(item: Pick<WorkItemWithoutScheduling, "lane" | "orchestration">) {
  if (item.lane === "synthesis") {
    return "synthesis" as const;
  }
  if (item.orchestration.requiresDistinctContributors) {
    return "distinct" as const;
  }
  if (
    (item.orchestration.remainingContributorSlots ?? 0) > 1 ||
    item.orchestration.contributorsNeeded > 1
  ) {
    return "parallel" as const;
  }
  return "single" as const;
}

function unresolvedUpstreamDependency(item: WorkItemWithoutScheduling): boolean {
  if (item.lane === "synthesis") {
    return false;
  }
  if (item.status === "completed" || item.status === "canceled") {
    return false;
  }
  return true;
}

function unresolvedUpstreamItems(
  current: WorkItemWithoutScheduling,
  items: WorkItemWithoutScheduling[],
): WorkItemWithoutScheduling[] {
  if (current.lane !== "synthesis") {
    return [];
  }
  return items.filter(
    (item) =>
      item.itemId !== current.itemId &&
      item.claimId === current.claimId &&
      unresolvedUpstreamDependency(item),
  );
}

function blockedScheduling(input: {
  blocker: string;
  needsMinimumCoverage: boolean;
  needsRedundantCoverage: boolean;
  preferredFreshContributor: boolean;
  reason: string;
  strategy: ClaimWorkSchedulingView["strategy"];
  blockingItemIds?: string[];
  reassignmentPreferred?: boolean;
  unresolvedDependencyCount?: number;
}): ClaimWorkSchedulingView {
  return {
    autoClaimable: false,
    blocker: input.blocker,
    blockingItemIds: input.blockingItemIds ?? [],
    desiredAdditionalClaims: 0,
    needsMinimumCoverage: input.needsMinimumCoverage,
    needsRedundantCoverage: input.needsRedundantCoverage,
    prefersFreshContributor: input.preferredFreshContributor,
    reassignmentPreferred: input.reassignmentPreferred ?? false,
    reason: input.reason,
    strategy: input.strategy,
    unresolvedDependencyCount: input.unresolvedDependencyCount ?? 0,
  };
}

export function deriveClaimWorkScheduling(
  item: WorkItemWithoutScheduling,
  items: WorkItemWithoutScheduling[],
): ClaimWorkSchedulingView {
  const strategy = strategyForItem(item);
  const minimumNeededAfterActiveRuns = positiveOrZero(
    item.orchestration.minimumContributorsNeeded - item.orchestration.activeRunCount,
  );
  const targetNeededAfterActiveRuns = positiveOrZero(
    item.orchestration.targetContributorsNeeded - item.orchestration.activeRunCount,
  );
  const needsMinimumCoverage = minimumNeededAfterActiveRuns > 0;
  const needsRedundantCoverage = !needsMinimumCoverage && targetNeededAfterActiveRuns > 0;
  const preferredFreshContributor =
    item.orchestration.requiresDistinctContributors && targetNeededAfterActiveRuns > 0;
  const reassignmentPreferred = item.orchestration.recommendedAction === "reassign";
  const upstreamItems = unresolvedUpstreamItems(item, items);

  if (upstreamItems.length > 0) {
    const blockingItemIds = upstreamItems.map((entry) => entry.itemId);
    const escalatedDependency = upstreamItems.some(
      (entry) => entry.status === "escalated" || entry.orchestration.shouldEscalate,
    );
    const failedDependency = upstreamItems.some((entry) => entry.status === "failed");
    return blockedScheduling({
      blocker: "dependency_blocked",
      blockingItemIds,
      needsMinimumCoverage,
      needsRedundantCoverage,
      preferredFreshContributor,
      reason: escalatedDependency
        ? "upstream claim work still needs manual escalation handling before synthesis is useful"
        : failedDependency
          ? "upstream claim work still needs reassignment or repair before synthesis is useful"
          : "upstream evaluation, execution, or maintenance work is still unresolved",
      strategy,
      unresolvedDependencyCount: upstreamItems.length,
    });
  }

  if (item.orchestration.shouldEscalate) {
    return blockedScheduling({
      blocker: "escalation_required",
      needsMinimumCoverage,
      needsRedundantCoverage,
      preferredFreshContributor,
      reason: "manual escalation should happen before more automatic claims",
      strategy,
      unresolvedDependencyCount: 0,
    });
  }

  if (!item.orchestration.canClaim) {
    return blockedScheduling({
      blocker: "not_claimable",
      needsMinimumCoverage,
      needsRedundantCoverage,
      preferredFreshContributor,
      reason: item.orchestration.statusReason,
      strategy,
      unresolvedDependencyCount: 0,
    });
  }

  if (item.routing.blockedByOpenWork) {
    return blockedScheduling({
      blocker: "dependency_blocked",
      needsMinimumCoverage,
      needsRedundantCoverage,
      preferredFreshContributor,
      reason: "prerequisite lower-lane work is still open",
      strategy,
      unresolvedDependencyCount: 0,
    });
  }

  const desiredAdditionalClaims =
    item.orchestration.remainingContributorSlots === null
      ? targetNeededAfterActiveRuns
      : Math.min(item.orchestration.remainingContributorSlots, targetNeededAfterActiveRuns);

  if (desiredAdditionalClaims <= 0) {
    return blockedScheduling({
      blocker: "policy_satisfied",
      needsMinimumCoverage,
      needsRedundantCoverage,
      preferredFreshContributor,
      reason:
        item.orchestration.targetContributorsNeeded > 0
          ? "existing active runs already cover the current corroboration target"
          : "current policy already has enough successful contributions",
      strategy,
      unresolvedDependencyCount: 0,
    });
  }

  return {
    autoClaimable: true,
    blocker: null,
    blockingItemIds: [],
    desiredAdditionalClaims,
    needsMinimumCoverage,
    needsRedundantCoverage,
    prefersFreshContributor: preferredFreshContributor,
    reassignmentPreferred,
    reason: reassignmentPreferred
      ? "item is scheduler-ready for reassignment after earlier runs ended without a useful result"
      : preferredFreshContributor && needsMinimumCoverage
        ? "item is scheduler-ready and still needs a fresh distinct contributor to reach minimum corroboration"
        : preferredFreshContributor && needsRedundantCoverage
          ? "minimum corroboration is already satisfied, but scheduler still wants a fresh distinct contributor for stronger redundancy"
          : needsMinimumCoverage
            ? desiredAdditionalClaims > 1
              ? "item is scheduler-ready and still sits below its minimum corroboration target"
              : "item is scheduler-ready for another contribution to reach minimum corroboration"
            : desiredAdditionalClaims > 1
              ? "minimum corroboration is satisfied, but the scheduler still sees uncovered parallel corroboration demand"
              : "minimum corroboration is satisfied, but the scheduler still wants one more corroborating contribution",
    strategy,
    unresolvedDependencyCount: 0,
  };
}
