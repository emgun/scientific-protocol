export type ClaimView = {
  claimId: string;
  author: string;
  domainId: number;
  metadataHash: string;
  resolutionModule: string;
  status: number;
  revisionOfClaimId: string | null;
  createdAtBlock: number;
};

export type ArtifactView = {
  artifactId: string;
  claimId: string;
  artifactType: number;
  contentDigest: string;
  uri: string;
  submitter: string;
};

export type ReplicationView = {
  replicationId: string;
  claimId: string;
  replicator: string;
  agentId: string;
  resultHash: string;
  outcome: number | null;
  resolutionStatus: number | null;
  confidenceBps: number | null;
  resolverType: number | null;
  resolutionHash: string | null;
  evidenceHash: string | null;
  evidenceURI: string | null;
};

export type CheckpointView = {
  checkpointId: string;
  domainId: number;
  subjectType: number;
  subjectActor: string;
  subjectClaimId: string;
  subjectAgentId: string;
  subjectModule: string;
  scoreVectorHash: string;
  payloadHash: string;
  uri: string;
};

export type AgentView = {
  agentId: string;
  operator: string;
  metadataHash: string;
  uri: string;
  budgetBalance: string;
  reservedBudget: string;
  spendLimit: string;
  active: boolean;
};

export type AgentControllerView = {
  agentId: string;
  controller: string;
  authorized: boolean;
};

export type ForecastView = {
  forecastId: string;
  claimId: string;
  forecaster: string;
  agentId: string;
  commitmentHash: string;
  stakeAmount: string;
  committedAt: number;
  revealDeadline: number;
  revealed: boolean;
  settled: boolean;
  direction: number;
  confidenceBps: number;
  resolutionDecisionId: string | null;
  finalStatus: number | null;
  matched: boolean | null;
  payoutAmount: string | null;
};

export type ResolutionDecisionView = {
  decisionId: string;
  claimId: string;
  replicationId: string;
  resolutionModule: string;
  status: number;
  claimStatus: number;
  confidenceBps: number;
  resolutionHash: string;
  evidenceHash: string;
  resolverType: number;
  createdAt: string;
  actor: string;
};

export type ChallengeView = {
  challengeId: string;
  claimId: string;
  replicationId: string;
  challenger: string;
  agentId: string;
  evidenceHash: string;
  evidenceURI: string;
  bondAmount: string;
  status: number;
  resolutionHash: string | null;
  createdAt: number;
  resolvedAt: number | null;
  payoutAmount: string | null;
  refundedAmount: string | null;
};

export type AppealView = {
  appealId: string;
  claimId: string;
  replicationId: string;
  challengeId: string;
  appellant: string;
  reason: number;
  filingHash: string;
  uri: string;
  status: number;
  adjudicationHash: string | null;
  adjudicationURI: string | null;
  bondAmount: string;
  createdAt: number;
  adjudicatedAt: number | null;
  refundedAmount: string | null;
};

export type ReadModel = {
  metadata: {
    chainId: number;
    indexedAt: string;
    deploymentBlock: number;
    latestBlock: number;
  };
  claims: ClaimView[];
  artifacts: ArtifactView[];
  replications: ReplicationView[];
  checkpoints: CheckpointView[];
  agents: AgentView[];
  agentControllers: AgentControllerView[];
  forecasts: ForecastView[];
  challenges: ChallengeView[];
  appeals: AppealView[];
};
