export type SourceRecordStatus =
  | "discovered"
  | "snapshotted"
  | "extracting"
  | "ready_for_publication"
  | "published"
  | "rejected";

export type SourceDiscoveryMode = "agent_discovered" | "user_submitted";

export type SourceType = "repository" | "url";

export type SourceExtractionAnchor = {
  label: string;
  text: string;
};

export type SourceExtractionCandidate = {
  anchors: SourceExtractionAnchor[];
  candidateId: string;
  claimType: string;
  confidenceBps: number;
  createdAt: string;
  methodology: string;
  reviewerAgentId: string | null;
  scope: string;
  statement: string;
  submissionId: string;
  taskId: string;
};

export type SourceRecordView = {
  canonicalSourceKey: string;
  createdAt: string;
  discoveryMode: SourceDiscoveryMode;
  extractionArtifactKey: string | null;
  publishedClaimId: string | null;
  snapshotArtifactKey: string | null;
  sourceId: string;
  sourceMetadata: Record<string, unknown>;
  sourceType: SourceType;
  status: SourceRecordStatus;
  submittedByActor: string | null;
  submittedByAgentId: string | null;
  updatedAt: string;
};

export type SourceSubmissionOutcome = "created" | "duplicate";

export type SourceSubmissionRecordView = {
  canonicalSourceKey: string;
  createdAt: string;
  discoveryMode: SourceDiscoveryMode;
  normalizedLocator: string;
  rawLocator: string;
  sourceId: string;
  submissionId: string;
  submissionOutcome: SourceSubmissionOutcome;
  submittedByActor: string | null;
  submittedByAgentId: string | null;
};

export type SourcePublicationCluster = {
  averageConfidenceBps: number;
  clusterKey: string;
  distinctAgents: number;
  memberCount: number;
  methodology: string;
  scope: string;
  statement: string;
};

export type SourceAutoPublicationDecision = {
  competingStrengthRatio: number | null;
  reason: string;
  shouldPublish: boolean;
  winningCluster: SourcePublicationCluster | null;
};

export type SourcePublicationDecisionView = {
  competingStrengthRatio: number | null;
  createdAt: string;
  decisionArtifactKey: string | null;
  decisionId: string;
  publishedClaimId: string | null;
  reason: string;
  shouldPublish: boolean;
  sourceId: string;
  winningCluster: SourcePublicationCluster | null;
};

export type SourceFeedItemView = {
  candidateCount: number;
  latestDecision: SourcePublicationDecisionView | null;
  openTaskCount: number;
  source: SourceRecordView;
};

export type SourceEventType =
  | "source.discovered"
  | "source.extracting_started"
  | "source.ready_for_publication"
  | "source.published"
  | "source.rejected"
  | "source.snapshotted";

export type SourceEventView = {
  claimId: string | null;
  eventId: string;
  eventType: SourceEventType;
  occurredAt: string;
  sourceId: string;
  summary: string;
  title: string;
};

export type ClaimFeedItemView = {
  claim: {
    author: string;
    claimId: string;
    createdAtBlock: number;
    domainId: number;
    machineProposed: boolean;
    sourceCanonicalKey: string | null;
    sourceId: string | null;
    sourceTitle: string | null;
    status: number;
  };
};

export type ClaimEventType = "claim.published.machine_proposed";

export type ClaimEventView = {
  claimId: string;
  domainId: number;
  eventId: string;
  eventType: ClaimEventType;
  occurredAt: string;
  sourceId: string | null;
  summary: string;
  title: string;
};

export type CanonicalSourceLocator = {
  canonicalSourceKey: string;
  normalizedLocator: string;
  ref: string | null;
  sourceType: SourceType;
};
