import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "ethers";
import {
  applyRecipientConcentrationDiscounts,
  buildClaimRewardPolicyExplanation,
  buildClaimRewardWorkDemandSignals,
  buildPolicyCandidates,
  deriveRewardTargetsForGroup,
} from "../src/rewards/policy.js";

describe("RewardPolicy", () => {
  it("builds inspectable per-work-kind pricing signals for a claim", () => {
    const explanation = buildClaimRewardPolicyExplanation({
      challenges: [
        {
          challengeId: "1",
          claimId: "11",
          replicationId: "2",
          challenger: "0x0000000000000000000000000000000000000004",
          agentId: "0",
          evidenceHash: "0xchallenge",
          evidenceURI: "ipfs://challenge",
          bondAmount: parseEther("0.1").toString(),
          status: 0,
          resolutionHash: "0xresolution",
          createdAt: 1,
          resolvedAt: null,
          payoutAmount: null,
          refundedAmount: null,
        },
      ],
      forecasts: [
        {
          forecastId: "7",
          claimId: "11",
          forecaster: "0x0000000000000000000000000000000000000005",
          agentId: "0",
          commitmentHash: "0xforecast",
          stakeAmount: parseEther("0.08").toString(),
          committedAt: 1,
          revealDeadline: 2,
          revealed: true,
          settled: true,
          direction: 0,
          confidenceBps: 8700,
          finalStatus: 1,
          matched: true,
          payoutAmount: parseEther("0.12").toString(),
        },
      ],
      pools: [
        {
          balanceWei: parseEther("0.05").toString(),
          workKind: "review",
        },
        {
          balanceWei: parseEther("0.02").toString(),
          workKind: "replication",
        },
      ],
      workGraph: {
        claimId: "11",
        edges: [],
        items: [
          {
            activeRun: null,
            agentActions: { claim: null, heartbeat: null, submit: [] },
            claimId: "11",
            completedAt: null,
            createdAt: "2026-04-01T00:00:00.000Z",
            description: "Open review task",
            itemId: "review-task:1",
            kind: "review_task",
            lane: "evaluation",
            orchestration: {
              activeRunCount: 0,
              attemptCount: 0,
              canClaim: true,
              canReassign: false,
              completedRunCount: 0,
              contributorsNeeded: 1,
              distinctContributorCount: 0,
              distinctContributorShortfall: 1,
              failedRunCount: 0,
              minimumContributorsNeeded: 1,
              minimumSatisfied: false,
              recommendedAction: "claim",
              remainingContributorSlots: 2,
              requiresDistinctContributors: true,
              shouldEscalate: false,
              statusReason: "needs coverage",
              successfulContributionCount: 0,
              targetContributorsNeeded: 2,
              targetSatisfied: false,
              timedOutRunCount: 0,
            },
            policy: {
              maxContributors: 2,
              minContributors: 2,
              requireDistinctAgents: true,
              requiredCapabilities: [],
            },
            relatedArtifactKeys: [],
            result: null,
            routing: {
              blockedByOpenWork: false,
              priorityBps: 12000,
              rationale: [],
              tier: "high",
            },
            runs: [],
            scheduling: {
              autoClaimable: true,
              blocker: null,
              blockingItemIds: [],
              desiredAdditionalClaims: 2,
              needsMinimumCoverage: true,
              needsRedundantCoverage: false,
              prefersFreshContributor: true,
              reassignmentPreferred: false,
              reason: "needs minimum corroboration",
              strategy: "distinct",
              unresolvedDependencyCount: 0,
            },
            scopeKey: "artifact_completeness_check",
            sourceType: "artifact_completeness_check",
            status: "open",
            subjectId: "claim:11",
            title: "Artifact completeness",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        ],
        subjects: [],
        summary: {
          activeLeases: 0,
          autoClaimableItems: 1,
          completedItems: 0,
          dependencyBlockedItems: 0,
          failedItems: 0,
          freshContributorItems: 1,
          lanes: { evaluation: 1, execution: 0, maintenance: 0, synthesis: 0 },
          latestActivityAt: "2026-04-01T00:00:00.000Z",
          minimumCoverageItems: 1,
          openItems: 1,
          participatingAgents: 0,
          reassignmentReadyItems: 0,
          redundancyTargetItems: 0,
          totalItems: 1,
          uncoveredDemand: 2,
        },
      },
    });

    assert.equal(explanation.signals.length >= 2, true);
    assert.equal(explanation.attention.forecastCount, 1);
    assert.equal(explanation.attention.openChallengeCount, 1);
    assert.equal(explanation.attention.distinctForecastParticipants, 1);
    assert.equal(explanation.attention.distinctChallengeParticipants, 1);
    assert.equal(explanation.attention.totalForecastStakeWei, parseEther("0.08").toString());
    assert.equal(explanation.attention.totalChallengeBondWei, parseEther("0.1").toString());
    assert.match(explanation.narrative, /work is priced most aggressively right now/i);
    const reviewSignal = explanation.signals.find((signal) => signal.workKind === "review");
    assert.ok(reviewSignal);
    assert.equal(reviewSignal.poolBalanceWei, parseEther("0.05").toString());
    assert.equal(reviewSignal.marketPressureBps >= 5_000, true);
    assert.equal(reviewSignal.schedulerPressureBps > 10_000, true);
    assert.equal(reviewSignal.combinedPressureBps >= reviewSignal.attentionPressureBps, true);
    assert.equal(reviewSignal.minimumCoverageItems, 1);
    assert.equal(reviewSignal.uncoveredDemand, 2);
  });

  it("derives scheduler scarcity signals from the generalized work graph", () => {
    const signals = buildClaimRewardWorkDemandSignals({
      claimId: "11",
      edges: [],
      items: [
        {
          activeRun: null,
          agentActions: { claim: null, heartbeat: null, submit: [] },
          claimId: "11",
          completedAt: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          description: "Open replication job",
          itemId: "replication-job:1",
          kind: "replication_job",
          lane: "execution",
          orchestration: {
            activeRunCount: 0,
            attemptCount: 0,
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
            statusReason: "needs reassignment",
            successfulContributionCount: 0,
            targetContributorsNeeded: 1,
            targetSatisfied: false,
            timedOutRunCount: 0,
          },
          policy: {
            maxContributors: 1,
            minContributors: 1,
            requireDistinctAgents: false,
            requiredCapabilities: [],
          },
          relatedArtifactKeys: [],
          result: null,
          routing: {
            blockedByOpenWork: false,
            priorityBps: 11000,
            rationale: [],
            tier: "high",
          },
          runs: [],
          scheduling: {
            autoClaimable: true,
            blocker: null,
            blockingItemIds: [],
            desiredAdditionalClaims: 1,
            needsMinimumCoverage: true,
            needsRedundantCoverage: false,
            prefersFreshContributor: false,
            reassignmentPreferred: true,
            reason: "needs reassignment",
            strategy: "single",
            unresolvedDependencyCount: 0,
          },
          scopeKey: "replication-job:1",
          sourceType: "replication_job",
          status: "open",
          subjectId: "claim:11",
          title: "Replication job",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      subjects: [],
      summary: {
        activeLeases: 0,
        autoClaimableItems: 1,
        completedItems: 0,
        dependencyBlockedItems: 0,
        failedItems: 0,
        freshContributorItems: 0,
        lanes: { evaluation: 0, execution: 1, maintenance: 0, synthesis: 0 },
        latestActivityAt: "2026-04-01T00:00:00.000Z",
        minimumCoverageItems: 1,
        openItems: 1,
        participatingAgents: 0,
        reassignmentReadyItems: 1,
        redundancyTargetItems: 0,
        totalItems: 1,
        uncoveredDemand: 1,
      },
    });

    assert.equal(signals.replication.minimumCoverageItems, 1);
    assert.equal(signals.replication.reassignmentReadyItems, 1);
    assert.equal(signals.replication.schedulerPressureBps > 10_000, true);
  });

  it("increases target totals when the claim work pool grows", () => {
    const initial = deriveRewardTargetsForGroup({
      candidates: [{ itemId: "review-task:1", qualityBps: 10_000 }],
      poolBalanceWei: parseEther("0.01"),
      workKind: "review",
    });
    const later = deriveRewardTargetsForGroup({
      candidates: [{ itemId: "review-task:1", qualityBps: 10_000 }],
      poolBalanceWei: parseEther("0.05"),
      workKind: "review",
    });

    assert.ok(initial.allocations[0]);
    assert.ok(later.allocations[0]);
    assert.equal(later.marketPressureBps > initial.marketPressureBps, true);
    assert.equal(later.allocations[0].targetTotalWei > initial.allocations[0].targetTotalWei, true);
  });

  it("allocates more of the distributable pool to higher-quality work", () => {
    const derived = deriveRewardTargetsForGroup({
      candidates: [
        { itemId: "review-task:1", qualityBps: 8_000 },
        { itemId: "review-task:2", qualityBps: 12_000 },
      ],
      poolBalanceWei: parseEther("0.04"),
      workKind: "review",
    });

    const low = derived.allocations.find((allocation) => allocation.itemId === "review-task:1");
    const high = derived.allocations.find((allocation) => allocation.itemId === "review-task:2");
    assert.ok(low);
    assert.ok(high);
    assert.equal(high.targetTotalWei > low.targetTotalWei, true);

    const totalAllocated = derived.allocations.reduce(
      (sum, allocation) => sum + allocation.targetTotalWei,
      0n,
    );
    assert.equal(totalAllocated <= derived.distributablePoolWei, true);
  });

  it("increases targets when broader attention pressure rises", () => {
    const baseline = deriveRewardTargetsForGroup({
      attentionPressureBps: 10_000,
      candidates: [{ itemId: "review-task:1", qualityBps: 10_000 }],
      poolBalanceWei: parseEther("0.04"),
      workKind: "review",
    });
    const elevated = deriveRewardTargetsForGroup({
      attentionPressureBps: 15_000,
      candidates: [{ itemId: "review-task:1", qualityBps: 10_000 }],
      poolBalanceWei: parseEther("0.04"),
      workKind: "review",
    });

    assert.ok(baseline.allocations[0]);
    assert.ok(elevated.allocations[0]);
    assert.equal(elevated.marketPressureBps > baseline.marketPressureBps, true);
    assert.equal(
      elevated.allocations[0].targetTotalWei > baseline.allocations[0].targetTotalWei,
      true,
    );
  });

  it("drops allocations below the work-kind quality floor", () => {
    const derived = deriveRewardTargetsForGroup({
      candidates: [{ itemId: "maintenance:1", qualityBps: 6_000 }],
      poolBalanceWei: parseEther("0.04"),
      workKind: "maintenance",
    });

    assert.ok(derived.allocations[0]);
    assert.equal(derived.allocations[0].targetTotalWei, 0n);
  });

  it("discounts repeated reward capture by the same recipient", () => {
    const adjusted = applyRecipientConcentrationDiscounts([
      {
        agentId: "1",
        budgetTopUpBps: 5000,
        claimId: "11",
        itemId: "review-task:1",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000001",
        workKind: "review" as const,
      },
      {
        agentId: "2",
        budgetTopUpBps: 5000,
        claimId: "11",
        itemId: "review-task:2",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000001",
        workKind: "review" as const,
      },
      {
        agentId: "3",
        budgetTopUpBps: 5000,
        claimId: "11",
        itemId: "review-task:3",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000002",
        workKind: "review" as const,
      },
    ]);

    const first = adjusted.find((candidate) => candidate.itemId === "review-task:1");
    const second = adjusted.find((candidate) => candidate.itemId === "review-task:2");
    const third = adjusted.find((candidate) => candidate.itemId === "review-task:3");
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.equal(first.qualityBps, 10_000);
    assert.equal(second.qualityBps < first.qualityBps, true);
    assert.equal(third.qualityBps, 10_000);
  });

  it("discounts repeated capture by the same agent identity even with different recipients", () => {
    const adjusted = applyRecipientConcentrationDiscounts([
      {
        agentId: "7",
        itemId: "review-task:1",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000001",
      },
      {
        agentId: "7",
        itemId: "review-task:2",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000002",
      },
      {
        agentId: "8",
        itemId: "review-task:3",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000003",
      },
    ]);

    const first = adjusted.find((candidate) => candidate.itemId === "review-task:1");
    const second = adjusted.find((candidate) => candidate.itemId === "review-task:2");
    const third = adjusted.find((candidate) => candidate.itemId === "review-task:3");
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.equal(second.qualityBps < first.qualityBps, true);
    assert.equal(third.qualityBps, 10_000);
  });

  it("discounts repeated capture by different agents under the same operator", () => {
    const adjusted = applyRecipientConcentrationDiscounts([
      {
        agentId: "7",
        itemId: "review-task:1",
        operator: "0x0000000000000000000000000000000000000010",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000001",
      },
      {
        agentId: "8",
        itemId: "review-task:2",
        operator: "0x0000000000000000000000000000000000000010",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000002",
      },
      {
        agentId: "9",
        itemId: "review-task:3",
        operator: "0x0000000000000000000000000000000000000011",
        qualityBps: 10_000,
        recipient: "0x0000000000000000000000000000000000000003",
      },
    ]);

    const first = adjusted.find((candidate) => candidate.itemId === "review-task:1");
    const second = adjusted.find((candidate) => candidate.itemId === "review-task:2");
    const third = adjusted.find((candidate) => candidate.itemId === "review-task:3");
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.equal(second.qualityBps < first.qualityBps, true);
    assert.equal(third.qualityBps, 10_000);
  });

  it("builds direct forecast and challenge reward candidates", async () => {
    const candidates = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({ operator: "0x0000000000000000000000000000000000000009" }),
      },
      calibrationHistory: new Map(),
      challenges: [
        {
          challengeId: "3",
          claimId: "11",
          replicationId: "2",
          challenger: "0x0000000000000000000000000000000000000004",
          agentId: "0",
          evidenceHash: "0xchallenge",
          evidenceURI: "ipfs://challenge",
          bondAmount: parseEther("0.2").toString(),
          status: 1,
          resolutionHash: "0xresolution",
          createdAt: 1,
          resolvedAt: 2,
          payoutAmount: parseEther("0.3").toString(),
          refundedAmount: null,
        },
      ],
      forecasts: [
        {
          forecastId: "7",
          claimId: "11",
          forecaster: "0x0000000000000000000000000000000000000005",
          agentId: "0",
          commitmentHash: "0xforecast",
          stakeAmount: parseEther("0.1").toString(),
          committedAt: 1,
          revealDeadline: 2,
          revealed: true,
          settled: true,
          direction: 0,
          confidenceBps: 8700,
          finalStatus: 1,
          matched: true,
          payoutAmount: parseEther("0.12").toString(),
        },
      ],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [],
      reviewTasks: [],
    });

    const forecastCandidate = candidates.find((candidate) => candidate.itemId === "forecast:7");
    const challengeCandidate = candidates.find((candidate) => candidate.itemId === "challenge:3");
    assert.ok(forecastCandidate);
    assert.ok(challengeCandidate);
    assert.equal(forecastCandidate.workKind, "forecast");
    assert.equal(challengeCandidate.workKind, "challenge");
    assert.equal(forecastCandidate.claimId, "11");
    assert.equal(challengeCandidate.claimId, "11");
    assert.equal(forecastCandidate.recipient, "0x0000000000000000000000000000000000000005");
    assert.equal(challengeCandidate.recipient, "0x0000000000000000000000000000000000000004");
  });

  it("discounts low-commitment forecast and challenge work", async () => {
    const candidates = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({ operator: "0x0000000000000000000000000000000000000009" }),
      },
      calibrationHistory: new Map(),
      challenges: [
        {
          challengeId: "3",
          claimId: "11",
          replicationId: "2",
          challenger: "0x0000000000000000000000000000000000000004",
          agentId: "0",
          evidenceHash: "0xchallenge",
          evidenceURI: "ipfs://challenge",
          bondAmount: parseEther("0.001").toString(),
          status: 1,
          resolutionHash: "0xresolution",
          createdAt: 1,
          resolvedAt: 2,
          payoutAmount: parseEther("0.3").toString(),
          refundedAmount: null,
        },
      ],
      forecasts: [
        {
          forecastId: "7",
          claimId: "11",
          forecaster: "0x0000000000000000000000000000000000000005",
          agentId: "0",
          commitmentHash: "0xforecast",
          stakeAmount: parseEther("0.001").toString(),
          committedAt: 1,
          revealDeadline: 2,
          revealed: true,
          settled: true,
          direction: 0,
          confidenceBps: 8700,
          finalStatus: 1,
          matched: true,
          payoutAmount: parseEther("0.12").toString(),
        },
      ],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [],
      reviewTasks: [],
    });

    const forecastCandidate = candidates.find((candidate) => candidate.itemId === "forecast:7");
    const challengeCandidate = candidates.find((candidate) => candidate.itemId === "challenge:3");
    assert.ok(forecastCandidate);
    assert.ok(challengeCandidate);
    assert.equal(forecastCandidate.qualityBps < 10_000, true);
    assert.equal(challengeCandidate.qualityBps < 12_000, true);
  });

  it("discounts review rewards for agents without meaningful calibration history", async () => {
    const baseline = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({ operator: "0x0000000000000000000000000000000000000009" }),
      },
      calibrationHistory: new Map(),
      challenges: [],
      forecasts: [],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [
        {
          submissionId: "1",
          taskId: "1",
          runId: "1",
          claimId: "11",
          reviewerActor: "0x0000000000000000000000000000000000000005",
          reviewerAgentId: "7",
          reviewType: "artifact_completeness_check",
          verdict: "pass",
          confidenceBps: 9000,
          evidenceArtifactKey: null,
          resultArtifactKey: null,
          schemaVersion: "review-task.v1",
          dimensions: {},
          payload: {},
          createdAt: "2026-03-11T00:00:00.000Z",
        },
      ],
      reviewTasks: [
        {
          taskId: "1",
          claimId: "11",
          taskType: "artifact_completeness_check",
          scopeKey: "artifact_completeness_check",
          schemaVersion: "review-task.v1",
          status: "completed",
          requestedBy: "test",
          requiredCapabilities: ["artifact-access"],
          inputArtifactKeys: [],
          consensusPolicy: {
            minSubmissions: 1,
            maxSubmissions: 1,
            requireDistinctAgents: false,
          },
          resultArtifactKey: null,
          failureReason: null,
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          completedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    const mature = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({ operator: "0x0000000000000000000000000000000000000009" }),
      },
      calibrationHistory: new Map([
        [
          "7",
          {
            agentId: "7",
            averageCalibrationBps: 9500,
            contributions: [],
            reviewerActor: "0x0000000000000000000000000000000000000005",
            samples: 5,
            weightBps: 9700,
          },
        ],
      ]),
      challenges: [],
      forecasts: [],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [
        {
          submissionId: "1",
          taskId: "1",
          runId: "1",
          claimId: "11",
          reviewerActor: "0x0000000000000000000000000000000000000005",
          reviewerAgentId: "7",
          reviewType: "artifact_completeness_check",
          verdict: "pass",
          confidenceBps: 9000,
          evidenceArtifactKey: null,
          resultArtifactKey: null,
          schemaVersion: "review-task.v1",
          dimensions: {},
          payload: {},
          createdAt: "2026-03-11T00:00:00.000Z",
        },
      ],
      reviewTasks: [
        {
          taskId: "1",
          claimId: "11",
          taskType: "artifact_completeness_check",
          scopeKey: "artifact_completeness_check",
          schemaVersion: "review-task.v1",
          status: "completed",
          requestedBy: "test",
          requiredCapabilities: ["artifact-access"],
          inputArtifactKeys: [],
          consensusPolicy: {
            minSubmissions: 1,
            maxSubmissions: 1,
            requireDistinctAgents: false,
          },
          resultArtifactKey: null,
          failureReason: null,
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          completedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    assert.ok(baseline[0]);
    assert.ok(mature[0]);
    assert.equal(baseline[0].qualityBps < mature[0].qualityBps, true);
  });

  it("discounts agent-performed work when the agent has little operating capital", async () => {
    const thinlyFunded = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({
          active: true,
          budgetBalance: parseEther("0.001"),
          operator: "0x0000000000000000000000000000000000000009",
          reservedBudget: 0n,
          spendLimit: parseEther("0.001"),
        }),
      },
      calibrationHistory: new Map([
        [
          "7",
          {
            agentId: "7",
            averageCalibrationBps: 9500,
            contributions: [],
            reviewerActor: "0x0000000000000000000000000000000000000005",
            samples: 5,
            weightBps: 9700,
          },
        ],
      ]),
      challenges: [],
      forecasts: [],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [
        {
          submissionId: "1",
          taskId: "1",
          runId: "1",
          claimId: "11",
          reviewerActor: "0x0000000000000000000000000000000000000005",
          reviewerAgentId: "7",
          reviewType: "artifact_completeness_check",
          verdict: "pass",
          confidenceBps: 9000,
          evidenceArtifactKey: null,
          resultArtifactKey: null,
          schemaVersion: "review-task.v1",
          dimensions: {},
          payload: {},
          createdAt: "2026-03-11T00:00:00.000Z",
        },
      ],
      reviewTasks: [
        {
          taskId: "1",
          claimId: "11",
          taskType: "artifact_completeness_check",
          scopeKey: "artifact_completeness_check",
          schemaVersion: "review-task.v1",
          status: "completed",
          requestedBy: "test",
          requiredCapabilities: ["artifact-access"],
          inputArtifactKeys: [],
          consensusPolicy: {
            minSubmissions: 1,
            maxSubmissions: 1,
            requireDistinctAgents: false,
          },
          resultArtifactKey: null,
          failureReason: null,
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          completedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    const wellFunded = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({
          active: true,
          budgetBalance: parseEther("0.08"),
          operator: "0x0000000000000000000000000000000000000009",
          reservedBudget: 0n,
          spendLimit: parseEther("0.08"),
        }),
      },
      calibrationHistory: new Map([
        [
          "7",
          {
            agentId: "7",
            averageCalibrationBps: 9500,
            contributions: [],
            reviewerActor: "0x0000000000000000000000000000000000000005",
            samples: 5,
            weightBps: 9700,
          },
        ],
      ]),
      challenges: [],
      forecasts: [],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [
        {
          submissionId: "1",
          taskId: "1",
          runId: "1",
          claimId: "11",
          reviewerActor: "0x0000000000000000000000000000000000000005",
          reviewerAgentId: "7",
          reviewType: "artifact_completeness_check",
          verdict: "pass",
          confidenceBps: 9000,
          evidenceArtifactKey: null,
          resultArtifactKey: null,
          schemaVersion: "review-task.v1",
          dimensions: {},
          payload: {},
          createdAt: "2026-03-11T00:00:00.000Z",
        },
      ],
      reviewTasks: [
        {
          taskId: "1",
          claimId: "11",
          taskType: "artifact_completeness_check",
          scopeKey: "artifact_completeness_check",
          schemaVersion: "review-task.v1",
          status: "completed",
          requestedBy: "test",
          requiredCapabilities: ["artifact-access"],
          inputArtifactKeys: [],
          consensusPolicy: {
            minSubmissions: 1,
            maxSubmissions: 1,
            requireDistinctAgents: false,
          },
          resultArtifactKey: null,
          failureReason: null,
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          completedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    assert.ok(thinlyFunded[0]);
    assert.ok(wellFunded[0]);
    assert.equal(thinlyFunded[0].qualityBps < wellFunded[0].qualityBps, true);
  });

  it("discounts direct review work that is not bonded through an agent budget", async () => {
    const direct = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({
          active: true,
          budgetBalance: parseEther("0.08"),
          operator: "0x0000000000000000000000000000000000000009",
          reservedBudget: 0n,
          spendLimit: parseEther("0.08"),
        }),
      },
      calibrationHistory: new Map(),
      challenges: [],
      forecasts: [],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [
        {
          submissionId: "1",
          taskId: "1",
          runId: "1",
          claimId: "11",
          reviewerActor: "0x0000000000000000000000000000000000000005",
          reviewerAgentId: null,
          reviewType: "artifact_completeness_check",
          verdict: "pass",
          confidenceBps: 9000,
          evidenceArtifactKey: null,
          resultArtifactKey: null,
          schemaVersion: "review-task.v1",
          dimensions: {},
          payload: {},
          createdAt: "2026-03-11T00:00:00.000Z",
        },
      ],
      reviewTasks: [
        {
          taskId: "1",
          claimId: "11",
          taskType: "artifact_completeness_check",
          scopeKey: "artifact_completeness_check",
          schemaVersion: "review-task.v1",
          status: "completed",
          requestedBy: "test",
          requiredCapabilities: ["artifact-access"],
          inputArtifactKeys: [],
          consensusPolicy: {
            minSubmissions: 1,
            maxSubmissions: 1,
            requireDistinctAgents: false,
          },
          resultArtifactKey: null,
          failureReason: null,
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          completedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    const bonded = await buildPolicyCandidates({
      agentRegistry: {
        getAgent: async () => ({
          active: true,
          budgetBalance: parseEther("0.08"),
          operator: "0x0000000000000000000000000000000000000009",
          reservedBudget: 0n,
          spendLimit: parseEther("0.08"),
        }),
      },
      calibrationHistory: new Map(),
      challenges: [],
      forecasts: [],
      maintenanceTasks: [],
      replicationsById: new Map(),
      replicationJobs: [],
      reviewSubmissions: [
        {
          submissionId: "1",
          taskId: "1",
          runId: "1",
          claimId: "11",
          reviewerActor: "0x0000000000000000000000000000000000000005",
          reviewerAgentId: "7",
          reviewType: "artifact_completeness_check",
          verdict: "pass",
          confidenceBps: 9000,
          evidenceArtifactKey: null,
          resultArtifactKey: null,
          schemaVersion: "review-task.v1",
          dimensions: {},
          payload: {},
          createdAt: "2026-03-11T00:00:00.000Z",
        },
      ],
      reviewTasks: [
        {
          taskId: "1",
          claimId: "11",
          taskType: "artifact_completeness_check",
          scopeKey: "artifact_completeness_check",
          schemaVersion: "review-task.v1",
          status: "completed",
          requestedBy: "test",
          requiredCapabilities: ["artifact-access"],
          inputArtifactKeys: [],
          consensusPolicy: {
            minSubmissions: 1,
            maxSubmissions: 1,
            requireDistinctAgents: false,
          },
          resultArtifactKey: null,
          failureReason: null,
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          completedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    });

    assert.ok(direct[0]);
    assert.ok(bonded[0]);
    assert.equal(direct[0].qualityBps < bonded[0].qualityBps, true);
  });
});
