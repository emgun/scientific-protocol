import type { ArtifactMaintenanceTaskView, ReplicationJobView } from "../coordinator/store.js";
import {
  type AgentCalibrationHistoryEntry,
  buildAgentCalibrationHistory,
} from "../review/calibration.js";
import type { ReviewSubmissionView, ReviewTaskView } from "../review/types.js";
import type { ClaimView, ReplicationView } from "../shared/read-model.js";
import { collectClaimWorkArtifactKeys } from "../work/graph.js";

export type AgentWorkSummaryView = {
  agentId: string;
  averageReviewCalibrationBps: number | null;
  calibratedReviewSamples: number;
  effectiveReviewWeightBps: number;
  fraudSignalReplicationCount: number;
  inconclusiveReplicationCount: number;
  maintenanceAuditCount: number;
  maintenanceFailureCount: number;
  maintenanceRepairCount: number;
  qualifiedReplicationCount: number;
  refutedReplicationCount: number;
  replicationCount: number;
  reviewSubmissionCount: number;
  supportedReplicationCount: number;
  workScore: number;
};

type MutableAgentWorkSummary = AgentWorkSummaryView;

export function defaultAgentWorkSummary(agentId: string): MutableAgentWorkSummary {
  return {
    agentId,
    averageReviewCalibrationBps: null,
    calibratedReviewSamples: 0,
    effectiveReviewWeightBps: 10_000,
    fraudSignalReplicationCount: 0,
    inconclusiveReplicationCount: 0,
    maintenanceAuditCount: 0,
    maintenanceFailureCount: 0,
    maintenanceRepairCount: 0,
    qualifiedReplicationCount: 0,
    refutedReplicationCount: 0,
    replicationCount: 0,
    reviewSubmissionCount: 0,
    supportedReplicationCount: 0,
    workScore: 0,
  };
}

function getSummary(
  summaries: Map<string, MutableAgentWorkSummary>,
  agentId: string | null | undefined,
): MutableAgentWorkSummary | null {
  if (!agentId || agentId === "0") {
    return null;
  }
  let summary = summaries.get(agentId);
  if (!summary) {
    summary = defaultAgentWorkSummary(agentId);
    summaries.set(agentId, summary);
  }
  return summary;
}

function scoreReplication(summary: MutableAgentWorkSummary, replication: ReplicationView): void {
  summary.replicationCount += 1;
  if (replication.resolutionStatus === 1) {
    summary.supportedReplicationCount += 1;
    summary.workScore += 20;
  } else if (replication.resolutionStatus === 2) {
    summary.qualifiedReplicationCount += 1;
    summary.workScore += 25;
  } else if (replication.resolutionStatus === 3) {
    summary.inconclusiveReplicationCount += 1;
    summary.workScore += 5;
  } else if (replication.resolutionStatus === 4) {
    summary.refutedReplicationCount += 1;
    summary.workScore -= 10;
  } else if (replication.resolutionStatus === 5) {
    summary.fraudSignalReplicationCount += 1;
    summary.workScore -= 40;
  }
}

function scoreCalibration(
  summary: MutableAgentWorkSummary,
  calibration: AgentCalibrationHistoryEntry,
): void {
  summary.calibratedReviewSamples = calibration.samples;
  summary.averageReviewCalibrationBps = calibration.averageCalibrationBps;
  summary.effectiveReviewWeightBps = calibration.weightBps;
  summary.workScore += calibration.samples * 3;
  if (typeof calibration.averageCalibrationBps === "number") {
    summary.workScore += Math.round((calibration.averageCalibrationBps - 5_000) / 500);
  }
}

function scoreMaintenance(
  summary: MutableAgentWorkSummary,
  task: ArtifactMaintenanceTaskView,
): void {
  if (task.status === "completed") {
    if (task.taskType === "repair") {
      summary.maintenanceRepairCount += 1;
      summary.workScore += 6;
    } else {
      summary.maintenanceAuditCount += 1;
      summary.workScore += 4;
    }
    return;
  }
  if (task.status === "failed") {
    summary.maintenanceFailureCount += 1;
    summary.workScore -= 3;
  }
}

export function buildAgentWorkSummaries(input: {
  claims: ClaimView[];
  maintenanceTasks: ArtifactMaintenanceTaskView[];
  replicationJobs?: ReplicationJobView[];
  replications: ReplicationView[];
  reviewSubmissions: ReviewSubmissionView[];
  reviewTasks?: ReviewTaskView[];
}): AgentWorkSummaryView[] {
  const summaries = new Map<string, MutableAgentWorkSummary>();
  const calibrationHistory = buildAgentCalibrationHistory(input.claims, input.reviewSubmissions);
  const trackedArtifactKeys = new Set(
    collectClaimWorkArtifactKeys({
      replicationJobs: input.replicationJobs,
      reviewSubmissions: input.reviewSubmissions,
      reviewTasks: input.reviewTasks,
    }),
  );

  for (const replication of input.replications) {
    const summary = getSummary(summaries, replication.agentId);
    if (!summary) {
      continue;
    }
    scoreReplication(summary, replication);
  }

  const reviewSubmissionCounts = new Map<string, number>();
  for (const submission of input.reviewSubmissions) {
    if (!submission.reviewerAgentId || submission.reviewerAgentId === "0") {
      continue;
    }
    reviewSubmissionCounts.set(
      submission.reviewerAgentId,
      (reviewSubmissionCounts.get(submission.reviewerAgentId) ?? 0) + 1,
    );
    getSummary(summaries, submission.reviewerAgentId);
  }

  for (const [agentId, count] of reviewSubmissionCounts.entries()) {
    const summary = getSummary(summaries, agentId);
    if (!summary) {
      continue;
    }
    summary.reviewSubmissionCount = count;
  }

  for (const [agentId, calibration] of calibrationHistory.entries()) {
    const summary = getSummary(summaries, agentId);
    if (!summary) {
      continue;
    }
    scoreCalibration(summary, calibration);
  }

  for (const task of input.maintenanceTasks) {
    if (trackedArtifactKeys.size > 0 && !trackedArtifactKeys.has(task.artifactKey)) {
      continue;
    }
    const summary = getSummary(summaries, task.assignedAgentId);
    if (!summary) {
      continue;
    }
    scoreMaintenance(summary, task);
  }

  return [...summaries.values()].sort((left, right) => {
    if (left.workScore !== right.workScore) {
      return right.workScore - left.workScore;
    }
    return left.agentId.localeCompare(right.agentId);
  });
}
