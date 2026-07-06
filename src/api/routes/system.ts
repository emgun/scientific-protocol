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
    url,
  } = context;
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
    });
    return true;
  }
  if (url.pathname === "/write-config") {
    json(response, 200, await buildWriteProtocolConfigPayload(deploymentPath, env));
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

  if (url.pathname === "/admin/sync" && request.method === "POST") {
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
