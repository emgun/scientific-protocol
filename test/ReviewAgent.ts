import { describe, it } from "node:test";
import { expect } from "chai";
import { Wallet } from "ethers";
import {
  runReferenceReviewAgentOnce,
  selectReviewTaskForAgent,
} from "../src/review/reference-agent.js";
import type { ClaimReviewState, ReviewTaskView } from "../src/review/types.js";
import { createSignedAgentRequest, verifyAgentRequestEnvelope } from "../src/sdk/index.js";
import type {
  ClaimDetailResponse,
  ClaimWorkItemView,
  SignedAgentRequestBody,
  SourceDetailResponse,
} from "../src/sdk/types.js";
import {
  type PersistedArtifactRecord,
  readVerifiedJsonArtifact,
} from "../src/shared/persisted-artifacts.js";

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
    createdAt: input.createdAt ?? "2026-04-06T12:00:00.000Z",
    failureReason: input.failureReason ?? null,
    inputArtifactKeys: input.inputArtifactKeys ?? [],
    requestedBy: input.requestedBy ?? "test",
    requiredCapabilities: input.requiredCapabilities ?? [],
    resultArtifactKey: input.resultArtifactKey ?? null,
    schemaVersion: input.schemaVersion ?? "review-task.v1",
    scopeKey: input.scopeKey ?? input.taskType,
    sourceId: input.sourceId ?? null,
    subjectId:
      input.subjectId ??
      (input.sourceId ? `source:${input.sourceId}` : `claim:${input.claimId ?? "unknown"}`),
    subjectType: input.subjectType ?? (input.sourceId ? "source_record" : "claim"),
    status: input.status ?? "open",
    taskId: input.taskId,
    taskType: input.taskType,
    updatedAt: input.updatedAt ?? "2026-04-06T12:00:00.000Z",
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
    artifacts: [
      {
        artifactId: "1",
        artifactType: 5,
        claimId: "9",
        contentDigest: "0xmanuscript",
        submitter: "0x0000000000000000000000000000000000000001",
        uri: "ipfs://manuscript",
      },
      {
        artifactId: "2",
        artifactType: 1,
        claimId: "9",
        contentDigest: "0xcode",
        submitter: "0x0000000000000000000000000000000000000001",
        uri: "ipfs://code",
      },
    ],
    appeals: [],
    author: "0x0000000000000000000000000000000000000001",
    challenges: [],
    checkpoints: [],
    claimId: "9",
    collectionCounts: {
      appeals: 0,
      artifacts: 2,
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

function buildSourceDetail(task: ReviewTaskView): SourceDetailResponse {
  return {
    candidates: [],
    publicationDecisions: {
      items: [],
      limit: 20,
      offset: 0,
      total: 0,
    },
    source: {
      canonicalSourceKey: "arxiv:2405.15793",
      createdAt: "2026-04-06T12:00:00.000Z",
      discoveryMode: "agent_discovered",
      extractionArtifactKey: "source-extraction-preview-1",
      publishedClaimId: null,
      snapshotArtifactKey: "source-snapshot-1",
      sourceId: task.sourceId ?? "17",
      sourceMetadata: {
        locator: "https://arxiv.org/abs/2405.15793",
        preview: {
          candidateStatements: [
            "SWE-agent resolves significantly more real GitHub issues than earlier autonomous coding agents.",
          ],
          extractedTextPreview:
            "We introduce SWE-agent, an autonomous software engineering system that resolves more real GitHub issues than prior approaches.",
          methodology: "Evaluation on SWE-bench style GitHub issue resolution tasks.",
          scope: "GitHub issue resolution performance for autonomous software engineering agents.",
          statement:
            "SWE-agent resolves significantly more real GitHub issues than earlier autonomous coding agents.",
          title: "SWE-agent",
        },
        title: "SWE-agent",
      },
      sourceType: "url",
      status: "extracting",
      submittedByActor: null,
      submittedByAgentId: "3",
      updatedAt: "2026-04-06T12:00:00.000Z",
    },
    tasks: [task],
    workGraph: {
      edges: [],
      items: [buildReviewWorkItem(task)],
      sourceId: task.sourceId ?? "17",
      subjects: [
        {
          href: `/sources/${task.sourceId ?? "17"}/view`,
          label: "SWE-agent",
          subjectId: `source:${task.sourceId ?? "17"}`,
          subjectType: "source_record",
        },
      ],
      summary: {
        activeLeases: 0,
        autoClaimableItems: task.status === "open" ? 1 : 0,
        completedItems: task.status === "completed" ? 1 : 0,
        dependencyBlockedItems: 0,
        failedItems: 0,
        freshContributorItems: 0,
        lanes: {
          evaluation: task.taskType === "claim_extraction_check" ? 1 : 0,
          execution: 0,
          maintenance: 0,
          synthesis: task.taskType === "claim_extraction_synthesis_check" ? 1 : 0,
        },
        latestActivityAt: task.updatedAt,
        minimumCoverageItems: task.status === "open" ? 1 : 0,
        openItems: task.status === "open" ? 1 : 0,
        participatingAgents: 0,
        reassignmentReadyItems: 0,
        redundancyTargetItems: 0,
        totalItems: 1,
        uncoveredDemand: task.status === "open" ? 1 : 0,
      },
    },
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
    result: task.resultArtifactKey
      ? {
          artifactKey: task.resultArtifactKey,
          confidenceBps: null,
          createdAt: task.completedAt,
          label: "Review task complete",
          summary: "A review submission was accepted for this work item.",
          type: "review_submission",
          verdict: null,
        }
      : null,
    routing: {
      blockedByOpenWork: false,
      priorityBps: status === "open" ? 6_500 : 0,
      rationale:
        status === "open"
          ? ["currently claimable through the generic runtime"]
          : ["work item is not claimable"],
      tier: status === "open" ? "high" : "hold",
    },
    scheduling: {
      autoClaimable: status === "open" && task.consensusPolicy.minSubmissions > 0,
      blocker: status === "open" ? null : "not_claimable",
      blockingItemIds: [],
      desiredAdditionalClaims: status === "open" ? task.consensusPolicy.minSubmissions : 0,
      needsMinimumCoverage: status === "open" && task.consensusPolicy.minSubmissions > 0,
      needsRedundantCoverage: false,
      prefersFreshContributor: task.consensusPolicy.requireDistinctAgents,
      reassignmentPreferred: false,
      reason:
        status === "open"
          ? "item is scheduler-ready for another claim"
          : "work item is not claimable",
      strategy:
        task.taskType === "certification_synthesis_check"
          ? "synthesis"
          : task.consensusPolicy.requireDistinctAgents
            ? "distinct"
            : "single",
      unresolvedDependencyCount: 0,
    },
    runs: [],
    scopeKey: task.scopeKey,
    sourceType: task.taskType,
    status,
    subjectId: "claim:9",
    title: `Review ${task.taskType}`,
    updatedAt: task.updatedAt,
  };
}

describe("reference review agent", () => {
  it("creates verifiable signed agent requests", async () => {
    const signer = Wallet.createRandom();
    const signed = await createSignedAgentRequest({
      actionType: "review_task_claim",
      agentId: "7",
      payload: {
        workerId: "review-worker-a",
      },
      requestNonce: "nonce-1",
      scopeKey: "review-task:11",
      signer,
    });

    const verified = verifyAgentRequestEnvelope(signed);
    expect(verified.recoveredAddress.toLowerCase()).to.equal(signer.address.toLowerCase());
    expect(signed.envelope.scopeKey).to.equal("review-task:11");
  });

  it("selects the oldest compatible open task", () => {
    const selected = selectReviewTaskForAgent(
      [
        {
          canClaim: true,
          claimId: "1",
          createdAt: "2026-04-06T12:02:00.000Z",
          itemId: "review-task:3",
          requiredCapabilities: ["statistics"],
          sourceId: null,
          taskId: "3",
          taskType: "stats_sanity_check",
        },
        {
          canClaim: true,
          claimId: "1",
          createdAt: "2026-04-06T12:01:00.000Z",
          itemId: "review-task:2",
          requiredCapabilities: ["method-analysis"],
          sourceId: null,
          taskId: "2",
          taskType: "method_consistency_check",
        },
      ],
      {
        capabilities: ["method-analysis"],
      },
    );

    expect(selected?.taskId).to.equal("2");
  });

  it("claims and submits a compatible review task through the public API", async () => {
    const signer = Wallet.createRandom();
    const selectedTask = buildReviewTask({
      claimId: "9",
      createdAt: "2026-04-06T12:01:00.000Z",
      requiredCapabilities: ["method-analysis"],
      taskId: "2",
      taskType: "method_consistency_check",
    });
    const incompatibleTask = buildReviewTask({
      claimId: "8",
      createdAt: "2026-04-06T12:00:00.000Z",
      requiredCapabilities: ["statistics"],
      taskId: "1",
      taskType: "stats_sanity_check",
    });
    const reviewState = buildClaimReviewState([selectedTask]);
    const claim = buildClaimDetail(reviewState);

    const claimedRequests: SignedAgentRequestBody[] = [];
    const heartbeatRequests: SignedAgentRequestBody[] = [];
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
                lastHeartbeatAt: "2026-04-06T12:03:10.000Z",
                runId: "4",
                startedAt: "2026-04-06T12:03:00.000Z",
                status: "running" as const,
                taskId: "2",
                workerId: "agent-3-review-api-worker",
              },
              task: selectedTask,
            },
          };
        },
        heartbeatWorkItem: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          heartbeatRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              agentId: "3",
              failureReason: null,
              finishedAt: null,
              lastHeartbeatAt: "2026-04-06T12:03:10.000Z",
              runId: "4",
              startedAt: "2026-04-06T12:03:00.000Z",
              status: "running" as const,
              taskId: "2",
              workerId: "agent-3-review-api-worker",
            },
          };
        },
        submitWorkResults: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          submittedRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              submission: {
                claimId: "9",
                confidenceBps: 6800,
                createdAt: "2026-04-06T12:04:00.000Z",
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
                completedAt: "2026-04-06T12:04:00.000Z",
                status: "completed",
              },
            },
          };
        },
      },
      getClaim: async () => claim,
      getClaimReview: async () => reviewState,
      getReviewTask: async () => ({
        runs: [],
        submissions: [],
        task: selectedTask,
      }),
      getSource: async () => buildSourceDetail(selectedTask),
      getWorkItem: async () => ({
        claimId: "9",
        edges: [],
        item: buildReviewWorkItem(selectedTask),
        subject: {
          href: "/claims/9/view",
          label: "Claim 9",
          subjectId: "claim:9",
          subjectType: "claim" as const,
        },
      }),
      listWorkItems: async () => ({
        items: [buildReviewWorkItem(incompatibleTask), buildReviewWorkItem(selectedTask)],
        limit: 20,
        offset: 0,
        total: 2,
      }),
      listReviewTasks: async () => ({
        items: [],
        limit: 20,
        offset: 0,
        total: 0,
      }),
    };

    const result = await runReferenceReviewAgentOnce({
      agentId: "3",
      capabilities: ["method-analysis"],
      client,
      signer,
      workerId: "agent-3-review-api-worker",
    });

    expect(result.completed).to.equal(true);
    expect(result.taskId).to.equal("2");
    expect(result.claimId).to.equal("9");
    expect(result.submissionId).to.equal("5");
    expect(claimedRequests).to.have.length(1);
    expect(heartbeatRequests).to.have.length(1);
    expect(submittedRequests).to.have.length(1);
    expect(claimedRequests[0]?.envelope.actionType).to.equal("review_task_claim");
    expect(claimedRequests[0]?.envelope.scopeKey).to.equal("review-task:2");
    expect(heartbeatRequests[0]?.envelope.actionType).to.equal("review_task_heartbeat");
    expect(submittedRequests[0]?.envelope.actionType).to.equal("review_task_submission");
    expect(submittedRequests[0]?.envelope.payload.verdict).to.equal("pass");
    const resultArtifact = submittedRequests[0]?.envelope.payload
      .resultArtifact as PersistedArtifactRecord;
    expect(resultArtifact.kind).to.equal("agent-review-submission-result");
    expect(await readVerifiedJsonArtifact(resultArtifact)).to.include({
      claimId: "9",
      reportedBy: signer.address,
      taskId: "2",
      verdict: "pass",
    });
  });

  it("submits deterministic candidate claims for source-backed extraction tasks", async () => {
    const signer = Wallet.createRandom();
    const extractionTask = buildReviewTask({
      claimId: null,
      requiredCapabilities: ["claim-extraction", "literature-scan"],
      sourceId: "17",
      taskId: "11",
      taskType: "claim_extraction_check",
    });
    const submittedRequests: SignedAgentRequestBody[] = [];

    const client = {
      agent: {
        claimWorkItem: async () => ({
          ok: true as const,
          result: {
            run: {
              agentId: "3",
              failureReason: null,
              finishedAt: null,
              lastHeartbeatAt: null,
              runId: "44",
              startedAt: "2026-04-06T12:00:00.000Z",
              status: "running" as const,
              taskId: "11",
              workerId: "agent-3-review-api-worker",
            },
            task: extractionTask,
          },
        }),
        heartbeatWorkItem: async () => ({
          ok: true as const,
          result: {
            agentId: "3",
            failureReason: null,
            finishedAt: null,
            lastHeartbeatAt: "2026-04-06T12:01:00.000Z",
            runId: "44",
            startedAt: "2026-04-06T12:00:00.000Z",
            status: "running" as const,
            taskId: "11",
            workerId: "agent-3-review-api-worker",
          },
        }),
        submitWorkResults: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          submittedRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              submission: {
                claimId: null,
                confidenceBps: 7200,
                createdAt: "2026-04-06T12:02:00.000Z",
                dimensions: {},
                evidenceArtifactKey: null,
                payload: signedRequest.envelope.payload,
                resultArtifactKey: null,
                reviewType: "claim_extraction_check" as const,
                reviewerActor: signer.address,
                reviewerAgentId: "3",
                runId: "44",
                schemaVersion: "review-submission.v1",
                sourceId: "17",
                submissionId: "55",
                taskId: "11",
                verdict: "pass" as const,
              },
              task: {
                ...extractionTask,
                completedAt: "2026-04-06T12:02:00.000Z",
                status: "completed",
              },
            },
          };
        },
      },
      getClaim: async () => {
        throw new Error("unexpected_getClaim");
      },
      getClaimReview: async () => {
        throw new Error("unexpected_getClaimReview");
      },
      getReviewTask: async () => ({
        runs: [],
        submissions: [],
        task: extractionTask,
      }),
      getSource: async () => buildSourceDetail(extractionTask),
      getWorkItem: async () => ({
        claimId: null,
        edges: [],
        item: null,
        source: null,
        subject: null,
      }),
      listReviewTasks: async () => ({
        items: [extractionTask],
        limit: 20,
        offset: 0,
        total: 1,
      }),
      listWorkItems: async () => ({
        items: [],
        limit: 20,
        offset: 0,
        total: 0,
      }),
    };

    const result = await runReferenceReviewAgentOnce({
      agentId: "3",
      capabilities: ["claim-extraction", "literature-scan"],
      client,
      signer,
      taskType: "claim_extraction_check",
      workerId: "agent-3-review-api-worker",
    });

    expect(result.completed).to.equal(true);
    expect(result.sourceId).to.equal("17");
    expect(result.claimId).to.equal(undefined);
    expect(submittedRequests).to.have.length(1);
    expect(submittedRequests[0]?.envelope.payload.candidateClaim).to.deep.include({
      claimType: "general",
      scope: "GitHub issue resolution performance for autonomous software engineering agents.",
      statement:
        "SWE-agent resolves significantly more real GitHub issues than earlier autonomous coding agents.",
    });
  });
});
