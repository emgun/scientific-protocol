import { getDatabaseUrl } from "../indexer/store.js";
import { isMainModule, parseIntegerValue } from "../shared/cli.js";
import { publishDomainCheckpoints } from "./publisher.js";
import {
  prepareCheckpointStore,
  readCheckpointPublication,
  readCheckpointPublicationsPage,
} from "./store.js";

function parseCommandLine(argv: string[] = process.argv): {
  command: string;
  positionals: string[];
} {
  const [, , command = "list", ...positionals] = argv;
  return { command, positionals };
}

function parseDomainId(raw: string | undefined): number {
  return parseIntegerValue(raw ?? "1", "domainId", { min: 0 });
}

async function publishCommand(
  positionals: string[],
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const domainId = parseDomainId(positionals[0]);
  return await publishDomainCheckpoints({
    connectionString: databaseUrl,
    domainId,
    env,
  });
}

async function listCommand(positionals: string[], databaseUrl: string): Promise<unknown> {
  const pool = await prepareCheckpointStore(databaseUrl);
  try {
    const domainId = positionals[0] ? parseDomainId(positionals[0]) : undefined;
    return await readCheckpointPublicationsPage(pool, {
      domainId,
      limit: 100,
      offset: 0,
    });
  } finally {
    await pool.end();
  }
}

async function showCommand(positionals: string[], databaseUrl: string): Promise<unknown> {
  const publicationId = positionals[0];
  if (!publicationId) {
    throw new Error("usage: show <publicationId>");
  }
  const pool = await prepareCheckpointStore(databaseUrl);
  try {
    const publication = await readCheckpointPublication(pool, publicationId);
    if (!publication) {
      throw new Error(`checkpoint publication ${publicationId} not found`);
    }
    return publication;
  } finally {
    await pool.end();
  }
}

export async function runCheckpointCliFromEnv(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const databaseUrl = getDatabaseUrl(env);
  const { command, positionals } = parseCommandLine(argv);
  if (command === "publish") {
    return await publishCommand(positionals, databaseUrl, env);
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
  runCheckpointCliFromEnv()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
