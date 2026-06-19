import type { ClaimWorkItemView, ClaimWorkRoutingTier } from "./types.js";

type WorkItemWithoutRouting = Omit<ClaimWorkItemView, "routing" | "scheduling">;

function clampPriority(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function tierForPriority(priorityBps: number): ClaimWorkRoutingTier {
  if (priorityBps >= 8_500) {
    return "critical";
  }
  if (priorityBps >= 6_500) {
    return "high";
  }
  if (priorityBps >= 4_000) {
    return "normal";
  }
  if (priorityBps > 0) {
    return "low";
  }
  return "hold";
}

function lanePriorityBoost(
  item: Pick<WorkItemWithoutRouting, "kind" | "lane" | "sourceType">,
): number {
  if (item.kind === "artifact_maintenance" && item.sourceType === "repair") {
    return 900;
  }
  if (item.kind === "replication_job") {
    return 800;
  }
  if (item.lane === "maintenance") {
    return 700;
  }
  if (item.lane === "execution") {
    return 650;
  }
  if (item.lane === "evaluation") {
    return 500;
  }
  return 200;
}

function isBlockingClaimWork(item: WorkItemWithoutRouting): boolean {
  return (
    item.itemId !== "" &&
    (item.status === "open" || item.status === "leased") &&
    item.lane !== "synthesis" &&
    (item.orchestration.canClaim || item.orchestration.activeRunCount > 0)
  );
}

function hasBlockingNonSynthesisWork(
  items: WorkItemWithoutRouting[],
  current: WorkItemWithoutRouting,
): boolean {
  if (current.lane !== "synthesis") {
    return false;
  }
  return items.some(
    (item) =>
      item.itemId !== current.itemId &&
      item.claimId === current.claimId &&
      isBlockingClaimWork(item),
  );
}

export function deriveClaimWorkRouting(
  item: WorkItemWithoutRouting,
  items: WorkItemWithoutRouting[],
): ClaimWorkItemView["routing"] {
  const blockedByOpenWork = hasBlockingNonSynthesisWork(items, item);
  if (!item.orchestration.canClaim) {
    return {
      blockedByOpenWork,
      priorityBps: 0,
      rationale: [item.orchestration.statusReason],
      tier: "hold",
    };
  }

  let priority = 0;
  const rationale: string[] = [];

  if (item.orchestration.recommendedAction === "reassign") {
    priority += 7_200;
    rationale.push("reopened after earlier runs failed");
  } else if (item.orchestration.recommendedAction === "claim") {
    priority += 6_000;
    rationale.push("currently claimable through the generic runtime");
  }

  priority += lanePriorityBoost(item);

  if (item.orchestration.minimumContributorsNeeded > 0) {
    if (
      item.orchestration.requiresDistinctContributors &&
      item.orchestration.distinctContributorShortfall > 0
    ) {
      priority += Math.min(1_600, item.orchestration.distinctContributorShortfall * 800);
      rationale.push(
        "scheduler still needs additional distinct contributors to reach minimum corroboration",
      );
    } else {
      priority += Math.min(1_400, item.orchestration.minimumContributorsNeeded * 700);
      rationale.push(
        "claim state still needs additional contributions to reach minimum corroboration",
      );
    }
  } else if (item.orchestration.targetContributorsNeeded > 0) {
    if (item.orchestration.requiresDistinctContributors) {
      priority += Math.min(900, item.orchestration.targetContributorsNeeded * 350);
      rationale.push("scheduler still wants an additional distinct corroborating contribution");
    } else {
      priority += Math.min(800, item.orchestration.targetContributorsNeeded * 300);
      rationale.push("scheduler still wants additional corroborating redundancy");
    }
  }

  if (item.orchestration.timedOutRunCount > 0) {
    priority += Math.min(1_000, item.orchestration.timedOutRunCount * 400);
    rationale.push("previous lease timed out");
  }

  if (item.orchestration.failedRunCount > item.orchestration.timedOutRunCount) {
    priority += Math.min(
      800,
      (item.orchestration.failedRunCount - item.orchestration.timedOutRunCount) * 250,
    );
    rationale.push("previous attempts ended without a successful contribution");
  }

  if (blockedByOpenWork) {
    priority = Math.min(priority, 1_500);
    rationale.unshift("waiting on lower-level open work before synthesis is useful");
  }

  const priorityBps = clampPriority(priority);
  return {
    blockedByOpenWork,
    priorityBps,
    rationale,
    tier: tierForPriority(priorityBps),
  };
}
