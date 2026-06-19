import { describe, it } from "node:test";
import { expect } from "chai";
import { deriveClaimWorkOrchestration } from "../src/work/orchestration.js";
import type { ClaimWorkRunView } from "../src/work/types.js";

function buildRun(input: Partial<ClaimWorkRunView> & Pick<ClaimWorkRunView, "runId" | "status">) {
  return {
    agentId: input.agentId ?? null,
    failureReason: input.failureReason ?? null,
    finishedAt: input.finishedAt ?? null,
    lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    runId: input.runId,
    startedAt: input.startedAt ?? "2026-04-08T12:00:00.000Z",
    status: input.status,
    workerId: input.workerId ?? "worker-1",
  } satisfies ClaimWorkRunView;
}

describe("claim work orchestration", () => {
  it("marks an open item as claimable when contributor slots are available", () => {
    const orchestration = deriveClaimWorkOrchestration({
      agentActions: {
        claim: "review_task_claim",
        heartbeat: "review_task_heartbeat",
        submit: ["review_task_submission"],
      },
      kind: "review_task",
      lane: "evaluation",
      policy: {
        maxContributors: 2,
        minContributors: 2,
        requireDistinctAgents: true,
        requiredCapabilities: ["method-analysis"],
      },
      runs: [],
      status: "open",
      successfulContributorAgentIds: ["agent-1"],
      successfulContributionCount: 1,
    });

    expect(orchestration.canClaim).to.equal(true);
    expect(orchestration.contributorsNeeded).to.equal(1);
    expect(orchestration.minimumContributorsNeeded).to.equal(1);
    expect(orchestration.targetContributorsNeeded).to.equal(1);
    expect(orchestration.minimumSatisfied).to.equal(false);
    expect(orchestration.targetSatisfied).to.equal(false);
    expect(orchestration.distinctContributorCount).to.equal(1);
    expect(orchestration.distinctContributorShortfall).to.equal(1);
    expect(orchestration.remainingContributorSlots).to.equal(1);
    expect(orchestration.recommendedAction).to.equal("claim");
    expect(orchestration.statusReason).to.match(/distinct contributors/i);
  });

  it("recommends reassignment after a failed run with no active lease", () => {
    const orchestration = deriveClaimWorkOrchestration({
      agentActions: {
        claim: "replication_job_claim",
        heartbeat: "replication_job_heartbeat",
        submit: ["replication_job_submission"],
      },
      kind: "replication_job",
      lane: "execution",
      policy: {
        maxContributors: 1,
        minContributors: 1,
        requireDistinctAgents: false,
        requiredCapabilities: ["execution"],
      },
      runs: [
        buildRun({
          failureReason: "execution_error",
          finishedAt: "2026-04-08T12:05:00.000Z",
          runId: "run-1",
          status: "failed",
        }),
      ],
      status: "open",
      successfulContributorAgentIds: [],
      successfulContributionCount: 0,
    });

    expect(orchestration.canReassign).to.equal(true);
    expect(orchestration.recommendedAction).to.equal("reassign");
    expect(orchestration.failedRunCount).to.equal(1);
  });

  it("recommends escalation after repeated heartbeat timeouts", () => {
    const orchestration = deriveClaimWorkOrchestration({
      agentActions: {
        claim: "artifact_task_claim",
        heartbeat: "artifact_task_heartbeat",
        submit: ["artifact_task_repair_submission"],
      },
      kind: "artifact_maintenance",
      lane: "maintenance",
      policy: {
        maxContributors: 1,
        minContributors: 1,
        requireDistinctAgents: false,
        requiredCapabilities: ["artifact-repair"],
      },
      runs: [
        buildRun({
          failureReason: "heartbeat_timeout",
          finishedAt: "2026-04-08T12:05:00.000Z",
          runId: "run-1",
          status: "failed",
        }),
        buildRun({
          failureReason: "heartbeat_timeout",
          finishedAt: "2026-04-08T12:10:00.000Z",
          runId: "run-2",
          status: "failed",
        }),
      ],
      status: "open",
      successfulContributorAgentIds: [],
      successfulContributionCount: 0,
    });

    expect(orchestration.shouldEscalate).to.equal(true);
    expect(orchestration.recommendedAction).to.equal("escalate");
    expect(orchestration.timedOutRunCount).to.equal(2);
  });

  it("treats duplicate successful contributors as incomplete when distinct agents are required", () => {
    const orchestration = deriveClaimWorkOrchestration({
      agentActions: {
        claim: "review_task_claim",
        heartbeat: "review_task_heartbeat",
        submit: ["review_task_submission"],
      },
      kind: "review_task",
      lane: "evaluation",
      policy: {
        maxContributors: 3,
        minContributors: 2,
        requireDistinctAgents: true,
        requiredCapabilities: ["statistics"],
      },
      runs: [],
      status: "open",
      successfulContributorAgentIds: ["agent-1", "agent-1"],
      successfulContributionCount: 2,
    });

    expect(orchestration.successfulContributionCount).to.equal(2);
    expect(orchestration.distinctContributorCount).to.equal(1);
    expect(orchestration.contributorsNeeded).to.equal(1);
    expect(orchestration.minimumContributorsNeeded).to.equal(1);
    expect(orchestration.targetContributorsNeeded).to.equal(2);
    expect(orchestration.distinctContributorShortfall).to.equal(1);
    expect(orchestration.canClaim).to.equal(true);
  });

  it("keeps redundancy demand visible after the minimum threshold is satisfied", () => {
    const orchestration = deriveClaimWorkOrchestration({
      agentActions: {
        claim: "review_task_claim",
        heartbeat: "review_task_heartbeat",
        submit: ["review_task_submission"],
      },
      kind: "review_task",
      lane: "evaluation",
      policy: {
        maxContributors: 3,
        minContributors: 2,
        requireDistinctAgents: true,
        requiredCapabilities: ["method-analysis"],
      },
      runs: [],
      status: "open",
      successfulContributorAgentIds: ["agent-1", "agent-2"],
      successfulContributionCount: 2,
    });

    expect(orchestration.minimumSatisfied).to.equal(true);
    expect(orchestration.targetSatisfied).to.equal(false);
    expect(orchestration.minimumContributorsNeeded).to.equal(0);
    expect(orchestration.targetContributorsNeeded).to.equal(1);
    expect(orchestration.canClaim).to.equal(true);
    expect(orchestration.statusReason).to.match(/minimum threshold|corroborating/i);
  });
});
