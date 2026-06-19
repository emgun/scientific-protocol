import type {
  ArtifactMaintenanceTaskRunView,
  ArtifactMaintenanceTaskType,
  ArtifactMaintenanceTaskView,
  ReplicationJobRunView,
  ReplicationJobView,
} from "../coordinator/store.js";
import type {
  ReviewSubmissionView,
  ReviewTaskRunView,
  ReviewTaskType,
  ReviewTaskView,
} from "../review/types.js";
import type { AgentRequestActionType } from "../shared/agent-requests.js";
import type { ArtifactView } from "../shared/read-model.js";
import type { SourceRecordView } from "../sources/types.js";

export type ClaimWorkItemKind = "artifact_maintenance" | "replication_job" | "review_task";

export type ClaimWorkLane = "evaluation" | "execution" | "maintenance" | "synthesis";

export type ClaimWorkStatus = "canceled" | "completed" | "escalated" | "failed" | "leased" | "open";

export type ClaimWorkSubjectType =
  | "claim"
  | "claim_artifact"
  | "persisted_artifact"
  | "source_record";

export type ClaimWorkEdgeRelation =
  | "attaches"
  | "evaluates"
  | "input"
  | "maintains"
  | "produces"
  | "reruns";

export type ClaimWorkPolicyView = {
  maxContributors: number | null;
  minContributors: number | null;
  requireDistinctAgents: boolean;
  requiredCapabilities: string[];
};

export type ClaimWorkOrchestrationAction =
  | "claim"
  | "closed"
  | "complete"
  | "escalate"
  | "reassign"
  | "wait";

export type ClaimWorkOrchestrationView = {
  activeRunCount: number;
  attemptCount: number;
  canClaim: boolean;
  canReassign: boolean;
  completedRunCount: number;
  contributorsNeeded: number;
  distinctContributorCount: number;
  distinctContributorShortfall: number;
  failedRunCount: number;
  minimumContributorsNeeded: number;
  minimumSatisfied: boolean;
  recommendedAction: ClaimWorkOrchestrationAction;
  remainingContributorSlots: number | null;
  requiresDistinctContributors: boolean;
  shouldEscalate: boolean;
  statusReason: string;
  successfulContributionCount: number;
  targetContributorsNeeded: number;
  targetSatisfied: boolean;
  timedOutRunCount: number;
};

export type ClaimWorkRoutingTier = "critical" | "high" | "hold" | "low" | "normal";

export type ClaimWorkRoutingView = {
  blockedByOpenWork: boolean;
  priorityBps: number;
  rationale: string[];
  tier: ClaimWorkRoutingTier;
};

export type ClaimWorkSchedulingStrategy = "distinct" | "parallel" | "single" | "synthesis";

export type ClaimWorkSchedulingView = {
  autoClaimable: boolean;
  blocker: string | null;
  blockingItemIds: string[];
  desiredAdditionalClaims: number;
  needsMinimumCoverage: boolean;
  needsRedundantCoverage: boolean;
  prefersFreshContributor: boolean;
  reassignmentPreferred: boolean;
  reason: string;
  strategy: ClaimWorkSchedulingStrategy;
  unresolvedDependencyCount: number;
};

export type ClaimWorkSubjectView = {
  href: string | null;
  label: string;
  subjectId: string;
  subjectType: ClaimWorkSubjectType;
};

export type ClaimWorkRunView = {
  agentId: string | null;
  failureReason: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  runId: string;
  startedAt: string;
  status: "completed" | "failed" | "running";
  workerId: string;
};

export type ClaimWorkResultView = {
  artifactKey: string | null;
  confidenceBps: number | null;
  createdAt: string | null;
  label: string;
  summary: string;
  type: "artifact_report" | "replication_result" | "review_submission";
  verdict: string | null;
};

export type ClaimWorkAgentActionsView = {
  claim: AgentRequestActionType | null;
  heartbeat: AgentRequestActionType | null;
  submit: AgentRequestActionType[];
};

export type ClaimWorkItemView = {
  activeRun: ClaimWorkRunView | null;
  agentActions: ClaimWorkAgentActionsView;
  claimId: string | null;
  completedAt: string | null;
  createdAt: string;
  description: string;
  itemId: string;
  kind: ClaimWorkItemKind;
  lane: ClaimWorkLane;
  orchestration: ClaimWorkOrchestrationView;
  policy: ClaimWorkPolicyView | null;
  relatedArtifactKeys: string[];
  result: ClaimWorkResultView | null;
  routing: ClaimWorkRoutingView;
  runs: ClaimWorkRunView[];
  scheduling: ClaimWorkSchedulingView;
  scopeKey: string | null;
  sourceType: ArtifactMaintenanceTaskType | ReviewTaskType | "replication_job";
  status: ClaimWorkStatus;
  subjectId: string;
  title: string;
  updatedAt: string | null;
};

export type ClaimWorkEdgeView = {
  fromId: string;
  relation: ClaimWorkEdgeRelation;
  toId: string;
};

export type ClaimWorkGraphSummary = {
  activeLeases: number;
  autoClaimableItems: number;
  completedItems: number;
  dependencyBlockedItems: number;
  failedItems: number;
  freshContributorItems: number;
  latestActivityAt: string | null;
  minimumCoverageItems: number;
  openItems: number;
  participatingAgents: number;
  reassignmentReadyItems: number;
  redundancyTargetItems: number;
  totalItems: number;
  uncoveredDemand: number;
  lanes: Record<ClaimWorkLane, number>;
};

export type ClaimWorkGraphView = {
  claimId: string;
  edges: ClaimWorkEdgeView[];
  items: ClaimWorkItemView[];
  subjects: ClaimWorkSubjectView[];
  summary: ClaimWorkGraphSummary;
};

export type SourceWorkGraphView = {
  edges: ClaimWorkEdgeView[];
  items: ClaimWorkItemView[];
  sourceId: string;
  subjects: ClaimWorkSubjectView[];
  summary: ClaimWorkGraphSummary;
};

export type ClaimWorkItemSourceView =
  | {
      kind: "artifact_maintenance";
      runs: ArtifactMaintenanceTaskRunView[];
      task: ArtifactMaintenanceTaskView;
    }
  | {
      job: ReplicationJobView;
      kind: "replication_job";
      runs: ReplicationJobRunView[];
    }
  | {
      kind: "review_task";
      runs: ReviewTaskRunView[];
      submissions: ReviewSubmissionView[];
      task: ReviewTaskView;
    };

export type ClaimWorkItemDetailView = {
  agentActions: ClaimWorkAgentActionsView;
  claimId: string | null;
  edges: ClaimWorkEdgeView[];
  item: ClaimWorkItemView;
  source: ClaimWorkItemSourceView | null;
  subject: ClaimWorkSubjectView | null;
};

export type BuildClaimWorkGraphInput = {
  artifactMaintenanceRunsByTaskId: Record<string, ClaimWorkRunView[]>;
  artifactMaintenanceTasks: ArtifactMaintenanceTaskView[];
  artifacts: ArtifactView[];
  claimId: string;
  replicationJobs: ReplicationJobView[];
  replicationRunsByJobId: Record<string, ClaimWorkRunView[]>;
  reviewRunsByTaskId: Record<string, ClaimWorkRunView[]>;
  reviewSubmissionsByTaskId: Record<string, ReviewSubmissionView[]>;
  reviewTasks: ReviewTaskView[];
};

export type BuildSourceWorkGraphInput = {
  reviewRunsByTaskId: Record<string, ClaimWorkRunView[]>;
  reviewSubmissionsByTaskId: Record<string, ReviewSubmissionView[]>;
  reviewTasks: ReviewTaskView[];
  source: SourceRecordView;
};
