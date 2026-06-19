import { getDatabaseUrl } from "../indexer/store.js";
import { isMainModule } from "../shared/cli.js";
import { resolveReplicationJob } from "./engine.js";
import { prepareResolverStore, readResolutionRun, readResolutionRunsPage } from "./store.js";

const RESOLUTION_STATUS_BY_NAME = new Map<string, number>([
  ["pending", 0],
  ["supported", 1],
  ["qualified", 2],
  ["inconclusive", 3],
  ["refuted", 4],
  ["fraudsignal", 5],
  ["fraud_signal", 5],
  ["escalated", 6],
]);

const CLAIM_STATUS_BY_NAME = new Map<string, number>([
  ["draft", 0],
  ["published", 1],
  ["underreplication", 2],
  ["under_replication", 2],
  ["provisionallysupported", 3],
  ["provisionally_supported", 3],
  ["qualified", 4],
  ["refuted", 5],
  ["fraudulent", 6],
  ["deprecated", 7],
]);

function parseOptionalEnum(
  raw: string | undefined,
  mapping: Map<string, number>,
  label: string,
): number | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (mapping.has(normalized)) {
    return mapping.get(normalized);
  }
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && new Set(mapping.values()).has(numeric)) {
    return numeric;
  }
  throw new Error(`invalid ${label}: ${raw}`);
}

function parseCommandLine(argv: string[] = process.argv): {
  command: string;
  positionals: string[];
} {
  const [, , command = "list", ...positionals] = argv;
  return { command, positionals };
}

async function resolveJobCommand(
  positionals: string[],
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("usage: resolve-job <jobId> [resolutionStatus] [claimStatus]");
  }
  return await resolveReplicationJob({
    claimStatus: parseOptionalEnum(positionals[2], CLAIM_STATUS_BY_NAME, "claimStatus"),
    connectionString: databaseUrl,
    env,
    jobId,
    resolutionStatus: parseOptionalEnum(
      positionals[1],
      RESOLUTION_STATUS_BY_NAME,
      "resolutionStatus",
    ),
  });
}

async function listCommand(databaseUrl: string): Promise<unknown> {
  const pool = await prepareResolverStore(databaseUrl);
  try {
    return await readResolutionRunsPage(pool, { limit: 50, offset: 0 });
  } finally {
    await pool.end();
  }
}

async function showCommand(positionals: string[], databaseUrl: string): Promise<unknown> {
  const runId = positionals[0];
  if (!runId) {
    throw new Error("usage: show <runId>");
  }
  const pool = await prepareResolverStore(databaseUrl);
  try {
    const run = await readResolutionRun(pool, runId);
    if (!run) {
      throw new Error(`resolution run ${runId} not found`);
    }
    return run;
  } finally {
    await pool.end();
  }
}

export async function runResolverCliFromEnv(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const databaseUrl = getDatabaseUrl(env);
  const { command, positionals } = parseCommandLine(argv);
  if (command === "resolve-job") {
    return await resolveJobCommand(positionals, databaseUrl, env);
  }
  if (command === "show") {
    return await showCommand(positionals, databaseUrl);
  }
  if (command === "list") {
    return await listCommand(databaseUrl);
  }
  throw new Error(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  runResolverCliFromEnv()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
