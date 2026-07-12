import type { Pool } from "pg";
import {
  createAgentWebhookSubscription,
  deactivateAgentWebhookSubscription,
  enqueueAgentWebhookPingDelivery,
  readAgentWebhookDeliveriesPage,
  readAgentWebhookDelivery,
  readAgentWebhookSubscription,
  readAgentWebhookSubscriptionSecret,
  readAgentWebhookSubscriptionsPage,
} from "../agents/webhooks.js";
import { enqueueArtifactAuditTasks } from "../artifacts/maintenance.js";
import { readCheckpointPublication, readCheckpointPublicationsPage } from "../checkpoints/store.js";
import { submitPersistedReplicationResult } from "../coordinator/execution.js";
import {
  claimArtifactMaintenanceTaskById,
  claimReplicationJobById,
  completeArtifactMaintenanceTask,
  completeReplicationJob,
  createArtifactMaintenanceTask,
  failReplicationJob,
  heartbeatArtifactMaintenanceTaskRun,
  heartbeatReplicationJobRun,
  readArtifactMaintenanceTask,
  readArtifactMaintenanceTaskRuns,
  readArtifactMaintenanceTasksPage,
  readClaimReplicationJobsPage,
  readPersistedArtifact,
  readPersistedArtifactAuditsPage,
  readPersistedArtifactMaintenanceTasksPage,
  readPersistedArtifactProvenance,
  readPersistedArtifactReplicas,
  readPersistedArtifactStorageAttestations,
  readPersistedArtifactStoragePolicy,
  readReplicationJob,
  readReplicationJobRuns,
  readReplicationJobsPage,
  recordPersistedArtifactAudit,
  upsertPersistedArtifact,
  upsertPersistedArtifactReplica,
} from "../coordinator/store.js";
import {
  createDemoArtifactDraft,
  createDemoClaim,
  listFeaturedDemoScenarios,
  openDemoReplicationJob,
  processDemoReplicationJob,
  recomputeDemoDomain,
  reseedOperationalDemoScenario,
  resetSandboxDemo,
  resolveDemoReplicationJob,
} from "../demo/actions.js";
import {
  readGovernanceEvents,
  readGovernanceOverview,
  readGovernanceProposalDetail,
  readGovernanceProposals,
  readGovernanceTreasury,
} from "../governance/read.js";
import { syncReadModel } from "../indexer/projector.js";
import {
  readAgent,
  readAgentControllers,
  readAgentControllersPage,
  readAgents,
  readAgentsPage,
  readAllAppeals,
  readAllArtifacts,
  readAllChallenges,
  readAllCheckpoints,
  readAllForecasts,
  readAllReplications,
  readAppealsByClaim,
  readAppealsPage,
  readArtifactsByClaim,
  readArtifactsPage,
  readChallengesByClaim,
  readChallengesPage,
  readCheckpointsByActor,
  readCheckpointsByClaim,
  readCheckpointsPage,
  readClaim,
  readClaims,
  readClaimsPage,
  readForecastsByClaim,
  readForecastsPage,
  readIndexerRuntimeStatus,
  readMetadata,
  readReadModelCounts,
  readReplicationsByClaim,
  readReplicationsPage,
  readSyncCursor,
} from "../indexer/store.js";
import { readDomainLeaderboard, readLatestReputationPayload } from "../reputation/store.js";
import { readResolutionRun, readResolutionRunsPage } from "../resolver/store.js";
import {
  claimReviewTaskById,
  createReviewAuthorResponse,
  createReviewTask,
  heartbeatReviewTaskRun,
  readReviewAuthorResponsesPage,
  readReviewIssuesPage,
  readReviewSubmission,
  readReviewSubmissionsPage,
  readReviewTask,
  readReviewTaskRuns,
  readReviewTasksPage,
  recordReviewSubmission,
} from "../review/store.js";
import { openDefaultReviewTasksForClaim } from "../review/workflow.js";
import { readClaimRewardPools, readRecipientAccruedRewardBalance } from "../rewards/read.js";
import { readWorkRewardSettlementsPage, readWorkRewardSettlementTotals } from "../rewards/store.js";
import {
  insertAgentRequest,
  readAgentRequest,
  readAgentRequestsPage,
} from "../shared/agent-requests.js";
import { getProvider, getRpcUrl } from "../shared/contracts.js";
import { readOperatorRequest, readOperatorRequestsPage } from "../shared/operator-requests.js";
import {
  insertPublicWriteRequest,
  markPublicWriteRequestAccepted,
  markPublicWriteRequestPending,
  markPublicWriteRequestRejected,
  readPublicWriteRequestByHash,
  releasePublicWriteRequestExecution,
  reservePublicWriteRequestExecution,
} from "../shared/public-write-requests.js";
import { readEnvValue } from "../shared/secrets.js";
import {
  confirmSourcePublication,
  rejectSourcePublication,
} from "../sources/manual-publication.js";
import { ingestSource } from "../sources/service.js";
import {
  readSourceByCanonicalKey,
  readSourceExtractionCandidates,
  readSourceExtractionCandidatesForSources,
  readSourcePublicationDecisionsPage,
  readSourceRecord,
  readSourceSubmissionRecordsPage,
  readSourcesPage,
  upsertSourceRecord,
} from "../sources/store.js";
import {
  createProductionArtifactDraft,
  createProductionClaim,
  publishProductionClaim,
} from "../submission/actions.js";
import { accessControllerHasRole } from "./auth.js";

export type ApiDependencies = {
  accessControllerHasRole: typeof accessControllerHasRole;
  claimArtifactMaintenanceTaskById: typeof claimArtifactMaintenanceTaskById;
  claimReplicationJobById: typeof claimReplicationJobById;
  claimReviewTaskById: typeof claimReviewTaskById;
  completeArtifactMaintenanceTask: typeof completeArtifactMaintenanceTask;
  completeReplicationJob: typeof completeReplicationJob;
  confirmSourcePublication: typeof confirmSourcePublication;
  createProductionArtifactDraft: typeof createProductionArtifactDraft;
  createProductionClaim: typeof createProductionClaim;
  publishProductionClaim: typeof publishProductionClaim;
  ingestSource: typeof ingestSource;
  createDemoArtifactDraft: typeof createDemoArtifactDraft;
  createArtifactMaintenanceTask: typeof createArtifactMaintenanceTask;
  createAgentWebhookSubscription: typeof createAgentWebhookSubscription;
  createDemoClaim: typeof createDemoClaim;
  createReviewAuthorResponse: typeof createReviewAuthorResponse;
  createReviewTask: typeof createReviewTask;
  deactivateAgentWebhookSubscription: typeof deactivateAgentWebhookSubscription;
  enqueueArtifactAuditTasks: typeof enqueueArtifactAuditTasks;
  enqueueAgentWebhookPingDelivery: typeof enqueueAgentWebhookPingDelivery;
  failReplicationJob: typeof failReplicationJob;
  heartbeatArtifactMaintenanceTaskRun: typeof heartbeatArtifactMaintenanceTaskRun;
  heartbeatReplicationJobRun: typeof heartbeatReplicationJobRun;
  heartbeatReviewTaskRun: typeof heartbeatReviewTaskRun;
  insertAgentRequest: typeof insertAgentRequest;
  insertPublicWriteRequest: typeof insertPublicWriteRequest;
  listFeaturedDemoScenarios: typeof listFeaturedDemoScenarios;
  markPublicWriteRequestAccepted: typeof markPublicWriteRequestAccepted;
  markPublicWriteRequestPending: typeof markPublicWriteRequestPending;
  markPublicWriteRequestRejected: typeof markPublicWriteRequestRejected;
  readPublicWriteRequestByHash: typeof readPublicWriteRequestByHash;
  releasePublicWriteRequestExecution: typeof releasePublicWriteRequestExecution;
  reservePublicWriteRequestExecution: typeof reservePublicWriteRequestExecution;
  openDefaultReviewTasksForClaim: typeof openDefaultReviewTasksForClaim;
  openDemoReplicationJob: typeof openDemoReplicationJob;
  processDemoReplicationJob: typeof processDemoReplicationJob;
  recomputeDemoDomain: typeof recomputeDemoDomain;
  reseedOperationalDemoScenario: typeof reseedOperationalDemoScenario;
  resetSandboxDemo: typeof resetSandboxDemo;
  resolveDemoReplicationJob: typeof resolveDemoReplicationJob;
  submitPersistedReplicationResult: typeof submitPersistedReplicationResult;
  getChainHeadBlock: () => Promise<number>;
  readArtifactMaintenanceTask: typeof readArtifactMaintenanceTask;
  readArtifactMaintenanceTaskRuns: typeof readArtifactMaintenanceTaskRuns;
  readArtifactMaintenanceTasksPage: typeof readArtifactMaintenanceTasksPage;
  readAgent: typeof readAgent;
  readAgentControllers: typeof readAgentControllers;
  readAgentControllersPage: typeof readAgentControllersPage;
  readAgentRequest: typeof readAgentRequest;
  readAgentRequestsPage: typeof readAgentRequestsPage;
  readAgentWebhookDeliveriesPage: typeof readAgentWebhookDeliveriesPage;
  readAgentWebhookDelivery: typeof readAgentWebhookDelivery;
  readAgentWebhookSubscription: typeof readAgentWebhookSubscription;
  readAgentWebhookSubscriptionSecret: typeof readAgentWebhookSubscriptionSecret;
  readAgentWebhookSubscriptionsPage: typeof readAgentWebhookSubscriptionsPage;
  readAgents: typeof readAgents;
  readAllArtifacts: typeof readAllArtifacts;
  readAllAppeals: typeof readAllAppeals;
  readAllCheckpoints: typeof readAllCheckpoints;
  readAllChallenges: typeof readAllChallenges;
  readAllForecasts: typeof readAllForecasts;
  readAllReplications: typeof readAllReplications;
  readAppealsByClaim: typeof readAppealsByClaim;
  readAppealsPage: typeof readAppealsPage;
  readAgentsPage: typeof readAgentsPage;
  readArtifactsPage: typeof readArtifactsPage;
  readArtifactsByClaim: typeof readArtifactsByClaim;
  readChallengesPage: typeof readChallengesPage;
  readChallengesByClaim: typeof readChallengesByClaim;
  readCheckpointPublication: typeof readCheckpointPublication;
  readCheckpointPublicationsPage: typeof readCheckpointPublicationsPage;
  readCheckpointsPage: typeof readCheckpointsPage;
  readCheckpointsByActor: typeof readCheckpointsByActor;
  readCheckpointsByClaim: typeof readCheckpointsByClaim;
  readClaim: typeof readClaim;
  readClaimReplicationJobsPage: typeof readClaimReplicationJobsPage;
  readClaims: typeof readClaims;
  readClaimsPage: typeof readClaimsPage;
  readClaimRewardPools: typeof readClaimRewardPools;
  readDomainLeaderboard: typeof readDomainLeaderboard;
  readForecastsPage: typeof readForecastsPage;
  readForecastsByClaim: typeof readForecastsByClaim;
  readIndexerRuntimeStatus: typeof readIndexerRuntimeStatus;
  readLatestReputationPayload: typeof readLatestReputationPayload;
  readMetadata: typeof readMetadata;
  readGovernanceOverview: typeof readGovernanceOverview;
  readGovernanceEvents: typeof readGovernanceEvents;
  readGovernanceProposalDetail: typeof readGovernanceProposalDetail;
  readGovernanceProposals: typeof readGovernanceProposals;
  readGovernanceTreasury: typeof readGovernanceTreasury;
  readOperatorRequest: typeof readOperatorRequest;
  readOperatorRequestsPage: typeof readOperatorRequestsPage;
  readPersistedArtifact: typeof readPersistedArtifact;
  readPersistedArtifactAuditsPage: typeof readPersistedArtifactAuditsPage;
  readPersistedArtifactMaintenanceTasksPage: typeof readPersistedArtifactMaintenanceTasksPage;
  readPersistedArtifactProvenance: typeof readPersistedArtifactProvenance;
  readPersistedArtifactReplicas: typeof readPersistedArtifactReplicas;
  readPersistedArtifactStorageAttestations: typeof readPersistedArtifactStorageAttestations;
  readPersistedArtifactStoragePolicy: typeof readPersistedArtifactStoragePolicy;
  readRecipientAccruedRewardBalance: typeof readRecipientAccruedRewardBalance;
  readReplicationJob: typeof readReplicationJob;
  readReplicationJobsPage: typeof readReplicationJobsPage;
  readReplicationJobRuns: typeof readReplicationJobRuns;
  readReviewAuthorResponsesPage: typeof readReviewAuthorResponsesPage;
  readReviewIssuesPage: typeof readReviewIssuesPage;
  readReadModelCounts: typeof readReadModelCounts;
  readReviewSubmission: typeof readReviewSubmission;
  readReviewSubmissionsPage: typeof readReviewSubmissionsPage;
  readReviewTask: typeof readReviewTask;
  readReviewTaskRuns: typeof readReviewTaskRuns;
  readReviewTasksPage: typeof readReviewTasksPage;
  readSourceExtractionCandidates: typeof readSourceExtractionCandidates;
  readSourceExtractionCandidatesForSources: typeof readSourceExtractionCandidatesForSources;
  readSourceByCanonicalKey: typeof readSourceByCanonicalKey;
  readSourcePublicationDecisionsPage: typeof readSourcePublicationDecisionsPage;
  readSourceRecord: typeof readSourceRecord;
  readSourceSubmissionRecordsPage: typeof readSourceSubmissionRecordsPage;
  readSourcesPage: typeof readSourcesPage;
  readResolutionRun: typeof readResolutionRun;
  readResolutionRunsPage: typeof readResolutionRunsPage;
  readSyncCursor: typeof readSyncCursor;
  readWorkRewardSettlementsPage: typeof readWorkRewardSettlementsPage;
  readWorkRewardSettlementTotals: typeof readWorkRewardSettlementTotals;
  readReplicationsPage: typeof readReplicationsPage;
  readReplicationsByClaim: typeof readReplicationsByClaim;
  recordPersistedArtifactAudit: typeof recordPersistedArtifactAudit;
  recordReviewSubmission: typeof recordReviewSubmission;
  rejectSourcePublication: typeof rejectSourcePublication;
  syncReadModel: typeof syncReadModel;
  upsertPersistedArtifact: typeof upsertPersistedArtifact;
  upsertPersistedArtifactReplica: typeof upsertPersistedArtifactReplica;
  upsertSourceRecord: typeof upsertSourceRecord;
};

export class ReadModelUnavailableError extends Error {
  constructor() {
    super("This protocol API is running without a configured read-model database.");
    this.name = "ReadModelUnavailableError";
  }
}

export function isReadModelOptionalApi(env: NodeJS.ProcessEnv): boolean {
  const mode = readEnvValue(env, "SP_API_MODE");
  return mode?.trim().toLowerCase() === "read-model-optional";
}

export function createUnavailableReadModelPool(): Pool {
  return {
    end: async () => undefined,
    query: async () => {
      throw new ReadModelUnavailableError();
    },
  } as unknown as Pool;
}

export async function readCurrentChainHeadBlock(rpcUrl = getRpcUrl()): Promise<number> {
  const provider = getProvider(rpcUrl);
  try {
    return await provider.getBlockNumber();
  } finally {
    if (typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}

export const defaultDependencies: ApiDependencies = {
  accessControllerHasRole,
  claimArtifactMaintenanceTaskById,
  claimReplicationJobById,
  claimReviewTaskById,
  completeArtifactMaintenanceTask,
  completeReplicationJob,
  confirmSourcePublication,
  createProductionArtifactDraft,
  createProductionClaim,
  ingestSource,
  createDemoArtifactDraft,
  createArtifactMaintenanceTask,
  createAgentWebhookSubscription,
  createDemoClaim,
  createReviewAuthorResponse,
  createReviewTask,
  deactivateAgentWebhookSubscription,
  enqueueArtifactAuditTasks,
  enqueueAgentWebhookPingDelivery,
  failReplicationJob,
  heartbeatArtifactMaintenanceTaskRun,
  heartbeatReplicationJobRun,
  heartbeatReviewTaskRun,
  insertAgentRequest,
  insertPublicWriteRequest,
  listFeaturedDemoScenarios,
  markPublicWriteRequestAccepted,
  markPublicWriteRequestPending,
  markPublicWriteRequestRejected,
  readPublicWriteRequestByHash,
  releasePublicWriteRequestExecution,
  reservePublicWriteRequestExecution,
  openDefaultReviewTasksForClaim,
  openDemoReplicationJob,
  processDemoReplicationJob,
  publishProductionClaim,
  recomputeDemoDomain,
  reseedOperationalDemoScenario,
  resetSandboxDemo,
  resolveDemoReplicationJob,
  submitPersistedReplicationResult,
  getChainHeadBlock: readCurrentChainHeadBlock,
  readArtifactMaintenanceTask,
  readArtifactMaintenanceTaskRuns,
  readArtifactMaintenanceTasksPage,
  readAgent,
  readAgentControllers,
  readAgentControllersPage,
  readAgentRequest,
  readAgentRequestsPage,
  readAgentWebhookDeliveriesPage,
  readAgentWebhookDelivery,
  readAgentWebhookSubscription,
  readAgentWebhookSubscriptionSecret,
  readAgentWebhookSubscriptionsPage,
  readAgents,
  readAllArtifacts,
  readAllAppeals,
  readAllCheckpoints,
  readAllChallenges,
  readAllForecasts,
  readAllReplications,
  readAppealsByClaim,
  readAppealsPage,
  readAgentsPage,
  readArtifactsPage,
  readArtifactsByClaim,
  readChallengesPage,
  readChallengesByClaim,
  readCheckpointPublication,
  readCheckpointPublicationsPage,
  readCheckpointsPage,
  readCheckpointsByActor,
  readCheckpointsByClaim,
  readClaim,
  readClaimReplicationJobsPage,
  readClaims,
  readClaimsPage,
  readClaimRewardPools,
  readDomainLeaderboard,
  readForecastsPage,
  readForecastsByClaim,
  readIndexerRuntimeStatus,
  readLatestReputationPayload,
  readMetadata,
  readGovernanceEvents,
  readGovernanceOverview,
  readGovernanceProposalDetail,
  readGovernanceProposals,
  readGovernanceTreasury,
  readOperatorRequest,
  readOperatorRequestsPage,
  readPersistedArtifact,
  readPersistedArtifactAuditsPage,
  readPersistedArtifactMaintenanceTasksPage,
  readPersistedArtifactProvenance,
  readPersistedArtifactReplicas,
  readPersistedArtifactStorageAttestations,
  readPersistedArtifactStoragePolicy,
  readRecipientAccruedRewardBalance,
  readReplicationJob,
  readReplicationJobsPage,
  readReplicationJobRuns,
  readReviewAuthorResponsesPage,
  readReviewIssuesPage,
  readReadModelCounts,
  readReviewSubmission,
  readReviewSubmissionsPage,
  readReviewTask,
  readReviewTaskRuns,
  readReviewTasksPage,
  readSourceExtractionCandidates,
  readSourceExtractionCandidatesForSources,
  readSourceByCanonicalKey,
  readSourcePublicationDecisionsPage,
  readSourceRecord,
  readSourceSubmissionRecordsPage,
  readSourcesPage,
  readResolutionRun,
  readResolutionRunsPage,
  readSyncCursor,
  readWorkRewardSettlementsPage,
  readWorkRewardSettlementTotals,
  readReplicationsPage,
  readReplicationsByClaim,
  recordPersistedArtifactAudit,
  recordReviewSubmission,
  rejectSourcePublication,
  syncReadModel,
  upsertPersistedArtifact,
  upsertPersistedArtifactReplica,
  upsertSourceRecord,
};
