import type { AgentRuntimeEventView } from "../agents/runtime-events.js";
import type {
  AgentWebhookDeliveryView,
  AgentWebhookEventType,
  AgentWebhookSubscriptionView,
} from "../agents/webhooks.js";
import type { AgentWorkSummaryView } from "../agents/work-summary.js";
import type {
  ArtifactMaintenanceTaskRunView,
  ArtifactMaintenanceTaskView,
  PersistedArtifactAuditView,
  PersistedArtifactProvenanceView,
  PersistedArtifactReplicaView,
  PersistedArtifactView,
  ReplicationJobRunView,
  ReplicationJobView,
} from "../coordinator/store.js";
import type {
  DemoClaimInput,
  DemoClaimResult,
  DemoDomainRecomputeResult,
} from "../demo/actions.js";
import type { DemoScenarioView } from "../demo/store.js";
import type {
  GovernanceEventView,
  GovernanceOverviewView,
  GovernanceProposalDetailView,
  GovernanceProposalSummaryView,
  GovernanceTreasuryView,
} from "../governance/read.js";
import type { IndexerRuntimeStatus, PageResult, ReadModelCounts } from "../indexer/store.js";
import type {
  AgentReviewCalibrationContributionView,
  AgentReviewCalibrationView,
  ClaimReviewState,
  ReviewAuthorResponseView,
  ReviewIssueView,
  ReviewSubmissionView,
  ReviewTaskRunView,
  ReviewTaskView,
} from "../review/types.js";
import type {
  AgentRewardStateView,
  ClaimRewardStateView,
  RecipientRewardStateView,
  RewardProtocolConfigView,
  RewardSettlementHistoryView,
} from "../rewards/views.js";
import type {
  AgentRequestActionType,
  AgentRequestEnvelope,
  AgentRequestView,
} from "../shared/agent-requests.js";
import type {
  PublicWriteActionType,
  PublicWriteEnvelope,
} from "../shared/public-write-requests.js";
import type {
  AgentView,
  AppealView,
  ArtifactView,
  ChallengeView,
  CheckpointView,
  ClaimView,
  ForecastView,
  ReadModel,
  ReplicationView,
} from "../shared/read-model.js";
import type {
  ConfirmSourcePublicationResult,
  RejectSourcePublicationResult,
} from "../sources/manual-publication.js";
import type {
  ClaimEventView,
  ClaimFeedItemView,
  SourceEventView,
  SourceExtractionCandidate,
  SourceFeedItemView,
  SourcePublicationDecisionView,
  SourceRecordView,
} from "../sources/types.js";
import type {
  ProductionArtifactDraftInput,
  ProductionArtifactDraftResult,
  ProductionClaimInput,
  ProductionClaimResult,
} from "../submission/actions.js";
import type { WriteProtocolConfigView } from "../submission/views.js";
import type {
  ClaimWorkGraphView,
  ClaimWorkItemDetailView,
  ClaimWorkItemView,
  ClaimWorkOrchestrationView,
  ClaimWorkRoutingView,
  ClaimWorkSchedulingView,
  SourceWorkGraphView,
} from "../work/types.js";

export type { DeploymentAddresses, DeploymentFile } from "../shared/deployment.js";
export type {
  AgentRequestActionType,
  AgentRequestEnvelope,
  AgentRequestView,
  AgentReviewCalibrationContributionView,
  AgentReviewCalibrationView,
  AgentRewardStateView,
  AgentRuntimeEventView,
  AgentView,
  AgentWebhookDeliveryView,
  AgentWebhookEventType,
  AgentWebhookSubscriptionView,
  AgentWorkSummaryView,
  AppealView,
  ArtifactMaintenanceTaskRunView,
  ArtifactMaintenanceTaskView,
  ArtifactView,
  ChallengeView,
  CheckpointView,
  ClaimEventView,
  ClaimFeedItemView,
  ClaimReviewState,
  ClaimRewardStateView,
  ClaimView,
  ClaimWorkGraphView,
  ClaimWorkItemDetailView,
  ClaimWorkItemView,
  ClaimWorkOrchestrationView,
  ClaimWorkRoutingView,
  ClaimWorkSchedulingView,
  ConfirmSourcePublicationResult,
  DemoClaimInput,
  DemoClaimResult,
  DemoDomainRecomputeResult,
  DemoScenarioView,
  ForecastView,
  GovernanceEventView,
  GovernanceOverviewView,
  GovernanceProposalDetailView,
  GovernanceProposalSummaryView,
  GovernanceTreasuryView,
  IndexerRuntimeStatus,
  PersistedArtifactAuditView,
  PersistedArtifactProvenanceView,
  PersistedArtifactReplicaView,
  PersistedArtifactView,
  ProductionArtifactDraftInput,
  ProductionArtifactDraftResult,
  ProductionClaimInput,
  ProductionClaimResult,
  PublicWriteActionType,
  PublicWriteEnvelope,
  ReadModel,
  ReadModelCounts,
  RecipientRewardStateView,
  RejectSourcePublicationResult,
  ReplicationJobRunView,
  ReplicationJobView,
  ReplicationView,
  ReviewAuthorResponseView,
  ReviewIssueView,
  ReviewSubmissionView,
  ReviewTaskRunView,
  ReviewTaskView,
  RewardProtocolConfigView,
  RewardSettlementHistoryView,
  SourceEventView,
  SourceExtractionCandidate,
  SourceFeedItemView,
  SourcePublicationDecisionView,
  SourceRecordView,
  SourceWorkGraphView,
  WriteProtocolConfigView,
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
