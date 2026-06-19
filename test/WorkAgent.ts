import { describe, it } from "node:test";
import { expect } from "chai";
import { Wallet } from "ethers";
import type { ClaimReviewState, ReviewTaskView } from "../src/review/types.js";
import type {
  ClaimDetailResponse,
  ClaimWorkItemView,
  SignedAgentRequestBody,
} from "../src/sdk/types.js";
import { runReferenceWorkAgentOnce, selectWorkItemForAgent } from "../src/work/reference-agent.js";

function buildReviewTask(
  input: Partial<ReviewTaskView> & Pick<ReviewTaskView, "claimId" | "taskId" | "taskType">,
): ReviewTaskView {
  return {
    claimId: input.claimId,
    completedAt: input.completedAt ?? null,
    consensusPolicy:
      input.consensusPolicy ??
      ({
        maxSubmissions: 2,
        minSubmissions: 1,
        requireDistinctAgents: true,
      } as ReviewTaskView["consensusPolicy"]),
    createdAt: input.createdAt ?? "2026-04-07T12:00:00.000Z",
    failureReason: input.failureReason ?? null,
    inputArtifactKeys: input.inputArtifactKeys ?? [],
    requestedBy: input.requestedBy ?? "test",
    requiredCapabilities: input.requiredCapabilities ?? [],
    resultArtifactKey: input.resultArtifactKey ?? null,
    schemaVersion: input.schemaVersion ?? "review-task.v1",
    scopeKey: input.scopeKey ?? input.taskType,
    status: input.status ?? "open",
    taskId: input.taskId,
    taskType: input.taskType,
    updatedAt: input.updatedAt ?? "2026-04-07T12:00:00.000Z",
  };
}

function buildReviewWorkItem(task: ReviewTaskView): ClaimWorkItemView {
  const status = task.status === "open" ? "open" : task.status;
  return {
    activeRun: null,
    agentActions: {
      claim: "review_task_claim",
      heartbeat: "review_task_heartbeat",
      submit: ["review_task_submission"],
    },
    claimId: task.claimId,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    description: `Review task ${task.taskType}`,
    itemId: `review-task:${task.taskId}`,
    kind: "review_task",
    lane: task.taskType === "certification_synthesis_check" ? "synthesis" : "evaluation",
    orchestration: {
      activeRunCount: 0,
      attemptCount: 0,
      canClaim: status === "open",
      canReassign: false,
      completedRunCount: 0,
      contributorsNeeded: task.consensusPolicy.minSubmissions,
      distinctContributorCount: 0,
      distinctContributorShortfall: task.consensusPolicy.requireDistinctAgents
        ? task.consensusPolicy.minSubmissions
        : 0,
      failedRunCount: 0,
      minimumContributorsNeeded: task.consensusPolicy.minSubmissions,
      minimumSatisfied: false,
      recommendedAction: status === "open" ? "claim" : "closed",
      remainingContributorSlots: task.consensusPolicy.maxSubmissions,
      requiresDistinctContributors: task.consensusPolicy.requireDistinctAgents,
      shouldEscalate: false,
      statusReason:
        status === "open" ? "item is open and still needs additional contributions" : "closed",
      successfulContributionCount: 0,
      targetContributorsNeeded: task.consensusPolicy.maxSubmissions,
      targetSatisfied: false,
      timedOutRunCount: 0,
    },
    policy: {
      maxContributors: task.consensusPolicy.maxSubmissions,
      minContributors: task.consensusPolicy.minSubmissions,
      requireDistinctAgents: task.consensusPolicy.requireDistinctAgents,
      requiredCapabilities: task.requiredCapabilities,
    },
    relatedArtifactKeys: task.inputArtifactKeys,
    result: null,
    routing: {
      blockedByOpenWork: false,
      priorityBps: 6_500,
      rationale: ["currently claimable through the generic runtime"],
      tier: "high",
    },
    scheduling: {
      autoClaimable: status === "open" && task.consensusPolicy.minSubmissions > 0,
      blocker: null,
      blockingItemIds: [],
      desiredAdditionalClaims: task.consensusPolicy.minSubmissions,
      needsMinimumCoverage: true,
      needsRedundantCoverage: false,
      prefersFreshContributor: task.consensusPolicy.requireDistinctAgents,
      reassignmentPreferred: false,
      reason: "item is scheduler-ready for another claim",
      strategy: task.consensusPolicy.requireDistinctAgents ? "distinct" : "single",
      unresolvedDependencyCount: 0,
    },
    runs: [],
    scopeKey: task.scopeKey,
    sourceType: task.taskType,
    status,
    subjectId: `claim:${task.claimId}`,
    title: `Review ${task.taskType}`,
    updatedAt: task.updatedAt,
  };
}

function buildClaimReviewState(tasks: ReviewTaskView[] = []): ClaimReviewState {
  return {
    agentCalibration: [],
    certifications: [],
    explanation: {
      materialSignals: [],
      missingPrerequisites: [],
      recentChanges: [],
      supportNarrative: "Support is still building.",
      uncertaintyNarrative: "Uncertainty remains moderate.",
    },
    estimates: {
      supportEstimateBps: 6_000,
      uncertaintyBps: 4_000,
    },
    recentResponses: [],
    recentSubmissions: [],
    summary: {
      distinctAgents: 0,
      openIssues: 0,
      openTasks: tasks.length,
      respondedIssues: 0,
      responses: 0,
      submissions: 0,
      taskTypesCovered: 0,
      tasks: tasks.length,
    },
    tasks,
    vector: [],
  };
}

function buildClaimDetail(review: ClaimReviewState): ClaimDetailResponse {
  return {
    artifacts: [],
    appeals: [],
    author: "0x0000000000000000000000000000000000000001",
    challenges: [],
    checkpoints: [],
    claimId: "9",
    collectionCounts: {
      appeals: 0,
      artifacts: 0,
      challenges: 0,
      checkpoints: 0,
      forecasts: 0,
      replications: 0,
    },
    createdAtBlock: 100,
    domainId: 1,
    forecasts: [],
    metadataHash: "0xmeta",
    replications: [],
    resolutionModule: "0x0000000000000000000000000000000000000010",
    review,
    revisionOfClaimId: null,
    status: 1,
  };
}

function buildReplicationWorkItem(
  input: Partial<ClaimWorkItemView> & Pick<ClaimWorkItemView, "claimId" | "itemId">,
): ClaimWorkItemView {
  const status = input.status ?? "open";
  const canClaim = input.orchestration?.canClaim ?? status === "open";
  return {
    activeRun: null,
    agentActions: {
      claim: "replication_job_claim",
      heartbeat: "replication_job_heartbeat",
      submit: ["replication_job_submission"],
    },
    claimId: input.claimId,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? "2026-04-07T12:00:00.000Z",
    description:
      input.description ??
      "Offchain replication brief that can produce a typed scientific replication record.",
    itemId: input.itemId,
    kind: "replication_job",
    lane: "execution",
    orchestration: input.orchestration ?? {
      activeRunCount: 0,
      attemptCount: 0,
      canClaim,
      canReassign: false,
      completedRunCount: 0,
      contributorsNeeded: 1,
      distinctContributorCount: 0,
      distinctContributorShortfall: 0,
      failedRunCount: 0,
      minimumContributorsNeeded: 1,
      minimumSatisfied: false,
      recommendedAction: canClaim ? "claim" : "closed",
      remainingContributorSlots: 1,
      requiresDistinctContributors: false,
      shouldEscalate: false,
      statusReason: canClaim ? "item is open and still needs additional contributions" : "closed",
      successfulContributionCount: 0,
      targetContributorsNeeded: 1,
      targetSatisfied: false,
      timedOutRunCount: 0,
    },
    policy: input.policy ?? {
      maxContributors: 1,
      minContributors: 1,
      requireDistinctAgents: false,
      requiredCapabilities: ["execution"],
    },
    relatedArtifactKeys: input.relatedArtifactKeys ?? [],
    result: input.result ?? null,
    routing: input.routing ?? {
      blockedByOpenWork: false,
      priorityBps: canClaim ? 6_800 : 0,
      rationale: canClaim ? ["currently claimable through the generic runtime"] : ["closed"],
      tier: canClaim ? "high" : "hold",
    },
    scheduling: input.scheduling ?? {
      autoClaimable: canClaim,
      blocker: canClaim ? null : "not_claimable",
      blockingItemIds: [],
      desiredAdditionalClaims: canClaim ? 1 : 0,
      needsMinimumCoverage: canClaim,
      needsRedundantCoverage: false,
      prefersFreshContributor: false,
      reassignmentPreferred: false,
      reason: canClaim ? "item is scheduler-ready for another claim" : "work item is not claimable",
      strategy: "single",
      unresolvedDependencyCount: 0,
    },
    runs: input.runs ?? [],
    scopeKey: input.scopeKey ?? input.itemId,
    sourceType: "replication_job",
    status,
    subjectId: input.subjectId ?? `claim:${input.claimId}`,
    title: input.title ?? "Replication Job",
    updatedAt: input.updatedAt ?? "2026-04-07T12:00:00.000Z",
  };
}

describe("reference work agent", () => {
  it("selects the highest-priority compatible claimable work item", () => {
    const selected = selectWorkItemForAgent(
      [
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:02:00.000Z",
              requiredCapabilities: ["statistics"],
              taskId: "3",
              taskType: "stats_sanity_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 9_100,
            rationale: ["reopened after earlier runs failed"],
            tier: "critical" as const,
          },
        },
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:01:00.000Z",
              requiredCapabilities: ["statistics"],
              taskId: "2",
              taskType: "stats_sanity_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 6_400,
            rationale: ["currently claimable through the generic runtime"],
            tier: "normal" as const,
          },
        },
      ],
      {
        capabilities: ["statistics"],
      },
    );

    expect(selected?.itemId).to.equal("review-task:3");
  });

  it("prefers reassignment-ready work ahead of ordinary fresh claims", () => {
    const selected = selectWorkItemForAgent(
      [
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:02:00.000Z",
              requiredCapabilities: ["statistics"],
              taskId: "3",
              taskType: "stats_sanity_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 9_200,
            rationale: ["currently claimable through the generic runtime"],
            tier: "critical" as const,
          },
          scheduling: {
            ...buildReviewWorkItem(
              buildReviewTask({
                claimId: "1",
                requiredCapabilities: ["statistics"],
                taskId: "3",
                taskType: "stats_sanity_check",
              }),
            ).scheduling,
            desiredAdditionalClaims: 1,
            reassignmentPreferred: false,
          },
        },
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:01:00.000Z",
              requiredCapabilities: ["statistics"],
              taskId: "2",
              taskType: "stats_sanity_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 8_800,
            rationale: ["reopened after earlier runs failed"],
            tier: "critical" as const,
          },
          scheduling: {
            ...buildReviewWorkItem(
              buildReviewTask({
                claimId: "1",
                requiredCapabilities: ["statistics"],
                taskId: "2",
                taskType: "stats_sanity_check",
              }),
            ).scheduling,
            reassignmentPreferred: true,
          },
        },
      ],
      {
        capabilities: ["statistics"],
      },
    );

    expect(selected?.itemId).to.equal("review-task:2");
  });

  it("prefers minimum-coverage work ahead of redundancy-only work", () => {
    const selected = selectWorkItemForAgent(
      [
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:02:00.000Z",
              requiredCapabilities: ["method-analysis"],
              taskId: "11",
              taskType: "method_consistency_check",
            }),
          ),
          orchestration: {
            ...buildReviewWorkItem(
              buildReviewTask({
                claimId: "1",
                requiredCapabilities: ["method-analysis"],
                taskId: "11",
                taskType: "method_consistency_check",
              }),
            ).orchestration,
            contributorsNeeded: 0,
            minimumContributorsNeeded: 0,
            minimumSatisfied: true,
            successfulContributionCount: 1,
            targetContributorsNeeded: 1,
            targetSatisfied: false,
          },
          scheduling: {
            ...buildReviewWorkItem(
              buildReviewTask({
                claimId: "1",
                requiredCapabilities: ["method-analysis"],
                taskId: "11",
                taskType: "method_consistency_check",
              }),
            ).scheduling,
            desiredAdditionalClaims: 1,
            needsMinimumCoverage: false,
            needsRedundantCoverage: true,
            prefersFreshContributor: true,
            reason:
              "minimum corroboration is satisfied, but scheduler still wants a fresh distinct contributor for stronger redundancy",
          },
          routing: {
            blockedByOpenWork: false,
            priorityBps: 9_300,
            rationale: ["scheduler still wants additional corroborating redundancy"],
            tier: "critical" as const,
          },
        },
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:01:00.000Z",
              requiredCapabilities: ["method-analysis"],
              taskId: "12",
              taskType: "method_consistency_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 7_200,
            rationale: [
              "claim state still needs additional contributions to reach minimum corroboration",
            ],
            tier: "high" as const,
          },
        },
      ],
      {
        capabilities: ["method-analysis"],
      },
    );

    expect(selected?.itemId).to.equal("review-task:12");
  });

  it("prefers fresh-contributor work ahead of otherwise similar ordinary work", () => {
    const selected = selectWorkItemForAgent(
      [
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:02:00.000Z",
              requiredCapabilities: ["statistics"],
              taskId: "3",
              taskType: "stats_sanity_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 8_900,
            rationale: ["currently claimable through the generic runtime"],
            tier: "critical" as const,
          },
          scheduling: {
            ...buildReviewWorkItem(
              buildReviewTask({
                claimId: "1",
                requiredCapabilities: ["statistics"],
                taskId: "3",
                taskType: "stats_sanity_check",
              }),
            ).scheduling,
            prefersFreshContributor: false,
          },
        },
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              createdAt: "2026-04-07T12:01:00.000Z",
              requiredCapabilities: ["statistics"],
              taskId: "2",
              taskType: "stats_sanity_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 8_500,
            rationale: ["consensus policy still needs additional distinct contributors"],
            tier: "critical" as const,
          },
          scheduling: {
            ...buildReviewWorkItem(
              buildReviewTask({
                claimId: "1",
                requiredCapabilities: ["statistics"],
                taskId: "2",
                taskType: "stats_sanity_check",
              }),
            ).scheduling,
            prefersFreshContributor: true,
          },
        },
      ],
      {
        capabilities: ["statistics"],
      },
    );

    expect(selected?.itemId).to.equal("review-task:2");
  });

  it("skips distinct-contributor work that the same agent already completed", () => {
    const selected = selectWorkItemForAgent(
      [
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              requiredCapabilities: ["statistics"],
              taskId: "4",
              taskType: "stats_sanity_check",
            }),
          ),
          orchestration: {
            ...buildReviewWorkItem(
              buildReviewTask({
                claimId: "1",
                requiredCapabilities: ["statistics"],
                taskId: "4",
                taskType: "stats_sanity_check",
              }),
            ).orchestration,
            completedRunCount: 1,
            contributorsNeeded: 1,
            distinctContributorCount: 1,
            distinctContributorShortfall: 1,
            successfulContributionCount: 1,
          },
          runs: [
            {
              agentId: "7",
              failureReason: null,
              finishedAt: "2026-04-07T12:03:00.000Z",
              lastHeartbeatAt: "2026-04-07T12:02:30.000Z",
              runId: "run-1",
              startedAt: "2026-04-07T12:02:00.000Z",
              status: "completed",
              workerId: "worker-7",
            },
          ],
          routing: {
            blockedByOpenWork: false,
            priorityBps: 9_100,
            rationale: ["consensus policy still needs additional distinct contributors"],
            tier: "critical" as const,
          },
        },
        {
          ...buildReviewWorkItem(
            buildReviewTask({
              claimId: "1",
              requiredCapabilities: ["statistics"],
              taskId: "5",
              taskType: "stats_sanity_check",
            }),
          ),
          routing: {
            blockedByOpenWork: false,
            priorityBps: 6_400,
            rationale: ["currently claimable through the generic runtime"],
            tier: "normal" as const,
          },
        },
      ],
      {
        agentId: "7",
        capabilities: ["statistics"],
      },
    );

    expect(selected?.itemId).to.equal("review-task:5");
  });

  it("dispatches a selected review work item through the generic work agent", async () => {
    const signer = Wallet.createRandom();
    const selectedTask = buildReviewTask({
      claimId: "9",
      createdAt: "2026-04-07T12:01:00.000Z",
      requiredCapabilities: ["method-analysis"],
      taskId: "2",
      taskType: "method_consistency_check",
    });
    const workItem = buildReviewWorkItem(selectedTask);
    const reviewState = buildClaimReviewState([selectedTask]);
    const claim = buildClaimDetail(reviewState);
    const claimedRequests: SignedAgentRequestBody[] = [];
    const submittedRequests: SignedAgentRequestBody[] = [];

    const client = {
      agent: {
        claimWorkItem: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          claimedRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              run: {
                agentId: "3",
                failureReason: null,
                finishedAt: null,
                lastHeartbeatAt: "2026-04-07T12:03:10.000Z",
                runId: "4",
                startedAt: "2026-04-07T12:03:00.000Z",
                status: "running" as const,
                taskId: "2",
                workerId: "agent-3-work-api-worker",
              },
              task: selectedTask,
            },
          };
        },
        heartbeatWorkItem: async () => ({
          ok: true as const,
          result: {
            agentId: "3",
            failureReason: null,
            finishedAt: null,
            lastHeartbeatAt: "2026-04-07T12:03:10.000Z",
            runId: "4",
            startedAt: "2026-04-07T12:03:00.000Z",
            status: "running" as const,
            taskId: "2",
            workerId: "agent-3-work-api-worker",
          },
        }),
        submitWorkResults: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          submittedRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              submission: {
                claimId: "9",
                confidenceBps: 6800,
                createdAt: "2026-04-07T12:04:00.000Z",
                dimensions: {
                  methodConsistency: 7800,
                },
                evidenceArtifactKey: null,
                payload: {},
                resultArtifactKey: "review-submission-result-1",
                reviewType: "method_consistency_check" as const,
                reviewerActor: signer.address,
                reviewerAgentId: "3",
                runId: "4",
                schemaVersion: "review-task.v1",
                submissionId: "5",
                taskId: "2",
                verdict: "pass" as const,
              },
              task: {
                ...selectedTask,
                completedAt: "2026-04-07T12:04:00.000Z",
                status: "completed" as const,
              },
            },
          };
        },
      },
      getClaim: async () => claim,
      getClaimReview: async () => reviewState,
      getPersistedArtifact: async () => {
        throw new Error("should not be called for review items");
      },
      getWorkItem: async () => ({
        agentActions: workItem.agentActions,
        claimId: "9",
        edges: [],
        item: workItem,
        source: {
          kind: "review_task" as const,
          runs: [],
          submissions: [],
          task: selectedTask,
        },
        subject: {
          href: "/claims/9/view",
          label: "Claim 9",
          subjectId: "claim:9",
          subjectType: "claim" as const,
        },
      }),
      listWorkItems: async () => ({
        items: [workItem],
        limit: 20,
        offset: 0,
        total: 1,
      }),
    };

    const result = await runReferenceWorkAgentOnce({
      agentId: "3",
      capabilities: ["method-analysis"],
      client,
      signer,
      workerId: "agent-3-work-api-worker",
    });

    expect(result.completed).to.equal(true);
    expect(result.kind).to.equal("review_task");
    expect(result.itemId).to.equal("review-task:2");
    expect(claimedRequests[0]?.envelope.actionType).to.equal("review_task_claim");
    expect(submittedRequests[0]?.envelope.actionType).to.equal("review_task_submission");
  });

  it("dispatches a selected replication work item through the generic work agent", async () => {
    const signer = Wallet.createRandom();
    const workItem = buildReplicationWorkItem({
      claimId: "9",
      itemId: "replication-job:6",
    });
    const reviewState = buildClaimReviewState([]);
    const claim = buildClaimDetail(reviewState);
    const claimedRequests: SignedAgentRequestBody[] = [];
    const submittedRequests: SignedAgentRequestBody[] = [];

    const client = {
      agent: {
        claimWorkItem: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          claimedRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              job: {
                assignedAgentId: "3",
                assignedAt: "2026-04-07T12:03:00.000Z",
                assignedWorker: "agent-3-work-api-worker",
                claimId: "9",
                completedAt: null,
                createdAt: "2026-04-07T12:01:00.000Z",
                evidenceHash: null,
                evidenceURI: null,
                failureReason: null,
                jobId: "6",
                onchainReplicationId: null,
                requestId: null,
                requestedBy: "test",
                resultArtifactKey: null,
                resultHash: null,
                specHash: "0xreplication-spec",
                specURI: "ipfs://replication-spec",
                status: "assigned" as const,
                submissionActor: null,
                submissionTxHash: null,
                submittedAt: null,
                updatedAt: "2026-04-07T12:03:00.000Z",
              },
              run: {
                agentId: "3",
                evidenceHash: null,
                evidenceURI: null,
                executionManifestHash: null,
                failureReason: null,
                finishedAt: null,
                jobId: "6",
                lastHeartbeatAt: "2026-04-07T12:03:10.000Z",
                requestId: null,
                resultArtifactKey: null,
                resultHash: null,
                runId: "4",
                startedAt: "2026-04-07T12:03:00.000Z",
                status: "running" as const,
                submissionTxHash: null,
                workerId: "agent-3-work-api-worker",
              },
            },
          };
        },
        heartbeatWorkItem: async () => ({
          ok: true as const,
          result: {
            agentId: "3",
            evidenceHash: null,
            evidenceURI: null,
            executionManifestHash: null,
            failureReason: null,
            finishedAt: null,
            jobId: "6",
            lastHeartbeatAt: "2026-04-07T12:03:10.000Z",
            requestId: null,
            resultArtifactKey: null,
            resultHash: null,
            runId: "4",
            startedAt: "2026-04-07T12:03:00.000Z",
            status: "running" as const,
            submissionTxHash: null,
            workerId: "agent-3-work-api-worker",
          },
        }),
        submitWorkResults: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          submittedRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              job: {
                assignedAgentId: "3",
                assignedAt: "2026-04-07T12:03:00.000Z",
                assignedWorker: "agent-3-work-api-worker",
                claimId: "9",
                completedAt: "2026-04-07T12:04:00.000Z",
                createdAt: "2026-04-07T12:01:00.000Z",
                evidenceHash: "0xreplication-result",
                evidenceURI: "ipfs://replication-result",
                failureReason: null,
                jobId: "6",
                onchainReplicationId: "8",
                requestId: "9",
                requestedBy: "test",
                resultArtifactKey: "replication-result-1",
                resultHash: "0xreplication-result",
                specHash: "0xreplication-spec",
                specURI: "ipfs://replication-spec",
                status: "completed" as const,
                submissionActor: signer.address,
                submissionTxHash: "0xfeed",
                submittedAt: "2026-04-07T12:04:00.000Z",
                updatedAt: "2026-04-07T12:04:00.000Z",
              },
              operatorRequestId: "9",
              resultArtifactKey: "replication-result-1",
              run: {
                agentId: "3",
                evidenceHash: "0xreplication-result",
                evidenceURI: "ipfs://replication-result",
                executionManifestHash: "0xreplication-result",
                failureReason: null,
                finishedAt: "2026-04-07T12:04:00.000Z",
                jobId: "6",
                lastHeartbeatAt: "2026-04-07T12:03:10.000Z",
                requestId: "9",
                resultArtifactKey: "replication-result-1",
                resultHash: "0xreplication-result",
                runId: "4",
                startedAt: "2026-04-07T12:03:00.000Z",
                status: "completed" as const,
                submissionTxHash: "0xfeed",
                workerId: "agent-3-work-api-worker",
              },
            },
          };
        },
      },
      getClaim: async () => claim,
      getClaimReview: async () => reviewState,
      getPersistedArtifact: async () => {
        throw new Error("should not be called for replication items");
      },
      getWorkItem: async () => ({
        agentActions: workItem.agentActions,
        claimId: "9",
        edges: [],
        item: workItem,
        source: {
          job: {
            assignedAgentId: null,
            assignedAt: null,
            assignedWorker: null,
            claimId: "9",
            completedAt: null,
            createdAt: "2026-04-07T12:01:00.000Z",
            evidenceHash: null,
            evidenceURI: null,
            failureReason: null,
            jobId: "6",
            onchainReplicationId: null,
            requestId: null,
            requestedBy: "test",
            resultArtifactKey: null,
            resultHash: null,
            specHash: "0xreplication-spec",
            specURI: "ipfs://replication-spec",
            status: "open" as const,
            submissionActor: null,
            submissionTxHash: null,
            submittedAt: null,
            updatedAt: "2026-04-07T12:01:00.000Z",
          },
          kind: "replication_job" as const,
          runs: [],
        },
        subject: {
          href: "/claims/9/view",
          label: "Claim 9",
          subjectId: "claim:9",
          subjectType: "claim" as const,
        },
      }),
      listWorkItems: async () => ({
        items: [workItem],
        limit: 20,
        offset: 0,
        total: 1,
      }),
    };

    const result = await runReferenceWorkAgentOnce({
      agentId: "3",
      capabilities: ["execution"],
      client,
      signer,
      workerId: "agent-3-work-api-worker",
    });

    expect(result.completed).to.equal(true);
    expect(result.kind).to.equal("replication_job");
    expect(result.itemId).to.equal("replication-job:6");
    expect(claimedRequests[0]?.envelope.actionType).to.equal("replication_job_claim");
    expect(submittedRequests[0]?.envelope.actionType).to.equal("replication_job_submission");
  });
});
