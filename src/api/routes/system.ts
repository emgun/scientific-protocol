import { serviceWritesEnabled } from "../../service/mode.js";
import { serviceProvenance } from "../../service/provenance.js";
import { readEnvValue } from "../../shared/secrets.js";
import { json } from "../http.js";
import { parseIntegerParam } from "../params.js";
import {
  buildPersistedArtifactDetail,
  buildReadModelOptionalApiHealth,
  buildSyncStatus,
  buildWriteProtocolConfigPayload,
} from "../read-payloads.js";
import type { RouteContext } from "./context.js";

export async function handleSystemRoutes(context: RouteContext): Promise<boolean> {
  const {
    databaseUrl,
    dependencies,
    deploymentPath,
    env,
    pool,
    readModelOptionalApi,
    readModelPath,
    request,
    response,
    serviceMode,
    url,
  } = context;
  if (url.pathname === "/livez") {
    json(response, 200, {
      ok: true,
      service: {
        mode: serviceMode,
        provenance: serviceProvenance(env),
        writesEnabled: serviceWritesEnabled(serviceMode),
      },
    });
    return true;
  }
  if (url.pathname === "/readyz") {
    if (readModelOptionalApi) {
      json(response, 200, {
        ok: true,
        readModel: "disabled",
        serviceMode,
      });
      return true;
    }
    try {
      const result = await pool.query<{ schema_migrations: string | null }>(
        "SELECT to_regclass('public.schema_migrations')::text AS schema_migrations",
      );
      if (!result.rows[0]?.schema_migrations) {
        json(response, 503, { error: "migrations_not_applied", ok: false });
        return true;
      }
      json(response, 200, { ok: true, readModel: "available", serviceMode });
    } catch {
      json(response, 503, { error: "read_model_unavailable", ok: false });
    }
    return true;
  }
  if (url.pathname === "/health") {
    if (readModelOptionalApi) {
      const apiHealth = await buildReadModelOptionalApiHealth(dependencies, deploymentPath, env);
      json(response, 200, {
        ok: true,
        ...apiHealth,
        api: {
          mode: "read-model-optional",
          readModel: "disabled",
        },
        readModel: {
          configured: false,
          status: "unavailable",
        },
        service: {
          mode: serviceMode,
          provenance: serviceProvenance(env),
          writesEnabled: serviceWritesEnabled(serviceMode),
        },
      });
      return true;
    }

    const metadata = await dependencies.readMetadata(pool);
    const counts = await dependencies.readReadModelCounts(pool);
    json(response, 200, {
      ok: true,
      ...metadata,
      counts,
      sync: await buildSyncStatus(dependencies, pool, metadata),
      service: {
        mode: serviceMode,
        provenance: serviceProvenance(env),
        writesEnabled: serviceWritesEnabled(serviceMode),
      },
    });
    return true;
  }
  if (url.pathname === "/write-config") {
    json(response, 200, {
      ...(await buildWriteProtocolConfigPayload(deploymentPath, env)),
      gateway: {
        mode: serviceMode,
        writesEnabled: serviceWritesEnabled(serviceMode),
      },
    });
    return true;
  }

  if (url.pathname === "/admin/status") {
    const metadata = await dependencies.readMetadata(pool);
    const counts = await dependencies.readReadModelCounts(pool);
    json(response, 200, {
      counts,
      metadata,
      sync: await buildSyncStatus(dependencies, pool, metadata),
    });
    return true;
  }

  const isCronSyncRequest = url.pathname === "/admin/sync" && request.method === "GET";
  if (url.pathname === "/admin/sync" && (request.method === "POST" || isCronSyncRequest)) {
    if (isCronSyncRequest) {
      // Cron invocations are GET requests carrying the CRON_SECRET bearer
      // token. Without a configured secret the GET form stays disabled; POST
      // remains the operator-facing trigger.
      const cronSecret = readEnvValue(env, "CRON_SECRET");
      const authorization = request.headers.authorization ?? "";
      if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
        json(response, 401, { error: "unauthorized" });
        return true;
      }
    }

    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      indexedAt: synced.metadata.indexedAt,
      latestBlock: synced.metadata.latestBlock,
      claims: synced.counts.claims,
      replications: synced.counts.replications,
      checkpoints: synced.counts.checkpoints,
      agents: synced.counts.agents,
      forecasts: synced.counts.forecasts,
      challenges: synced.counts.challenges,
      appeals: synced.counts.appeals,
    });
    return true;
  }

  return false;
}

export async function handleOperatorRequestRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, pool, response, url } = context;
  if (url.pathname === "/operator-requests") {
    json(
      response,
      200,
      await dependencies.readOperatorRequestsPage(pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        actionType:
          (url.searchParams.get("actionType") as
            | "checkpoint_publication"
            | "replication_submission"
            | "resolution_submission"
            | null) ?? undefined,
        operatorAddress: url.searchParams.get("operatorAddress") ?? undefined,
        scopeKey: url.searchParams.get("scopeKey") ?? undefined,
        status:
          (url.searchParams.get("status") as "failed" | "prepared" | "submitted" | null) ??
          undefined,
      }),
    );
    return true;
  }
  const operatorRequestMatch = url.pathname.match(/^\/operator-requests\/(\d+)$/);
  if (operatorRequestMatch) {
    const operatorRequest = await dependencies.readOperatorRequest(pool, operatorRequestMatch[1]);
    if (!operatorRequest) {
      json(response, 404, { error: "operator_request_not_found" });
      return true;
    }
    json(response, 200, {
      ...operatorRequest,
      payloadArtifact: operatorRequest.payloadArtifactKey
        ? await buildPersistedArtifactDetail(pool, dependencies, operatorRequest.payloadArtifactKey)
        : null,
    });
    return true;
  }

  return false;
}
