import { NonceManager, parseEther } from "ethers";
import {
  type ArtifactMaintenanceTaskView,
  type ReplicationJobView,
  readArtifactMaintenanceTaskRuns,
  readArtifactMaintenanceTasksPage,
  readReplicationJobRuns,
  readReplicationJobsPage,
} from "../coordinator/store.js";
import {
  readArtifactsByClaim,
  readChallengesPage,
  readClaimsPage,
  readForecastsPage,
  readReplicationsPage,
} from "../indexer/store.js";
import {
  type AgentCalibrationHistoryEntry,
  buildAgentCalibrationHistory,
} from "../review/calibration.js";
import {
  readReviewSubmissionsPage,
  readReviewTaskRuns,
  readReviewTasksPage,
} from "../review/store.js";
import type { ReviewSubmissionView, ReviewTaskView } from "../review/types.js";
import { getContract } from "../shared/contracts.js";
import { getDeploymentPath, loadDeploymentFile } from "../shared/deployment.js";
import { createManagedOperatorSigner } from "../shared/operator.js";
import { readAllPages } from "../shared/pagination.js";
import type { ChallengeView, ForecastView, ReplicationView } from "../shared/read-model.js";
import { buildClaimWorkGraph, toClaimWorkRunView } from "../work/graph.js";
import type { ClaimWorkGraphView } from "../work/types.js";
import { type SettledWorkReward, settleWorkReward } from "./settlement.js";
import {
  insertWorkRewardSettlement,
  prepareRewardStore,
  readAccruedRewardTotals,
} from "./store.js";
import {
  CLAIM_REWARD_WORK_KIND_CODES,
  type ClaimRewardWorkKind,
  rewardWorkKindForReviewTaskType,
  rewardWorkKindForWorkItem,
} from "./types.js";
import type {
  ClaimRewardPolicyAttentionView,
  ClaimRewardPolicyExplanationView,
  ClaimRewardPolicySignalView,
} from "./views.js";

const DEFAULT_POLICY_VERSION = "auto-v1";
const BPS_SCALE = 10_000n;

const POLICY_CONFIG: Record<
  ClaimRewardWorkKind,
  {
    baseRewardWei: bigint;
    distributionFractionBps: number;
    fundingTargetWei: bigint;
    minimumQualityBps: number;
  }
> = {
  challenge: {
    baseRewardWei: parseEther("0.008"),
    distributionFractionBps: 6_000,
    fundingTargetWei: parseEther("0.08"),
    minimumQualityBps: 6_500,
  },
  forecast: {
    baseRewardWei: parseEther("0.004"),
    distributionFractionBps: 4_000,
    fundingTargetWei: parseEther("0.04"),
    minimumQualityBps: 6_000,
  },
  maintenance: {
    baseRewardWei: parseEther("0.003"),
    distributionFractionBps: 5_000,
    fundingTargetWei: parseEther("0.03"),
    minimumQualityBps: 7_000,
  },
  replication: {
    baseRewardWei: parseEther("0.01"),
    distributionFractionBps: 7_000,
    fundingTargetWei: parseEther("0.1"),
    minimumQualityBps: 7_500,
  },
  review: {
    baseRewardWei: parseEther("0.005"),
    distributionFractionBps: 6_000,
    fundingTargetWei: parseEther("0.05"),
    minimumQualityBps: 6_000,
  },
  synthesis: {
    baseRewardWei: parseEther("0.006"),
    distributionFractionBps: 5_000,
    fundingTargetWei: parseEther("0.06"),
    minimumQualityBps: 7_500,
  },
};

const OPEN_WORK_COMMITMENT_TARGETS: Partial<Record<ClaimRewardWorkKind, bigint>> = {
  maintenance: parseEther("0.02"),
  replication: parseEther("0.05"),
  review: parseEther("0.03"),
  synthesis: parseEther("0.04"),
};

type PolicyCandidate = {
  agentId: string | null;
  budgetTopUpBps: number;
  claimId: string;
  itemId: string;
  operator: string | null;
  qualityBps: number;
  recipient: string | null;
  workKind: ClaimRewardWorkKind;
};

type MaintenancePolicyTask = ArtifactMaintenanceTaskView & {
  claimId: string;
};

type PolicyAgentRegistry = {
  getAgent(agentId: bigint): Promise<{
    active?: boolean;
    budgetBalance?: bigint | number | string;
    operator: string;
    reservedBudget?: bigint | number | string;
    spendLimit?: bigint | number | string;
  }>;
};

type PolicyAgentRecord = {
  active: boolean;
  budgetBalance: bigint;
  operator: string;
  reservedBudget: bigint;
  spendLimit: bigint;
};

type ClaimRewardWorkDemandSignal = {
  freshContributorItems: number;
  minimumCoverageItems: number;
  reassignmentReadyItems: number;
  redundancyTargetItems: number;
  schedulerPressureBps: number;
  uncoveredDemand: number;
  workKind: ClaimRewardWorkKind;
};

function distinctParticipantCount(
  values: Array<string | null | undefined>,
  prefix: string,
): number {
  return new Set(
    values
      .map((value) => normalizeAddress(value) ?? null)
      .filter((value): value is string => value !== null)
      .map((value) => `${prefix}:${value.toLowerCase()}`),
  ).size;
}

function marketParticipantKey(input: {
  actor?: string | null;
  agentId?: string | null;
}): string | null {
  if (input.agentId && input.agentId !== "0") {
    return `agent:${input.agentId}`;
  }
  const actor = normalizeAddress(input.actor);
  return actor ? `actor:${actor.toLowerCase()}` : null;
}

export type RewardPolicySettlementView = SettledWorkReward & {
  accruedTotalWei: string;
  budgetTopUpBps: number;
  marketPressureBps: number;
  policyVersion: string;
  qualityBps: number;
  targetTotalWei: string;
};

export type AutomaticRewardPolicyResult = {
  policyVersion: string;
  settlements: RewardPolicySettlementView[];
};

export type RewardTargetCandidate = {
  itemId: string;
  qualityBps: number;
};

export type RewardTargetAllocation = {
  itemId: string;
  targetTotalWei: bigint;
};

function normalizeAddress(input: string | null | undefined): string | null {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function clampInteger(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function marketPressureBps(poolBalanceWei: bigint, fundingTargetWei: bigint): number {
  if (fundingTargetWei <= 0n) {
    return 10_000;
  }
  const raw = (poolBalanceWei * BPS_SCALE) / fundingTargetWei;
  return Number(clampInteger(raw, 5_000n, 20_000n));
}

function titleCase(input: string): string {
  return input
    .replaceAll("_", " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join(" ");
}

function emptyWorkDemandSignal(workKind: ClaimRewardWorkKind): ClaimRewardWorkDemandSignal {
  return {
    freshContributorItems: 0,
    minimumCoverageItems: 0,
    reassignmentReadyItems: 0,
    redundancyTargetItems: 0,
    schedulerPressureBps: 10_000,
    uncoveredDemand: 0,
    workKind,
  };
}

function computeSchedulerPressureBps(
  signal: Omit<ClaimRewardWorkDemandSignal, "schedulerPressureBps">,
): number {
  return Math.min(
    20_000,
    10_000 +
      Math.min(3_000, signal.minimumCoverageItems * 1_200) +
      Math.min(1_800, signal.reassignmentReadyItems * 900) +
      Math.min(1_200, signal.freshContributorItems * 600) +
      Math.min(1_000, signal.uncoveredDemand * 450) +
      Math.min(800, signal.redundancyTargetItems * 250),
  );
}

export function buildClaimRewardWorkDemandSignals(
  workGraph: ClaimWorkGraphView | null | undefined,
): Record<ClaimRewardWorkKind, ClaimRewardWorkDemandSignal> {
  const byKind = Object.fromEntries(
    Object.keys(POLICY_CONFIG).map((workKind) => [
      workKind,
      emptyWorkDemandSignal(workKind as ClaimRewardWorkKind),
    ]),
  ) as Record<ClaimRewardWorkKind, ClaimRewardWorkDemandSignal>;

  if (!workGraph) {
    return byKind;
  }

  for (const item of workGraph.items) {
    const workKind = rewardWorkKindForWorkItem({
      kind: item.kind,
      sourceType: item.sourceType,
    });
    const signal = byKind[workKind];
    if (!signal) {
      continue;
    }
    if (item.scheduling.needsMinimumCoverage) {
      signal.minimumCoverageItems += 1;
    }
    if (item.scheduling.needsRedundantCoverage) {
      signal.redundancyTargetItems += 1;
    }
    if (item.scheduling.prefersFreshContributor) {
      signal.freshContributorItems += 1;
    }
    if (item.scheduling.reassignmentPreferred) {
      signal.reassignmentReadyItems += 1;
    }
    signal.uncoveredDemand += item.scheduling.desiredAdditionalClaims;
  }

  for (const signal of Object.values(byKind)) {
    signal.schedulerPressureBps = computeSchedulerPressureBps({
      freshContributorItems: signal.freshContributorItems,
      minimumCoverageItems: signal.minimumCoverageItems,
      reassignmentReadyItems: signal.reassignmentReadyItems,
      redundancyTargetItems: signal.redundancyTargetItems,
      uncoveredDemand: signal.uncoveredDemand,
      workKind: signal.workKind,
    });
  }

  return byKind;
}

export function deriveRewardTargetsForGroup(input: {
  attentionPressureBps?: number;
  candidates: RewardTargetCandidate[];
  poolBalanceWei: bigint;
  workKind: ClaimRewardWorkKind;
}): {
  allocations: RewardTargetAllocation[];
  distributablePoolWei: bigint;
  marketPressureBps: number;
} {
  const config = POLICY_CONFIG[input.workKind];
  const poolPressure = marketPressureBps(input.poolBalanceWei, config.fundingTargetWei);
  const attentionPressure = input.attentionPressureBps ?? 10_000;
  const marketPressure = Number(
    clampInteger((BigInt(poolPressure) * BigInt(attentionPressure)) / BPS_SCALE, 5_000n, 25_000n),
  );
  const distributablePoolWei = clampInteger(
    (((input.poolBalanceWei * BigInt(config.distributionFractionBps)) / BPS_SCALE) *
      BigInt(attentionPressure)) /
      BPS_SCALE,
    0n,
    input.poolBalanceWei,
  );
  if (distributablePoolWei === 0n || input.candidates.length === 0) {
    return {
      allocations: input.candidates.map((candidate) => ({
        itemId: candidate.itemId,
        targetTotalWei: 0n,
      })),
      distributablePoolWei,
      marketPressureBps: marketPressure,
    };
  }

  const rawTargets = input.candidates.map((candidate) => {
    if (candidate.qualityBps < config.minimumQualityBps) {
      return 0n;
    }
    const rawTarget =
      (config.baseRewardWei * BigInt(candidate.qualityBps) * BigInt(marketPressure)) /
      (BPS_SCALE * BPS_SCALE);
    return rawTarget > 0n ? rawTarget : 0n;
  });
  const rawTargetSum = rawTargets.reduce((sum, current) => sum + current, 0n);
  if (rawTargetSum === 0n) {
    return {
      allocations: input.candidates.map((candidate) => ({
        itemId: candidate.itemId,
        targetTotalWei: 0n,
      })),
      distributablePoolWei,
      marketPressureBps: marketPressure,
    };
  }

  return {
    allocations: input.candidates.map((candidate, index) => ({
      itemId: candidate.itemId,
      targetTotalWei: (distributablePoolWei * rawTargets[index]) / rawTargetSum,
    })),
    distributablePoolWei,
    marketPressureBps: marketPressure,
  };
}

function budgetTopUpBps(agentId: string | null): number {
  return agentId && agentId !== "0" ? 5_000 : 0;
}

function agentEconomicMaturityBps(agent: PolicyAgentRecord | undefined): number {
  if (!agent) {
    return 7_000;
  }
  if (!agent.active) {
    return 4_000;
  }
  const availableBudget =
    agent.budgetBalance > agent.reservedBudget ? agent.budgetBalance - agent.reservedBudget : 0n;
  const availableBudgetBps = Number(
    commitmentStrengthBps(availableBudget, parseEther("0.03"), 4_000n),
  );
  const spendEnvelopeBps = Number(
    commitmentStrengthBps(agent.spendLimit, parseEther("0.03"), 5_000n),
  );
  return Math.round((availableBudgetBps * 7 + spendEnvelopeBps * 3) / 10);
}

function applyAgentEconomicMaturity(
  baseQualityBps: number,
  agent: PolicyAgentRecord | undefined,
): number {
  return Math.round((baseQualityBps * agentEconomicMaturityBps(agent)) / 10_000);
}

function directWorkCommitmentBps(
  workKind: ClaimRewardWorkKind,
  agent: PolicyAgentRecord | undefined,
): number {
  const targetWei = OPEN_WORK_COMMITMENT_TARGETS[workKind];
  if (!targetWei) {
    return 10_000;
  }
  if (!agent) {
    return workKind === "replication" ? 4_500 : 4_000;
  }
  if (!agent.active) {
    return 3_500;
  }
  const availableBudget =
    agent.budgetBalance > agent.reservedBudget ? agent.budgetBalance - agent.reservedBudget : 0n;
  const bondedCapital = availableBudget + agent.spendLimit;
  return Number(commitmentStrengthBps(bondedCapital, targetWei, 4_500n));
}

function applyDirectWorkCommitment(
  baseQualityBps: number,
  workKind: ClaimRewardWorkKind,
  agent: PolicyAgentRecord | undefined,
): number {
  return Math.round((baseQualityBps * directWorkCommitmentBps(workKind, agent)) / 10_000);
}

function qualityForReview(
  task: ReviewTaskView,
  latestSubmission: ReviewSubmissionView,
  calibration: AgentCalibrationHistoryEntry | undefined,
  agent: PolicyAgentRecord | undefined,
): number {
  const calibrationSamples = calibration?.samples ?? 0;
  const verdictBps =
    latestSubmission.verdict === "inconclusive"
      ? 7_000
      : latestSubmission.verdict === "pass" || latestSubmission.verdict === "fail"
        ? 10_000
        : 9_000;
  const confidenceBps = Math.max(4_000, latestSubmission.confidenceBps);
  const calibrationBps = calibration?.weightBps ?? 10_000;
  const maturityBps = Math.min(10_000, 6_500 + calibrationSamples * 700);
  const economicBps = agentEconomicMaturityBps(agent);
  const synthesisBonus = task.taskType === "certification_synthesis_check" ? 1_100 : 1_000;
  return Math.min(
    20_000,
    Math.round(
      (verdictBps * confidenceBps * calibrationBps * maturityBps * economicBps * synthesisBonus) /
        10_000_000_000_000_000_000,
    ),
  );
}

function qualityForReplication(replication: ReplicationView | undefined): number {
  if (!replication || replication.resolutionStatus === null) {
    return 8_000;
  }
  switch (replication.resolutionStatus) {
    case 1:
      return 10_000;
    case 2:
      return 11_000;
    case 3:
      return 8_000;
    case 4:
      return 11_000;
    case 5:
      return 12_000;
    default:
      return 8_000;
  }
}

function qualityForMaintenance(task: ArtifactMaintenanceTaskView): number {
  return task.taskType === "repair" ? 10_000 : 8_500;
}

function commitmentStrengthBps(amountWei: bigint, targetWei: bigint, minimumBps: bigint): bigint {
  if (targetWei <= 0n) {
    return BPS_SCALE;
  }
  return clampInteger((amountWei * BPS_SCALE) / targetWei, minimumBps, BPS_SCALE);
}

function qualityForForecast(forecast: ForecastView): number {
  if (!forecast.settled || forecast.finalStatus === null) {
    return 0;
  }
  const commitmentBps = commitmentStrengthBps(
    BigInt(forecast.stakeAmount),
    parseEther("0.05"),
    2_500n,
  );
  const baseQuality = !forecast.matched
    ? Math.max(2_500, Math.round(forecast.confidenceBps * 0.5))
    : Math.min(15_000, 8_500 + Math.round(forecast.confidenceBps * 0.2));
  return Math.round((baseQuality * Number(commitmentBps)) / 10_000);
}

function qualityForChallenge(challenge: ChallengeView): number {
  const commitmentBps = commitmentStrengthBps(
    BigInt(challenge.bondAmount),
    parseEther("0.1"),
    3_500n,
  );
  const baseQuality = (() => {
    switch (challenge.status) {
      case 1:
        return 12_000;
      case 2:
        return 7_000;
      case 4:
        return 0;
      default:
        return 0;
    }
  })();
  return Math.round((baseQuality * Number(commitmentBps)) / 10_000);
}

function applyRankDiscounts<
  T extends {
    itemId: string;
    qualityBps: number;
  },
>(candidates: T[], bucketKey: (candidate: T) => string, stepBps: number, minimumBps: number): T[] {
  const adjustedByItemId = new Map<string, T>();
  const buckets = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = bucketKey(candidate);
    const existing = buckets.get(key) ?? [];
    existing.push(candidate);
    buckets.set(key, existing);
  }
  for (const bucket of buckets.values()) {
    const ranked = [...bucket].sort((left, right) => right.qualityBps - left.qualityBps);
    for (const [index, candidate] of ranked.entries()) {
      const discountBps = Math.max(minimumBps, 10_000 - index * stepBps);
      adjustedByItemId.set(candidate.itemId, {
        ...candidate,
        qualityBps: Math.max(0, Math.round((candidate.qualityBps * discountBps) / 10_000)),
      });
    }
  }
  return candidates
    .map((candidate) => adjustedByItemId.get(candidate.itemId))
    .filter((candidate): candidate is T => candidate !== undefined);
}

export function applyRecipientConcentrationDiscounts<
  T extends {
    agentId?: string | null;
    itemId: string;
    operator?: string | null;
    qualityBps: number;
    recipient: string | null;
  },
>(candidates: T[]): T[] {
  const operatorAdjusted = applyRankDiscounts(
    candidates,
    (candidate) =>
      normalizeAddress(candidate.operator)?.toLowerCase() ??
      `unassigned-operator:${candidate.itemId}`,
    1_250,
    6_000,
  );
  const identityAdjusted = applyRankDiscounts(
    operatorAdjusted,
    (candidate) =>
      candidate.agentId && candidate.agentId !== "0"
        ? `agent:${candidate.agentId}`
        : (normalizeAddress(candidate.recipient)?.toLowerCase() ??
          `unassigned:${candidate.itemId}`),
    1_500,
    5_000,
  );
  return applyRankDiscounts(
    identityAdjusted,
    (candidate) =>
      normalizeAddress(candidate.recipient)?.toLowerCase() ?? `unassigned:${candidate.itemId}`,
    2_000,
    4_500,
  );
}

function applyCandidateQualityDiscounts<T extends PolicyCandidate>(candidates: T[]): T[] {
  return applyRecipientConcentrationDiscounts(applyRedundancyDiscounts(candidates));
}

function openChallengeCount(challenges: ChallengeView[]): number {
  return challenges.filter((challenge) => challenge.status === 0 || challenge.status === 3).length;
}

function distinctForecastParticipants(forecasts: ForecastView[]): number {
  return new Set(
    forecasts
      .map((forecast) =>
        marketParticipantKey({
          actor: forecast.forecaster,
          agentId: forecast.agentId,
        }),
      )
      .filter((entry): entry is string => entry !== null),
  ).size;
}

function distinctChallengeParticipants(challenges: ChallengeView[]): number {
  return new Set(
    challenges
      .map((challenge) =>
        marketParticipantKey({
          actor: challenge.challenger,
          agentId: challenge.agentId,
        }),
      )
      .filter((entry): entry is string => entry !== null),
  ).size;
}

function totalForecastStakeWei(forecasts: ForecastView[]): bigint {
  return forecasts.reduce((sum, forecast) => sum + BigInt(forecast.stakeAmount), 0n);
}

function totalChallengeBondWei(challenges: ChallengeView[]): bigint {
  return challenges.reduce((sum, challenge) => sum + BigInt(challenge.bondAmount), 0n);
}

function forecastActivityPressureBps(forecasts: ForecastView[]): number {
  if (forecasts.length === 0) {
    return 10_000;
  }
  const totalStakeWei = totalForecastStakeWei(forecasts);
  const revealedForecasts = forecasts.filter((forecast) => forecast.revealed || forecast.settled);
  const directionSet = new Set(revealedForecasts.map((forecast) => forecast.direction));
  const disagreementPressure = directionSet.size > 1 ? 1_200 : 0;
  const byDirectionStake = new Map<number, bigint>();
  for (const forecast of revealedForecasts) {
    byDirectionStake.set(
      forecast.direction,
      (byDirectionStake.get(forecast.direction) ?? 0n) + BigInt(forecast.stakeAmount),
    );
  }
  const minorityStake =
    [...byDirectionStake.values()].sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left > right ? -1 : 1;
    })[1] ?? 0n;
  const balancedPressure = Number(
    clampInteger((minorityStake * 1_000n) / parseEther("0.03"), 0n, 1_000n),
  );
  const confidenceSpread =
    revealedForecasts.length > 1
      ? Math.max(...revealedForecasts.map((forecast) => forecast.confidenceBps)) -
        Math.min(...revealedForecasts.map((forecast) => forecast.confidenceBps))
      : 0;
  const spreadPressure = Math.min(800, Math.floor(confidenceSpread / 5));
  const stakePressure = Number(
    clampInteger((totalStakeWei * 1_800n) / parseEther("0.05"), 0n, 1_800n),
  );
  const participantPressure = Math.min(1_400, distinctForecastParticipants(forecasts) * 350);
  return (
    10_000 +
    Math.min(900, forecasts.length * 150) +
    participantPressure +
    disagreementPressure +
    balancedPressure +
    spreadPressure +
    stakePressure
  );
}

function challengeActivityPressureBps(challenges: ChallengeView[]): number {
  if (challenges.length === 0) {
    return 10_000;
  }
  const totalBondWei = totalChallengeBondWei(challenges);
  const bondPressure = Number(
    clampInteger((totalBondWei * 2_500n) / parseEther("0.1"), 0n, 2_500n),
  );
  const participantPressure = Math.min(1_600, distinctChallengeParticipants(challenges) * 450);
  return (
    10_000 +
    Math.min(1_800, openChallengeCount(challenges) * 700) +
    participantPressure +
    bondPressure
  );
}

function attentionPressureBpsForClaim(input: {
  challenges: ChallengeView[];
  forecasts: ForecastView[];
  workKind: ClaimRewardWorkKind;
}): number {
  const forecastPressure = forecastActivityPressureBps(input.forecasts);
  const challengePressure = challengeActivityPressureBps(input.challenges);
  const forecastDelta = Math.max(0, forecastPressure - 10_000);
  const challengeDelta = Math.max(0, challengePressure - 10_000);
  switch (input.workKind) {
    case "challenge":
      return Math.min(20_000, 10_000 + challengeDelta + Math.floor(forecastDelta / 4));
    case "forecast":
      return Math.min(18_000, 10_000 + forecastDelta + Math.floor(challengeDelta / 5));
    case "maintenance":
      return Math.min(15_000, 10_000 + Math.floor(challengeDelta / 4));
    case "replication":
      return Math.min(
        18_000,
        10_000 + Math.floor(forecastDelta / 2) + Math.floor(challengeDelta / 3),
      );
    case "synthesis":
      return Math.min(19_000, 10_000 + Math.floor((forecastDelta + challengeDelta) / 2));
    default:
      return Math.min(
        18_000,
        10_000 + Math.floor(forecastDelta / 2) + Math.floor(challengeDelta / 2),
      );
  }
}

function combinedAttentionPressureBps(input: {
  claimAttentionPressureBps: number;
  schedulerPressureBps: number;
}): number {
  return Number(
    clampInteger(
      (BigInt(input.claimAttentionPressureBps) * BigInt(input.schedulerPressureBps)) / BPS_SCALE,
      5_000n,
      25_000n,
    ),
  );
}

export function buildClaimRewardPolicyExplanation(input: {
  challenges: ChallengeView[];
  forecasts: ForecastView[];
  policyVersion?: string;
  pools: Array<{
    balanceWei: string;
    workKind: ClaimRewardWorkKind;
  }>;
  workGraph?: ClaimWorkGraphView | null;
}): ClaimRewardPolicyExplanationView {
  const forecastPressure = forecastActivityPressureBps(input.forecasts);
  const challengePressure = challengeActivityPressureBps(input.challenges);
  const demandSignals = buildClaimRewardWorkDemandSignals(input.workGraph);
  const attention: ClaimRewardPolicyAttentionView = {
    challengeActivityPressureBps: challengePressure,
    distinctChallengeParticipants: distinctChallengeParticipants(input.challenges),
    distinctForecastParticipants: distinctForecastParticipants(input.forecasts),
    forecastActivityPressureBps: forecastPressure,
    forecastCount: input.forecasts.length,
    openChallengeCount: openChallengeCount(input.challenges),
    totalChallengeBondWei: totalChallengeBondWei(input.challenges).toString(),
    totalForecastStakeWei: totalForecastStakeWei(input.forecasts).toString(),
  };
  const poolBalanceByWorkKind = new Map(
    input.pools.map((pool) => [pool.workKind, BigInt(pool.balanceWei)]),
  );
  const signals: ClaimRewardPolicySignalView[] = Object.entries(POLICY_CONFIG).map(
    ([workKind, config]) => {
      const typedWorkKind = workKind as ClaimRewardWorkKind;
      const poolBalanceWei = poolBalanceByWorkKind.get(typedWorkKind) ?? 0n;
      const demand = demandSignals[typedWorkKind];
      const attentionPressure = attentionPressureBpsForClaim({
        challenges: input.challenges,
        forecasts: input.forecasts,
        workKind: typedWorkKind,
      });
      const combinedPressure = combinedAttentionPressureBps({
        claimAttentionPressureBps: attentionPressure,
        schedulerPressureBps: demand.schedulerPressureBps,
      });
      return {
        attentionPressureBps: attentionPressure,
        baseRewardWei: config.baseRewardWei.toString(),
        combinedPressureBps: combinedPressure,
        distributionFractionBps: config.distributionFractionBps,
        freshContributorItems: demand.freshContributorItems,
        fundingTargetWei: config.fundingTargetWei.toString(),
        marketPressureBps: marketPressureBps(poolBalanceWei, config.fundingTargetWei),
        minimumQualityBps: config.minimumQualityBps,
        minimumCoverageItems: demand.minimumCoverageItems,
        poolBalanceWei: poolBalanceWei.toString(),
        reassignmentReadyItems: demand.reassignmentReadyItems,
        redundancyTargetItems: demand.redundancyTargetItems,
        schedulerPressureBps: demand.schedulerPressureBps,
        uncoveredDemand: demand.uncoveredDemand,
        workKind: typedWorkKind,
      };
    },
  );

  const strongestSignal =
    [...signals].sort((left, right) => {
      const leftStrength =
        left.marketPressureBps + left.attentionPressureBps + left.schedulerPressureBps;
      const rightStrength =
        right.marketPressureBps + right.attentionPressureBps + right.schedulerPressureBps;
      if (leftStrength === rightStrength) {
        return left.workKind.localeCompare(right.workKind);
      }
      return rightStrength - leftStrength;
    })[0] ?? null;

  const narrative = strongestSignal
    ? `${titleCase(strongestSignal.workKind)} work is priced most aggressively right now because its pool pressure is ${Math.round(
        strongestSignal.marketPressureBps / 100,
      )}% and its live attention multiplier is ${Math.round(
        strongestSignal.attentionPressureBps / 100,
      )}%, with scheduler scarcity at ${Math.round(strongestSignal.schedulerPressureBps / 100)}% and a combined pressure of ${Math.round(strongestSignal.combinedPressureBps / 100)}%.`
    : "Reward pricing is idle until a claim work pool is funded.";

  return {
    attention,
    narrative,
    policyVersion: input.policyVersion ?? DEFAULT_POLICY_VERSION,
    signals,
  };
}

function applyRedundancyDiscounts<T extends PolicyCandidate>(candidates: T[]): T[] {
  return applyRankDiscounts(candidates, () => "__all__", 1_500, 5_500);
}

async function lookupAgentOperator(
  agentRegistry: PolicyAgentRegistry,
  agentId: string,
): Promise<string> {
  const agent = await agentRegistry.getAgent(BigInt(agentId));
  return agent.operator as string;
}

async function lookupAgentRecord(
  agentRegistry: PolicyAgentRegistry,
  agentId: string,
): Promise<PolicyAgentRecord> {
  const agent = await agentRegistry.getAgent(BigInt(agentId));
  return {
    active: agent.active ?? true,
    budgetBalance: BigInt(agent.budgetBalance ?? 0),
    operator: agent.operator as string,
    reservedBudget: BigInt(agent.reservedBudget ?? 0),
    spendLimit: BigInt(agent.spendLimit ?? 0),
  };
}

export async function buildPolicyCandidates(input: {
  agentRegistry: PolicyAgentRegistry;
  calibrationHistory: Map<string, AgentCalibrationHistoryEntry>;
  challenges: ChallengeView[];
  forecasts: ForecastView[];
  maintenanceTasks: MaintenancePolicyTask[];
  replicationsById: Map<string, ReplicationView>;
  replicationJobs: ReplicationJobView[];
  reviewSubmissions: ReviewSubmissionView[];
  reviewTasks: ReviewTaskView[];
}): Promise<PolicyCandidate[]> {
  const candidates: PolicyCandidate[] = [];
  const latestReviewSubmissionByTaskId = new Map<string, ReviewSubmissionView>();
  const agentRecords = new Map<string, PolicyAgentRecord>();
  async function getAgentRecord(
    agentId: string | null | undefined,
  ): Promise<PolicyAgentRecord | undefined> {
    if (!agentId || agentId === "0") {
      return undefined;
    }
    const existing = agentRecords.get(agentId);
    if (existing) {
      return existing;
    }
    const loaded = await lookupAgentRecord(input.agentRegistry, agentId);
    agentRecords.set(agentId, loaded);
    return loaded;
  }
  for (const submission of input.reviewSubmissions) {
    const current = latestReviewSubmissionByTaskId.get(submission.taskId);
    if (!current || submission.createdAt > current.createdAt) {
      latestReviewSubmissionByTaskId.set(submission.taskId, submission);
    }
  }

  for (const task of input.reviewTasks) {
    if (task.status !== "completed" || !task.claimId) {
      continue;
    }
    const latestSubmission = latestReviewSubmissionByTaskId.get(task.taskId);
    if (!latestSubmission) {
      continue;
    }
    const agentId = latestSubmission.reviewerAgentId;
    const agentRecord = await getAgentRecord(agentId);
    const recipient =
      (latestSubmission.reviewerActor || agentRecord?.operator) ??
      (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
    if (!recipient) {
      continue;
    }
    candidates.push({
      agentId,
      budgetTopUpBps: budgetTopUpBps(agentId),
      claimId: task.claimId,
      itemId: `review-task:${task.taskId}`,
      operator: agentRecord?.operator ?? null,
      qualityBps: applyDirectWorkCommitment(
        qualityForReview(
          task,
          latestSubmission,
          agentId ? input.calibrationHistory.get(agentId) : undefined,
          agentRecord,
        ),
        rewardWorkKindForReviewTaskType(task.taskType),
        agentRecord,
      ),
      recipient,
      workKind: rewardWorkKindForReviewTaskType(task.taskType),
    });
  }

  for (const job of input.replicationJobs) {
    if (job.status !== "completed") {
      continue;
    }
    const replication = job.onchainReplicationId
      ? input.replicationsById.get(job.onchainReplicationId)
      : undefined;
    const agentId =
      replication && replication.agentId !== "0" ? replication.agentId : job.assignedAgentId;
    const agentRecord = await getAgentRecord(agentId);
    const recipient =
      replication?.replicator ??
      job.submissionActor ??
      agentRecord?.operator ??
      (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
    if (!recipient) {
      continue;
    }
    candidates.push({
      agentId,
      budgetTopUpBps: budgetTopUpBps(agentId),
      claimId: job.claimId,
      itemId: `replication-job:${job.jobId}`,
      operator: agentRecord?.operator ?? null,
      qualityBps: applyDirectWorkCommitment(
        applyAgentEconomicMaturity(qualityForReplication(replication), agentRecord),
        "replication",
        agentRecord,
      ),
      recipient,
      workKind: "replication",
    });
  }

  for (const task of input.maintenanceTasks) {
    if (task.status !== "completed") {
      continue;
    }
    const agentId = task.assignedAgentId;
    const agentRecord = await getAgentRecord(agentId);
    const recipient =
      agentRecord?.operator ??
      (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
    if (!recipient) {
      continue;
    }
    candidates.push({
      agentId,
      budgetTopUpBps: budgetTopUpBps(agentId),
      claimId: task.claimId,
      itemId: `artifact-maintenance:${task.taskId}`,
      operator: agentRecord?.operator ?? null,
      qualityBps: applyDirectWorkCommitment(
        applyAgentEconomicMaturity(qualityForMaintenance(task), agentRecord),
        "maintenance",
        agentRecord,
      ),
      recipient,
      workKind: "maintenance",
    });
  }

  for (const forecast of input.forecasts) {
    if (!forecast.settled || forecast.finalStatus === null) {
      continue;
    }
    const agentId = forecast.agentId && forecast.agentId !== "0" ? forecast.agentId : null;
    const recipient =
      normalizeAddress(forecast.forecaster) ??
      (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
    if (!recipient) {
      continue;
    }
    candidates.push({
      agentId,
      budgetTopUpBps: budgetTopUpBps(agentId),
      claimId: forecast.claimId,
      itemId: `forecast:${forecast.forecastId}`,
      operator: agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null,
      qualityBps: qualityForForecast(forecast),
      recipient,
      workKind: "forecast",
    });
  }

  for (const challenge of input.challenges) {
    if (![1, 2].includes(challenge.status)) {
      continue;
    }
    const agentId = challenge.agentId && challenge.agentId !== "0" ? challenge.agentId : null;
    const recipient =
      normalizeAddress(challenge.challenger) ??
      (agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null);
    if (!recipient) {
      continue;
    }
    candidates.push({
      agentId,
      budgetTopUpBps: budgetTopUpBps(agentId),
      claimId: challenge.claimId,
      itemId: `challenge:${challenge.challengeId}`,
      operator: agentId ? await lookupAgentOperator(input.agentRegistry, agentId) : null,
      qualityBps: qualityForChallenge(challenge),
      recipient,
      workKind: "challenge",
    });
  }

  return candidates;
}

export async function applyAutomaticRewardPolicy(options: {
  claimId?: string;
  connectionString?: string;
  domainId?: number;
  env?: NodeJS.ProcessEnv;
  maxSettlements?: number;
  policyVersion?: string;
}): Promise<AutomaticRewardPolicyResult> {
  const env = options.env ?? process.env;
  const policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
  const pool = await prepareRewardStore(options.connectionString);
  try {
    const [
      claimsPage,
      challengesPage,
      forecastsPage,
      reviewTasksPage,
      reviewSubmissionsPage,
      replicationJobsPage,
      replicationsPage,
      maintenanceTasksPage,
    ] = await Promise.all([
      readAllPages((pagination) =>
        readClaimsPage(pool, { ...pagination, domainId: options.domainId }),
      ),
      readAllPages((pagination) => readChallengesPage(pool, pagination)),
      readAllPages((pagination) => readForecastsPage(pool, pagination)),
      readAllPages((pagination) =>
        readReviewTasksPage(pool, { ...pagination, claimId: options.claimId }),
      ),
      readAllPages((pagination) =>
        readReviewSubmissionsPage(pool, { ...pagination, claimId: options.claimId }),
      ),
      readAllPages((pagination) =>
        readReplicationJobsPage(pool, { ...pagination, claimId: options.claimId }),
      ),
      readAllPages((pagination) => readReplicationsPage(pool, pagination)),
      readAllPages((pagination) => readArtifactMaintenanceTasksPage(pool, pagination)),
    ]);

    const claimIds = new Set(
      claimsPage
        .filter((claim) => options.claimId === undefined || claim.claimId === options.claimId)
        .map((claim) => claim.claimId),
    );
    const filteredReviewTasks = reviewTasksPage.filter(
      (task) => typeof task.claimId === "string" && claimIds.has(task.claimId),
    );
    const filteredReviewSubmissions = reviewSubmissionsPage.filter(
      (submission) => typeof submission.claimId === "string" && claimIds.has(submission.claimId),
    );
    const filteredReplicationJobs = replicationJobsPage.filter((job) => claimIds.has(job.claimId));
    const filteredChallenges = challengesPage.filter((challenge) =>
      claimIds.has(challenge.claimId),
    );
    const filteredForecasts = forecastsPage.filter((forecast) => claimIds.has(forecast.claimId));
    const filteredReplications = replicationsPage.filter((replication) =>
      claimIds.has(replication.claimId),
    );
    const artifactKeyToClaimId = new Map<string, string>();
    for (const task of filteredReviewTasks) {
      if (!task.claimId) {
        continue;
      }
      for (const artifactKey of task.inputArtifactKeys) {
        artifactKeyToClaimId.set(artifactKey, task.claimId);
      }
      if (task.resultArtifactKey) {
        artifactKeyToClaimId.set(task.resultArtifactKey, task.claimId);
      }
    }
    for (const submission of filteredReviewSubmissions) {
      if (!submission.claimId) {
        continue;
      }
      if (submission.evidenceArtifactKey) {
        artifactKeyToClaimId.set(submission.evidenceArtifactKey, submission.claimId);
      }
      if (submission.resultArtifactKey) {
        artifactKeyToClaimId.set(submission.resultArtifactKey, submission.claimId);
      }
    }
    for (const job of filteredReplicationJobs) {
      if (job.resultArtifactKey) {
        artifactKeyToClaimId.set(job.resultArtifactKey, job.claimId);
      }
    }
    const filteredMaintenanceTasks = maintenanceTasksPage
      .map((task) => ({
        ...task,
        claimId: artifactKeyToClaimId.get(task.artifactKey) ?? null,
      }))
      .filter(
        (
          task,
        ): task is ArtifactMaintenanceTaskView & {
          claimId: string;
        } => typeof task.claimId === "string" && claimIds.has(task.claimId),
      );

    const reviewRunsByTaskId = Object.fromEntries(
      await Promise.all(
        filteredReviewTasks.map(async (task) => [
          task.taskId,
          (await readReviewTaskRuns(pool, task.taskId)).map(toClaimWorkRunView),
        ]),
      ),
    );
    const replicationRunsByJobId = Object.fromEntries(
      await Promise.all(
        filteredReplicationJobs.map(async (job) => [
          job.jobId,
          (await readReplicationJobRuns(pool, job.jobId)).map(toClaimWorkRunView),
        ]),
      ),
    );
    const maintenanceRunsByTaskId = Object.fromEntries(
      await Promise.all(
        filteredMaintenanceTasks.map(async (task) => [
          task.taskId,
          (await readArtifactMaintenanceTaskRuns(pool, task.taskId)).map(toClaimWorkRunView),
        ]),
      ),
    );
    const workGraphsByClaimId = new Map<string, ClaimWorkGraphView>(
      await Promise.all(
        [...claimIds].map(
          async (claimId): Promise<readonly [string, ClaimWorkGraphView]> => [
            claimId,
            buildClaimWorkGraph({
              artifactMaintenanceRunsByTaskId: Object.fromEntries(
                filteredMaintenanceTasks
                  .filter((task) => task.claimId === claimId)
                  .map((task) => [task.taskId, maintenanceRunsByTaskId[task.taskId] ?? []]),
              ),
              artifactMaintenanceTasks: filteredMaintenanceTasks.filter(
                (task) => task.claimId === claimId,
              ),
              artifacts: await readArtifactsByClaim(pool, claimId),
              claimId,
              replicationJobs: filteredReplicationJobs.filter((job) => job.claimId === claimId),
              replicationRunsByJobId: Object.fromEntries(
                filteredReplicationJobs
                  .filter((job) => job.claimId === claimId)
                  .map((job) => [job.jobId, replicationRunsByJobId[job.jobId] ?? []]),
              ),
              reviewRunsByTaskId: Object.fromEntries(
                filteredReviewTasks
                  .filter((task) => task.claimId === claimId)
                  .map((task) => [task.taskId, reviewRunsByTaskId[task.taskId] ?? []]),
              ),
              reviewSubmissionsByTaskId: Object.fromEntries(
                filteredReviewTasks
                  .filter((task) => task.claimId === claimId)
                  .map((task) => [
                    task.taskId,
                    filteredReviewSubmissions.filter(
                      (submission) => submission.taskId === task.taskId,
                    ),
                  ]),
              ),
              reviewTasks: filteredReviewTasks.filter((task) => task.claimId === claimId),
            }),
          ],
        ),
      ),
    );
    const demandSignalsByClaimId = new Map<
      string,
      Record<ClaimRewardWorkKind, ClaimRewardWorkDemandSignal>
    >(
      [...workGraphsByClaimId.entries()].map(([claimId, workGraph]) => [
        claimId,
        buildClaimRewardWorkDemandSignals(workGraph),
      ]),
    );

    const calibrationHistory = buildAgentCalibrationHistory(
      claimsPage.filter((claim) => claimIds.has(claim.claimId)),
      filteredReviewSubmissions,
    );
    const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
    const signer = new NonceManager(
      createManagedOperatorSigner(["SP_REWARD_SETTLER_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"], {
        env,
        localAccountIndex: 0,
      }),
    );
    try {
      const [claimRewardVault, agentRegistry] = await Promise.all([
        getContract("ClaimRewardVault", deployment.addresses.claimRewardVault, signer),
        getContract("AgentRegistry", deployment.addresses.agentRegistry, signer),
      ]);
      const replicationsById = new Map(
        filteredReplications.map(
          (replication) => [replication.replicationId, replication] as const,
        ),
      );
      const candidates = await buildPolicyCandidates({
        agentRegistry: agentRegistry as unknown as PolicyAgentRegistry,
        calibrationHistory,
        challenges: filteredChallenges,
        forecasts: filteredForecasts,
        maintenanceTasks: filteredMaintenanceTasks,
        replicationsById,
        replicationJobs: filteredReplicationJobs,
        reviewSubmissions: filteredReviewSubmissions,
        reviewTasks: filteredReviewTasks,
      });
      const accruedByItem = await readAccruedRewardTotals(pool, policyVersion);
      const candidatesByGroup = new Map<string, PolicyCandidate[]>();
      for (const candidate of candidates) {
        const key = `${candidate.claimId}:${candidate.workKind}`;
        const existing = candidatesByGroup.get(key) ?? [];
        existing.push(candidate);
        candidatesByGroup.set(key, existing);
      }

      const settlements: RewardPolicySettlementView[] = [];
      const forecastsByClaimId = new Map<string, ForecastView[]>();
      for (const forecast of filteredForecasts) {
        const existing = forecastsByClaimId.get(forecast.claimId) ?? [];
        existing.push(forecast);
        forecastsByClaimId.set(forecast.claimId, existing);
      }
      const challengesByClaimId = new Map<string, ChallengeView[]>();
      for (const challenge of filteredChallenges) {
        const existing = challengesByClaimId.get(challenge.claimId) ?? [];
        existing.push(challenge);
        challengesByClaimId.set(challenge.claimId, existing);
      }
      for (const [groupKey, groupCandidates] of candidatesByGroup.entries()) {
        const [claimId, workKind] = groupKey.split(":") as [string, ClaimRewardWorkKind];
        const poolBalanceWei = BigInt(
          await claimRewardVault.claimRewardPools(
            BigInt(claimId),
            CLAIM_REWARD_WORK_KIND_CODES[workKind],
          ),
        );
        if (poolBalanceWei === 0n) {
          continue;
        }
        const adjustedCandidates = applyCandidateQualityDiscounts(groupCandidates);
        const claimAttentionPressure = attentionPressureBpsForClaim({
          challenges: challengesByClaimId.get(claimId) ?? [],
          forecasts: forecastsByClaimId.get(claimId) ?? [],
          workKind,
        });
        const schedulerPressureBps =
          demandSignalsByClaimId.get(claimId)?.[workKind]?.schedulerPressureBps ?? 10_000;
        const derivedTargets = deriveRewardTargetsForGroup({
          attentionPressureBps: combinedAttentionPressureBps({
            claimAttentionPressureBps: claimAttentionPressure,
            schedulerPressureBps,
          }),
          candidates: adjustedCandidates.map((candidate) => ({
            itemId: candidate.itemId,
            qualityBps: candidate.qualityBps,
          })),
          poolBalanceWei,
          workKind,
        });
        if (derivedTargets.distributablePoolWei === 0n) {
          continue;
        }
        const targetByItemId = new Map(
          derivedTargets.allocations.map((allocation) => [
            allocation.itemId,
            allocation.targetTotalWei,
          ]),
        );

        for (const candidate of adjustedCandidates) {
          if (options.maxSettlements && settlements.length >= options.maxSettlements) {
            break;
          }
          const targetTotalWei = targetByItemId.get(candidate.itemId) ?? 0n;
          if (targetTotalWei === 0n) {
            continue;
          }
          const existing = accruedByItem.get(candidate.itemId) ?? { accruedWei: 0n, count: 0 };
          if (targetTotalWei <= existing.accruedWei) {
            continue;
          }
          const deltaWei = targetTotalWei - existing.accruedWei;
          const label = `${policyVersion}:step-${existing.count + 1}`;
          const result = await settleWorkReward({
            amountEth: "0",
            amountWei: deltaWei.toString(),
            budgetTopUpBps: candidate.budgetTopUpBps,
            connectionString: options.connectionString,
            env,
            itemId: candidate.itemId,
            recipient: candidate.recipient ?? undefined,
            settlementLabel: label,
          });
          const persisted = await insertWorkRewardSettlement(pool, {
            accruedTotalWei: targetTotalWei.toString(),
            agentId: result.agentId,
            amountWei: result.amountWei,
            budgetTopUpBps: candidate.budgetTopUpBps,
            claimId: result.claimId,
            itemId: candidate.itemId,
            marketPressureBps: derivedTargets.marketPressureBps,
            policyVersion,
            qualityBps: candidate.qualityBps,
            recipient: result.recipient,
            settlementId: result.settlementId,
            settlementLabel: result.settlementLabel,
            targetTotalWei: targetTotalWei.toString(),
            txHash: result.txHash,
            workKind,
          });
          accruedByItem.set(candidate.itemId, {
            accruedWei: targetTotalWei,
            count: existing.count + 1,
          });
          settlements.push({
            ...result,
            accruedTotalWei: persisted.accruedTotalWei,
            budgetTopUpBps: persisted.budgetTopUpBps,
            marketPressureBps: persisted.marketPressureBps,
            policyVersion: persisted.policyVersion,
            qualityBps: persisted.qualityBps,
            targetTotalWei: persisted.targetTotalWei,
          });
        }
      }

      return {
        policyVersion,
        settlements,
      };
    } finally {
    }
  } finally {
    await pool.end();
  }
}
