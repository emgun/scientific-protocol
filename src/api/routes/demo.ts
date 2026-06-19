// Sandbox/demo surface. All /demo/* routes live here; the /demo/admin/* routes are
// additionally gated by isSandboxAdminRoutesEnabled (SP_ENABLE_SANDBOX_ADMIN_ROUTES)
// via isSandboxAdminRouteDisabled, so the production surface stays auditable.
import { persistJsonArtifact } from "../../shared/persisted-artifacts.js";
import { json, readJsonBody } from "../http.js";
import { parseArtifactDraftPayload } from "../params.js";
import { buildDemoScenarioPayloads, buildSyncStatus } from "../read-payloads.js";
import {
  isDemoAdminAuthorized,
  isSandboxAdminRouteDisabled,
  readDemoAdminToken,
} from "../sandbox.js";
import type { RouteContext } from "./context.js";

export async function handleSandboxDemoRoutes(context: RouteContext): Promise<boolean> {
  const {
    databaseUrl,
    dependencies,
    deploymentPath,
    env,
    pool,
    readModelPath,
    request,
    response,
    url,
  } = context;
  if (url.pathname === "/demo/claims" && request.method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const result = await dependencies.createDemoClaim(
      {
        artifactType: typeof body.artifactType === "number" ? body.artifactType : undefined,
        artifactUri: String(body.artifactUri ?? ""),
        authorBondEth: typeof body.authorBondEth === "string" ? body.authorBondEth : undefined,
        bountyEth: typeof body.bountyEth === "string" ? body.bountyEth : undefined,
        domainId: typeof body.domainId === "number" ? body.domainId : undefined,
        metadata: typeof body.metadata === "string" ? body.metadata : undefined,
        methodology: typeof body.methodology === "string" ? body.methodology : undefined,
        openReplicationJob: body.openReplicationJob === true,
        predictionHooks:
          typeof body.predictionHooks === "string" ? body.predictionHooks : undefined,
        requestedBy: typeof body.requestedBy === "string" ? body.requestedBy : undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        statement: String(body.statement ?? ""),
      },
      pool,
      { env },
    );
    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      result,
      synced: {
        indexedAt: synced.metadata.indexedAt,
        latestBlock: synced.metadata.latestBlock,
      },
    });
    return true;
  }

  if (url.pathname === "/demo/claim-drafts/from-artifact" && request.method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const result = await dependencies.createDemoArtifactDraft(
      parseArtifactDraftPayload(body),
      pool,
    );
    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      result,
      synced: {
        indexedAt: synced.metadata.indexedAt,
        latestBlock: synced.metadata.latestBlock,
      },
    });
    return true;
  }

  if (url.pathname === "/demo/replication-jobs" && request.method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const result = await dependencies.openDemoReplicationJob(
      {
        claimId: String(body.claimId ?? ""),
        requestedBy: typeof body.requestedBy === "string" ? body.requestedBy : undefined,
      },
      pool,
    );
    json(response, 200, { ok: true, result });
    return true;
  }

  if (url.pathname === "/demo/artifact-maintenance-tasks" && request.method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const result = await dependencies.createArtifactMaintenanceTask(pool, {
      artifactKey: String(body.artifactKey ?? ""),
      requestedBy:
        typeof body.requestedBy === "string" ? body.requestedBy : "demo-artifact-maintenance",
      targetProvider: typeof body.targetProvider === "string" ? body.targetProvider : undefined,
      targetReplicaKey:
        typeof body.targetReplicaKey === "string" ? body.targetReplicaKey : undefined,
      taskType: body.taskType === "repair" ? "repair" : "audit",
    });
    json(response, 200, { ok: true, result });
    return true;
  }

  if (
    url.pathname === "/demo/artifact-maintenance-tasks/enqueue-audits" &&
    request.method === "POST"
  ) {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const staleAfterMinutes =
      typeof body.staleAfterMinutes === "number" ? body.staleAfterMinutes : undefined;
    const result = await dependencies.enqueueArtifactAuditTasks(pool, {
      requestedBy:
        typeof body.requestedBy === "string" ? body.requestedBy : "demo-artifact-maintenance",
      staleAfterMs:
        staleAfterMinutes === undefined ? undefined : Math.max(0, staleAfterMinutes) * 60 * 1000,
    });
    json(response, 200, { ok: true, result });
    return true;
  }

  const processJobMatch = url.pathname.match(/^\/demo\/replication-jobs\/(\d+)\/process$/);
  if (processJobMatch && request.method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const result = await dependencies.processDemoReplicationJob(
      {
        jobId: processJobMatch[1],
        workerId: typeof body.workerId === "string" ? body.workerId : undefined,
      },
      databaseUrl,
      env,
    );
    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      result,
      synced: {
        indexedAt: synced.metadata.indexedAt,
        latestBlock: synced.metadata.latestBlock,
      },
    });
    return true;
  }

  const resolveJobMatch = url.pathname.match(/^\/demo\/replication-jobs\/(\d+)\/resolve$/);
  if (resolveJobMatch && request.method === "POST") {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const result = await dependencies.resolveDemoReplicationJob(
      {
        jobId: resolveJobMatch[1],
        claimStatus: typeof body.claimStatus === "number" ? body.claimStatus : undefined,
        confidenceBps: typeof body.confidenceBps === "number" ? body.confidenceBps : undefined,
        resolutionStatus:
          typeof body.resolutionStatus === "number" ? body.resolutionStatus : undefined,
      },
      databaseUrl,
      env,
    );
    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      result,
      synced: {
        indexedAt: synced.metadata.indexedAt,
        latestBlock: synced.metadata.latestBlock,
      },
    });
    return true;
  }

  const recomputeDomainMatch = url.pathname.match(/^\/demo\/domains\/(\d+)\/recompute$/);
  if (recomputeDomainMatch && request.method === "POST") {
    const domainId = Number(recomputeDomainMatch[1]);
    const result = await dependencies.recomputeDemoDomain({ domainId }, databaseUrl, env);
    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      result,
      synced: {
        indexedAt: synced.metadata.indexedAt,
        latestBlock: synced.metadata.latestBlock,
      },
    });
    return true;
  }

  if (url.pathname === "/demo/scenarios" && request.method === "GET") {
    json(response, 200, {
      items: await buildDemoScenarioPayloads(dependencies, pool, databaseUrl),
    });
    return true;
  }

  if (url.pathname === "/demo/admin/status" && request.method === "GET") {
    if (isSandboxAdminRouteDisabled(response, env)) {
      return true;
    }

    if (!isDemoAdminAuthorized(request, env)) {
      json(response, 401, { error: "demo_admin_unauthorized" });
      return true;
    }

    const metadata = await dependencies.readMetadata(pool);
    const counts = await dependencies.readReadModelCounts(pool);
    json(response, 200, {
      ok: true,
      tokenConfigured: readDemoAdminToken(env) !== null,
      counts,
      sync: await buildSyncStatus(dependencies, pool, metadata),
      scenarios: await buildDemoScenarioPayloads(dependencies, pool, databaseUrl),
    });
    return true;
  }

  if (url.pathname === "/demo/admin/reseed-operational" && request.method === "POST") {
    if (isSandboxAdminRouteDisabled(response, env)) {
      return true;
    }

    if (!isDemoAdminAuthorized(request, env)) {
      json(response, 401, { error: "demo_admin_unauthorized" });
      return true;
    }

    const result = await dependencies.reseedOperationalDemoScenario(databaseUrl, env);
    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      result,
      scenarios: await buildDemoScenarioPayloads(dependencies, pool, databaseUrl),
      synced: {
        indexedAt: synced.metadata.indexedAt,
        latestBlock: synced.metadata.latestBlock,
      },
    });
    return true;
  }

  if (url.pathname === "/demo/admin/reset-demo" && request.method === "POST") {
    if (isSandboxAdminRouteDisabled(response, env)) {
      return true;
    }

    if (!isDemoAdminAuthorized(request, env)) {
      json(response, 401, { error: "demo_admin_unauthorized" });
      return true;
    }

    const result = await dependencies.resetSandboxDemo(databaseUrl, env);
    const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
      env,
    });
    json(response, 200, {
      ok: true,
      result,
      scenarios: await buildDemoScenarioPayloads(dependencies, pool, databaseUrl),
      synced: {
        indexedAt: synced.metadata.indexedAt,
        latestBlock: synced.metadata.latestBlock,
      },
    });
    return true;
  }

  const demoOpenReviewTasksMatch = url.pathname.match(
    /^\/demo\/claims\/(\d+)\/review-tasks\/open-defaults$/,
  );
  if (demoOpenReviewTasksMatch && request.method === "POST") {
    const claimId = demoOpenReviewTasksMatch[1];
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const requestedBy =
      typeof body.requestedBy === "string" && body.requestedBy.trim().length > 0
        ? body.requestedBy.trim()
        : "demo-review-bootstrap";
    const tasks = await dependencies.openDefaultReviewTasksForClaim(pool, {
      claimId,
      requestedBy,
    });
    json(response, 200, {
      ok: true,
      result: {
        claimId,
        requestedBy,
        taskCount: tasks.length,
        tasks,
      },
    });
    return true;
  }

  const demoCreateReviewResponseMatch = url.pathname.match(
    /^\/demo\/claims\/(\d+)\/review-responses$/,
  );
  if (demoCreateReviewResponseMatch && request.method === "POST") {
    const claimId = demoCreateReviewResponseMatch[1];
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    if (typeof body.summary !== "string" || body.summary.trim().length === 0) {
      json(response, 400, { error: "invalid_review_response_summary" });
      return true;
    }
    const issueIds = Array.isArray(body.issueIds)
      ? body.issueIds
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    const responderActor =
      typeof body.responderActor === "string" && body.responderActor.trim().length > 0
        ? body.responderActor
        : "demo-author";
    const responseArtifact = await persistJsonArtifact("review-author-response", {
      claimId,
      detail: typeof body.detail === "string" ? body.detail : body.summary,
      issueIds,
      responderActor,
      summary: body.summary,
    });
    await dependencies.upsertPersistedArtifact(pool, responseArtifact);
    const created = await dependencies.createReviewAuthorResponse(pool, {
      claimId,
      issueIds,
      responderActor,
      responseArtifactKey: responseArtifact.artifactKey,
      summary: body.summary.trim(),
    });
    json(response, 200, {
      ok: true,
      result: created,
    });
    return true;
  }

  return false;
}
