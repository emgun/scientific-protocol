import { getReadModelPath, syncReadModel } from "../src/indexer/projector.js";
import {
  createReadModelPool,
  getDatabaseUrl,
  migrateReadModelDb,
  readReadModelCounts,
} from "../src/indexer/store.js";
import { isMainModule } from "../src/shared/cli.js";
import { getDeploymentPath } from "../src/shared/deployment.js";
import { readEnvValue } from "../src/shared/secrets.js";

function normalizedDatabaseIdentity(value: string): string {
  const url = new URL(value);
  url.password = "";
  return url.toString();
}

export async function rebuildReadModelFresh(env: NodeJS.ProcessEnv = process.env) {
  const sourceDatabaseUrl = getDatabaseUrl(env);
  const targetDatabaseUrl = readEnvValue(env, "SP_REBUILD_DATABASE_URL");
  if (!targetDatabaseUrl) throw new Error("SP_REBUILD_DATABASE_URL is required");
  if (
    normalizedDatabaseIdentity(sourceDatabaseUrl) === normalizedDatabaseIdentity(targetDatabaseUrl)
  ) {
    throw new Error("SP_REBUILD_DATABASE_URL must be a fresh database, not SP_DATABASE_URL");
  }

  const pool = createReadModelPool(targetDatabaseUrl, env);
  try {
    await migrateReadModelDb(pool);
    const counts = await readReadModelCounts(pool);
    if (Object.values(counts).some((count) => count > 0)) {
      throw new Error("rebuild target must not contain chain-derived records");
    }
    const operational = await pool.query<{ count: string }>(`
      SELECT (
        (SELECT COUNT(*) FROM source_records) +
        (SELECT COUNT(*) FROM persisted_artifacts) +
        (SELECT COUNT(*) FROM review_tasks) +
        (SELECT COUNT(*) FROM replication_jobs)
      )::text AS count
    `);
    if (Number(operational.rows[0]?.count ?? "0") > 0) {
      throw new Error("rebuild target must not contain operational records");
    }

    return await syncReadModel(getDeploymentPath(env), getReadModelPath(env), targetDatabaseUrl, {
      env,
      pool,
      snapshot: false,
    });
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await rebuildReadModelFresh(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
