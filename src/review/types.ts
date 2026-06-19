export const REVIEW_TASK_TYPES = [
  "artifact_completeness_check",
  "artifact_integrity_check",
  "benchmark_rerun_check",
  "certification_synthesis_check",
  "claim_extraction_check",
  "claim_extraction_synthesis_check",
  "contradiction_scan",
  "method_consistency_check",
  "replication_readiness_check",
  "stats_sanity_check",
] as const;

export type ReviewTaskType =
  | "artifact_completeness_check"
  | "artifact_integrity_check"
  | "benchmark_rerun_check"
  | "certification_synthesis_check"
  | "claim_extraction_check"
  | "claim_extraction_synthesis_check"
  | "contradiction_scan"
  | "method_consistency_check"
  | "replication_readiness_check"
  | "stats_sanity_check";

export type ReviewTaskSubjectType = "claim" | "source_record";

export type ReviewTaskStatus = "canceled" | "completed" | "escalated" | "open";
export type ReviewTaskRunStatus = "completed" | "failed" | "running";
export type ReviewSubmissionVerdict = "fail" | "flag" | "inconclusive" | "pass";
export type ReviewIssueSeverity = "critical" | "high" | "low" | "medium";
export type ReviewIssueStatus = "dismissed" | "open" | "resolved" | "responded";

export const CLAIM_REVIEW_VECTOR_DIMENSIONS = [
  "artifactCompleteness",
  "artifactIntegrity",
  "certificationReadiness",
  "challengePressure",
  "contradictionPressure",
  "forecastSupport",
  "methodConsistency",
  "replicationSupport",
  "reproducibilityReadiness",
  "reviewCoverage",
  "reviewDiversity",
  "reviewFreshness",
  "statisticalSanity",
] as const;

export type ClaimReviewVectorDimension =
  | "artifactCompleteness"
  | "artifactIntegrity"
  | "certificationReadiness"
  | "challengePressure"
  | "contradictionPressure"
  | "forecastSupport"
  | "methodConsistency"
  | "replicationSupport"
  | "reproducibilityReadiness"
  | "reviewCoverage"
  | "reviewDiversity"
  | "reviewFreshness"
  | "statisticalSanity";

export type ReviewCertificationStatus =
  | "blocked"
  | "certified"
  | "clear"
  | "contested"
  | "pending"
  | "provisional";

export type ReviewConsensusPolicy = {
  maxSubmissions: number;
  minSubmissions: number;
  requireDistinctAgents: boolean;
};

export type ReviewDimensionScores = Partial<Record<ClaimReviewVectorDimension, number>>;

export type ReviewTaskView = {
  claimId: string | null;
  completedAt: string | null;
  consensusPolicy: ReviewConsensusPolicy;
  createdAt: string;
  failureReason: string | null;
  inputArtifactKeys: string[];
  requestedBy: string;
  requiredCapabilities: string[];
  resultArtifactKey: string | null;
  schemaVersion: string;
  scopeKey: string;
  sourceId?: string | null;
  subjectId?: string;
  subjectType?: ReviewTaskSubjectType;
  status: ReviewTaskStatus;
  taskId: string;
  taskType: ReviewTaskType;
  updatedAt: string;
};

export type ReviewTaskRunView = {
  agentId: string | null;
  failureReason: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  runId: string;
  startedAt: string;
  status: ReviewTaskRunStatus;
  taskId: string;
  workerId: string;
};

export type ReviewSubmissionView = {
  claimId: string | null;
  confidenceBps: number;
  createdAt: string;
  dimensions: ReviewDimensionScores;
  evidenceArtifactKey: string | null;
  payload: Record<string, unknown>;
  resultArtifactKey: string | null;
  reviewType: ReviewTaskType;
  reviewerActor: string;
  reviewerAgentId: string | null;
  runId: string | null;
  schemaVersion: string;
  sourceId?: string | null;
  submissionId: string;
  taskId: string;
  verdict: ReviewSubmissionVerdict;
};

export type ReviewIssueView = {
  artifactAnchor: Record<string, unknown>;
  category: string;
  createdAt: string;
  issueId: string;
  status: ReviewIssueStatus;
  severity: ReviewIssueSeverity;
  submissionId: string;
  summary: string;
  updatedAt: string;
};

export type ReviewAuthorResponseView = {
  claimId: string;
  createdAt: string;
  issueIds: string[];
  responderActor: string;
  responseArtifactKey: string;
  responseId: string;
  summary: string;
};

export type ClaimReviewVectorEntry = {
  dimension: ClaimReviewVectorDimension;
  evidenceCount: number;
  label: string;
  scoreBps: number | null;
  tone: "good" | "idle" | "negative" | "neutral";
  updatedAt: string | null;
};

export type ClaimReviewCertificationView = {
  certificationKey: string;
  label: string;
  reason: string;
  scoreBps: number | null;
  status: ReviewCertificationStatus;
};

export type ClaimReviewEstimateView = {
  supportEstimateBps: number | null;
  uncertaintyBps: number | null;
};

export type ClaimReviewExplanationReferenceView = {
  createdAt: string | null;
  href: string | null;
  itemId: string | null;
  label: string;
  sourceType: "replication" | "review_submission" | "work_item";
  submissionId: string | null;
  taskId: string | null;
  verdict: string | null;
};

export type ClaimReviewExplanationSignalView = {
  dimension: ClaimReviewVectorDimension;
  kind: "support" | "uncertainty";
  label: string;
  references: ClaimReviewExplanationReferenceView[];
  reason: string;
  scoreBps: number | null;
};

export type ClaimReviewMissingPrerequisiteView = {
  key: string;
  label: string;
  reason: string;
  references: ClaimReviewExplanationReferenceView[];
};

export type ClaimReviewRecentChangeView = {
  createdAt: string | null;
  label: string;
  reason: string;
  references: ClaimReviewExplanationReferenceView[];
  tone: "good" | "neutral" | "warn";
};

export type ClaimReviewReaderDriverView = {
  kind: "support" | "uncertainty";
  label: string;
  reason: string;
  references: ClaimReviewExplanationReferenceView[];
};

export type ClaimReviewOpenQuestionView = {
  label: string;
  reason: string;
  references: ClaimReviewExplanationReferenceView[];
};

export type ClaimReviewReaderSummaryView = {
  keyDrivers: ClaimReviewReaderDriverView[];
  latestScientificUpdate: string;
  openQuestions: ClaimReviewOpenQuestionView[];
  verdictSummary: string;
};

export type ClaimReviewExplanationView = {
  materialSignals: ClaimReviewExplanationSignalView[];
  missingPrerequisites: ClaimReviewMissingPrerequisiteView[];
  recentChanges: ClaimReviewRecentChangeView[];
  readerSummary: ClaimReviewReaderSummaryView;
  supportNarrative: string;
  uncertaintyNarrative: string;
};

export type AgentReviewCalibrationContributionView = {
  calibrationBps: number;
  claimId: string;
  claimStatus: number;
  createdAt: string;
  outcomeSupportBps: number;
  predictedSupportBps: number;
  reviewType: ReviewTaskType;
  reviewerActor: string;
  submissionId: string;
  verdict: ReviewSubmissionVerdict;
};

export type AgentReviewCalibrationView = {
  agentId: string;
  averageCalibrationBps: number | null;
  reviewerActor: string | null;
  samples: number;
  weightBps: number;
};

export type ClaimReviewAgentCalibrationView = AgentReviewCalibrationView & {
  claimSubmissions: number;
  recentContributions: AgentReviewCalibrationContributionView[];
};

export type ClaimReviewSummary = {
  distinctAgents: number;
  openIssues: number;
  openTasks: number;
  respondedIssues: number;
  responses: number;
  submissions: number;
  taskTypesCovered: number;
  tasks: number;
};

export type ClaimReviewState = {
  agentCalibration: ClaimReviewAgentCalibrationView[];
  certifications: ClaimReviewCertificationView[];
  explanation: ClaimReviewExplanationView;
  estimates: ClaimReviewEstimateView;
  recentResponses: ReviewAuthorResponseView[];
  recentSubmissions: ReviewSubmissionView[];
  summary: ClaimReviewSummary;
  tasks: ReviewTaskView[];
  vector: ClaimReviewVectorEntry[];
};
