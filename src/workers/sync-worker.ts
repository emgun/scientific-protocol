import type { Pool } from "pg";
import { resolveReadModelSyncConfig, syncReadModel } from "../indexer/projector.js";
import {
  DEFAULT_MIGRATIONS_PATH,
  prepareReadModelStore,
  ReadModelSyncInProgressError,
} from "../indexer/store.js";
import { isMainModule, readPositiveIntegerEnv, runJsonCliLoop } from "../shared/cli.js";

export type SyncWorkerResult =
  | {
      indexedAt: string;
      latestBlock: number;
      claims: number;
      artifacts: number;
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
  pool?: Pool,
): Promise<SyncWorkerResult> {
  const { databaseUrl, deploymentPath, outputPath } = resolveReadModelSyncConfig(env);
  try {
    const summary = await syncReadModel(deploymentPath, outputPath, databaseUrl, { env, pool });
    return {
      indexedAt: summary.metadata.indexedAt,
      latestBlock: summary.metadata.latestBlock,
      claims: summary.counts.claims,
      artifacts: summary.counts.artifacts,
      replications: summary.counts.replications,
      checkpoints: summary.counts.checkpoints,
      agents: summary.counts.agents,
      forecasts: summary.counts.forecasts,
      challenges: summary.counts.challenges,
      appeals: summary.counts.appeals,
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
  const { databaseUrl } = resolveReadModelSyncConfig(env);
  const pool = await prepareReadModelStore(databaseUrl, DEFAULT_MIGRATIONS_PATH, env);
  try {
    await runJsonCliLoop({ intervalMs, once: false, runOnce: () => runSyncWorkerOnce(env, pool) });
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await startSyncWorkerFromEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
