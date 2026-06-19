import type {
  ArtifactMaintenanceTaskType,
  ArtifactMaintenanceTaskView,
  ReplicationJobView,
} from "../coordinator/store.js";
import type { ReviewConsensusPolicy, ReviewTaskType, ReviewTaskView } from "../review/types.js";
import type { AgentRequestActionType } from "../shared/agent-requests.js";
import type { ClaimWorkAgentActionsView, ClaimWorkItemView } from "./types.js";

const DEFAULT_REVIEW_CONSENSUS_POLICY: ReviewConsensusPolicy = {
  maxSubmissions: 1,
  minSubmissions: 1,
  requireDistinctAgents: false,
};

export function defaultReviewConsensusPolicy(taskType: ReviewTaskType): ReviewConsensusPolicy {
  switch (taskType) {
    case "certification_synthesis_check":
    case "claim_extraction_synthesis_check":
    case "benchmark_rerun_check":
      return DEFAULT_REVIEW_CONSENSUS_POLICY;
    case "claim_extraction_check":
      return {
        maxSubmissions: 4,
        minSubmissions: 2,
        requireDistinctAgents: true,
      };
    case "contradiction_scan":
    case "method_consistency_check":
    case "stats_sanity_check":
      return {
        maxSubmissions: 3,
        minSubmissions: 2,
        requireDistinctAgents: true,
      };
    default:
      return {
        maxSubmissions: 2,
        minSubmissions: 2,
        requireDistinctAgents: true,
      };
  }
}

export function requiredCapabilitiesForReviewTask(taskType: ReviewTaskType): string[] {
  switch (taskType) {
    case "artifact_completeness_check":
    case "artifact_integrity_check":
      return ["artifact-access", "content-integrity"];
    case "benchmark_rerun_check":
      return ["execution", "benchmark-rerun"];
    case "claim_extraction_check":
      return ["claim-extraction", "literature-scan"];
    case "claim_extraction_synthesis_check":
      return ["claim-synthesis"];
    case "contradiction_scan":
      return ["literature-scan", "claim-comparison"];
    case "method_consistency_check":
      return ["method-analysis"];
    case "replication_readiness_check":
      return ["artifact-analysis", "execution-readiness"];
    case "stats_sanity_check":
      return ["statistics"];
    case "certification_synthesis_check":
      return ["claim-aggregation"];
  }
}

export function requiredCapabilitiesForArtifactMaintenanceTask(
  taskType: ArtifactMaintenanceTaskType,
): string[] {
  return taskType === "repair" ? ["artifact-repair"] : ["artifact-audit"];
}

export function requiredCapabilitiesForReplicationJob(
  _job: Pick<ReplicationJobView, "claimId" | "jobId">,
): string[] {
  return ["execution"];
}

export function laneForReviewTask(taskType: ReviewTaskType): ClaimWorkItemView["lane"] {
  if (
    taskType === "certification_synthesis_check" ||
    taskType === "claim_extraction_synthesis_check"
  ) {
    return "synthesis";
  }
  if (taskType === "benchmark_rerun_check") {
    return "execution";
  }
  return "evaluation";
}

export function buildReviewWorkPolicy(task: ReviewTaskView): ClaimWorkItemView["policy"] {
  return {
    maxContributors: task.consensusPolicy.maxSubmissions,
    minContributors: task.consensusPolicy.minSubmissions,
    requireDistinctAgents: task.consensusPolicy.requireDistinctAgents,
    requiredCapabilities: task.requiredCapabilities,
  };
}

export function buildArtifactMaintenanceWorkPolicy(
  task: Pick<ArtifactMaintenanceTaskView, "taskType">,
): ClaimWorkItemView["policy"] {
  return {
    maxContributors: 1,
    minContributors: 1,
    requireDistinctAgents: false,
    requiredCapabilities: requiredCapabilitiesForArtifactMaintenanceTask(task.taskType),
  };
}

export function buildReplicationWorkPolicy(
  job: Pick<ReplicationJobView, "claimId" | "jobId">,
): ClaimWorkItemView["policy"] {
  return {
    maxContributors: 1,
    minContributors: 1,
    requireDistinctAgents: false,
    requiredCapabilities: requiredCapabilitiesForReplicationJob(job),
  };
}

function emptyAgentActions(): ClaimWorkAgentActionsView {
  return {
    claim: null,
    heartbeat: null,
    submit: [],
  };
}

export function agentActionsForWorkItem(input: {
  kind: ClaimWorkItemView["kind"];
  sourceType: ClaimWorkItemView["sourceType"];
}): ClaimWorkAgentActionsView {
  if (input.kind === "review_task") {
    return {
      claim: "review_task_claim",
      heartbeat: "review_task_heartbeat",
      submit: ["review_task_submission"],
    };
  }
  if (input.kind === "artifact_maintenance") {
    const submitAction: AgentRequestActionType =
      input.sourceType === "repair"
        ? "artifact_task_repair_submission"
        : "artifact_task_audit_submission";
    return {
      claim: "artifact_task_claim",
      heartbeat: "artifact_task_heartbeat",
      submit: [submitAction],
    };
  }
  if (input.kind === "replication_job") {
    return {
      claim: "replication_job_claim",
      heartbeat: "replication_job_heartbeat",
      submit: ["replication_job_submission"],
    };
  }
  return emptyAgentActions();
}
