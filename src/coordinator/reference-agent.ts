import { randomUUID } from "node:crypto";
import type { ScientificProtocolClient } from "../sdk/client.js";
import { ScientificProtocolApiError } from "../sdk/client.js";
import type {
  ClaimDetailResponse,
  ClaimWorkItemView,
  ReplicationJobRunView,
  ReplicationJobView,
} from "../sdk/types.js";
import {
  type AgentRequestSigner,
  createSignedAgentRequest,
} from "../shared/agent-request-envelope.js";

type ReplicationAgentClient = Pick<
  ScientificProtocolClient,
  "getClaim" | "getWorkItem" | "listWorkItems"
> & {
  agent: Pick<
    ScientificProtocolClient["agent"],
    "claimWorkItem" | "heartbeatWorkItem" | "submitWorkResults"
  >;
};

type ReplicationJobCandidate = {
  canClaim: boolean;
  claimId: string;
  createdAt: string;
  itemId: string;
  jobId: string;
  requiredCapabilities: string[];
};

export type ReferenceReplicationAgentOptions = {
  actorAddress?: string;
  agentId: string;
  capabilities?: string[];
  client: ReplicationAgentClient;
  jobId?: string;
  limit?: number;
  signer: AgentRequestSigner;
  workerId: string;
};

export type ReferenceReplicationAgentRunResult = {
  claimId?: string;
  completed?: boolean;
  idle?: boolean;
  itemId?: string;
  jobId?: string;
  message?: string;
  onchainReplicationId?: string | null;
  operatorRequestId?: string | null;
  resultArtifactKey?: string | null;
  runId?: string;
  workerId: string;
};

function normalizeCapabilities(input: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (input ?? [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
}

export function replicationJobMatchesCapabilities(
  job: Pick<ReplicationJobCandidate, "requiredCapabilities">,
  capabilities?: string[],
): boolean {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.length === 0) {
    return true;
  }
  const capabilitySet = new Set(normalized);
  return job.requiredCapabilities.every((capability) => capabilitySet.has(capability));
}

export function selectReplicationJobForAgent(
  jobs: ReplicationJobCandidate[],
  options: {
    capabilities?: string[];
    jobId?: string;
  } = {},
): ReplicationJobCandidate | null {
  const matching = jobs
    .filter((job) => job.canClaim)
    .filter((job) => !options.jobId || job.jobId === options.jobId)
    .filter((job) => replicationJobMatchesCapabilities(job, options.capabilities))
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }
      return left.jobId.localeCompare(right.jobId);
    });
  return matching[0] ?? null;
}

function toReplicationJobCandidate(item: ClaimWorkItemView): ReplicationJobCandidate | null {
  if (item.kind !== "replication_job" || !item.claimId) {
    return null;
  }
  return {
    canClaim: item.orchestration.canClaim,
    claimId: item.claimId,
    createdAt: item.createdAt,
    itemId: item.itemId,
    jobId: item.itemId.startsWith("replication-job:")
      ? item.itemId.slice("replication-job:".length)
      : item.itemId,
    requiredCapabilities: item.policy?.requiredCapabilities ?? [],
  };
}

function isReplicationJobClaimResult(result: unknown): result is {
  job: ReplicationJobView;
  run: ReplicationJobRunView;
} {
  if (!result || typeof result !== "object") {
    return false;
  }
  const value = result as Record<string, unknown>;
  const job = value.job as Record<string, unknown> | undefined;
  return (
    !!job &&
    typeof value.run === "object" &&
    typeof job.jobId === "string" &&
    typeof job.claimId === "string"
  );
}

function isReplicationJobSubmissionResult(result: unknown): result is {
  job: ReplicationJobView;
  operatorRequestId: string;
  resultArtifactKey: string;
  run: ReplicationJobRunView;
} {
  if (!result || typeof result !== "object") {
    return false;
  }
  const value = result as Record<string, unknown>;
  const job = value.job as Record<string, unknown> | undefined;
  return (
    !!job &&
    typeof value.operatorRequestId === "string" &&
    typeof value.resultArtifactKey === "string" &&
    typeof value.run === "object"
  );
}

async function listCandidateJobs(
  client: ReplicationAgentClient,
  options: Pick<ReferenceReplicationAgentOptions, "jobId" | "limit">,
): Promise<ReplicationJobCandidate[]> {
  if (options.jobId) {
    const detail = await client.getWorkItem(`replication-job:${options.jobId}`);
    return detail.item
      ? [detail.item]
          .map(toReplicationJobCandidate)
          .filter((job): job is ReplicationJobCandidate => job !== null)
      : [];
  }

  const page = await client.listWorkItems({
    claimable: true,
    kind: "replication_job",
    limit: options.limit ?? 20,
    offset: 0,
    status: "open",
  });
  return page.items
    .map(toReplicationJobCandidate)
    .filter((job): job is ReplicationJobCandidate => job !== null);
}

function isClaimConflict(error: unknown): boolean {
  return error instanceof ScientificProtocolApiError && error.status === 409;
}

async function claimJob(
  input: Pick<
    ReferenceReplicationAgentOptions,
    "actorAddress" | "agentId" | "client" | "signer"
  > & {
    job: ReplicationJobCandidate;
    workerId: string;
  },
): Promise<{ job: ReplicationJobView; run: ReplicationJobRunView }> {
  const signedClaim = await createSignedAgentRequest({
    actionType: "replication_job_claim",
    actorAddress: input.actorAddress,
    agentId: input.agentId,
    payload: {
      workerId: input.workerId,
    },
    requestNonce: randomUUID(),
    scopeKey: `replication-job:${input.job.jobId}`,
    signer: input.signer,
  });
  const claimed = await input.client.agent.claimWorkItem(input.job.itemId, signedClaim);
  if (!isReplicationJobClaimResult(claimed.result)) {
    throw new Error("unexpected_replication_job_claim_result");
  }
  return claimed.result;
}

async function heartbeatClaimedRun(
  input: Pick<
    ReferenceReplicationAgentOptions,
    "actorAddress" | "agentId" | "client" | "signer"
  > & {
    jobId: string;
    runId: string;
    workerId: string;
  },
): Promise<void> {
  const signedHeartbeat = await createSignedAgentRequest({
    actionType: "replication_job_heartbeat",
    actorAddress: input.actorAddress,
    agentId: input.agentId,
    payload: {
      runId: input.runId,
      workerId: input.workerId,
    },
    requestNonce: randomUUID(),
    scopeKey: `replication-job:${input.jobId}`,
    signer: input.signer,
  });
  await input.client.agent.heartbeatWorkItem(`replication-job:${input.jobId}`, signedHeartbeat);
}

function buildReplicationSubmissionPayload(
  claim: ClaimDetailResponse,
  input: {
    jobId: string;
    runId: string;
    workerId: string;
  },
): Record<string, unknown> {
  const artifactCount = claim.artifacts?.length ?? claim.collectionCounts.artifacts;
  const supportiveReplications =
    claim.replications?.filter(
      (replication: { outcome?: number; resolutionStatus?: number }) =>
        replication.resolutionStatus === 1 ||
        replication.resolutionStatus === 2 ||
        replication.outcome === 1 ||
        replication.outcome === 2,
    ).length ?? 0;
  const confidenceBps = supportiveReplications > 0 ? 8_200 : 7_200;
  return {
    claimSnapshot: {
      artifactCount,
      challengeCount: claim.collectionCounts.challenges,
      checkpointCount: claim.collectionCounts.checkpoints,
      claimId: claim.claimId,
      domainId: claim.domainId,
      forecastCount: claim.collectionCounts.forecasts,
      supportiveReplications,
    },
    confidenceBps,
    executionProfile: "reference-replication",
    jobId: input.jobId,
    runId: input.runId,
    summary:
      artifactCount > 0
        ? `Reference agent prepared a replication bundle for claim ${claim.claimId} using ${artifactCount} attached artifacts.`
        : `Reference agent prepared a replication bundle for claim ${claim.claimId}.`,
    workerId: input.workerId,
  };
}

export async function runReferenceReplicationAgentOnce(
  options: ReferenceReplicationAgentOptions,
): Promise<ReferenceReplicationAgentRunResult> {
  const jobs = await listCandidateJobs(options.client, options);
  const compatibleJobs = options.jobId
    ? jobs
    : jobs.filter((job) => replicationJobMatchesCapabilities(job, options.capabilities));

  if (compatibleJobs.length === 0) {
    return {
      idle: true,
      message:
        options.jobId && jobs.length > 0
          ? "requested replication job is not compatible with this agent configuration"
          : "no compatible open replication job available",
      workerId: options.workerId,
    };
  }

  const preferredJob =
    options.jobId !== undefined
      ? selectReplicationJobForAgent(jobs, {
          capabilities: options.capabilities,
          jobId: options.jobId,
        })
      : null;
  const candidateJobs = preferredJob
    ? [preferredJob]
    : [...compatibleJobs].sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.jobId.localeCompare(right.jobId);
      });

  for (const job of candidateJobs) {
    let claimed: { job: ReplicationJobView; run: ReplicationJobRunView };
    try {
      claimed = await claimJob({
        actorAddress: options.actorAddress,
        agentId: options.agentId,
        client: options.client,
        job,
        signer: options.signer,
        workerId: options.workerId,
      });
    } catch (error) {
      if (isClaimConflict(error) && !options.jobId) {
        continue;
      }
      throw error;
    }

    await heartbeatClaimedRun({
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      client: options.client,
      jobId: claimed.job.jobId,
      runId: claimed.run.runId,
      signer: options.signer,
      workerId: options.workerId,
    });

    const claim = await options.client.getClaim(claimed.job.claimId);
    const signedSubmission = await createSignedAgentRequest({
      actionType: "replication_job_submission",
      actorAddress: options.actorAddress,
      agentId: options.agentId,
      payload: buildReplicationSubmissionPayload(claim, {
        jobId: claimed.job.jobId,
        runId: claimed.run.runId,
        workerId: options.workerId,
      }),
      requestNonce: randomUUID(),
      scopeKey: `replication-job:${claimed.job.jobId}`,
      signer: options.signer,
    });

    const submitted = await options.client.agent.submitWorkResults(
      `replication-job:${claimed.job.jobId}`,
      signedSubmission,
    );
    if (!isReplicationJobSubmissionResult(submitted.result)) {
      throw new Error("unexpected_replication_job_submission_result");
    }
    return {
      claimId: claimed.job.claimId,
      completed: true,
      itemId: `replication-job:${claimed.job.jobId}`,
      jobId: claimed.job.jobId,
      onchainReplicationId: submitted.result.job.onchainReplicationId,
      operatorRequestId: submitted.result.operatorRequestId,
      resultArtifactKey: submitted.result.resultArtifactKey,
      runId: claimed.run.runId,
      workerId: options.workerId,
    };
  }

  return {
    idle: true,
    message: "no compatible open replication job available",
    workerId: options.workerId,
  };
}
