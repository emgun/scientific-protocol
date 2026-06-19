import { resolveReadModelSyncConfig, syncReadModel } from "../indexer/projector.js";
import { ReadModelSyncInProgressError } from "../indexer/store.js";
import { isMainModule, readPositiveIntegerEnv, runJsonCliLoop } from "../shared/cli.js";

export type SyncWorkerResult =
  | {
      indexedAt: string;
      latestBlock: number;
      claims: number;
      replications: number;
      checkpoints: number;
      agents: number;
      forecasts: number;
      challenges: number;
      appeals: number;
    }
  | {
      reason: "sync_in_progress";
      skipped: true;
    };

export async function runSyncWorkerOnce(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SyncWorkerResult> {
  const { databaseUrl, deploymentPath, outputPath } = resolveReadModelSyncConfig(env);
  try {
    const model = await syncReadModel(deploymentPath, outputPath, databaseUrl, { env });
    return {
      indexedAt: model.metadata.indexedAt,
      latestBlock: model.metadata.latestBlock,
      claims: model.claims.length,
      replications: model.replications.length,
      checkpoints: model.checkpoints.length,
      agents: model.agents.length,
      forecasts: model.forecasts.length,
      challenges: model.challenges.length,
      appeals: model.appeals.length,
    };
  } catch (error) {
    if (error instanceof ReadModelSyncInProgressError) {
      return { reason: "sync_in_progress", skipped: true };
    }
    throw error;
  }
}

export async function startSyncWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const intervalMs = readPositiveIntegerEnv(env, "SP_SYNC_INTERVAL_MS", 10_000);
  await runJsonCliLoop({ intervalMs, once: false, runOnce: () => runSyncWorkerOnce(env) });
}

if (isMainModule(import.meta.url)) {
  try {
    await startSyncWorkerFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
