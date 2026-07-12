#!/usr/bin/env node

import { getDatabaseUrl, createReadModelPool, migrateReadModelDb } from "../indexer/store.js";
import { isMainModule, readOptionalTrimmedEnv } from "../shared/cli.js";
import { assertWriteEnabled, resolveServiceMode } from "./mode.js";
import { serviceProvenance } from "./provenance.js";

const USAGE = `Scientific Protocol reference service

Usage: scientific-protocol-service <command> [worker]

Commands:
  gateway                       Start the HTTP gateway
  migrate                       Apply read-model migrations
  sync                          Run one chain-to-read-model sync
  worker sync                   Run the recurring indexer worker
  worker review                 Run the review worker (write-enabled only)
  worker replication            Run the replication worker (write-enabled only)
  worker artifact-maintenance   Run the artifact maintenance worker (write-enabled only)
  healthcheck                   Check /livez on the configured gateway
  readiness                     Check /readyz on the configured gateway
  version                       Print release provenance
  help                          Print this help
`;

export function serviceUsage(): string {
  return USAGE;
}

async function checkEndpoint(
  pathname: "/livez" | "/readyz",
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const port = readOptionalTrimmedEnv(env, "PORT") ?? "3000";
  const baseUrl =
    readOptionalTrimmedEnv(env, "SP_SERVICE_HEALTH_URL") ?? `http://127.0.0.1:${port}`;
  const response = await fetch(new URL(pathname, baseUrl), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}`);
  }
  return await response.json();
}

async function migrate(env: NodeJS.ProcessEnv): Promise<{ migrated: true }> {
  const pool = createReadModelPool(getDatabaseUrl(env), env);
  try {
    await migrateReadModelDb(pool);
    return { migrated: true };
  } finally {
    await pool.end();
  }
}

async function runWorker(worker: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  if (worker === "sync") {
    const { startSyncWorkerFromEnv } = await import("../workers/sync-worker.js");
    await startSyncWorkerFromEnv(env);
    return;
  }
  assertWriteEnabled(env);
  if (worker === "review") {
    const { startReviewWorkerFromEnv } = await import("../workers/review-worker.js");
    await startReviewWorkerFromEnv(env);
    return;
  }
  if (worker === "replication") {
    const { startReplicationWorkerFromEnv } = await import("../workers/replication-worker.js");
    await startReplicationWorkerFromEnv(env);
    return;
  }
  if (worker === "artifact-maintenance") {
    const { startArtifactMaintenanceWorkerFromEnv } =
      await import("../workers/artifact-maintenance-worker.js");
    await startArtifactMaintenanceWorkerFromEnv(env);
    return;
  }
  throw new Error(`unknown worker: ${worker ?? "(missing)"}`);
}

export async function runServiceCommand(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const [, , command = "help", worker] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    return serviceUsage();
  }
  if (command === "version" || command === "--version" || command === "-v") {
    return serviceProvenance(env);
  }
  if (command === "gateway") {
    resolveServiceMode(env);
    const { startApiServerFromEnv } = await import("../api/server.js");
    await startApiServerFromEnv(env);
    return undefined;
  }
  if (command === "migrate") {
    return await migrate(env);
  }
  if (command === "sync") {
    const { syncReadModelFromEnv } = await import("../indexer/cli.js");
    return await syncReadModelFromEnv(env);
  }
  if (command === "worker") {
    await runWorker(worker, env);
    return undefined;
  }
  if (command === "healthcheck") {
    return await checkEndpoint("/livez", env);
  }
  if (command === "readiness") {
    return await checkEndpoint("/readyz", env);
  }
  throw new Error(`unknown service command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runServiceCommand()
    .then((result) => {
      if (typeof result === "string") {
        console.log(result);
      } else if (result !== undefined) {
        console.log(JSON.stringify(result, null, 2));
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
