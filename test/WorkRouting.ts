import { describe, it } from "node:test";
import { expect } from "chai";
import { deriveClaimWorkRouting } from "../src/work/routing.js";
import type { ClaimWorkItemView } from "../src/work/types.js";

function buildWorkItem(
  input: Partial<ClaimWorkItemView> &
    Pick<ClaimWorkItemView, "claimId" | "itemId" | "kind" | "lane">,
): Omit<ClaimWorkItemView, "routing" | "scheduling"> {
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

describe("claim work routing", () => {
  it("prioritizes reassignment pressure over ordinary claimable work", () => {
    const ordinary = buildWorkItem({
      claimId: "1",
      itemId: "review-task:1",
      kind: "review_task",
      lane: "evaluation",
    });
    const reopened = buildWorkItem({
      claimId: "1",
      itemId: "replication-job:2",
      kind: "replication_job",
      lane: "execution",
      orchestration: {
        ...ordinary.orchestration,
        canReassign: true,
        failedRunCount: 1,
        recommendedAction: "reassign",
      },
      sourceType: "replication_job",
    });

    const ordinaryRouting = deriveClaimWorkRouting(ordinary, [ordinary, reopened]);
    const reopenedRouting = deriveClaimWorkRouting(reopened, [ordinary, reopened]);

    expect(reopenedRouting.priorityBps).to.be.greaterThan(ordinaryRouting.priorityBps);
    expect(reopenedRouting.tier).to.equal("critical");
  });

  it("holds synthesis work behind open lower-level claim work", () => {
    const evaluation = buildWorkItem({
      claimId: "1",
      itemId: "review-task:1",
      kind: "review_task",
      lane: "evaluation",
    });
    const synthesis = buildWorkItem({
      claimId: "1",
      itemId: "review-task:2",
      kind: "review_task",
      lane: "synthesis",
      sourceType: "certification_synthesis_check",
    });

    const synthesisRouting = deriveClaimWorkRouting(synthesis, [evaluation, synthesis]);

    expect(synthesisRouting.blockedByOpenWork).to.equal(true);
    expect(synthesisRouting.priorityBps).to.be.lessThan(2_000);
    expect(synthesisRouting.rationale[0]).to.match(/waiting on lower-level open work/i);
  });

  it("surfaces distinct-contributor pressure in routing rationale", () => {
    const item = buildWorkItem({
      claimId: "1",
      itemId: "review-task:3",
      kind: "review_task",
      lane: "evaluation",
      orchestration: {
        activeRunCount: 0,
        attemptCount: 1,
        canClaim: true,
        canReassign: false,
        completedRunCount: 1,
        contributorsNeeded: 1,
        distinctContributorCount: 1,
        distinctContributorShortfall: 1,
        failedRunCount: 0,
        minimumContributorsNeeded: 1,
        minimumSatisfied: false,
        recommendedAction: "claim",
        remainingContributorSlots: 1,
        requiresDistinctContributors: true,
        shouldEscalate: false,
        statusReason: "item is open and still needs additional distinct contributors",
        successfulContributionCount: 1,
        targetContributorsNeeded: 1,
        targetSatisfied: false,
        timedOutRunCount: 0,
      },
      policy: {
        maxContributors: 2,
        minContributors: 2,
        requireDistinctAgents: true,
        requiredCapabilities: ["statistics"],
      },
    });

    const routing = deriveClaimWorkRouting(item, [item]);

    expect(routing.rationale.join(" ")).to.match(/distinct contributors/i);
    expect(routing.priorityBps).to.be.greaterThan(7_000);
  });

  it("surfaces redundancy pressure after minimum corroboration is already satisfied", () => {
    const item = buildWorkItem({
      claimId: "1",
      itemId: "review-task:4",
      kind: "review_task",
      lane: "evaluation",
      orchestration: {
        activeRunCount: 0,
        attemptCount: 1,
        canClaim: true,
        canReassign: false,
        completedRunCount: 2,
        contributorsNeeded: 0,
        distinctContributorCount: 2,
        distinctContributorShortfall: 0,
        failedRunCount: 0,
        minimumContributorsNeeded: 0,
        minimumSatisfied: true,
        recommendedAction: "claim",
        remainingContributorSlots: 1,
        requiresDistinctContributors: true,
        shouldEscalate: false,
        statusReason:
          "item reached its minimum threshold but can still accept another distinct corroborating contribution",
        successfulContributionCount: 2,
        targetContributorsNeeded: 1,
        targetSatisfied: false,
        timedOutRunCount: 0,
      },
      policy: {
        maxContributors: 3,
        minContributors: 2,
        requireDistinctAgents: true,
        requiredCapabilities: ["method-analysis"],
      },
    });

    const routing = deriveClaimWorkRouting(item, [item]);

    expect(routing.rationale.join(" ")).to.match(
      /corroborating redundancy|distinct corroborating/i,
    );
    expect(routing.priorityBps).to.be.greaterThan(1_000);
  });
});
