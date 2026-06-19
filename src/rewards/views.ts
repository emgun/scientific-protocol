import type { PageResult } from "../indexer/store.js";
import type { WorkRewardSettlementTotalsView, WorkRewardSettlementView } from "./store.js";
import type { ClaimRewardWorkKind } from "./types.js";

export type RewardProtocolConfigView = {
  chainId: number;
  claimRewardVaultAddress: string;
  network: string;
  rpcUrl?: string;
};

export type ClaimRewardPoolView = {
  balanceWei: string;
  workKind: ClaimRewardWorkKind;
};

export type ClaimRewardPolicyAttentionView = {
  challengeActivityPressureBps: number;
  distinctChallengeParticipants: number;
  distinctForecastParticipants: number;
  forecastActivityPressureBps: number;
  forecastCount: number;
  openChallengeCount: number;
  totalChallengeBondWei: string;
  totalForecastStakeWei: string;
};

export type ClaimRewardPolicySignalView = {
  attentionPressureBps: number;
  baseRewardWei: string;
  combinedPressureBps: number;
  distributionFractionBps: number;
  freshContributorItems: number;
  fundingTargetWei: string;
  marketPressureBps: number;
  minimumQualityBps: number;
  minimumCoverageItems: number;
  poolBalanceWei: string;
  reassignmentReadyItems: number;
  redundancyTargetItems: number;
  schedulerPressureBps: number;
  uncoveredDemand: number;
  workKind: ClaimRewardWorkKind;
};

export type ClaimRewardPolicyExplanationView = {
  attention: ClaimRewardPolicyAttentionView;
  narrative: string;
  policyVersion: string;
  signals: ClaimRewardPolicySignalView[];
};

export type ClaimRewardStateView = {
  claimId: string;
  policy: ClaimRewardPolicyExplanationView;
  pools: ClaimRewardPoolView[];
  recentSettlements: PageResult<WorkRewardSettlementView>;
  settled: WorkRewardSettlementTotalsView;
  totalPoolWei: string;
};

export type AgentRewardStateView = {
  agentId: string;
  budgetBalanceWei: string;
  operator: string;
  recentSettlements: PageResult<WorkRewardSettlementView>;
  settled: WorkRewardSettlementTotalsView;
  withdrawableRewardBalanceWei: string;
};

export type RewardSettlementHistoryView = {
  recentSettlements: PageResult<WorkRewardSettlementView>;
  settled: WorkRewardSettlementTotalsView;
};

export type RecipientRewardStateView = RewardSettlementHistoryView & {
  recipient: string;
  withdrawableRewardBalanceWei: string;
};
