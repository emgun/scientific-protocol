import {
  type ArtifactMaintenanceExecutionResult,
  processArtifactMaintenanceTask,
} from "../artifacts/maintenance.js";
import {
  isMainModule,
  readBooleanEnv,
  readEnumEnv,
  readOptionalTrimmedEnv,
  readPositiveIntegerEnv,
  runJsonCliLoop,
} from "../shared/cli.js";

const artifactMaintenanceTaskTypes = ["audit", "repair"] as const;

export async function runArtifactMaintenanceWorkerOnce(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ArtifactMaintenanceExecutionResult> {
  const taskId = readOptionalTrimmedEnv(env, "SP_ARTIFACT_MAINTENANCE_TASK_ID");
  const taskType = readEnumEnv(
    env,
    "SP_ARTIFACT_MAINTENANCE_TASK_TYPE",
    artifactMaintenanceTaskTypes,
  );
  const workerId =
    readOptionalTrimmedEnv(env, "SP_ARTIFACT_MAINTENANCE_WORKER_ID") ??
    "local-artifact-maintenance-worker";

  return processArtifactMaintenanceTask({
    env,
    taskId,
    taskType,
    workerId,
  });
}

export async function startArtifactMaintenanceWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const once = readBooleanEnv(env, "SP_ARTIFACT_MAINTENANCE_WORKER_ONCE", true);
  const intervalMs = readPositiveIntegerEnv(
    env,
    "SP_ARTIFACT_MAINTENANCE_WORKER_INTERVAL_MS",
    10_000,
  );
  await runJsonCliLoop({
    intervalMs,
    once,
    runOnce: () => runArtifactMaintenanceWorkerOnce(env),
  });
}

if (isMainModule(import.meta.url)) {
  try {
    await startArtifactMaintenanceWorkerFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
