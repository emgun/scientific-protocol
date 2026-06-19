import { getDatabaseUrl } from "../indexer/store.js";
import { isMainModule, parseIntegerValue } from "../shared/cli.js";
import { computeDomainLeaderboard } from "./engine.js";
import {
  prepareReputationStore,
  readDomainLeaderboard,
  readLatestReputationPayload,
} from "./store.js";

function parseCommandLine(argv: string[] = process.argv): { command: string; domainId: number } {
  const [, , command = "show", domainIdRaw = "1"] = argv;
  return { command, domainId: parseIntegerValue(domainIdRaw, "domainId", { min: 0 }) };
}

async function compute(domainId: number, databaseUrl: string): Promise<unknown> {
  return await computeDomainLeaderboard(databaseUrl, domainId);
}

async function show(domainId: number, databaseUrl: string): Promise<unknown> {
  const pool = await prepareReputationStore(databaseUrl);
  try {
    const [payload, leaderboard] = await Promise.all([
      readLatestReputationPayload(pool, domainId),
      readDomainLeaderboard(pool, domainId, { limit: 20, offset: 0 }),
    ]);
    return { payload, leaderboard };
  } finally {
    await pool.end();
  }
}

export async function runReputationCliFromEnv(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const databaseUrl = getDatabaseUrl(env);
  const { command, domainId } = parseCommandLine(argv);
  if (command === "compute") {
    return await compute(domainId, databaseUrl);
  }
  if (command === "show") {
    return await show(domainId, databaseUrl);
  }
  throw new Error(`unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runReputationCliFromEnv(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
