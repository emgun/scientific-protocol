import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonRpcProvider } from "ethers";
import { Pool } from "pg";
import { DEFAULT_ARTIFACT_STORE_ROOT } from "../artifacts/persistence.js";
import { getReadModelPath } from "../indexer/projector.js";
import { getDatabaseUrl } from "../indexer/store.js";
import { parseJsonText, readOptionalTrimmedEnv } from "../shared/cli.js";
import { getRpcUrl } from "../shared/contracts.js";
import { getDeploymentPath } from "../shared/deployment.js";
import { isLocalDevelopmentRpcUrl } from "../shared/env.js";
import { isGcsUrl } from "../shared/gcs.js";
import { resetManagedOperatorSigners } from "../shared/operator.js";
import { readEnvValue } from "../shared/secrets.js";

export class SandboxDemoResetInProgressError extends Error {
  constructor() {
    super("sandbox_demo_reset_in_progress");
  }
}

type SandboxChainSnapshot = {
  createdAt: string;
  rpcUrl: string;
  snapshotId: string;
};

let sandboxResetPromise: Promise<{ finishedAt: string; resetAt: string }> | null = null;

export function getSandboxChainSnapshotPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    readOptionalTrimmedEnv(env, "SP_SANDBOX_CHAIN_SNAPSHOT_PATH") ??
    path.resolve(process.cwd(), "ops", "runtime", "sandbox.chain-snapshot.json")
  );
}

export function resolveSandboxArtifactCleanupConfig(env: NodeJS.ProcessEnv = process.env): {
  artifactBackend: string;
  artifactRoot: string;
} {
  return {
    artifactBackend: readEnvValue(env, "SP_ARTIFACT_BACKEND") ?? "filesystem",
    artifactRoot: readEnvValue(env, "SP_ARTIFACT_FILESYSTEM_ROOT") ?? DEFAULT_ARTIFACT_STORE_ROOT,
  };
}

function validateSandboxChainSnapshot(value: unknown, snapshotPath: string): SandboxChainSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${snapshotPath} must contain a sandbox chain snapshot object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.snapshotId !== "string" || record.snapshotId.trim() === "") {
    throw new Error(`${snapshotPath} snapshotId is required`);
  }
  if (typeof record.rpcUrl !== "string" || record.rpcUrl.trim() === "") {
    throw new Error(`${snapshotPath} rpcUrl is required`);
  }
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error(`${snapshotPath} createdAt must be an ISO timestamp`);
  }
  return {
    createdAt: record.createdAt,
    rpcUrl: record.rpcUrl,
    snapshotId: record.snapshotId,
  };
}

async function readSandboxChainSnapshot(
  snapshotPath = getSandboxChainSnapshotPath(),
): Promise<SandboxChainSnapshot | null> {
  try {
    return validateSandboxChainSnapshot(
      parseJsonText(await readFile(snapshotPath, "utf8"), snapshotPath),
      snapshotPath,
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSandboxChainSnapshot(
  snapshot: SandboxChainSnapshot,
  snapshotPath = getSandboxChainSnapshotPath(),
): Promise<void> {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

async function removeIfPresent(targetPath: string): Promise<void> {
  await rm(targetPath, { force: true, recursive: true });
}

async function clearDirectoryContents(targetPath: string): Promise<void> {
  try {
    const entries = await readdir(targetPath, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) =>
        rm(path.join(targetPath, entry.name), { force: true, recursive: true }),
      ),
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return;
    }
    throw error;
  }
}

async function resetSandboxReadModelDatabase(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
    await pool.query("GRANT ALL ON SCHEMA public TO public");
  } finally {
    await pool.end();
  }
}

async function clearSandboxLocalState(env: NodeJS.ProcessEnv): Promise<void> {
  const deploymentPath = getDeploymentPath(env);
  const readModelPath = getReadModelPath(env);
  if (!isGcsUrl(deploymentPath)) {
    await removeIfPresent(deploymentPath);
  }
  await removeIfPresent(readModelPath);

  const { artifactBackend, artifactRoot } = resolveSandboxArtifactCleanupConfig(env);
  if (artifactBackend === "filesystem") {
    await clearDirectoryContents(artifactRoot);
  }
}

async function createRpcSnapshot(provider: JsonRpcProvider): Promise<string> {
  const snapshotId = await provider.send("evm_snapshot", []);
  if (typeof snapshotId !== "string" || snapshotId.length === 0) {
    throw new Error("sandbox_snapshot_creation_failed");
  }
  return snapshotId;
}

export async function ensureSandboxBootstrapSnapshot(
  rpcUrl?: string,
  snapshotPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandboxChainSnapshot | null> {
  const resolvedRpcUrl = rpcUrl ?? getRpcUrl(env);
  const resolvedSnapshotPath = snapshotPath ?? getSandboxChainSnapshotPath(env);
  if (!isLocalDevelopmentRpcUrl(resolvedRpcUrl)) {
    return null;
  }

  const existing = await readSandboxChainSnapshot(resolvedSnapshotPath);
  if (existing) {
    return existing;
  }

  const provider = new JsonRpcProvider(resolvedRpcUrl);
  try {
    const snapshotId = await createRpcSnapshot(provider);
    const snapshot = {
      createdAt: new Date().toISOString(),
      rpcUrl: resolvedRpcUrl,
      snapshotId,
    };
    await writeSandboxChainSnapshot(snapshot, resolvedSnapshotPath);
    return snapshot;
  } finally {
    provider.destroy();
  }
}

async function hardhatResetCurrentRpc(rpcUrl: string): Promise<boolean> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    await provider.send("hardhat_reset", []);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Method hardhat_reset is not supported")) {
      return false;
    }
    throw error;
  } finally {
    provider.destroy();
  }
}

async function revertSandboxBootstrapSnapshot(
  rpcUrl: string,
  snapshotPath = getSandboxChainSnapshotPath(),
): Promise<void> {
  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const snapshot = await readSandboxChainSnapshot(snapshotPath);
    if (!snapshot) {
      throw new Error("sandbox_bootstrap_snapshot_missing");
    }

    const reverted = await provider.send("evm_revert", [snapshot.snapshotId]);
    if (reverted !== true) {
      throw new Error("sandbox_bootstrap_snapshot_revert_failed");
    }

    await writeSandboxChainSnapshot(
      {
        createdAt: new Date().toISOString(),
        rpcUrl,
        snapshotId: await createRpcSnapshot(provider),
      },
      snapshotPath,
    );
  } finally {
    provider.destroy();
  }
}

async function runBootstrapScript(env: NodeJS.ProcessEnv): Promise<void> {
  const rootDir = process.cwd();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [path.join(rootDir, "script", "bootstrap-staging-demo.sh")], {
      cwd: rootDir,
      env: {
        ...env,
        HOME: env.HOME ?? rootDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`;
      if (output.length > 16000) {
        output = output.slice(-16000);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`sandbox bootstrap failed with exit code ${code}\n${output.trim()}`));
    });
  });
}

export async function resetSandboxDemoEnvironment(
  connectionString?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ finishedAt: string; resetAt: string }> {
  const rpcUrl = getRpcUrl(env);
  const snapshotPath = getSandboxChainSnapshotPath(env);
  const resolvedConnectionString = connectionString ?? getDatabaseUrl(env);
  if (!isLocalDevelopmentRpcUrl(rpcUrl)) {
    throw new Error("sandbox_demo_reset_requires_local_development_rpc");
  }

  if (sandboxResetPromise) {
    throw new SandboxDemoResetInProgressError();
  }

  sandboxResetPromise = (async () => {
    const resetAt = new Date().toISOString();
    resetManagedOperatorSigners();
    const hardResetApplied = await hardhatResetCurrentRpc(rpcUrl);
    if (!hardResetApplied) {
      await revertSandboxBootstrapSnapshot(rpcUrl, snapshotPath);
    }
    await resetSandboxReadModelDatabase(resolvedConnectionString);
    await clearSandboxLocalState(env);
    resetManagedOperatorSigners();
    await runBootstrapScript(env);
    resetManagedOperatorSigners();
    return {
      finishedAt: new Date().toISOString(),
      resetAt,
    };
  })();

  try {
    return await sandboxResetPromise;
  } finally {
    sandboxResetPromise = null;
  }
}
