import type { ReviewTaskType } from "../review/types.js";
import { processReviewTask, type ReviewExecutionResult } from "../review/worker.js";
import {
  isMainModule,
  readBooleanEnv,
  readEnumEnv,
  readOptionalTrimmedEnv,
  readPositiveIntegerEnv,
  runJsonCliLoop,
} from "../shared/cli.js";

const reviewTaskTypes = [
  "artifact_completeness_check",
  "artifact_integrity_check",
  "benchmark_rerun_check",
  "certification_synthesis_check",
  "contradiction_scan",
  "method_consistency_check",
  "replication_readiness_check",
  "stats_sanity_check",
] as const satisfies readonly ReviewTaskType[];

export async function runReviewWorkerOnce(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReviewExecutionResult> {
  const taskId = readOptionalTrimmedEnv(env, "SP_REVIEW_TASK_ID");
  const taskType = readEnumEnv(env, "SP_REVIEW_TASK_TYPE", reviewTaskTypes);
  const workerId = readOptionalTrimmedEnv(env, "SP_REVIEW_WORKER_ID") ?? "local-review-worker";

  return processReviewTask({
    env,
    taskId,
    taskType,
    workerId,
  });
}

export async function startReviewWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const once = readBooleanEnv(env, "SP_REVIEW_WORKER_ONCE", true);
  const intervalMs = readPositiveIntegerEnv(env, "SP_REVIEW_WORKER_INTERVAL_MS", 10_000);
  await runJsonCliLoop({ intervalMs, once, runOnce: () => runReviewWorkerOnce(env) });
}

if (isMainModule(import.meta.url)) {
  try {
    await startReviewWorkerFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
