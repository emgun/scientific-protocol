import type { ClaimView } from "../shared/read-model.js";
import type {
  AgentReviewCalibrationContributionView,
  AgentReviewCalibrationView,
  ReviewSubmissionView,
} from "./types.js";

export type AgentCalibrationHistoryEntry = AgentReviewCalibrationView & {
  contributions: AgentReviewCalibrationContributionView[];
};

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

export function claimOutcomeSupportBps(status: number): number | null {
  if (status === 3) {
    return 7_000;
  }
  if (status === 4) {
    return 9_000;
  }
  if (status === 5) {
    return 2_000;
  }
  if (status === 6) {
    return 500;
  }
  return null;
}

export function submissionSupportSignalBps(submission: ReviewSubmissionView): number {
  if (submission.verdict === "pass") {
    return 8_500;
  }
  if (submission.verdict === "inconclusive") {
    return 5_000;
  }
  if (submission.verdict === "flag") {
    return 2_000;
  }
  return 1_500;
}

export function calibrationWeightBps(averageCalibrationBps: number | null): number {
  if (averageCalibrationBps === null) {
    return 10_000;
  }
  return clampBps(4_000 + (averageCalibrationBps * 6_000) / 10_000);
}

export function defaultAgentCalibration(
  agentId: string,
  reviewerActor: string | null = null,
): AgentCalibrationHistoryEntry {
  return {
    agentId,
    averageCalibrationBps: null,
    contributions: [],
    reviewerActor,
    samples: 0,
    weightBps: 10_000,
  };
}

export function buildAgentCalibrationHistory(
  claims: ClaimView[],
  submissions: ReviewSubmissionView[],
  options: {
    excludeClaimId?: string;
  } = {},
): Map<string, AgentCalibrationHistoryEntry> {
  const outcomeByClaimId = new Map(
    claims
      .filter((claim) => claim.claimId !== options.excludeClaimId)
      .map(
        (claim) =>
          [
            claim.claimId,
            { claimStatus: claim.status, outcomeSupportBps: claimOutcomeSupportBps(claim.status) },
          ] as const,
      )
      .filter(
        (entry): entry is readonly [string, { claimStatus: number; outcomeSupportBps: number }] =>
          entry[1].outcomeSupportBps !== null,
      ),
  );
  const aggregates = new Map<
    string,
    {
      contributions: AgentReviewCalibrationContributionView[];
      reviewerActor: string | null;
    }
  >();

  for (const submission of submissions) {
    if (!submission.reviewerAgentId || !submission.claimId) {
      continue;
    }
    const outcome = outcomeByClaimId.get(submission.claimId);
    if (!outcome) {
      continue;
    }
    const predictedSupportBps = submissionSupportSignalBps(submission);
    const calibrationBps = clampBps(
      10_000 - Math.abs(predictedSupportBps - outcome.outcomeSupportBps),
    );
    const aggregate = aggregates.get(submission.reviewerAgentId) ?? {
      contributions: [],
      reviewerActor: null,
    };
    aggregate.reviewerActor ??= submission.reviewerActor;
    aggregate.contributions.push({
      calibrationBps,
      claimId: submission.claimId,
      claimStatus: outcome.claimStatus,
      createdAt: submission.createdAt,
      outcomeSupportBps: outcome.outcomeSupportBps,
      predictedSupportBps,
      reviewType: submission.reviewType,
      reviewerActor: submission.reviewerActor,
      submissionId: submission.submissionId,
      verdict: submission.verdict,
    });
    aggregates.set(submission.reviewerAgentId, aggregate);
  }

  return new Map(
    [...aggregates.entries()].map(([agentId, aggregate]) => {
      const contributions = [...aggregate.contributions].sort((left, right) => {
        const timeDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        if (timeDelta !== 0) {
          return timeDelta;
        }
        return right.submissionId.localeCompare(left.submissionId);
      });
      const totalCalibration = contributions.reduce(
        (sum, contribution) => sum + contribution.calibrationBps,
        0,
      );
      const samples = contributions.length;
      const averageCalibrationBps = samples > 0 ? clampBps(totalCalibration / samples) : null;
      return [
        agentId,
        {
          agentId,
          averageCalibrationBps,
          contributions,
          reviewerActor: aggregate.reviewerActor,
          samples,
          weightBps: calibrationWeightBps(averageCalibrationBps),
        },
      ] as const;
    }),
  );
}
