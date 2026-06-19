import type { ReviewTaskType } from "../review/types.js";
import type { ClaimWorkItemView } from "../work/types.js";

export const CLAIM_REWARD_WORK_KIND_CODES = {
  review: 0,
  replication: 1,
  maintenance: 2,
  challenge: 3,
  synthesis: 4,
  forecast: 5,
} as const;

export type ClaimRewardWorkKind = keyof typeof CLAIM_REWARD_WORK_KIND_CODES;
export const CLAIM_REWARD_WORK_KINDS = Object.keys(
  CLAIM_REWARD_WORK_KIND_CODES,
) as ClaimRewardWorkKind[];

export function rewardWorkKindForReviewTaskType(taskType: ReviewTaskType): ClaimRewardWorkKind {
  return taskType === "certification_synthesis_check" ? "synthesis" : "review";
}

export function rewardWorkKindForWorkItem(input: {
  kind: ClaimWorkItemView["kind"];
  sourceType: ClaimWorkItemView["sourceType"];
}): ClaimRewardWorkKind {
  if (input.kind === "review_task") {
    return rewardWorkKindForReviewTaskType(input.sourceType as ReviewTaskType);
  }
  if (input.kind === "replication_job") {
    return "replication";
  }
  return "maintenance";
}
