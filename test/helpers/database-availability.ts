import net from "node:net";
import { getDatabaseUrl } from "../../src/indexer/store.js";

/// Probes the configured Postgres endpoint so database-backed suites can skip
/// gracefully on machines without a local database. CI and full verification
/// runs set SP_REQUIRE_DB_TESTS=1, which turns an unreachable database into a
/// hard failure instead of a silent skip.
export async function probeDatabase(env: NodeJS.ProcessEnv = process.env): Promise<{
  available: boolean;
  required: boolean;
  skipReason: string | false;
}> {
  const required = env.SP_REQUIRE_DB_TESTS === "1";
  const url = new URL(getDatabaseUrl(env));
  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port || 5432);

  const available = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

  if (!available && required) {
    throw new Error(
      `SP_REQUIRE_DB_TESTS=1 but Postgres is unreachable at ${host}:${port}. ` +
        "Start it with `npm run db:start:local` or point SP_DATABASE_URL at a running instance.",
    );
  }

  if (!available) {
    console.warn(
      `[db-tests] Postgres unreachable at ${host}:${port}; skipping database-backed suite. ` +
        "Start it with `npm run db:start:local` to include these tests.",
    );
  }

  return {
    available,
    required,
    skipReason: available
      ? false
      : "requires Postgres (npm run db:start:local); enforced in CI via SP_REQUIRE_DB_TESTS=1",
  };
}
