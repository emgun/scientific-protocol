import { readFile } from "node:fs/promises";
import { getDatabaseUrl, readClaim } from "../indexer/store.js";
import { isMainModule } from "../shared/cli.js";
import { persistJsonArtifact, sha256Hex } from "../shared/persisted-artifacts.js";
import {
  createReplicationJob,
  prepareCoordinatorStore,
  readClaimReplicationJobsPage,
  readReplicationJob,
  readReplicationJobRuns,
  readReplicationJobsPage,
  upsertPersistedArtifact,
} from "./store.js";

function parseCommandLine(argv: string[] = process.argv): {
  command: string;
  positionals: string[];
} {
  const [, , command = "list", ...positionals] = argv;
  return { command, positionals };
}

async function openCommand(positionals: string[], databaseUrl: string): Promise<unknown> {
  const claimId = positionals[0];
  const requestedBy = positionals[1] ?? "local-coordinator";
  const specFile = positionals[2];
  if (!claimId) {
    throw new Error("usage: open <claimId> [requestedBy] [specFile]");
  }

  const pool = await prepareCoordinatorStore(databaseUrl);
  try {
    const claim = await readClaim(pool, claimId);
    if (!claim) {
      throw new Error(`claim ${claimId} not found`);
    }

    let specPayload: unknown = {
      claimId,
      executionProfile: "objective-reproduction",
      requestedAt: new Date().toISOString(),
      requestedBy,
    };
    let specURI: string | undefined;
    if (specFile) {
      const contents = await readFile(specFile, "utf8");
      specPayload = { claimId, requestedBy, sourceFile: specFile, contents };
      const persisted = await persistJsonArtifact("replication-spec", specPayload);
      await upsertPersistedArtifact(pool, persisted);
      specURI = persisted.storagePath;
    }

    const specHash = `0x${sha256Hex(JSON.stringify(specPayload))}`;
    const job = await createReplicationJob(pool, {
      claimId,
      requestedBy,
      specHash,
      specURI,
    });
    return job;
  } finally {
    await pool.end();
  }
}

async function listCommand(positionals: string[], databaseUrl: string): Promise<unknown> {
  const claimId = positionals[0];
  const pool = await prepareCoordinatorStore(databaseUrl);
  try {
    return claimId
      ? await readClaimReplicationJobsPage(pool, claimId, { limit: 50, offset: 0 })
      : await readReplicationJobsPage(pool, { limit: 50, offset: 0 });
  } finally {
    await pool.end();
  }
}

async function showCommand(positionals: string[], databaseUrl: string): Promise<unknown> {
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("usage: show <jobId>");
  }
  const pool = await prepareCoordinatorStore(databaseUrl);
  try {
    const job = await readReplicationJob(pool, jobId);
    if (!job) {
      throw new Error(`replication job ${jobId} not found`);
    }
    const runs = await readReplicationJobRuns(pool, jobId);
    return { ...job, runs };
  } finally {
    await pool.end();
  }
}

export async function runCoordinatorCliFromEnv(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const databaseUrl = getDatabaseUrl(env);
  const { command, positionals } = parseCommandLine(argv);
  if (command === "open") {
    return await openCommand(positionals, databaseUrl);
  }
  if (command === "show") {
    return await showCommand(positionals, databaseUrl);
  }
  if (command === "list") {
    return await listCommand(positionals, databaseUrl);
  }
  throw new Error(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runCoordinatorCliFromEnv(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
