import type {
  ArtifactView,
  ChallengeView,
  ClaimView,
  ForecastView,
  ReplicationView,
} from "../shared/read-model.js";
import type { ClaimWorkItemView } from "../work/types.js";
import { type AgentCalibrationHistoryEntry, buildAgentCalibrationHistory } from "./calibration.js";
import type {
  ClaimReviewAgentCalibrationView,
  ClaimReviewCertificationView,
  ClaimReviewEstimateView,
  ClaimReviewExplanationReferenceView,
  ClaimReviewExplanationSignalView,
  ClaimReviewExplanationView,
  ClaimReviewMissingPrerequisiteView,
  ClaimReviewOpenQuestionView,
  ClaimReviewReaderDriverView,
  ClaimReviewReaderSummaryView,
  ClaimReviewRecentChangeView,
  ClaimReviewState,
  ClaimReviewSummary,
  ClaimReviewVectorDimension,
  ClaimReviewVectorEntry,
  ReviewAuthorResponseView,
  ReviewIssueView,
  ReviewSubmissionView,
  ReviewTaskType,
  ReviewTaskView,
} from "./types.js";

const DIMENSION_LABELS: Record<ClaimReviewVectorDimension, string> = {
  artifactCompleteness: "Artifact completeness",
  artifactIntegrity: "Artifact integrity",
  certificationReadiness: "Certification readiness",
  challengePressure: "Challenge pressure",
  contradictionPressure: "Contradiction pressure",
  forecastSupport: "Forecast support",
  methodConsistency: "Method consistency",
  replicationSupport: "Replication support",
  reproducibilityReadiness: "Reproducibility readiness",
  reviewCoverage: "Review coverage",
  reviewDiversity: "Review diversity",
  reviewFreshness: "Review freshness",
  statisticalSanity: "Statistical sanity",
};

const DIMENSION_TASK_TYPES: Partial<Record<ClaimReviewVectorDimension, ReviewTaskType[]>> = {
  artifactCompleteness: ["artifact_completeness_check"],
  artifactIntegrity: ["artifact_integrity_check"],
  certificationReadiness: ["certification_synthesis_check"],
  contradictionPressure: ["contradiction_scan"],
  methodConsistency: ["method_consistency_check"],
  reproducibilityReadiness: ["benchmark_rerun_check", "replication_readiness_check"],
  replicationSupport: ["benchmark_rerun_check", "replication_readiness_check"],
  statisticalSanity: ["stats_sanity_check"],
};

const POSITIVE_DIMS = new Set<ClaimReviewVectorDimension>([
  "artifactCompleteness",
  "artifactIntegrity",
  "certificationReadiness",
  "forecastSupport",
  "methodConsistency",
  "replicationSupport",
  "reproducibilityReadiness",
  "reviewCoverage",
  "reviewDiversity",
  "reviewFreshness",
  "statisticalSanity",
]);

type BuildClaimReviewStateInput = {
  artifacts: ArtifactView[];
  challenges: ChallengeView[];
  claims?: ClaimView[];
  currentClaimId?: string;
  forecasts: ForecastView[];
  issues: ReviewIssueView[];
  replications: ReplicationView[];
  responses: ReviewAuthorResponseView[];
  submissionHistory?: ReviewSubmissionView[];
  submissions: ReviewSubmissionView[];
  tasks: ReviewTaskView[];
  workItems?: ClaimWorkItemView[];
};

type DimensionAggregate = {
  evidenceCount: number;
  scoreBps: number | null;
  updatedAt: string | null;
};

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return clampBps(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function titleCase(input: string): string {
  return input
    .replaceAll("_", " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function scoreTone(dimension: ClaimReviewVectorDimension, scoreBps: number | null) {
  if (scoreBps === null) {
    return "idle" as const;
  }
  const isPositive = POSITIVE_DIMS.has(dimension);
  if (isPositive) {
    if (scoreBps >= 7_500) {
      return "good" as const;
    }
    if (scoreBps >= 4_500) {
      return "neutral" as const;
    }
    return "negative" as const;
  }
  if (scoreBps <= 3_000) {
    return "good" as const;
  }
  if (scoreBps <= 5_500) {
    return "neutral" as const;
  }
  return "negative" as const;
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left);
  if (timestamps.length === 0) {
    return null;
  }
  return new Date(timestamps[0]).toISOString();
}

function parseTimestampMillis(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function aggregateSubmittedDimension(
  submissions: ReviewSubmissionView[],
  dimension: ClaimReviewVectorDimension,
  agentCalibration: Map<string, AgentCalibrationHistoryEntry>,
): DimensionAggregate {
  const evidence = submissions.filter(
    (submission) => typeof submission.dimensions[dimension] === "number",
  );
  if (evidence.length === 0) {
    return {
      evidenceCount: 0,
      scoreBps: null,
      updatedAt: null,
    };
  }
  const weightedScores = evidence.map((submission) => {
    const dimensionScore = Number(submission.dimensions[dimension] ?? 0);
    const confidenceWeight = Math.max(1_000, submission.confidenceBps);
    const calibrationWeight = submission.reviewerAgentId
      ? (agentCalibration.get(submission.reviewerAgentId)?.weightBps ?? 10_000)
      : 10_000;
    const effectiveWeight = Math.max(
      1_000,
      Math.round((confidenceWeight * calibrationWeight) / 10_000),
    );
    return dimensionScore * effectiveWeight;
  });
  const totalWeight = evidence.reduce((sum, submission) => {
    const confidenceWeight = Math.max(1_000, submission.confidenceBps);
    const calibrationWeight = submission.reviewerAgentId
      ? (agentCalibration.get(submission.reviewerAgentId)?.weightBps ?? 10_000)
      : 10_000;
    return sum + Math.max(1_000, Math.round((confidenceWeight * calibrationWeight) / 10_000));
  }, 0);
  return {
    evidenceCount: evidence.length,
    scoreBps: clampBps(weightedScores.reduce((sum, value) => sum + value, 0) / totalWeight),
    updatedAt: latestTimestamp(evidence.map((submission) => submission.createdAt)),
  };
}

function buildAgentCalibrationView(
  submissions: ReviewSubmissionView[],
  agentCalibration: Map<string, AgentCalibrationHistoryEntry>,
): ClaimReviewAgentCalibrationView[] {
  const currentClaimSubmissions = new Map<
    string,
    {
      claimSubmissions: number;
      reviewerActor: string | null;
    }
  >();

  for (const submission of submissions) {
    if (!submission.reviewerAgentId) {
      continue;
    }
    const aggregate = currentClaimSubmissions.get(submission.reviewerAgentId) ?? {
      claimSubmissions: 0,
      reviewerActor: null,
    };
    aggregate.claimSubmissions += 1;
    aggregate.reviewerActor ??= submission.reviewerActor;
    currentClaimSubmissions.set(submission.reviewerAgentId, aggregate);
  }

  return [...currentClaimSubmissions.entries()]
    .map(([agentId, aggregate]) => ({
      agentId,
      averageCalibrationBps: agentCalibration.get(agentId)?.averageCalibrationBps ?? null,
      claimSubmissions: aggregate.claimSubmissions,
      recentContributions: agentCalibration.get(agentId)?.contributions.slice(0, 2) ?? [],
      reviewerActor: aggregate.reviewerActor,
      samples: agentCalibration.get(agentId)?.samples ?? 0,
      weightBps: agentCalibration.get(agentId)?.weightBps ?? 10_000,
    }))
    .sort((left, right) => {
      if (left.weightBps === right.weightBps) {
        if (left.samples === right.samples) {
          return left.agentId.localeCompare(right.agentId);
        }
        return right.samples - left.samples;
      }
      return right.weightBps - left.weightBps;
    });
}

function hasArtifactType(artifacts: ArtifactView[], artifactType: number): boolean {
  return artifacts.some((artifact) => Number(artifact.artifactType) === artifactType);
}

function fallbackArtifactCompleteness(artifacts: ArtifactView[]): number | null {
  if (artifacts.length === 0) {
    return 0;
  }
  let score = 3_500 + Math.min(artifacts.length, 3) * 1_300;
  if (hasArtifactType(artifacts, 5)) {
    score += 1_200;
  }
  if (hasArtifactType(artifacts, 1) || hasArtifactType(artifacts, 4)) {
    score += 1_000;
  }
  if (hasArtifactType(artifacts, 2)) {
    score += 700;
  }
  return clampBps(score);
}

function fallbackArtifactIntegrity(artifacts: ArtifactView[]): number | null {
  if (artifacts.length === 0) {
    return 0;
  }
  const validArtifacts = artifacts.filter(
    (artifact) => artifact.contentDigest.startsWith("0x") && artifact.uri.trim().length > 0,
  ).length;
  return clampBps((validArtifacts / artifacts.length) * 10_000);
}

function fallbackMethodConsistency(artifacts: ArtifactView[]): number | null {
  if (hasArtifactType(artifacts, 5)) {
    return hasArtifactType(artifacts, 1) || hasArtifactType(artifacts, 4) ? 7_000 : 6_000;
  }
  if (artifacts.length > 0) {
    return 4_500;
  }
  return 0;
}

function fallbackStatisticalSanity(
  artifacts: ArtifactView[],
  replications: ReplicationView[],
): number | null {
  if (hasArtifactType(artifacts, 5) && replications.length > 0) {
    return 6_500;
  }
  if (hasArtifactType(artifacts, 5)) {
    return 5_000;
  }
  return 0;
}

function fallbackReproducibilityReadiness(artifacts: ArtifactView[]): number | null {
  const hasCode = hasArtifactType(artifacts, 1);
  const hasContainer = hasArtifactType(artifacts, 2);
  const hasNotebook = hasArtifactType(artifacts, 4);
  if (hasCode && (hasContainer || hasNotebook)) {
    return 8_500;
  }
  if (hasCode || hasNotebook) {
    return 7_000;
  }
  if (artifacts.length > 0) {
    return 4_000;
  }
  return 0;
}

function fallbackReplicationSupport(replications: ReplicationView[]): number | null {
  if (replications.length === 0) {
    return 0;
  }
  const scores = replications.map((replication) => {
    if (replication.resolutionStatus === 1 || replication.resolutionStatus === 2) {
      return 8_500;
    }
    if (replication.resolutionStatus === 4 || replication.resolutionStatus === 5) {
      return 2_000;
    }
    if (replication.outcome === 1 || replication.outcome === 2) {
      return 7_500;
    }
    if (replication.outcome === 4 || replication.outcome === 5 || replication.outcome === 6) {
      return 2_500;
    }
    return 5_000;
  });
  return average(scores);
}

function fallbackForecastSupport(forecasts: ForecastView[]): number | null {
  if (forecasts.length === 0) {
    return 0;
  }
  const scores = forecasts.map((forecast) => {
    const confidence = clampBps(forecast.confidenceBps);
    const base =
      forecast.direction === 0
        ? confidence
        : forecast.direction === 1
          ? 5_000
          : 10_000 - confidence;
    if (forecast.settled && forecast.matched === false) {
      return clampBps(10_000 - base);
    }
    return base;
  });
  return average(scores);
}

function severityPressure(issues: ReviewIssueView[]): number {
  if (issues.length === 0) {
    return 0;
  }
  const points = issues.map((issue) => {
    switch (issue.severity) {
      case "critical":
        return 3_500;
      case "high":
        return 2_500;
      case "medium":
        return 1_500;
      default:
        return 700;
    }
  });
  return clampBps(points.reduce((sum, value) => sum + value, 0));
}

function fallbackChallengePressure(
  challenges: ChallengeView[],
  issues: ReviewIssueView[],
): number | null {
  const challengeScore = challenges.reduce((score, challenge) => {
    switch (challenge.status) {
      case 0:
        return score + 2_000;
      case 1:
        return score + 3_500;
      case 2:
        return score + 800;
      case 3:
        return score + 4_500;
      default:
        return score + 300;
    }
  }, 0);
  return clampBps(
    challengeScore + severityPressure(issues.filter((issue) => issue.status === "open")),
  );
}

function fallbackContradictionPressure(
  submissions: ReviewSubmissionView[],
  issues: ReviewIssueView[],
): number | null {
  let score = 0;
  for (const submission of submissions) {
    if (
      submission.reviewType === "contradiction_scan" ||
      submission.reviewType === "method_consistency_check" ||
      submission.reviewType === "stats_sanity_check"
    ) {
      if (submission.verdict === "fail" || submission.verdict === "flag") {
        score += Math.max(2_000, submission.confidenceBps);
      }
    }
  }
  score += severityPressure(
    issues.filter(
      (issue) =>
        issue.status === "open" &&
        (issue.category === "contradiction" || issue.category === "methodology"),
    ),
  );
  return clampBps(score);
}

function computeReviewCoverage(
  tasks: ReviewTaskView[],
  submissions: ReviewSubmissionView[],
): number | null {
  if (tasks.length === 0) {
    return 0;
  }
  const coveredTypes = new Set(submissions.map((submission) => submission.reviewType));
  const taskTypes = new Set(tasks.map((task) => task.taskType));
  return clampBps((coveredTypes.size / Math.max(1, taskTypes.size)) * 10_000);
}

function computeReviewDiversity(submissions: ReviewSubmissionView[]): number | null {
  if (submissions.length === 0) {
    return 0;
  }
  const distinctAgents = new Set(
    submissions.map((submission) => submission.reviewerAgentId).filter(Boolean),
  ).size;
  const distinctActors = new Set(submissions.map((submission) => submission.reviewerActor)).size;
  const distinctTaskTypes = new Set(submissions.map((submission) => submission.reviewType)).size;
  const score =
    (distinctAgents / submissions.length) * 5_000 +
    (distinctActors / submissions.length) * 2_000 +
    Math.min(3_000, distinctTaskTypes * 600);
  return clampBps(score);
}

function computeReviewFreshness(submissions: ReviewSubmissionView[]): number | null {
  const latest = latestTimestamp(submissions.map((submission) => submission.createdAt));
  if (!latest) {
    return 0;
  }
  const ageMs = Date.now() - new Date(latest).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) {
    return 10_000;
  }
  if (ageDays <= 30) {
    return 8_000;
  }
  if (ageDays <= 90) {
    return 6_000;
  }
  if (ageDays <= 180) {
    return 4_000;
  }
  return 2_000;
}

function computeCertificationReadiness(
  dimensions: Record<ClaimReviewVectorDimension, number | null>,
): number | null {
  const positiveDimensions = [
    dimensions.artifactCompleteness,
    dimensions.artifactIntegrity,
    dimensions.methodConsistency,
    dimensions.statisticalSanity,
    dimensions.reproducibilityReadiness,
    dimensions.replicationSupport,
    dimensions.reviewCoverage,
    dimensions.reviewDiversity,
    dimensions.reviewFreshness,
    dimensions.forecastSupport,
  ].filter((value): value is number => typeof value === "number");
  if (positiveDimensions.length === 0) {
    return 0;
  }
  const base = average(positiveDimensions) ?? 0;
  const penalty =
    ((dimensions.challengePressure ?? 0) + (dimensions.contradictionPressure ?? 0)) / 3;
  return clampBps(base - penalty);
}

function computeSupportEstimate(
  dimensions: Record<ClaimReviewVectorDimension, number | null>,
): number | null {
  const supportSignals = [
    dimensions.artifactCompleteness,
    dimensions.artifactIntegrity,
    dimensions.methodConsistency,
    dimensions.statisticalSanity,
    dimensions.reproducibilityReadiness,
    dimensions.replicationSupport,
    dimensions.forecastSupport,
  ].filter((value): value is number => typeof value === "number");
  if (supportSignals.length === 0) {
    return 0;
  }
  const base = average(supportSignals) ?? 0;
  const penalty =
    average([dimensions.challengePressure ?? 0, dimensions.contradictionPressure ?? 0]) ?? 0;
  return clampBps(base - penalty / 2);
}

function invertBps(scoreBps: number | null): number {
  return clampBps(10_000 - (scoreBps ?? 0));
}

function computeUncertaintyEstimate(
  dimensions: Record<ClaimReviewVectorDimension, number | null>,
  supportEstimateBps: number | null,
): number | null {
  const ambiguity =
    supportEstimateBps === null
      ? 10_000
      : clampBps(10_000 - Math.abs(supportEstimateBps - 5_000) * 2);
  return average([
    invertBps(dimensions.reviewCoverage),
    invertBps(dimensions.reviewDiversity),
    invertBps(dimensions.reviewFreshness),
    average([dimensions.challengePressure ?? 0, dimensions.contradictionPressure ?? 0]) ?? 0,
    ambiguity,
  ]);
}

function buildCertifications(
  dimensions: Record<ClaimReviewVectorDimension, number | null>,
  summary: ClaimReviewSummary,
  replications: ReplicationView[],
): ClaimReviewCertificationView[] {
  const certifications: ClaimReviewCertificationView[] = [];

  const artifactReady =
    (dimensions.artifactCompleteness ?? 0) >= 8_000 && (dimensions.artifactIntegrity ?? 0) >= 8_000;
  certifications.push({
    certificationKey: "artifact_complete",
    label: "Artifact complete",
    reason: artifactReady
      ? "Artifacts are present with strong completeness and integrity support."
      : summary.tasks > 0
        ? "Artifacts are still being evaluated by agent checks."
        : "No review evidence is available yet.",
    scoreBps: average([dimensions.artifactCompleteness ?? 0, dimensions.artifactIntegrity ?? 0]),
    status: artifactReady ? "certified" : summary.tasks > 0 ? "pending" : "blocked",
  });

  const methodChecked =
    (dimensions.methodConsistency ?? 0) >= 7_000 && (dimensions.statisticalSanity ?? 0) >= 7_000;
  certifications.push({
    certificationKey: "method_checked",
    label: "Method checked",
    reason: methodChecked
      ? "Method and statistics checks are above the current threshold."
      : summary.submissions > 0
        ? "Method review evidence exists, but has not crossed the certification threshold."
        : "No method-focused review evidence exists yet.",
    scoreBps: average([dimensions.methodConsistency ?? 0, dimensions.statisticalSanity ?? 0]),
    status: methodChecked ? "certified" : summary.submissions > 0 ? "pending" : "blocked",
  });

  const reproReady = artifactReady && (dimensions.reproducibilityReadiness ?? 0) >= 7_500;
  certifications.push({
    certificationKey: "repro_ready",
    label: "Repro ready",
    reason: reproReady
      ? "The current artifact bundle looks reproducible enough for downstream reruns."
      : "Reproducibility readiness still needs stronger artifact and execution evidence.",
    scoreBps: dimensions.reproducibilityReadiness,
    status: reproReady ? "certified" : summary.tasks > 0 ? "pending" : "blocked",
  });

  const independentlyReplicated =
    replications.length > 0 && (dimensions.replicationSupport ?? 0) >= 7_000;
  certifications.push({
    certificationKey: "independently_replicated",
    label: "Independently replicated",
    reason: independentlyReplicated
      ? "Replication evidence currently supports the claim."
      : replications.length > 0
        ? "Replication evidence exists but is still mixed or incomplete."
        : "No replication evidence has been recorded yet.",
    scoreBps: dimensions.replicationSupport,
    status: independentlyReplicated ? "certified" : replications.length > 0 ? "pending" : "blocked",
  });

  const contested =
    (dimensions.challengePressure ?? 0) >= 6_000 ||
    (dimensions.contradictionPressure ?? 0) >= 6_000;
  certifications.push({
    certificationKey: "contested",
    label: "Contested state",
    reason: contested
      ? "Open challenge or contradiction pressure is materially elevated."
      : "No strong active contradiction signal is currently dominating the record.",
    scoreBps: average([dimensions.challengePressure ?? 0, dimensions.contradictionPressure ?? 0]),
    status: contested ? "contested" : "clear",
  });

  const readiness = dimensions.certificationReadiness ?? 0;
  const provisional =
    readiness >= 7_500 &&
    !contested &&
    (dimensions.reviewCoverage ?? 0) >= 6_000 &&
    (dimensions.reviewDiversity ?? 0) >= 4_500;
  const fullyCertified = provisional && readiness >= 8_500 && summary.distinctAgents >= 2;
  certifications.push({
    certificationKey: "provisionally_certified",
    label: "Provisional certification",
    reason: fullyCertified
      ? "The claim clears the current review, diversity, and certification thresholds."
      : provisional
        ? "The claim clears provisional thresholds but still needs deeper corroboration."
        : contested
          ? "Certification is blocked by elevated contradiction or challenge pressure."
          : "The claim has not yet crossed the readiness threshold.",
    scoreBps: dimensions.certificationReadiness,
    status: contested
      ? "contested"
      : fullyCertified
        ? "certified"
        : provisional
          ? "provisional"
          : "pending",
  });

  return certifications;
}

function formatBps(scoreBps: number | null): string {
  if (typeof scoreBps !== "number") {
    return "pending";
  }
  return `${Math.round(scoreBps / 100)}%`;
}

function reviewTaskItemId(taskId: string): string {
  return `review-task:${taskId}`;
}

function reviewWorkItemHref(claimId: string | undefined, itemId: string | null): string | null {
  if (!claimId || !itemId) {
    return null;
  }
  return `/work-items/${encodeURIComponent(itemId)}?claimId=${encodeURIComponent(claimId)}`;
}

function reviewSubmissionReference(
  claimId: string | undefined,
  submission: ReviewSubmissionView,
): ClaimReviewExplanationReferenceView {
  return {
    createdAt: submission.createdAt,
    href: reviewWorkItemHref(claimId, reviewTaskItemId(submission.taskId)),
    itemId: reviewTaskItemId(submission.taskId),
    label: `${titleCase(submission.reviewType)} submission ${submission.submissionId}`,
    sourceType: "review_submission",
    submissionId: submission.submissionId,
    taskId: submission.taskId,
    verdict: submission.verdict,
  };
}

function workItemReference(
  claimId: string | undefined,
  item: ClaimWorkItemView,
): ClaimReviewExplanationReferenceView {
  return {
    createdAt: item.updatedAt ?? item.completedAt ?? item.createdAt,
    href: reviewWorkItemHref(claimId, item.itemId),
    itemId: item.itemId,
    label: item.title,
    sourceType: "work_item",
    submissionId: null,
    taskId:
      item.kind === "review_task" && item.itemId.startsWith("review-task:")
        ? item.itemId.slice("review-task:".length)
        : null,
    verdict: item.result?.verdict ?? null,
  };
}

function replicationReference(
  claimId: string | undefined,
  replication: ReplicationView,
): ClaimReviewExplanationReferenceView {
  return {
    createdAt: null,
    href: claimId ? `/claims/${encodeURIComponent(claimId)}/replications` : null,
    itemId: null,
    label: `Replication ${replication.replicationId}`,
    sourceType: "replication",
    submissionId: null,
    taskId: null,
    verdict: `${replication.outcome}`,
  };
}

function sortReferencesByRecency<T extends { createdAt: string | null }>(values: T[]): T[] {
  return [...values].sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
  );
}

function referencesForDimension(
  claimId: string | undefined,
  dimension: ClaimReviewVectorDimension,
  submissions: ReviewSubmissionView[],
  workItems: ClaimWorkItemView[],
): ClaimReviewExplanationReferenceView[] {
  const submissionRefs = sortReferencesByRecency(
    submissions
      .filter((submission) => typeof submission.dimensions[dimension] === "number")
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return right.createdAt.localeCompare(left.createdAt);
        }
        return right.confidenceBps - left.confidenceBps;
      })
      .slice(0, 2)
      .map((submission) => reviewSubmissionReference(claimId, submission)),
  );
  if (submissionRefs.length > 0) {
    return submissionRefs;
  }

  const taskTypes = new Set(DIMENSION_TASK_TYPES[dimension] ?? []);
  if (dimension === "replicationSupport") {
    return sortReferencesByRecency(
      workItems
        .filter(
          (item) =>
            item.kind === "replication_job" ||
            (item.kind === "review_task" && taskTypes.has(item.sourceType as ReviewTaskType)),
        )
        .slice(0, 2)
        .map((item) => workItemReference(claimId, item)),
    );
  }

  if (taskTypes.size === 0) {
    return [];
  }

  return sortReferencesByRecency(
    workItems
      .filter(
        (item) => item.kind === "review_task" && taskTypes.has(item.sourceType as ReviewTaskType),
      )
      .slice(0, 2)
      .map((item) => workItemReference(claimId, item)),
  );
}

function workReferencesForPredicate(
  claimId: string | undefined,
  workItems: ClaimWorkItemView[],
  predicate: (item: ClaimWorkItemView) => boolean,
): ClaimReviewExplanationReferenceView[] {
  return sortReferencesByRecency(
    workItems
      .filter(predicate)
      .slice(0, 2)
      .map((item) => workItemReference(claimId, item)),
  );
}

function submissionTone(
  verdict: ReviewSubmissionView["verdict"],
): ClaimReviewRecentChangeView["tone"] {
  if (verdict === "pass") {
    return "good";
  }
  if (verdict === "inconclusive") {
    return "neutral";
  }
  return "warn";
}

function buildSupportSignals(
  vector: ClaimReviewVectorEntry[],
  claimId: string | undefined,
  submissions: ReviewSubmissionView[],
  workItems: ClaimWorkItemView[],
): ClaimReviewExplanationSignalView[] {
  return vector
    .filter((entry) => typeof entry.scoreBps === "number")
    .filter((entry) => entry.tone === "good" || entry.tone === "neutral")
    .sort((left, right) => (right.scoreBps ?? 0) - (left.scoreBps ?? 0))
    .slice(0, 2)
    .map((entry) => {
      const references = referencesForDimension(claimId, entry.dimension, submissions, workItems);
      return {
        dimension: entry.dimension,
        kind: "support" as const,
        label: entry.label,
        references,
        reason: references[0]
          ? `${entry.label} is currently supporting the claim at ${formatBps(entry.scoreBps)}; the strongest recent signal is ${references[0].label}.`
          : `${entry.label} is currently supporting the claim at ${formatBps(entry.scoreBps)}.`,
        scoreBps: entry.scoreBps,
      };
    });
}

function buildUncertaintySignals(
  vector: ClaimReviewVectorEntry[],
  claimId: string | undefined,
  submissions: ReviewSubmissionView[],
  workItems: ClaimWorkItemView[],
): ClaimReviewExplanationSignalView[] {
  const negativeSignals = vector
    .filter((entry) => typeof entry.scoreBps === "number" && entry.tone === "negative")
    .sort((left, right) => (right.scoreBps ?? 0) - (left.scoreBps ?? 0))
    .slice(0, 2)
    .map((entry) => {
      const references = referencesForDimension(claimId, entry.dimension, submissions, workItems);
      return {
        dimension: entry.dimension,
        kind: "uncertainty" as const,
        label: entry.label,
        references,
        reason: references[0]
          ? `${entry.label} is still unresolved at ${formatBps(entry.scoreBps)}; the latest relevant work is ${references[0].label}.`
          : `${entry.label} is still unresolved at ${formatBps(entry.scoreBps)}.`,
        scoreBps: entry.scoreBps,
      };
    });
  if (negativeSignals.length > 0) {
    return negativeSignals;
  }

  return vector
    .filter((entry) => typeof entry.scoreBps === "number")
    .sort((left, right) => (left.scoreBps ?? 0) - (right.scoreBps ?? 0))
    .slice(0, 2)
    .map((entry) => {
      const references = referencesForDimension(claimId, entry.dimension, submissions, workItems);
      return {
        dimension: entry.dimension,
        kind: "uncertainty" as const,
        label: entry.label,
        references,
        reason: references[0]
          ? `${entry.label} still needs stronger corroboration at ${formatBps(entry.scoreBps)}; the next relevant work is ${references[0].label}.`
          : `${entry.label} still needs stronger corroboration at ${formatBps(entry.scoreBps)}.`,
        scoreBps: entry.scoreBps,
      };
    });
}

function buildMissingPrerequisites(
  claimId: string | undefined,
  dimensions: Record<ClaimReviewVectorDimension, number | null>,
  summary: ClaimReviewSummary,
  replications: ReplicationView[],
  workItems: ClaimWorkItemView[],
): ClaimReviewMissingPrerequisiteView[] {
  const missing: ClaimReviewMissingPrerequisiteView[] = [];

  if (
    (dimensions.artifactCompleteness ?? 0) < 8_000 ||
    (dimensions.artifactIntegrity ?? 0) < 8_000
  ) {
    missing.push({
      key: "artifact_quality",
      label: "Artifact quality",
      reason: "Artifacts still need stronger completeness and integrity corroboration.",
      references: workReferencesForPredicate(
        claimId,
        workItems,
        (item) =>
          item.kind === "review_task" &&
          item.status !== "completed" &&
          (item.sourceType === "artifact_completeness_check" ||
            item.sourceType === "artifact_integrity_check"),
      ),
    });
  }
  if ((dimensions.methodConsistency ?? 0) < 7_000 || (dimensions.statisticalSanity ?? 0) < 7_000) {
    missing.push({
      key: "method_checks",
      label: "Method and statistics",
      reason: "Method consistency and statistical sanity have not crossed the current threshold.",
      references: workReferencesForPredicate(
        claimId,
        workItems,
        (item) =>
          item.kind === "review_task" &&
          item.status !== "completed" &&
          (item.sourceType === "method_consistency_check" ||
            item.sourceType === "stats_sanity_check"),
      ),
    });
  }
  if (replications.length === 0 || (dimensions.replicationSupport ?? 0) < 7_000) {
    missing.push({
      key: "replication_support",
      label: "Replication support",
      reason: "Replication support is still too thin for strong certification.",
      references: workReferencesForPredicate(
        claimId,
        workItems,
        (item) =>
          item.status !== "completed" &&
          (item.kind === "replication_job" ||
            (item.kind === "review_task" && item.sourceType === "replication_readiness_check")),
      ),
    });
  }
  if ((dimensions.reviewCoverage ?? 0) < 6_000 || (dimensions.reviewDiversity ?? 0) < 4_500) {
    missing.push({
      key: "independent_coverage",
      label: "Independent corroboration",
      reason: "Broader independent agent coverage is still needed.",
      references: workReferencesForPredicate(
        claimId,
        workItems,
        (item) =>
          item.status === "open" &&
          (item.scheduling.needsMinimumCoverage ||
            item.scheduling.needsRedundantCoverage ||
            item.scheduling.prefersFreshContributor),
      ),
    });
  }
  if (summary.openIssues > 0 || (dimensions.challengePressure ?? 0) >= 6_000) {
    missing.push({
      key: "open_issues",
      label: "Open issues and challenges",
      reason: "Open review issues or challenge pressure still need to be resolved.",
      references: workReferencesForPredicate(
        claimId,
        workItems,
        (item) =>
          item.kind === "review_task" &&
          item.status !== "completed" &&
          (item.sourceType === "contradiction_scan" ||
            item.sourceType === "certification_synthesis_check"),
      ),
    });
  }
  if ((dimensions.contradictionPressure ?? 0) >= 6_000) {
    missing.push({
      key: "contradiction_pressure",
      label: "Contradiction pressure",
      reason: "Contradiction pressure is still elevated enough to block stronger certification.",
      references: workReferencesForPredicate(
        claimId,
        workItems,
        (item) =>
          item.kind === "review_task" &&
          (item.sourceType === "contradiction_scan" ||
            item.sourceType === "certification_synthesis_check"),
      ),
    });
  }

  return missing
    .filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.key === entry.key) === index,
    )
    .slice(0, 4);
}

function buildRecentChanges(
  claimId: string | undefined,
  submissions: ReviewSubmissionView[],
  replications: ReplicationView[],
): ClaimReviewRecentChangeView[] {
  const submissionChanges = submissions.map((submission) => ({
    createdAt: submission.createdAt,
    label: `${titleCase(submission.reviewType)} ${titleCase(submission.verdict)}`,
    reason: scientificUpdateReasonForSubmission(submission),
    references: [reviewSubmissionReference(claimId, submission)],
    tone: submissionTone(submission.verdict),
    sortKey: `submission:${submission.createdAt}:${submission.submissionId}`,
  }));

  const replicationChanges = [...replications].sort(compareReplicationIds).map((replication) => ({
    createdAt: null,
    label: `Replication ${replication.replicationId}`,
    reason: scientificUpdateReasonForReplication(replication),
    references: [replicationReference(claimId, replication)],
    tone:
      replication.resolutionStatus === 1 || replication.resolutionStatus === 2
        ? ("good" as const)
        : replication.resolutionStatus === 4 || replication.resolutionStatus === 5
          ? ("warn" as const)
          : ("neutral" as const),
    sortKey: `replication:${normalizeReplicationSortKey(replication.replicationId)}`,
  }));

  return [...submissionChanges, ...replicationChanges]
    .sort((left, right) => {
      const leftTimestamp = parseTimestampMillis(left.createdAt);
      const rightTimestamp = parseTimestampMillis(right.createdAt);
      if (leftTimestamp !== null || rightTimestamp !== null) {
        if (leftTimestamp === null) {
          return 1;
        }
        if (rightTimestamp === null) {
          return -1;
        }
        if (leftTimestamp !== rightTimestamp) {
          return rightTimestamp - leftTimestamp;
        }
      }
      return right.sortKey.localeCompare(left.sortKey);
    })
    .slice(0, 4)
    .map(({ sortKey: _sortKey, ...entry }) => entry);
}

function scientificUpdateReasonForSubmission(submission: ReviewSubmissionView): string {
  return typeof submission.payload.summary === "string" && submission.payload.summary.length > 0
    ? submission.payload.summary
    : `${titleCase(submission.reviewType)} returned ${submission.verdict}.`;
}

function scientificUpdateReasonForReplication(replication: ReplicationView): string {
  return replication.resolutionStatus === 1 || replication.resolutionStatus === 2
    ? "A resolved replication is currently supporting the claim."
    : replication.resolutionStatus === 4 || replication.resolutionStatus === 5
      ? "A resolved replication is currently weakening the claim."
      : "A replication result has been recorded for the claim.";
}

function normalizeReplicationSortKey(replicationId: string): string {
  const numericReplicationId = Number(replicationId);
  if (Number.isFinite(numericReplicationId)) {
    return String(numericReplicationId).padStart(20, "0");
  }
  return replicationId;
}

function compareReplicationIds(left: ReplicationView, right: ReplicationView): number {
  const leftId = Number(left.replicationId);
  const rightId = Number(right.replicationId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return rightId - leftId;
  }
  return right.replicationId.localeCompare(left.replicationId);
}

function selectLatestScientificUpdate(
  submissions: ReviewSubmissionView[],
  replications: ReplicationView[],
): string {
  const timestampedSubmission = [...submissions]
    .map((submission) => ({
      createdAt: parseTimestampMillis(submission.createdAt),
      reason: scientificUpdateReasonForSubmission(submission),
    }))
    .filter((entry): entry is { createdAt: number; reason: string } => entry.createdAt !== null)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (timestampedSubmission) {
    return timestampedSubmission.reason;
  }

  const fallbackReplication = [...replications]
    .sort(compareReplicationIds)
    .map((replication) => scientificUpdateReasonForReplication(replication))[0];
  if (fallbackReplication) {
    return fallbackReplication;
  }

  const fallbackSubmission = [...submissions]
    .sort((left, right) => right.submissionId.localeCompare(left.submissionId))
    .map((submission) => scientificUpdateReasonForSubmission(submission))[0];
  return fallbackSubmission ?? "No recent scientific update has been recorded yet.";
}

function buildReaderSummary(
  materialSignals: ClaimReviewExplanationSignalView[],
  missingPrerequisites: ClaimReviewMissingPrerequisiteView[],
  submissions: ReviewSubmissionView[],
  replications: ReplicationView[],
  summary: ClaimReviewSummary,
  supportNarrative: string,
  uncertaintyNarrative: string,
): ClaimReviewReaderSummaryView {
  const keyDrivers: ClaimReviewReaderDriverView[] = materialSignals.slice(0, 3).map((signal) => ({
    kind: signal.kind,
    label: signal.label,
    reason: signal.reason,
    references: signal.references,
  }));
  const openQuestions: ClaimReviewOpenQuestionView[] = missingPrerequisites
    .slice(0, 3)
    .map((entry) => ({
      label: entry.label,
      reason: entry.reason,
      references: entry.references,
    }));
  const latestScientificUpdate = selectLatestScientificUpdate(submissions, replications);
  const verdictSummary = [
    `Review summary: ${summary.submissions} submissions, ${summary.distinctAgents} distinct agents, and ${summary.taskTypesCovered} task types across ${summary.tasks} tasks.`,
    `Support narrative: ${supportNarrative}`,
    `Uncertainty narrative: ${uncertaintyNarrative}`,
  ].join(" ");

  return {
    keyDrivers,
    latestScientificUpdate,
    openQuestions,
    verdictSummary,
  };
}

function buildReviewExplanation(
  claimId: string | undefined,
  vector: ClaimReviewVectorEntry[],
  dimensions: Record<ClaimReviewVectorDimension, number | null>,
  summary: ClaimReviewSummary,
  replications: ReplicationView[],
  submissions: ReviewSubmissionView[],
  workItems: ClaimWorkItemView[],
): ClaimReviewExplanationView {
  const supportSignals = buildSupportSignals(vector, claimId, submissions, workItems);
  const uncertaintySignals = buildUncertaintySignals(vector, claimId, submissions, workItems);
  const materialSignals = [...supportSignals, ...uncertaintySignals].slice(0, 4);
  const missingPrerequisites = buildMissingPrerequisites(
    claimId,
    dimensions,
    summary,
    replications,
    workItems,
  );
  const recentChanges = buildRecentChanges(claimId, submissions, replications);
  const supportNarrative =
    supportSignals[0]?.reason ?? "Agent review has not accumulated enough support evidence yet.";
  const uncertaintyNarrative =
    uncertaintySignals[0]?.reason ??
    "Uncertainty remains high because the review graph is still sparse.";
  const readerSummary = buildReaderSummary(
    materialSignals,
    missingPrerequisites,
    submissions,
    replications,
    summary,
    supportNarrative,
    uncertaintyNarrative,
  );

  return {
    materialSignals,
    missingPrerequisites,
    recentChanges,
    readerSummary,
    supportNarrative,
    uncertaintyNarrative,
  };
}

function sortTasks(tasks: ReviewTaskView[]): ReviewTaskView[] {
  return [...tasks].sort((left, right) => {
    if (left.status === right.status) {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    }
    return left.status === "open" ? -1 : 1;
  });
}

export function buildClaimReviewState(input: BuildClaimReviewStateInput): ClaimReviewState {
  const openIssues = input.issues.filter((issue) => issue.status === "open");
  const distinctAgents = new Set(
    input.submissions.map((submission) => submission.reviewerAgentId).filter(Boolean),
  ).size;
  const taskTypesCovered = new Set(input.submissions.map((submission) => submission.reviewType))
    .size;

  const summary: ClaimReviewSummary = {
    distinctAgents,
    openIssues: openIssues.length,
    openTasks: input.tasks.filter((task) => task.status === "open").length,
    respondedIssues: input.issues.filter((issue) => issue.status === "responded").length,
    responses: input.responses.length,
    submissions: input.submissions.length,
    taskTypesCovered,
    tasks: input.tasks.length,
  };

  const agentCalibration = buildAgentCalibrationHistory(
    input.claims ?? [],
    input.submissionHistory ?? input.submissions,
    { excludeClaimId: input.currentClaimId },
  );

  const dimensions: Record<ClaimReviewVectorDimension, DimensionAggregate> = {
    artifactCompleteness: aggregateSubmittedDimension(
      input.submissions,
      "artifactCompleteness",
      agentCalibration,
    ),
    artifactIntegrity: aggregateSubmittedDimension(
      input.submissions,
      "artifactIntegrity",
      agentCalibration,
    ),
    certificationReadiness: aggregateSubmittedDimension(
      input.submissions,
      "certificationReadiness",
      agentCalibration,
    ),
    challengePressure: aggregateSubmittedDimension(
      input.submissions,
      "challengePressure",
      agentCalibration,
    ),
    contradictionPressure: aggregateSubmittedDimension(
      input.submissions,
      "contradictionPressure",
      agentCalibration,
    ),
    forecastSupport: aggregateSubmittedDimension(
      input.submissions,
      "forecastSupport",
      agentCalibration,
    ),
    methodConsistency: aggregateSubmittedDimension(
      input.submissions,
      "methodConsistency",
      agentCalibration,
    ),
    replicationSupport: aggregateSubmittedDimension(
      input.submissions,
      "replicationSupport",
      agentCalibration,
    ),
    reproducibilityReadiness: aggregateSubmittedDimension(
      input.submissions,
      "reproducibilityReadiness",
      agentCalibration,
    ),
    reviewCoverage: aggregateSubmittedDimension(
      input.submissions,
      "reviewCoverage",
      agentCalibration,
    ),
    reviewDiversity: aggregateSubmittedDimension(
      input.submissions,
      "reviewDiversity",
      agentCalibration,
    ),
    reviewFreshness: aggregateSubmittedDimension(
      input.submissions,
      "reviewFreshness",
      agentCalibration,
    ),
    statisticalSanity: aggregateSubmittedDimension(
      input.submissions,
      "statisticalSanity",
      agentCalibration,
    ),
  };

  dimensions.artifactCompleteness.scoreBps ??= fallbackArtifactCompleteness(input.artifacts);
  dimensions.artifactIntegrity.scoreBps ??= fallbackArtifactIntegrity(input.artifacts);
  dimensions.methodConsistency.scoreBps ??= fallbackMethodConsistency(input.artifacts);
  dimensions.statisticalSanity.scoreBps ??= fallbackStatisticalSanity(
    input.artifacts,
    input.replications,
  );
  dimensions.reproducibilityReadiness.scoreBps ??= fallbackReproducibilityReadiness(
    input.artifacts,
  );
  dimensions.replicationSupport.scoreBps ??= fallbackReplicationSupport(input.replications);
  dimensions.forecastSupport.scoreBps ??= fallbackForecastSupport(input.forecasts);
  dimensions.challengePressure.scoreBps ??= fallbackChallengePressure(input.challenges, openIssues);
  dimensions.contradictionPressure.scoreBps ??= fallbackContradictionPressure(
    input.submissions,
    openIssues,
  );
  dimensions.reviewCoverage.scoreBps ??= computeReviewCoverage(input.tasks, input.submissions);
  dimensions.reviewDiversity.scoreBps ??= computeReviewDiversity(input.submissions);
  dimensions.reviewFreshness.scoreBps ??= computeReviewFreshness(input.submissions);

  const dimensionScores = Object.fromEntries(
    Object.entries(dimensions).map(([key, value]) => [key, value.scoreBps]),
  ) as Record<ClaimReviewVectorDimension, number | null>;
  dimensions.certificationReadiness.scoreBps =
    dimensions.certificationReadiness.scoreBps ?? computeCertificationReadiness(dimensionScores);
  dimensions.certificationReadiness.updatedAt =
    dimensions.certificationReadiness.updatedAt ??
    latestTimestamp([
      dimensions.artifactCompleteness.updatedAt,
      dimensions.methodConsistency.updatedAt,
      dimensions.replicationSupport.updatedAt,
      dimensions.reviewCoverage.updatedAt,
    ]);

  const supportEstimateBps = computeSupportEstimate(dimensionScores);
  const uncertaintyBps = computeUncertaintyEstimate(dimensionScores, supportEstimateBps);
  const estimates: ClaimReviewEstimateView = {
    supportEstimateBps,
    uncertaintyBps,
  };
  const agentCalibrationView = buildAgentCalibrationView(input.submissions, agentCalibration);

  const vector: ClaimReviewVectorEntry[] = Object.entries(dimensions).map(
    ([dimension, aggregate]) => ({
      dimension: dimension as ClaimReviewVectorDimension,
      evidenceCount: aggregate.evidenceCount,
      label: DIMENSION_LABELS[dimension as ClaimReviewVectorDimension],
      scoreBps: aggregate.scoreBps,
      tone: scoreTone(dimension as ClaimReviewVectorDimension, aggregate.scoreBps),
      updatedAt: aggregate.updatedAt,
    }),
  );

  const certifications = buildCertifications(
    Object.fromEntries(vector.map((entry) => [entry.dimension, entry.scoreBps])) as Record<
      ClaimReviewVectorDimension,
      number | null
    >,
    summary,
    input.replications,
  );
  const explanation = buildReviewExplanation(
    input.currentClaimId,
    vector,
    dimensionScores,
    summary,
    input.replications,
    input.submissions,
    input.workItems ?? [],
  );

  return {
    agentCalibration: agentCalibrationView,
    certifications,
    explanation,
    estimates,
    recentResponses: [...input.responses]
      .sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      )
      .slice(0, 5),
    recentSubmissions: [...input.submissions]
      .sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      )
      .slice(0, 6),
    summary,
    tasks: sortTasks(input.tasks).slice(0, 8),
    vector,
  };
}

export function defaultReviewTaskTypesForClaim(artifacts: ArtifactView[]): ReviewTaskType[] {
  const base: ReviewTaskType[] = [
    "artifact_integrity_check",
    "artifact_completeness_check",
    "replication_readiness_check",
    "contradiction_scan",
    "certification_synthesis_check",
  ];
  if (hasArtifactType(artifacts, 5)) {
    base.push("method_consistency_check", "stats_sanity_check");
  }
  if (
    hasArtifactType(artifacts, 1) ||
    hasArtifactType(artifacts, 2) ||
    hasArtifactType(artifacts, 4)
  ) {
    base.push("benchmark_rerun_check");
  }
  return Array.from(new Set(base));
}
