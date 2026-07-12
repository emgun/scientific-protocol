import type { Pool } from "pg";
import { upsertPersistedArtifact } from "../coordinator/store.js";
import {
  readAgent,
  readArtifactsByClaim,
  readChallengesByClaim,
  readClaim,
  readClaimsPage,
  readForecastsByClaim,
  readReplicationsByClaim,
} from "../indexer/store.js";
import { readOptionalTrimmedEnv } from "../shared/cli.js";
import { readAllPages } from "../shared/pagination.js";
import { persistJsonArtifact } from "../shared/persisted-artifacts.js";
import { buildClaimReviewState } from "./aggregation.js";
import { evaluateReviewTask } from "./evaluate.js";
import {
  claimReviewTaskById,
  failReviewTaskRun,
  prepareReviewStore,
  readReviewAuthorResponsesPage,
  readReviewIssuesPage,
  readReviewSubmissionsPage,
  readReviewTasksPage,
  recordReviewSubmission,
} from "./store.js";
import type { ReviewTaskType, ReviewTaskView } from "./types.js";

export type ReviewExecutionResult = {
  completed?: boolean;
  failed?: boolean;
  idle?: boolean;
  message?: string;
  resultArtifactKey?: string | null;
  runId?: string;
  submissionId?: string;
  taskId?: string;
  taskType?: ReviewTaskType;
  workerId: string;
};

async function buildTaskInputs(pool: Pool, task: ReviewTaskView) {
  if (!task.claimId) {
    throw new Error("source_backed_review_tasks_not_supported_by_worker");
  }
  const claimId = task.claimId;
  const [
    claim,
    artifacts,
    replications,
    forecasts,
    challenges,
    tasksPage,
    submissionsPage,
    submissionHistoryPage,
    issuesPage,
    responsesPage,
    claimsPage,
  ] = await Promise.all([
    readClaim(pool, claimId),
    readArtifactsByClaim(pool, claimId),
    readReplicationsByClaim(pool, claimId),
    readForecastsByClaim(pool, claimId),
    readChallengesByClaim(pool, claimId),
    readAllPages((pagination) => readReviewTasksPage(pool, { ...pagination, claimId })),
    readAllPages((pagination) => readReviewSubmissionsPage(pool, { ...pagination, claimId })),
    readAllPages((pagination) => readReviewSubmissionsPage(pool, pagination)),
    readAllPages((pagination) => readReviewIssuesPage(pool, { ...pagination, claimId })),
    readAllPages((pagination) => readReviewAuthorResponsesPage(pool, { ...pagination, claimId })),
    readAllPages((pagination) => readClaimsPage(pool, pagination)),
  ]);

  if (!claim) {
    throw new Error("claim_not_found");
  }

  const reviewState = buildClaimReviewState({
    artifacts,
    challenges,
    claims: claimsPage,
    currentClaimId: claimId,
    forecasts,
    issues: issuesPage,
    replications,
    responses: responsesPage,
    submissionHistory: submissionHistoryPage,
    submissions: submissionsPage,
    tasks: tasksPage,
  });
  return {
    artifactTypes: artifacts.map((artifact) => Number(artifact.artifactType)),
    artifactsCount: artifacts.length,
    challengeCount: challenges.length,
    challengesOpen: challenges.filter(
      (challenge) => challenge.status === 0 || challenge.status === 3,
    ).length,
    claim,
    reviewState,
    replicationCount: replications.length,
    supportiveReplications: replications.filter(
      (replication) =>
        replication.resolutionStatus === 1 ||
        replication.resolutionStatus === 2 ||
        replication.outcome === 1 ||
        replication.outcome === 2,
    ).length,
  };
}

async function resolveReviewerActor(
  pool: Pool,
  workerId: string,
  agentId?: string,
): Promise<string> {
  if (agentId) {
    const agent = await readAgent(pool, agentId);
    if (agent) {
      return agent.operator;
    }
    return `agent:${agentId}`;
  }
  return workerId;
}

export async function processReviewTask(input: {
  connectionString?: string;
  env?: NodeJS.ProcessEnv;
  taskId?: string;
  taskType?: ReviewTaskType;
  workerId: string;
}): Promise<ReviewExecutionResult> {
  const pool = await prepareReviewStore(input.connectionString);
  try {
    const env = input.env ?? process.env;
    const agentId = readOptionalTrimmedEnv(env, "SP_REVIEW_AGENT_ID");
    const taskPage = await readReviewTasksPage(pool, {
      limit: input.taskId ? 1 : 20,
      offset: 0,
      status: "open",
      taskType: input.taskType,
    });
    const candidateTasks = input.taskId
      ? taskPage.items.filter((task) => task.taskId === input.taskId)
      : taskPage.items;

    let claimed: {
      run: Awaited<ReturnType<typeof claimReviewTaskById>> extends infer T
        ? T extends { run: infer R }
          ? R
          : never
        : never;
      task: ReviewTaskView;
    } | null = null;
    for (const task of candidateTasks) {
      claimed = await claimReviewTaskById(pool, {
        agentId,
        taskId: task.taskId,
        workerId: input.workerId,
      });
      if (claimed) {
        break;
      }
    }

    if (!claimed) {
      return {
        idle: true,
        message: "no open review task available",
        workerId: input.workerId,
      };
    }

    const reviewerActor = await resolveReviewerActor(pool, input.workerId, agentId);

    try {
      const taskInputs = await buildTaskInputs(pool, claimed.task);
      const evaluation = evaluateReviewTask(claimed.task, {
        artifactTypes: taskInputs.artifactTypes,
        artifactsCount: taskInputs.artifactsCount,
        challengeCount: taskInputs.challengeCount,
        challengesOpen: taskInputs.challengesOpen,
        claimStatus: taskInputs.claim.status,
        reviewState: taskInputs.reviewState,
        replicationCount: taskInputs.replicationCount,
        supportiveReplications: taskInputs.supportiveReplications,
      });

      const report = {
        claimId: claimed.task.claimId,
        confidenceBps: evaluation.confidenceBps,
        dimensions: evaluation.dimensions,
        issues: evaluation.issues,
        summary: evaluation.summary,
        taskId: claimed.task.taskId,
        taskType: claimed.task.taskType,
        verdict: evaluation.verdict,
        workerId: input.workerId,
      };
      const resultArtifact = await persistJsonArtifact("review-submission-result", report, {
        env,
      });
      await upsertPersistedArtifact(pool, resultArtifact);

      const recorded = await recordReviewSubmission(pool, {
        confidenceBps: evaluation.confidenceBps,
        dimensions: evaluation.dimensions,
        issues: evaluation.issues.map((issue) => ({
          category: issue.category,
          severity: issue.severity,
          summary: issue.summary,
        })),
        payload: report,
        resultArtifactKey: resultArtifact.artifactKey,
        reviewerActor,
        reviewerAgentId: agentId,
        runId: claimed.run.runId,
        taskId: claimed.task.taskId,
        verdict: evaluation.verdict,
      });

      return {
        completed: true,
        resultArtifactKey: resultArtifact.artifactKey,
        runId: claimed.run.runId,
        submissionId: recorded.submission.submissionId,
        taskId: claimed.task.taskId,
        taskType: claimed.task.taskType,
        workerId: input.workerId,
      };
    } catch (error) {
      await failReviewTaskRun(pool, {
        failureReason: error instanceof Error ? error.message : String(error),
        runId: claimed.run.runId,
        taskId: claimed.task.taskId,
      });
      return {
        failed: true,
        message: error instanceof Error ? error.message : String(error),
        runId: claimed.run.runId,
        taskId: claimed.task.taskId,
        taskType: claimed.task.taskType,
        workerId: input.workerId,
      };
    }
  } finally {
    await pool.end();
  }
}
