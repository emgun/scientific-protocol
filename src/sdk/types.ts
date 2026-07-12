import type {
  AgentRequestActionType,
  AgentRequestEnvelope,
} from "../shared/agent-request-envelope.js";

export type {
  AgentRequestActionType,
  AgentRequestEnvelope,
} from "../shared/agent-request-envelope.js";
export type { DeploymentAddresses, DeploymentFile } from "../shared/deployment.js";

export type ProtocolRecord = any;

export type AgentRequestView = ProtocolRecord;
export type AgentReviewCalibrationContributionView = ProtocolRecord;
export type AgentReviewCalibrationView = ProtocolRecord;
export type AgentRewardStateView = ProtocolRecord;
export type AgentRuntimeEventView = ProtocolRecord;
export type AgentView = ProtocolRecord;
export type AgentWebhookDeliveryView = ProtocolRecord;
export type AgentWebhookEventType = string;
export type AgentWebhookSubscriptionView = ProtocolRecord;
export type AgentWorkSummaryView = ProtocolRecord;
export type AppealView = ProtocolRecord;
export type ArtifactMaintenanceTaskRunView = ProtocolRecord;
export type ArtifactMaintenanceTaskView = ProtocolRecord;
export type ArtifactView = ProtocolRecord;
export type ChallengeView = ProtocolRecord;
export type CheckpointView = ProtocolRecord;
export type ClaimEventView = ProtocolRecord;
export type ClaimFeedItemView = ProtocolRecord;
export type ClaimReviewState = ProtocolRecord;
export type ClaimRewardStateView = ProtocolRecord;
export type ClaimView = ProtocolRecord;
export type ClaimWorkGraphView = ProtocolRecord;
export type ClaimWorkItemDetailView = ProtocolRecord;
export type ClaimWorkItemView = ProtocolRecord;
export type ClaimWorkOrchestrationView = ProtocolRecord;
export type ClaimWorkRoutingView = ProtocolRecord;
export type ClaimWorkSchedulingView = ProtocolRecord;
export type ConfirmSourcePublicationResult = ProtocolRecord;
export type DemoClaimInput = ProtocolRecord;
export type DemoClaimResult = ProtocolRecord;
export type DemoDomainRecomputeResult = ProtocolRecord;
export type DemoScenarioView = ProtocolRecord;
export type ForecastView = ProtocolRecord;
export type GovernanceEventView = ProtocolRecord;
export type GovernanceOverviewView = ProtocolRecord;
export type GovernanceProposalDetailView = ProtocolRecord;
export type GovernanceProposalSummaryView = ProtocolRecord;
export type GovernanceTreasuryView = ProtocolRecord;
export type IndexerRuntimeStatus = ProtocolRecord;
export type PersistedArtifactAuditView = ProtocolRecord;
export type PersistedArtifactProvenanceView = ProtocolRecord;
export type PersistedArtifactReplicaView = ProtocolRecord;
export type PersistedArtifactView = ProtocolRecord;
export type ProductionArtifactDraftInput = ProtocolRecord;
export type ProductionArtifactDraftResult = ProtocolRecord;
export type ProductionClaimInput = ProtocolRecord;
export type ProductionClaimResult = ProtocolRecord;
export type ReadModelCounts = Record<string, number>;
export type RecipientRewardStateView = ProtocolRecord;
export type RejectSourcePublicationResult = ProtocolRecord;
export type ReplicationJobRunView = ProtocolRecord;
export type ReplicationJobView = ProtocolRecord;
export type ReplicationView = ProtocolRecord;
export type ReviewAuthorResponseView = ProtocolRecord;
export type ReviewIssueView = ProtocolRecord;
export type ReviewSubmissionView = ProtocolRecord;
export type ReviewTaskRunView = ProtocolRecord;
export type ReviewTaskView = ProtocolRecord;
export type RewardProtocolConfigView = ProtocolRecord;
export type RewardSettlementHistoryView = ProtocolRecord;
export type SourceEventView = ProtocolRecord;
export type SourceExtractionCandidate = ProtocolRecord;
export type SourceFeedItemView = ProtocolRecord;
export type SourcePublicationDecisionView = ProtocolRecord;
export type SourceRecordView = ProtocolRecord;
export type SourceWorkGraphView = ProtocolRecord;
export type WriteProtocolConfigView = ProtocolRecord;

export type PublicWriteActionType =
  | "claim_create"
  | "claim_publish"
  | "claim_draft_from_artifact"
  | "domain_recompute"
  | "replication_job_open"
  | "replication_job_process"
  | "replication_job_resolve"
  | "source_publication_confirm"
  | "source_publication_reject"
  | "source_submit";

export type PublicWriteEnvelope = {
  actionType: PublicWriteActionType;
  actorAddress: string;
  chainId: number;
  issuedAt: string;
  payload: ProtocolRecord;
  requestNonce: string;
  scopeKey: string;
};

export type ReadModel = {
  metadata: ProtocolRecord;
  [key: string]: unknown;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export type PagedResponse<T> = PageResult<T>;

export type ClaimCollectionCounts = {
  appeals: number;
  artifacts: number;
  challenges: number;
  checkpoints: number;
  forecasts: number;
  replications: number;
};

export type ClaimDetailResponse = ClaimView & {
  collectionCounts: ClaimCollectionCounts;
  appeals?: AppealView[];
  artifacts?: ArtifactView[];
  challenges?: ChallengeView[];
  checkpoints?: CheckpointView[];
  forecasts?: ForecastView[];
  replications?: ReplicationView[];
  rewards?: ClaimRewardStateView;
  review?: ClaimReviewState;
  workGraph?: ClaimWorkGraphView;
};

export type DemoScenarioPayload = DemoScenarioView & {
  claim: (ClaimView & { collectionCounts: ClaimCollectionCounts }) | null;
};

export type ApiSyncStatus = {
  blocksRemaining: number | null;
  chainHeadBlock: number | null;
  cursorBlock: number | null;
  indexer: IndexerRuntimeStatus;
  lagBlocks: number | null;
  rpcError: string | null;
  rpcReachable: boolean;
  syncedToHead: boolean | null;
};

export type HealthResponse = ReadModel["metadata"] & {
  counts: ReadModelCounts;
  databaseUrl: string;
  ok: true;
  sync: ApiSyncStatus;
};

export type AdminStatusResponse = {
  counts: ReadModelCounts;
  metadata: ReadModel["metadata"];
  sync: ApiSyncStatus;
};

export type DemoAdminStatusResponse = {
  counts: ReadModelCounts;
  ok: true;
  scenarios: DemoScenarioPayload[];
  sync: ApiSyncStatus;
  tokenConfigured: boolean;
};

export type DemoMutationResponse<TResult> = {
  ok: true;
  result: TResult;
  synced?: {
    indexedAt: string;
    latestBlock: number;
  };
};

export type DemoScenariosResponse = {
  items: DemoScenarioPayload[];
};

export type ReplicationJobDetailResponse = {
  artifact: PersistedArtifactDetailResponse | null;
  job: ReplicationJobView | null;
  runs: ReplicationJobRunView[];
};

export type ArtifactMaintenanceTaskDetailResponse = {
  artifact: PersistedArtifactDetailResponse | null;
  runs: ArtifactMaintenanceTaskRunView[];
  task: ArtifactMaintenanceTaskView;
};

export type ReviewTaskDetailResponse = {
  runs: ReviewTaskRunView[];
  submissions: ReviewSubmissionView[];
  task: ReviewTaskView;
};

export type SourceDetailResponse = {
  candidates: SourceExtractionCandidate[];
  publicationDecisions: PagedResponse<SourcePublicationDecisionView>;
  source: SourceRecordView;
  tasks: ReviewTaskView[];
  workGraph: SourceWorkGraphView;
};

export type SourceIngestionResponse = {
  ok: true;
  requestId: string;
  result: ProductionArtifactDraftResult;
};

export type SourceListQuery = {
  limit?: number;
  offset?: number;
  status?:
    | "discovered"
    | "snapshotted"
    | "extracting"
    | "ready_for_publication"
    | "published"
    | "rejected";
};

export type SourceListResponse = PagedResponse<SourceRecordView>;
export type SourcePublicationDecisionsResponse = PagedResponse<SourcePublicationDecisionView>;
export type SourceFeedResponse = PagedResponse<SourceFeedItemView>;
export type ClaimFeedResponse = PagedResponse<ClaimFeedItemView>;
export type SourceEventsResponse = PagedResponse<SourceEventView>;
export type ClaimEventsResponse = PagedResponse<ClaimEventView>;
export type ConfirmSourcePublicationResponse = {
  ok: true;
  requestId: string;
  result: ConfirmSourcePublicationResult;
  synced: {
    indexedAt: string;
    latestBlock: number;
  };
};
export type RejectSourcePublicationResponse = {
  ok: true;
  requestId: string;
  result: RejectSourcePublicationResult;
};

export type ClaimWorkGraphResponse = ClaimWorkGraphView;
export type SourceWorkGraphResponse = SourceWorkGraphView;
export type ClaimWorkItemDetailResponse = ClaimWorkItemDetailView;

export type AgentRequestDetailResponse = AgentRequestView;

export type AgentReviewCalibrationResponse = AgentReviewCalibrationView & {
  contributions: PagedResponse<AgentReviewCalibrationContributionView>;
};

export type AgentWorkSummaryResponse = {
  agentId: string;
  domainId: number | null;
  summary: AgentWorkSummaryView;
};
export type ClaimRewardStateResponse = ClaimRewardStateView;
export type AgentRewardStateResponse = AgentRewardStateView;
export type RecipientRewardStateResponse = RecipientRewardStateView;
export type RewardSettlementHistoryResponse = RewardSettlementHistoryView;
export type RewardProtocolConfigResponse = RewardProtocolConfigView;
export type WriteProtocolConfigResponse = WriteProtocolConfigView;
export type GovernanceEventsResponse = PagedResponse<GovernanceEventView>;
export type GovernanceOverviewResponse = GovernanceOverviewView;
export type GovernanceTreasuryResponse = GovernanceTreasuryView;
export type GovernanceProposalDetailResponse = GovernanceProposalDetailView;
export type GovernanceProposalsResponse = PagedResponse<GovernanceProposalSummaryView>;

export type AgentRuntimeEventsResponse = PagedResponse<AgentRuntimeEventView>;

export type AgentWebhookSubscriptionsResponse = PagedResponse<AgentWebhookSubscriptionView>;
export type AgentWebhookDeliveriesResponse = PagedResponse<AgentWebhookDeliveryView>;
export type AgentWebhookSubscriptionCreateResponse = {
  ok: true;
  result: {
    signingSecret: string;
    subscription: AgentWebhookSubscriptionView;
  };
};
export type AgentWebhookSubscriptionDeleteResponse = {
  ok: true;
  result: AgentWebhookSubscriptionView | null;
};
export type AgentWebhookSubscriptionPingResponse = {
  ok: true;
  result: {
    delivery: AgentWebhookDeliveryView;
    subscription: AgentWebhookSubscriptionView;
  };
};

export type SignedAgentRequestBody = {
  envelope: AgentRequestEnvelope;
  signature: string;
};

export type SignedPublicWriteRequestBody = {
  envelope: PublicWriteEnvelope;
  signature: string;
};

export type PersistedArtifactDetailResponse = PersistedArtifactView & {
  provenance: PersistedArtifactProvenanceView | null;
  recentAudits: PagedResponse<PersistedArtifactAuditView>;
  replicas: PersistedArtifactReplicaView[];
};

export type DomainLeaderboardResponse<TEntry = Record<string, unknown>> = {
  items: TEntry[];
  latestPayload: {
    computedAt: string;
    domainId: number;
    payloadHash: string;
    payloadId: string;
    uri: string;
  } | null;
  limit: number;
  offset: number;
  total: number;
};

export type ClaimListQuery = {
  author?: string;
  domainId?: number;
  limit?: number;
  offset?: number;
  status?: number;
};

export type CreateDemoClaimRequest = DemoClaimInput;
export type CreateProductionClaimRequest = ProductionClaimInput;
export type CreateProductionArtifactDraftRequest = ProductionArtifactDraftInput;

export type OpenDemoReplicationJobRequest = {
  claimId: string;
  requestedBy?: string;
};

export type ProcessDemoReplicationJobRequest = {
  workerId?: string;
};

export type ResolveDemoReplicationJobRequest = {
  claimStatus?: number;
  confidenceBps?: number;
  resolutionStatus?: number;
};
