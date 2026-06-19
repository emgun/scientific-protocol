import { keccak256, NonceManager, parseEther, toUtf8Bytes } from "ethers";
import {
  prepareCoordinatorStore,
  readArtifactMaintenanceTask,
  readReplicationJob,
  readReplicationJobsPage,
} from "../coordinator/store.js";
import { readChallenge, readForecast } from "../indexer/store.js";
import { readReviewSubmissionsPage, readReviewTask, readReviewTasksPage } from "../review/store.js";
import { getContract } from "../shared/contracts.js";
import { getDeploymentPath, loadDeploymentFile } from "../shared/deployment.js";
import { createManagedOperatorSigner } from "../shared/operator.js";
import {
  CLAIM_REWARD_WORK_KIND_CODES,
  type ClaimRewardWorkKind,
  rewardWorkKindForReviewTaskType,
} from "./types.js";

export type SettleWorkRewardInput = {
  amountEth: string;
  amountWei?: string;
  budgetTopUpBps?: number;
  connectionString?: string;
  env?: NodeJS.ProcessEnv;
  itemId: string;
  recipient?: string;
  settlementLabel?: string;
};

export type SettledWorkReward = {
  agentId: string | null;
  amountWei: string;
  claimId: string;
  recipient: string;
  settlementId: string;
  settlementLabel: string;
  txHash: string;
  workKind: ClaimRewardWorkKind;
};

type ResolvedWorkTarget = {
  agentId: string | null;
  claimId: string;
  defaultSettlementLabel: string;
  recipient: string;
  workKind: ClaimRewardWorkKind;
};

function normalizeAddress(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseItemId(itemId: string): { kind: string; sourceId: string } {
  const [kind, sourceId] = itemId.split(":", 2);
  if (!kind || !sourceId) {
    throw new Error(`invalid work item id: ${itemId}`);
  }
  return { kind, sourceId };
}

async function lookupAgentOperator(
  agentRegistry: Awaited<ReturnType<typeof getContract>>,
  agentId: string,
): Promise<string> {
  const agent = await agentRegistry.getAgent(BigInt(agentId));
  return agent.operator as string;
}

async function resolveReviewTarget(input: {
  agentRegistry: Awaited<ReturnType<typeof getContract>>;
  pool: Awaited<ReturnType<typeof prepareCoordinatorStore>>;
  recipientOverride: string | null;
  taskId: string;
}): Promise<ResolvedWorkTarget> {
  const task = await readReviewTask(input.pool, input.taskId);
  if (!task) {
    throw new Error(`review task ${input.taskId} not found`);
  }
  const submissions = await readReviewSubmissionsPage(input.pool, {
    limit: 1,
    offset: 0,
    taskId: input.taskId,
  });
  const latestSubmission = submissions.items[0];
  if (!latestSubmission) {
    throw new Error(`review task ${input.taskId} has no submissions to reward`);
  }

  const agentId = latestSubmission.reviewerAgentId;
  const recipient =
    input.recipientOverride ??
    normalizeAddress(latestSubmission.reviewerActor) ??
    (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
  if (!recipient) {
    throw new Error(`review task ${input.taskId} is missing a reward recipient`);
  }

  return {
    agentId,
    claimId:
      task.claimId ??
      (() => {
        throw new Error(`review task ${input.taskId} is not claim-backed and cannot be settled`);
      })(),
    defaultSettlementLabel: `review-submission:${latestSubmission.submissionId}`,
    recipient,
    workKind: rewardWorkKindForReviewTaskType(task.taskType),
  };
}

async function resolveReplicationTarget(input: {
  agentRegistry: Awaited<ReturnType<typeof getContract>>;
  pool: Awaited<ReturnType<typeof prepareCoordinatorStore>>;
  recipientOverride: string | null;
  replicationRegistry: Awaited<ReturnType<typeof getContract>>;
  jobId: string;
}): Promise<ResolvedWorkTarget> {
  const job = await readReplicationJob(input.pool, input.jobId);
  if (!job) {
    throw new Error(`replication job ${input.jobId} not found`);
  }
  if (job.status !== "completed") {
    throw new Error(`replication job ${input.jobId} must be completed before reward settlement`);
  }

  let agentId: string | null = job.assignedAgentId;
  let recipient =
    input.recipientOverride ??
    normalizeAddress(job.submissionActor) ??
    (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
  let defaultSettlementLabel = `replication-job:${job.jobId}`;
  if (job.onchainReplicationId) {
    const replication = await input.replicationRegistry.getReplication(
      BigInt(job.onchainReplicationId),
    );
    agentId = BigInt(replication.agentId).toString();
    if (agentId === "0") {
      agentId = null;
    }
    recipient = input.recipientOverride ?? (replication.replicator as string);
    defaultSettlementLabel = `replication:${job.onchainReplicationId}`;
  }
  if (!recipient) {
    throw new Error(`replication job ${input.jobId} is missing a reward recipient`);
  }

  return {
    agentId,
    claimId: job.claimId,
    defaultSettlementLabel,
    recipient,
    workKind: "replication",
  };
}

async function resolveMaintenanceTarget(input: {
  agentRegistry: Awaited<ReturnType<typeof getContract>>;
  pool: Awaited<ReturnType<typeof prepareCoordinatorStore>>;
  recipientOverride: string | null;
  taskId: string;
}): Promise<ResolvedWorkTarget> {
  const task = await readArtifactMaintenanceTask(input.pool, input.taskId);
  if (!task) {
    throw new Error(`artifact maintenance task ${input.taskId} not found`);
  }
  if (task.status !== "completed") {
    throw new Error(
      `artifact maintenance task ${input.taskId} must be completed before reward settlement`,
    );
  }

  const agentId = task.assignedAgentId;
  const recipient =
    input.recipientOverride ??
    (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
  if (!recipient) {
    throw new Error(`artifact maintenance task ${input.taskId} is missing a reward recipient`);
  }

  return {
    agentId,
    claimId: await findClaimIdForArtifactKey(input.pool, task.artifactKey),
    defaultSettlementLabel: `artifact-maintenance:${task.taskId}`,
    recipient,
    workKind: "maintenance",
  };
}

async function resolveForecastTarget(input: {
  agentRegistry: Awaited<ReturnType<typeof getContract>>;
  pool: Awaited<ReturnType<typeof prepareCoordinatorStore>>;
  recipientOverride: string | null;
  forecastId: string;
}): Promise<ResolvedWorkTarget> {
  const forecast = await readForecast(input.pool, input.forecastId);
  if (!forecast) {
    throw new Error(`forecast ${input.forecastId} not found`);
  }
  if (!forecast.settled) {
    throw new Error(`forecast ${input.forecastId} must be settled before reward settlement`);
  }

  const agentId = forecast.agentId && forecast.agentId !== "0" ? forecast.agentId : null;
  const recipient =
    input.recipientOverride ??
    normalizeAddress(forecast.forecaster) ??
    (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
  if (!recipient) {
    throw new Error(`forecast ${input.forecastId} is missing a reward recipient`);
  }

  return {
    agentId,
    claimId: forecast.claimId,
    defaultSettlementLabel: `forecast:${forecast.forecastId}`,
    recipient,
    workKind: "forecast",
  };
}

async function resolveChallengeTarget(input: {
  agentRegistry: Awaited<ReturnType<typeof getContract>>;
  pool: Awaited<ReturnType<typeof prepareCoordinatorStore>>;
  recipientOverride: string | null;
  challengeId: string;
}): Promise<ResolvedWorkTarget> {
  const challenge = await readChallenge(input.pool, input.challengeId);
  if (!challenge) {
    throw new Error(`challenge ${input.challengeId} not found`);
  }
  if (challenge.status === 0 || challenge.status === 3) {
    throw new Error(`challenge ${input.challengeId} must be resolved before reward settlement`);
  }

  const agentId = challenge.agentId && challenge.agentId !== "0" ? challenge.agentId : null;
  const recipient =
    input.recipientOverride ??
    normalizeAddress(challenge.challenger) ??
    (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
  if (!recipient) {
    throw new Error(`challenge ${input.challengeId} is missing a reward recipient`);
  }

  return {
    agentId,
    claimId: challenge.claimId,
    defaultSettlementLabel: `challenge:${challenge.challengeId}`,
    recipient,
    workKind: "challenge",
  };
}

async function findClaimIdForArtifactKey(
  pool: Awaited<ReturnType<typeof prepareCoordinatorStore>>,
  artifactKey: string,
): Promise<string> {
  const [reviewTasks, reviewSubmissions, replicationJobs] = await Promise.all([
    readReviewTasksPage(pool, { limit: 1000, offset: 0 }),
    readReviewSubmissionsPage(pool, { limit: 1000, offset: 0 }),
    readReplicationJobsPage(pool, { limit: 1000, offset: 0 }),
  ]);
  const reviewTask = reviewTasks.items.find(
    (task) =>
      task.resultArtifactKey === artifactKey || task.inputArtifactKeys.includes(artifactKey),
  );
  if (reviewTask?.claimId) {
    return reviewTask.claimId;
  }
  const reviewSubmission = reviewSubmissions.items.find(
    (submission) =>
      submission.resultArtifactKey === artifactKey ||
      submission.evidenceArtifactKey === artifactKey,
  );
  if (reviewSubmission?.claimId) {
    return reviewSubmission.claimId;
  }
  const replicationJob = replicationJobs.items.find((job) => job.resultArtifactKey === artifactKey);
  if (replicationJob) {
    return replicationJob.claimId;
  }
  throw new Error(`unable to resolve claim id for artifact ${artifactKey}`);
}

export async function settleWorkReward(input: SettleWorkRewardInput): Promise<SettledWorkReward> {
  const env = input.env ?? process.env;
  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
  const signer = new NonceManager(
    createManagedOperatorSigner(["SP_REWARD_SETTLER_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"], {
      env,
      localAccountIndex: 0,
    }),
  );
  const pool = await prepareCoordinatorStore(input.connectionString);
  try {
    const [claimRewardVault, agentRegistry, replicationRegistry] = await Promise.all([
      getContract("ClaimRewardVault", deployment.addresses.claimRewardVault, signer),
      getContract("AgentRegistry", deployment.addresses.agentRegistry, signer),
      getContract("ReplicationRegistry", deployment.addresses.replicationRegistry, signer),
    ]);
    const { kind, sourceId } = parseItemId(input.itemId);
    const recipientOverride = normalizeAddress(input.recipient);
    let target: ResolvedWorkTarget;
    if (kind === "review-task") {
      target = await resolveReviewTarget({
        agentRegistry,
        pool,
        recipientOverride,
        taskId: sourceId,
      });
    } else if (kind === "replication-job") {
      target = await resolveReplicationTarget({
        agentRegistry,
        pool,
        recipientOverride,
        replicationRegistry,
        jobId: sourceId,
      });
    } else if (kind === "artifact-maintenance") {
      target = await resolveMaintenanceTarget({
        agentRegistry,
        pool,
        recipientOverride,
        taskId: sourceId,
      });
    } else if (kind === "forecast") {
      target = await resolveForecastTarget({
        agentRegistry,
        pool,
        recipientOverride,
        forecastId: sourceId,
      });
    } else if (kind === "challenge") {
      target = await resolveChallengeTarget({
        agentRegistry,
        pool,
        recipientOverride,
        challengeId: sourceId,
      });
    } else {
      throw new Error(`unsupported work item kind: ${kind}`);
    }

    const settlementLabel = input.settlementLabel?.trim() || target.defaultSettlementLabel;
    const settlementId = keccak256(toUtf8Bytes(`${input.itemId}:${settlementLabel}`));
    const budgetTopUpBps =
      input.budgetTopUpBps ?? (target.agentId && target.agentId !== "0" ? 5_000 : 0);
    const amountWei =
      typeof input.amountWei === "string" ? BigInt(input.amountWei) : parseEther(input.amountEth);
    const tx = await claimRewardVault.accrueWorkReward(
      BigInt(target.claimId),
      CLAIM_REWARD_WORK_KIND_CODES[target.workKind],
      settlementId,
      target.recipient,
      BigInt(target.agentId ?? "0"),
      amountWei,
      budgetTopUpBps,
    );
    const receipt = await tx.wait();
    return {
      agentId: target.agentId,
      amountWei: amountWei.toString(),
      claimId: target.claimId,
      recipient: target.recipient,
      settlementId,
      settlementLabel,
      txHash: receipt.hash,
      workKind: target.workKind,
    };
  } finally {
    await pool.end();
  }
}
