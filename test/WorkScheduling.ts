import { describe, it } from "node:test";
import { expect } from "chai";
import { deriveClaimWorkScheduling } from "../src/work/scheduling.js";
import type { ClaimWorkItemView } from "../src/work/types.js";

function buildWorkItem(
  input: Partial<ClaimWorkItemView> &
    Pick<ClaimWorkItemView, "claimId" | "itemId" | "kind" | "lane">,
): Omit<ClaimWorkItemView, "scheduling"> {
  return {
    activeRun: null,
    agentActions: {
      claim: "review_task_claim",
      heartbeat: "review_task_heartbeat",
      submit: ["review_task_submission"],
    },
    claimId: input.claimId,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? "2026-04-08T12:00:00.000Z",
    description: input.description ?? "work item",
    itemId: input.itemId,
    kind: input.kind,
    lane: input.lane,
    orchestration:
      input.orchestration ??
      ({
        activeRunCount: 0,
        attemptCount: 0,
        canClaim: true,
        canReassign: false,
        completedRunCount: 0,
        contributorsNeeded: 1,
        distinctContributorCount: 0,
        distinctContributorShortfall: 0,
        failedRunCount: 0,
        minimumContributorsNeeded: 1,
        minimumSatisfied: false,
        recommendedAction: "claim",
        remainingContributorSlots: 1,
        requiresDistinctContributors: false,
        shouldEscalate: false,
        statusReason: "item is open and still needs additional contributions",
        successfulContributionCount: 0,
        targetContributorsNeeded: 1,
        targetSatisfied: false,
        timedOutRunCount: 0,
      } as ClaimWorkItemView["orchestration"]),
    policy:
      input.policy ??
      ({
        maxContributors: 1,
        minContributors: 1,
        requireDistinctAgents: false,
        requiredCapabilities: [],
      } as ClaimWorkItemView["policy"]),
    relatedArtifactKeys: input.relatedArtifactKeys ?? [],
    result: input.result ?? null,
    routing:
      input.routing ??
      ({
        blockedByOpenWork: false,
        priorityBps: 6_500,
        rationale: ["currently claimable through the generic runtime"],
        tier: "high",
      } as ClaimWorkItemView["routing"]),
    runs: input.runs ?? [],
    scopeKey: input.scopeKey ?? null,
    sourceType:
      input.sourceType ??
      (input.kind === "replication_job" ? "replication_job" : "method_consistency_check"),
    status: input.status ?? "open",
    subjectId: input.subjectId ?? `claim:${input.claimId}`,
    title: input.title ?? "Work",
    updatedAt: input.updatedAt ?? "2026-04-08T12:00:00.000Z",
  };
}

describe("claim work scheduling", () => {
  it("stops auto-claiming once the current policy minimum is already satisfied", () => {
    const item = buildWorkItem({
      claimId: "1",
      itemId: "review-task:1",
      kind: "review_task",
      lane: "evaluation",
      orchestration: {
        activeRunCount: 0,
        attemptCount: 1,
        canClaim: true,
        canReassign: false,
        completedRunCount: 1,
        contributorsNeeded: 0,
        distinctContributorCount: 1,
        distinctContributorShortfall: 0,
        failedRunCount: 0,
        minimumContributorsNeeded: 0,
        minimumSatisfied: true,
        recommendedAction: "claim",
        remainingContributorSlots: 0,
        requiresDistinctContributors: false,
        shouldEscalate: false,
        statusReason: "item is open and can accept more contributions",
        successfulContributionCount: 1,
        targetContributorsNeeded: 0,
        targetSatisfied: true,
        timedOutRunCount: 0,
      },
      policy: {
        maxContributors: 1,
        minContributors: 1,
        requireDistinctAgents: false,
        requiredCapabilities: ["method-analysis"],
      },
    });

    const scheduling = deriveClaimWorkScheduling(item, [item]);

    expect(scheduling.autoClaimable).to.equal(false);
    expect(scheduling.blocker).to.equal("policy_satisfied");
    expect(scheduling.blockingItemIds).to.deep.equal([]);
    expect(scheduling.desiredAdditionalClaims).to.equal(0);
    expect(scheduling.needsMinimumCoverage).to.equal(false);
    expect(scheduling.needsRedundantCoverage).to.equal(false);
    expect(scheduling.reassignmentPreferred).to.equal(false);
    expect(scheduling.unresolvedDependencyCount).to.equal(0);
  });

  it("blocks synthesis auto-claims while lower-lane work is still open", () => {
    const evaluation = buildWorkItem({
      claimId: "1",
      itemId: "review-task:1",
      kind: "review_task",
      lane: "evaluation",
    });
    const item = buildWorkItem({
      claimId: "1",
      itemId: "review-task:2",
      kind: "review_task",
      lane: "synthesis",
      sourceType: "certification_synthesis_check",
      routing: {
        blockedByOpenWork: true,
        priorityBps: 1_000,
        rationale: ["waiting on lower-level open work before synthesis is useful"],
        tier: "hold",
      },
    });

    const scheduling = deriveClaimWorkScheduling(item, [evaluation, item]);

    expect(scheduling.autoClaimable).to.equal(false);
    expect(scheduling.blocker).to.equal("dependency_blocked");
    expect(scheduling.blockingItemIds).to.deep.equal(["review-task:1"]);
    expect(scheduling.strategy).to.equal("synthesis");
    expect(scheduling.unresolvedDependencyCount).to.equal(1);
  });

  it("only asks for the uncovered portion of the contribution target after active runs", () => {
    const item = buildWorkItem({
      claimId: "1",
      itemId: "review-task:3",
      kind: "review_task",
      lane: "evaluation",
      orchestration: {
        activeRunCount: 1,
        attemptCount: 1,
        canClaim: true,
        canReassign: false,
        completedRunCount: 0,
        contributorsNeeded: 2,
        distinctContributorCount: 0,
        distinctContributorShortfall: 0,
        failedRunCount: 0,
        minimumContributorsNeeded: 2,
        minimumSatisfied: false,
        recommendedAction: "claim",
        remainingContributorSlots: 1,
        requiresDistinctContributors: false,
        shouldEscalate: false,
        statusReason: "item is open and still needs additional contributions",
        successfulContributionCount: 0,
        targetContributorsNeeded: 2,
        targetSatisfied: false,
        timedOutRunCount: 0,
      },
      policy: {
        maxContributors: 2,
        minContributors: 2,
        requireDistinctAgents: false,
        requiredCapabilities: ["statistics"],
      },
    });

    const scheduling = deriveClaimWorkScheduling(item, [item]);

    expect(scheduling.autoClaimable).to.equal(true);
    expect(scheduling.desiredAdditionalClaims).to.equal(1);
    expect(scheduling.needsMinimumCoverage).to.equal(true);
    expect(scheduling.needsRedundantCoverage).to.equal(false);
    expect(scheduling.strategy).to.equal("parallel");
    expect(scheduling.reassignmentPreferred).to.equal(false);
  });

  it("marks reopened work as reassignment-preferred", () => {
    const item = buildWorkItem({
      claimId: "1",
      itemId: "replication-job:9",
      kind: "replication_job",
      lane: "execution",
      orchestration: {
        activeRunCount: 0,
        attemptCount: 2,
        canClaim: true,
        canReassign: true,
        completedRunCount: 0,
        contributorsNeeded: 1,
        distinctContributorCount: 0,
        distinctContributorShortfall: 0,
        failedRunCount: 1,
        minimumContributorsNeeded: 1,
        minimumSatisfied: false,
        recommendedAction: "reassign",
        remainingContributorSlots: 1,
        requiresDistinctContributors: false,
        shouldEscalate: false,
        statusReason:
          "previous runs ended without enough successful contributions and the item can be reassigned",
        successfulContributionCount: 0,
        targetContributorsNeeded: 1,
        targetSatisfied: false,
        timedOutRunCount: 0,
      },
      sourceType: "replication_job",
    });

    const scheduling = deriveClaimWorkScheduling(item, [item]);

    expect(scheduling.autoClaimable).to.equal(true);
    expect(scheduling.reassignmentPreferred).to.equal(true);
    expect(scheduling.reason).to.match(/reassignment/i);
  });

  it("blocks synthesis while upstream work is escalated even if no open lease remains", () => {
    const escalated = buildWorkItem({
      claimId: "1",
      itemId: "artifact-maintenance:4",
      kind: "artifact_maintenance",
      lane: "maintenance",
      status: "escalated",
      orchestration: {
        activeRunCount: 0,
        attemptCount: 2,
        canClaim: false,
        canReassign: false,
        completedRunCount: 0,
        contributorsNeeded: 1,
        distinctContributorCount: 0,
        distinctContributorShortfall: 0,
        failedRunCount: 2,
        minimumContributorsNeeded: 1,
        minimumSatisfied: false,
        recommendedAction: "escalate",
        remainingContributorSlots: 1,
        requiresDistinctContributors: false,
        shouldEscalate: true,
        statusReason:
          "item exhausted its current retry path without enough successful contributions",
        successfulContributionCount: 0,
        targetContributorsNeeded: 1,
        targetSatisfied: false,
        timedOutRunCount: 2,
      },
      sourceType: "audit",
    });
    const synthesis = buildWorkItem({
      claimId: "1",
      itemId: "review-task:5",
      kind: "review_task",
      lane: "synthesis",
      sourceType: "certification_synthesis_check",
    });

    const scheduling = deriveClaimWorkScheduling(synthesis, [escalated, synthesis]);

    expect(scheduling.autoClaimable).to.equal(false);
    expect(scheduling.blocker).to.equal("dependency_blocked");
    expect(scheduling.reason).to.match(/manual escalation handling/i);
    expect(scheduling.blockingItemIds).to.deep.equal(["artifact-maintenance:4"]);
  });

  it("keeps redundancy claims open after the minimum corroboration threshold is satisfied", () => {
    const item = buildWorkItem({
      claimId: "1",
      itemId: "review-task:7",
      kind: "review_task",
      lane: "evaluation",
      orchestration: {
        activeRunCount: 0,
        attemptCount: 1,
        canClaim: true,
        canReassign: false,
        completedRunCount: 1,
        contributorsNeeded: 0,
        distinctContributorCount: 1,
        distinctContributorShortfall: 0,
        failedRunCount: 0,
        minimumContributorsNeeded: 0,
        minimumSatisfied: true,
        recommendedAction: "claim",
        remainingContributorSlots: 2,
        requiresDistinctContributors: true,
        shouldEscalate: false,
        statusReason:
          "item reached its minimum threshold but can still accept another distinct corroborating contribution",
        successfulContributionCount: 1,
        targetContributorsNeeded: 2,
        targetSatisfied: false,
        timedOutRunCount: 0,
      },
      policy: {
        maxContributors: 3,
        minContributors: 1,
        requireDistinctAgents: true,
        requiredCapabilities: ["method-analysis"],
      },
    });

    const scheduling = deriveClaimWorkScheduling(item, [item]);

    expect(scheduling.autoClaimable).to.equal(true);
    expect(scheduling.desiredAdditionalClaims).to.equal(2);
    expect(scheduling.needsMinimumCoverage).to.equal(false);
    expect(scheduling.needsRedundantCoverage).to.equal(true);
    expect(scheduling.prefersFreshContributor).to.equal(true);
    expect(scheduling.reason).to.match(/redundancy|corroborating/i);
  });
});
