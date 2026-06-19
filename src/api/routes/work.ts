import { getRpcUrl } from "../../shared/contracts.js";
import {
  authenticateOperatorLifecycleRequest,
  listReplicationSubmitterAuthorizedAddresses,
  type OperatorLifecycleAuthentication,
  ROLE_HASH,
} from "../auth.js";
import { isHttpRequestError, json, readJsonBody } from "../http.js";
import { hasAnySearchParam, parseBooleanParam, parseIntegerParam } from "../params.js";
import {
  buildArtifactMaintenanceTaskDetail,
  buildPersistedArtifactDetail,
  buildWorkItemDetailPayload,
  buildWorkItemsPagePayload,
  buildWriteProtocolConfigPayload,
  readAllReviewSubmissions,
} from "../read-payloads.js";
import type { RouteContext } from "./context.js";

export async function handleWorkLifecycleRoutes(context: RouteContext): Promise<boolean> {
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
  const processProductionJobMatch = url.pathname.match(/^\/replication-jobs\/(\d+)\/process$/);
  if (processProductionJobMatch && request.method === "POST") {
    const body = await readJsonBody(request);
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    let authenticated: OperatorLifecycleAuthentication | null = null;
    try {
      authenticated = await authenticateOperatorLifecycleRequest(
        dependencies,
        pool,
        request,
        body,
        {
          actionType: "replication_job_process",
          authorizeSignedActor: async (actorAddress) =>
            (await listReplicationSubmitterAuthorizedAddresses(env)).includes(
              actorAddress.toLowerCase(),
            ),
          chainId: writeConfig.chainId,
          env,
          scopeKey: `replication-job:${processProductionJobMatch[1]}:process`,
        },
      );
      const payload = authenticated.payload;
      const result = await dependencies.processDemoReplicationJob(
        {
          jobId: processProductionJobMatch[1],
          workerId: typeof payload.workerId === "string" ? payload.workerId : undefined,
        },
        databaseUrl,
        env,
      );
      if (authenticated.mode === "signed") {
        await dependencies.markPublicWriteRequestAccepted(
          pool,
          authenticated.acceptedRequestId,
          `replication-job:${processProductionJobMatch[1]}:processed`,
        );
      }
      const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
        env,
      });
      json(response, 200, {
        ok: true,
        requestId: authenticated.mode === "signed" ? authenticated.acceptedRequestId : undefined,
        result,
        synced: {
          indexedAt: synced.metadata.indexedAt,
          latestBlock: synced.metadata.latestBlock,
        },
      });
    } catch (error) {
      if (
        isHttpRequestError(error) &&
        (error.message === "operator_unauthorized" || error.message === "operator_forbidden")
      ) {
        json(response, error.responseStatus, { error: error.message });
        return true;
      }
      if (isHttpRequestError(error) && error.message.startsWith("public_write_")) {
        json(response, error.responseStatus, { error: error.message });
        return true;
      }
      if (isHttpRequestError(error) && error.message.startsWith("invalid_")) {
        json(response, error.responseStatus, { error: error.message });
        return true;
      }
      if (authenticated?.mode === "signed") {
        await dependencies.markPublicWriteRequestRejected(
          pool,
          authenticated.acceptedRequestId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    return true;
  }

  const resolveProductionJobMatch = url.pathname.match(/^\/replication-jobs\/(\d+)\/resolve$/);
  if (resolveProductionJobMatch && request.method === "POST") {
    const body = await readJsonBody(request);
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    let authenticated: OperatorLifecycleAuthentication | null = null;
    try {
      authenticated = await authenticateOperatorLifecycleRequest(
        dependencies,
        pool,
        request,
        body,
        {
          actionType: "replication_job_resolve",
          authorizeSignedActor: async (actorAddress) =>
            dependencies.accessControllerHasRole(
              deploymentPath,
              ROLE_HASH.RESOLVER_ROLE,
              actorAddress.toLowerCase(),
              getRpcUrl(env),
            ),
          chainId: writeConfig.chainId,
          env,
          scopeKey: `replication-job:${resolveProductionJobMatch[1]}:resolve`,
        },
      );
      const payload = authenticated.payload;
      const result = await dependencies.resolveDemoReplicationJob(
        {
          jobId: resolveProductionJobMatch[1],
          claimStatus: typeof payload.claimStatus === "number" ? payload.claimStatus : undefined,
          confidenceBps:
            typeof payload.confidenceBps === "number" ? payload.confidenceBps : undefined,
          resolutionStatus:
            typeof payload.resolutionStatus === "number" ? payload.resolutionStatus : undefined,
        },
        databaseUrl,
        env,
      );
      if (authenticated.mode === "signed") {
        await dependencies.markPublicWriteRequestAccepted(
          pool,
          authenticated.acceptedRequestId,
          `replication-job:${resolveProductionJobMatch[1]}:resolved`,
        );
      }
      const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
        env,
      });
      json(response, 200, {
        ok: true,
        requestId: authenticated.mode === "signed" ? authenticated.acceptedRequestId : undefined,
        result,
        synced: {
          indexedAt: synced.metadata.indexedAt,
          latestBlock: synced.metadata.latestBlock,
        },
      });
    } catch (error) {
      if (
        isHttpRequestError(error) &&
        (error.message === "operator_unauthorized" || error.message === "operator_forbidden")
      ) {
        json(response, error.responseStatus, { error: error.message });
        return true;
      }
      if (
        isHttpRequestError(error) &&
        (error.message.startsWith("public_write_") || error.message.startsWith("invalid_"))
      ) {
        json(response, error.responseStatus, { error: error.message });
        return true;
      }
      if (authenticated?.mode === "signed") {
        await dependencies.markPublicWriteRequestRejected(
          pool,
          authenticated.acceptedRequestId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    return true;
  }

  const recomputeProductionDomainMatch = url.pathname.match(/^\/domains\/(\d+)\/recompute$/);
  if (recomputeProductionDomainMatch && request.method === "POST") {
    const body = await readJsonBody(request);
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    let authenticated: OperatorLifecycleAuthentication | null = null;
    try {
      authenticated = await authenticateOperatorLifecycleRequest(
        dependencies,
        pool,
        request,
        body,
        {
          actionType: "domain_recompute",
          authorizeSignedActor: async (actorAddress) =>
            dependencies.accessControllerHasRole(
              deploymentPath,
              ROLE_HASH.CHECKPOINT_PUBLISHER_ROLE,
              actorAddress.toLowerCase(),
              getRpcUrl(env),
            ),
          chainId: writeConfig.chainId,
          env,
          scopeKey: `domain:${recomputeProductionDomainMatch[1]}:recompute`,
        },
      );
      const domainId = Number(recomputeProductionDomainMatch[1]);
      const result = await dependencies.recomputeDemoDomain({ domainId }, databaseUrl, env);
      if (authenticated.mode === "signed") {
        await dependencies.markPublicWriteRequestAccepted(
          pool,
          authenticated.acceptedRequestId,
          `domain:${domainId}:recomputed`,
        );
      }
      const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
        env,
      });
      json(response, 200, {
        ok: true,
        requestId: authenticated.mode === "signed" ? authenticated.acceptedRequestId : undefined,
        result,
        synced: {
          indexedAt: synced.metadata.indexedAt,
          latestBlock: synced.metadata.latestBlock,
        },
      });
    } catch (error) {
      if (
        isHttpRequestError(error) &&
        (error.message === "operator_unauthorized" || error.message === "operator_forbidden")
      ) {
        json(response, error.responseStatus, { error: error.message });
        return true;
      }
      if (
        isHttpRequestError(error) &&
        (error.message.startsWith("public_write_") || error.message.startsWith("invalid_"))
      ) {
        json(response, error.responseStatus, { error: error.message });
        return true;
      }
      if (authenticated?.mode === "signed") {
        await dependencies.markPublicWriteRequestRejected(
          pool,
          authenticated.acceptedRequestId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    return true;
  }

  return false;
}

export async function handleWorkReadRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, pool, response, url } = context;
  if (url.pathname === "/work-items") {
    json(
      response,
      200,
      await buildWorkItemsPagePayload(dependencies, pool, {
        claimId: url.searchParams.get("claimId") ?? undefined,
        claimable: parseBooleanParam(url, "claimable"),
        kind:
          (url.searchParams.get("kind") as
            | "artifact_maintenance"
            | "replication_job"
            | "review_task"
            | null) ?? undefined,
        lane:
          (url.searchParams.get("lane") as
            | "evaluation"
            | "execution"
            | "maintenance"
            | "synthesis"
            | null) ?? undefined,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        sourceId: url.searchParams.get("sourceId") ?? undefined,
        status:
          (url.searchParams.get("status") as
            | "canceled"
            | "completed"
            | "escalated"
            | "failed"
            | "leased"
            | "open"
            | null) ?? undefined,
      }),
    );
    return true;
  }

  const workItemMatch = url.pathname.match(/^\/work-items\/([^/]+)$/);
  if (workItemMatch) {
    const detail = await buildWorkItemDetailPayload(dependencies, pool, {
      claimId: url.searchParams.get("claimId") ?? undefined,
      itemId: decodeURIComponent(workItemMatch[1]),
      sourceId: url.searchParams.get("sourceId") ?? undefined,
    });
    if (!detail) {
      json(response, 404, { error: "work_item_not_found" });
      return true;
    }
    json(response, 200, detail);
    return true;
  }
  if (url.pathname === "/review-tasks") {
    json(
      response,
      200,
      await dependencies.readReviewTasksPage(pool, {
        claimId: url.searchParams.get("claimId") ?? undefined,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        sourceId: url.searchParams.get("sourceId") ?? undefined,
        status:
          (url.searchParams.get("status") as
            | "canceled"
            | "completed"
            | "escalated"
            | "open"
            | null) ?? undefined,
        taskType: url.searchParams.get("taskType") as
          | "artifact_completeness_check"
          | "artifact_integrity_check"
          | "benchmark_rerun_check"
          | "certification_synthesis_check"
          | "claim_extraction_check"
          | "claim_extraction_synthesis_check"
          | "contradiction_scan"
          | "method_consistency_check"
          | "replication_readiness_check"
          | "stats_sanity_check"
          | undefined,
      }),
    );
    return true;
  }

  const reviewTaskMatch = url.pathname.match(/^\/review-tasks\/(\d+)$/);
  if (reviewTaskMatch) {
    const task = await dependencies.readReviewTask(pool, reviewTaskMatch[1]);
    if (!task) {
      json(response, 404, { error: "review_task_not_found" });
      return true;
    }
    json(response, 200, {
      runs: await dependencies.readReviewTaskRuns(pool, reviewTaskMatch[1]),
      submissions: await readAllReviewSubmissions(dependencies, pool, {
        taskId: reviewTaskMatch[1],
      }),
      task,
    });
    return true;
  }

  const reviewTaskSubmissionsMatch = url.pathname.match(/^\/review-tasks\/(\d+)\/submissions$/);
  if (reviewTaskSubmissionsMatch) {
    json(
      response,
      200,
      await dependencies.readReviewSubmissionsPage(pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        taskId: reviewTaskSubmissionsMatch[1],
        reviewerAgentId: url.searchParams.get("reviewerAgentId") ?? undefined,
        verdict:
          (url.searchParams.get("verdict") as "fail" | "flag" | "inconclusive" | "pass" | null) ??
          undefined,
      }),
    );
    return true;
  }
  if (url.pathname === "/replications") {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "claimId",
        "replicator",
        "agentId",
        "outcome",
        "resolutionStatus",
        "resolverType",
        "confidenceBps",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readReplicationsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: url.searchParams.get("claimId") ?? undefined,
          replicator: url.searchParams.get("replicator") ?? undefined,
          agentId: url.searchParams.get("agentId") ?? undefined,
          outcome: parseIntegerParam(url, "outcome"),
          resolutionStatus: parseIntegerParam(url, "resolutionStatus"),
          resolverType: parseIntegerParam(url, "resolverType"),
          confidenceBps: parseIntegerParam(url, "confidenceBps"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAllReplications(pool));
    return true;
  }

  if (url.pathname === "/replication-jobs") {
    json(
      response,
      200,
      await dependencies.readReplicationJobsPage(pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        claimId: url.searchParams.get("claimId") ?? undefined,
        assignedAgentId: url.searchParams.get("assignedAgentId") ?? undefined,
        assignedWorker: url.searchParams.get("assignedWorker") ?? undefined,
        requestedBy: url.searchParams.get("requestedBy") ?? undefined,
        status:
          (url.searchParams.get("status") as "assigned" | "completed" | "failed" | "open" | null) ??
          undefined,
      }),
    );
    return true;
  }

  if (url.pathname === "/artifact-maintenance-tasks") {
    json(
      response,
      200,
      await dependencies.readArtifactMaintenanceTasksPage(pool, {
        artifactKey: url.searchParams.get("artifactKey") ?? undefined,
        assignedAgentId: url.searchParams.get("assignedAgentId") ?? undefined,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        status:
          (url.searchParams.get("status") as "assigned" | "completed" | "failed" | "open" | null) ??
          undefined,
        targetReplicaKey: url.searchParams.get("targetReplicaKey") ?? undefined,
        taskType: (url.searchParams.get("taskType") as "audit" | "repair" | null) ?? undefined,
      }),
    );
    return true;
  }

  const replicationJobMatch = url.pathname.match(/^\/replication-jobs\/(\d+)$/);
  if (replicationJobMatch) {
    const job = await dependencies.readReplicationJob(pool, replicationJobMatch[1]);
    if (!job) {
      json(response, 404, { error: "replication_job_not_found" });
      return true;
    }

    json(response, 200, {
      ...job,
      operatorRequest: job.requestId
        ? await dependencies.readOperatorRequest(pool, job.requestId)
        : null,
      resultArtifact: job.resultArtifactKey
        ? await buildPersistedArtifactDetail(pool, dependencies, job.resultArtifactKey)
        : null,
      runs: await dependencies.readReplicationJobRuns(pool, job.jobId),
    });
    return true;
  }

  const artifactMaintenanceTaskMatch = url.pathname.match(/^\/artifact-maintenance-tasks\/(\d+)$/);
  if (artifactMaintenanceTaskMatch) {
    const detail = await buildArtifactMaintenanceTaskDetail(
      pool,
      dependencies,
      artifactMaintenanceTaskMatch[1],
    );
    if (!detail) {
      json(response, 404, { error: "artifact_maintenance_task_not_found" });
      return true;
    }
    json(response, 200, detail);
    return true;
  }

  if (url.pathname === "/resolution-runs") {
    json(
      response,
      200,
      await dependencies.readResolutionRunsPage(pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        claimId: url.searchParams.get("claimId") ?? undefined,
        jobId: url.searchParams.get("jobId") ?? undefined,
        replicationId: url.searchParams.get("replicationId") ?? undefined,
        resolver: url.searchParams.get("resolver") ?? undefined,
        status:
          (url.searchParams.get("status") as "failed" | "prepared" | "submitted" | null) ??
          undefined,
      }),
    );
    return true;
  }

  const resolutionRunMatch = url.pathname.match(/^\/resolution-runs\/(\d+)$/);
  if (resolutionRunMatch) {
    const run = await dependencies.readResolutionRun(pool, resolutionRunMatch[1]);
    if (!run) {
      json(response, 404, { error: "resolution_run_not_found" });
      return true;
    }
    json(response, 200, {
      ...run,
      operatorRequest: run.requestId
        ? await dependencies.readOperatorRequest(pool, run.requestId)
        : null,
      rationaleArtifact: run.rationaleArtifactKey
        ? await buildPersistedArtifactDetail(pool, dependencies, run.rationaleArtifactKey)
        : null,
    });
    return true;
  }

  return false;
}
