import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import { Wallet } from "ethers";
import {
  runReferenceArtifactMaintenanceAgentOnce,
  selectArtifactMaintenanceTaskForAgent,
} from "../src/artifacts/reference-agent.js";
import type {
  ArtifactMaintenanceTaskView,
  ClaimWorkItemView,
  PersistedArtifactDetailResponse,
  SignedAgentRequestBody,
} from "../src/sdk/types.js";
import { sha256Hex } from "../src/shared/persisted-artifacts.js";

function buildMaintenanceTask(
  input: Partial<ArtifactMaintenanceTaskView> &
    Pick<ArtifactMaintenanceTaskView, "artifactKey" | "taskId" | "taskType">,
): ArtifactMaintenanceTaskView {
  return {
    artifactKey: input.artifactKey,
    assignedAgentId: input.assignedAgentId ?? null,
    assignedAt: input.assignedAt ?? null,
    assignedWorker: input.assignedWorker ?? null,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? "2026-04-07T12:00:00.000Z",
    failureReason: input.failureReason ?? null,
    repairLocator: input.repairLocator ?? null,
    repairSourceReplicaKey: input.repairSourceReplicaKey ?? null,
    requestedBy: input.requestedBy ?? "test",
    resultArtifactKey: input.resultArtifactKey ?? null,
    status: input.status ?? "open",
    targetProvider: input.targetProvider ?? null,
    targetReplicaKey: input.targetReplicaKey ?? null,
    taskId: input.taskId,
    taskType: input.taskType,
    updatedAt: input.updatedAt ?? "2026-04-07T12:00:00.000Z",
  };
}

function buildMaintenanceWorkItem(task: ArtifactMaintenanceTaskView): ClaimWorkItemView {
  const status = task.status === "open" ? "open" : task.status;
  return {
    activeRun: null,
    agentActions: {
      claim: "artifact_task_claim",
      heartbeat: "artifact_task_heartbeat",
      submit: [
        task.taskType === "repair"
          ? "artifact_task_repair_submission"
          : "artifact_task_audit_submission",
      ],
    },
    claimId: "1",
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    description: `Artifact ${task.taskType} task`,
    itemId: `artifact-maintenance:${task.taskId}`,
    kind: "artifact_maintenance",
    lane: "maintenance",
    orchestration: {
      activeRunCount: 0,
      attemptCount: 0,
      canClaim: status === "open",
      canReassign: false,
      completedRunCount: 0,
      contributorsNeeded: 1,
      distinctContributorCount: 0,
      distinctContributorShortfall: 0,
      failedRunCount: 0,
      minimumContributorsNeeded: 1,
      minimumSatisfied: false,
      recommendedAction: status === "open" ? "claim" : "closed",
      remainingContributorSlots: 1,
      requiresDistinctContributors: false,
      shouldEscalate: false,
      statusReason:
        status === "open" ? "item is open and still needs additional contributions" : "closed",
      successfulContributionCount: 0,
      targetContributorsNeeded: 1,
      targetSatisfied: false,
      timedOutRunCount: 0,
    },
    policy: {
      maxContributors: 1,
      minContributors: 1,
      requireDistinctAgents: false,
      requiredCapabilities: task.taskType === "repair" ? ["artifact-repair"] : ["artifact-audit"],
    },
    relatedArtifactKeys: [task.artifactKey],
    result: null,
    routing: {
      blockedByOpenWork: false,
      priorityBps: status === "open" ? 6_800 : 0,
      rationale:
        status === "open"
          ? ["currently claimable through the generic runtime"]
          : ["work item is not claimable"],
      tier: status === "open" ? "high" : "hold",
    },
    scheduling: {
      autoClaimable: status === "open",
      blocker: status === "open" ? null : "not_claimable",
      blockingItemIds: [],
      desiredAdditionalClaims: status === "open" ? 1 : 0,
      needsMinimumCoverage: status === "open",
      needsRedundantCoverage: false,
      prefersFreshContributor: false,
      reassignmentPreferred: false,
      reason:
        status === "open"
          ? "item is scheduler-ready for another claim"
          : "work item is not claimable",
      strategy: "single",
      unresolvedDependencyCount: 0,
    },
    runs: [],
    scopeKey: task.targetReplicaKey,
    sourceType: task.taskType,
    status,
    subjectId: `persisted-artifact:${task.artifactKey}`,
    title: `Artifact ${task.taskType}`,
    updatedAt: task.updatedAt,
  };
}

describe("reference artifact maintenance agent", () => {
  it("selects the oldest compatible open maintenance task", () => {
    const selected = selectArtifactMaintenanceTaskForAgent(
      [
        {
          canClaim: true,
          createdAt: "2026-04-07T12:02:00.000Z",
          itemId: "artifact-maintenance:3",
          requiredCapabilities: ["artifact-repair"],
          taskId: "3",
          taskType: "repair",
        },
        {
          canClaim: true,
          createdAt: "2026-04-07T12:01:00.000Z",
          itemId: "artifact-maintenance:2",
          requiredCapabilities: ["artifact-audit"],
          taskId: "2",
          taskType: "audit",
        },
      ],
      {
        capabilities: ["artifact-audit"],
      },
    );

    expect(selected?.taskId).to.equal("2");
  });

  it("claims and submits an audit maintenance task through the public API", async () => {
    const signer = Wallet.createRandom();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-maint-agent-"));
    const artifactPath = path.join(tempRoot, "artifact.json");
    const artifactBytes = Buffer.from(JSON.stringify({ ok: true }), "utf8");
    await writeFile(artifactPath, artifactBytes);
    const artifactSha = `0x${sha256Hex(artifactBytes)}`;

    const selectedTask = buildMaintenanceTask({
      artifactKey: "replication-result-abc123",
      createdAt: "2026-04-07T12:01:00.000Z",
      taskId: "2",
      taskType: "audit",
    });
    const incompatibleTask = buildMaintenanceTask({
      artifactKey: "replication-result-def456",
      createdAt: "2026-04-07T12:00:00.000Z",
      taskId: "1",
      taskType: "repair",
    });
    const artifact: PersistedArtifactDetailResponse = {
      artifactKey: "replication-result-abc123",
      byteLength: artifactBytes.byteLength,
      contentType: "application/json",
      createdAt: "2026-04-07T12:00:00.000Z",
      kind: "replication-result",
      provenance: null,
      recentAudits: {
        items: [],
        limit: 10,
        offset: 0,
        total: 0,
      },
      replicas: [
        {
          createdAt: "2026-04-07T12:00:00.000Z",
          isPrimary: true,
          lastCheckError: null,
          lastCheckStatus: "verified",
          lastCheckedAt: "2026-04-07T12:00:00.000Z",
          locator: artifactPath,
          provider: "filesystem",
          replicaKey: "primary",
          updatedAt: "2026-04-07T12:00:00.000Z",
        },
      ],
      sha256: artifactSha,
      storagePath: artifactPath,
    };

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
                lastHeartbeatAt: "2026-04-07T12:03:10.000Z",
                runId: "4",
                startedAt: "2026-04-07T12:03:00.000Z",
                status: "running" as const,
                summaryArtifactKey: null,
                taskId: "2",
                workerId: "agent-3-maintenance-api-worker",
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
              lastHeartbeatAt: "2026-04-07T12:03:10.000Z",
              runId: "4",
              startedAt: "2026-04-07T12:03:00.000Z",
              status: "running" as const,
              summaryArtifactKey: null,
              taskId: "2",
              workerId: "agent-3-maintenance-api-worker",
            },
          };
        },
        submitWorkResults: async (_itemId: string, signedRequest: SignedAgentRequestBody) => {
          submittedRequests.push(signedRequest);
          return {
            ok: true as const,
            result: {
              createdRepairTasks: [],
              task: {
                ...selectedTask,
                completedAt: "2026-04-07T12:04:00.000Z",
                resultArtifactKey: "artifact-maintenance-agent-audit-result-1",
                status: "completed" as const,
              },
            },
          };
        },
      },
      getPersistedArtifact: async () => artifact,
      getWorkItem: async () => ({
        agentActions: buildMaintenanceWorkItem(selectedTask).agentActions,
        claimId: "1",
        edges: [],
        item: buildMaintenanceWorkItem(selectedTask),
        source: {
          kind: "artifact_maintenance" as const,
          runs: [],
          task: selectedTask,
        },
        subject: {
          href: `/persisted-artifacts/${selectedTask.artifactKey}/view`,
          label: selectedTask.artifactKey,
          subjectId: `persisted-artifact:${selectedTask.artifactKey}`,
          subjectType: "persisted_artifact" as const,
        },
      }),
      listWorkItems: async () => ({
        items: [buildMaintenanceWorkItem(incompatibleTask), buildMaintenanceWorkItem(selectedTask)],
        limit: 20,
        offset: 0,
        total: 2,
      }),
    };

    try {
      const result = await runReferenceArtifactMaintenanceAgentOnce({
        agentId: "3",
        capabilities: ["artifact-audit"],
        client,
        signer,
        workerId: "agent-3-maintenance-api-worker",
      });

      expect(result.completed).to.equal(true);
      expect(result.taskId).to.equal("2");
      expect(result.artifactKey).to.equal("replication-result-abc123");
      expect(claimedRequests).to.have.length(1);
      expect(heartbeatRequests).to.have.length(1);
      expect(submittedRequests).to.have.length(1);
      expect(claimedRequests[0]?.envelope.actionType).to.equal("artifact_task_claim");
      expect(heartbeatRequests[0]?.envelope.actionType).to.equal("artifact_task_heartbeat");
      expect(submittedRequests[0]?.envelope.actionType).to.equal("artifact_task_audit_submission");
      expect(submittedRequests[0]?.envelope.scopeKey).to.equal("artifact-maintenance-task:2");
      expect(Array.isArray(submittedRequests[0]?.envelope.payload.audits)).to.equal(true);
      expect(
        (submittedRequests[0]?.envelope.payload.audits as Array<{ status: string }>)[0]?.status,
      ).to.equal("verified");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
