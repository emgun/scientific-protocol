import { randomUUID } from "node:crypto";
import { authenticateSignedPublicWriteRequest } from "../auth.js";
import { json } from "../http.js";
import {
  hasAnySearchParam,
  parseBooleanParam,
  parseDetailView,
  parseIntegerParam,
} from "../params.js";
import {
  buildClaimCollectionCounts,
  buildClaimEventsPayload,
  buildClaimFeedPayload,
  buildClaimReviewStatePayload,
  buildClaimRewardStatePayload,
  buildClaimWorkGraphPayload,
  buildWriteProtocolConfigPayload,
  readAllClaimReplicationJobs,
  readAllReviewSubmissions,
  readAllReviewTasks,
} from "../read-payloads.js";
import type { RouteContext } from "./context.js";

export async function handleClaimWriteRoutes(context: RouteContext): Promise<boolean> {
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
  if (url.pathname === "/claims" && request.method === "POST") {
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    const authenticated = await authenticateSignedPublicWriteRequest(dependencies, pool, request, {
      actionType: "claim_create",
      allowRecordedReplay: true,
      chainId: writeConfig.chainId,
    });
    let accepted = false;
    let draftCheckpoint: string | null = null;
    const leaseOwner = randomUUID();
    const leaseAcquired = await dependencies.reservePublicWriteRequestExecution(pool, {
      leaseMs: 5 * 60 * 1000,
      leaseOwner,
      requestId: authenticated.acceptedRequestId,
    });
    if (!leaseAcquired) throw new Error("public_write_request_in_progress");
    try {
      const payload = authenticated.envelope.payload;
      const result = await dependencies.createProductionClaim(
        {
          artifactType: typeof payload.artifactType === "number" ? payload.artifactType : undefined,
          artifactSha256: String(payload.artifactSha256 ?? ""),
          artifactUri: String(payload.artifactUri ?? ""),
          authorBondEth:
            typeof payload.authorBondEth === "string" ? payload.authorBondEth : undefined,
          domainId: typeof payload.domainId === "number" ? payload.domainId : undefined,
          metadata: typeof payload.metadata === "string" ? payload.metadata : undefined,
          methodology: typeof payload.methodology === "string" ? payload.methodology : undefined,
          openReplicationJob: payload.openReplicationJob === true,
          predictionHooks:
            typeof payload.predictionHooks === "string" ? payload.predictionHooks : undefined,
          requestedBy: typeof payload.requestedBy === "string" ? payload.requestedBy : undefined,
          scope: typeof payload.scope === "string" ? payload.scope : undefined,
          statement: String(payload.statement ?? ""),
        },
        authenticated.envelope.actorAddress,
        pool,
        {
          env,
          requestHash: authenticated.requestHash,
          onClaimDraftCreated: async ({ claimId, createClaimTxHash }) => {
            draftCheckpoint = `claim:${claimId}:draft:createTx:${createClaimTxHash}`;
            await dependencies.markPublicWriteRequestPending(
              pool,
              authenticated.acceptedRequestId,
              draftCheckpoint,
            );
          },
        },
      );
      await dependencies.markPublicWriteRequestAccepted(
        pool,
        authenticated.acceptedRequestId,
        `claim:${result.claimId}`,
      );
      accepted = true;
      const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
        env,
      });
      json(response, 200, {
        ok: true,
        requestId: authenticated.acceptedRequestId,
        result,
        synced: {
          indexedAt: synced.metadata.indexedAt,
          latestBlock: synced.metadata.latestBlock,
        },
      });
    } catch (error) {
      if (!accepted) {
        await dependencies.markPublicWriteRequestRejected(
          pool,
          authenticated.acceptedRequestId,
          [draftCheckpoint, error instanceof Error ? error.message : String(error)]
            .filter(Boolean)
            .join(":reconciliation_required:"),
        );
      }
      throw error;
    } finally {
      await dependencies.releasePublicWriteRequestExecution(pool, {
        leaseOwner,
        requestId: authenticated.acceptedRequestId,
      });
    }
    return true;
  }
  const claimPublishMatch = url.pathname.match(/^\/claims\/(\d+)\/publish$/);
  if (claimPublishMatch && request.method === "POST") {
    const claimId = claimPublishMatch[1];
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    const authenticated = await authenticateSignedPublicWriteRequest(dependencies, pool, request, {
      actionType: "claim_publish",
      chainId: writeConfig.chainId,
      scopeKey: `claim:${claimId}`,
    });
    let accepted = false;
    try {
      const result = await dependencies.publishProductionClaim(
        claimId,
        authenticated.envelope.actorAddress,
        env,
      );
      await dependencies.markPublicWriteRequestAccepted(
        pool,
        authenticated.acceptedRequestId,
        `claim:${claimId}:published`,
      );
      accepted = true;
      const synced = await dependencies.syncReadModel(deploymentPath, readModelPath, databaseUrl, {
        env,
      });
      json(response, 200, {
        ok: true,
        requestId: authenticated.acceptedRequestId,
        result,
        synced: { indexedAt: synced.metadata.indexedAt, latestBlock: synced.metadata.latestBlock },
      });
    } catch (error) {
      if (!accepted) {
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
  const replicationJobOpenMatch = url.pathname.match(/^\/claims\/(\d+)\/replication-jobs$/);
  if (replicationJobOpenMatch && request.method === "POST") {
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    const claimId = replicationJobOpenMatch[1];
    const authenticated = await authenticateSignedPublicWriteRequest(dependencies, pool, request, {
      actionType: "replication_job_open",
      chainId: writeConfig.chainId,
      scopeKey: `claim:${claimId}`,
    });
    try {
      const claim = await dependencies.readClaim(pool, claimId);
      if (!claim) {
        throw new Error("claim_not_found");
      }
      if (claim.author.toLowerCase() !== authenticated.envelope.actorAddress.toLowerCase()) {
        throw new Error("claim_author_unauthorized");
      }
      const payload = authenticated.envelope.payload;
      const result = await dependencies.openDemoReplicationJob(
        {
          claimId,
          requestedBy: typeof payload.requestedBy === "string" ? payload.requestedBy : "claim-view",
        },
        pool,
      );
      await dependencies.markPublicWriteRequestAccepted(
        pool,
        authenticated.acceptedRequestId,
        `replication-job:${result.jobId}`,
      );
      json(response, 200, {
        ok: true,
        requestId: authenticated.acceptedRequestId,
        result,
      });
    } catch (error) {
      await dependencies.markPublicWriteRequestRejected(
        pool,
        authenticated.acceptedRequestId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return true;
  }

  return false;
}

export async function handleClaimReadRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, deploymentPath, env, pool, response, url } = context;
  if (url.pathname === "/feeds/claims") {
    json(
      response,
      200,
      await buildClaimFeedPayload(dependencies, pool, {
        claimId: url.searchParams.get("claimId") ?? undefined,
        domainId: parseIntegerParam(url, "domainId"),
        limit: parseIntegerParam(url, "limit"),
        machineProposed: parseBooleanParam(url, "machineProposed"),
        offset: parseIntegerParam(url, "offset"),
        status: parseIntegerParam(url, "status"),
        view: url.searchParams.get("view") === "record" ? "record" : "summary",
      }),
    );
    return true;
  }
  if (url.pathname === "/events/claims") {
    json(
      response,
      200,
      await buildClaimEventsPayload(dependencies, pool, {
        claimId: url.searchParams.get("claimId") ?? undefined,
        domainId: parseIntegerParam(url, "domainId"),
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
      }),
    );
    return true;
  }
  if (url.pathname === "/claims") {
    if (hasAnySearchParam(url, ["limit", "offset", "domainId", "status", "author"])) {
      json(
        response,
        200,
        await dependencies.readClaimsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          domainId: parseIntegerParam(url, "domainId"),
          status: parseIntegerParam(url, "status"),
          author: url.searchParams.get("author") ?? undefined,
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readClaims(pool));
    return true;
  }
  const claimMatch = url.pathname.match(/^\/claims\/(\d+)$/);
  if (claimMatch) {
    const claim = await dependencies.readClaim(pool, claimMatch[1]);
    if (!claim) {
      json(response, 404, { error: "claim_not_found" });
      return true;
    }

    const view = parseDetailView(url);
    if (view === "summary") {
      json(response, 200, {
        ...claim,
        collectionCounts: await buildClaimCollectionCounts(dependencies, pool, claim.claimId),
      });
      return true;
    }

    const [
      artifacts,
      replications,
      checkpoints,
      forecasts,
      challenges,
      appeals,
      reviewTasks,
      reviewSubmissions,
      replicationJobs,
    ] = await Promise.all([
      dependencies.readArtifactsByClaim(pool, claim.claimId),
      dependencies.readReplicationsByClaim(pool, claim.claimId),
      dependencies.readCheckpointsByClaim(pool, claim.claimId),
      dependencies.readForecastsByClaim(pool, claim.claimId),
      dependencies.readChallengesByClaim(pool, claim.claimId),
      dependencies.readAppealsByClaim(pool, claim.claimId),
      readAllReviewTasks(dependencies, pool, { claimId: claim.claimId }),
      readAllReviewSubmissions(dependencies, pool, { claimId: claim.claimId }),
      readAllClaimReplicationJobs(dependencies, pool, claim.claimId),
    ]);
    const workGraph = await buildClaimWorkGraphPayload(dependencies, pool, claim.claimId, {
      artifacts,
      replicationJobs,
      reviewSubmissions,
      reviewTasks,
    });
    const review = await buildClaimReviewStatePayload(dependencies, pool, claim.claimId, {
      artifacts,
      challenges,
      forecasts,
      replications,
      reviewSubmissions,
      reviewTasks,
      reviewWorkGraph: workGraph,
    });
    const rewards = await buildClaimRewardStatePayload(
      dependencies,
      pool,
      deploymentPath,
      claim.claimId,
      {},
      {
        challenges,
        forecasts,
        workGraph,
      },
      env,
    );

    json(response, 200, {
      ...claim,
      collectionCounts: {
        artifacts: artifacts.length,
        replications: replications.length,
        checkpoints: checkpoints.length,
        forecasts: forecasts.length,
        challenges: challenges.length,
        appeals: appeals.length,
      },
      artifacts,
      replications,
      checkpoints,
      forecasts,
      challenges,
      appeals,
      review,
      workGraph,
      rewards,
    });
    return true;
  }
  const claimArtifactsMatch = url.pathname.match(/^\/claims\/(\d+)\/artifacts$/);
  const claimReviewMatch = url.pathname.match(/^\/claims\/(\d+)\/review$/);
  if (claimReviewMatch) {
    const claim = await dependencies.readClaim(pool, claimReviewMatch[1]);
    if (!claim) {
      json(response, 404, { error: "claim_not_found" });
      return true;
    }
    json(
      response,
      200,
      await buildClaimReviewStatePayload(dependencies, pool, claimReviewMatch[1]),
    );
    return true;
  }

  const claimWorkGraphMatch = url.pathname.match(/^\/claims\/(\d+)\/work-graph$/);
  if (claimWorkGraphMatch) {
    const claim = await dependencies.readClaim(pool, claimWorkGraphMatch[1]);
    if (!claim) {
      json(response, 404, { error: "claim_not_found" });
      return true;
    }
    json(
      response,
      200,
      await buildClaimWorkGraphPayload(dependencies, pool, claimWorkGraphMatch[1]),
    );
    return true;
  }
  const claimReviewTasksMatch = url.pathname.match(/^\/claims\/(\d+)\/review-tasks$/);
  if (claimReviewTasksMatch) {
    json(
      response,
      200,
      await dependencies.readReviewTasksPage(pool, {
        claimId: claimReviewTasksMatch[1],
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
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
          | "contradiction_scan"
          | "method_consistency_check"
          | "replication_readiness_check"
          | "stats_sanity_check"
          | undefined,
      }),
    );
    return true;
  }

  const claimReviewSubmissionsMatch = url.pathname.match(/^\/claims\/(\d+)\/review-submissions$/);
  if (claimReviewSubmissionsMatch) {
    json(
      response,
      200,
      await dependencies.readReviewSubmissionsPage(pool, {
        claimId: claimReviewSubmissionsMatch[1],
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        reviewerAgentId: url.searchParams.get("reviewerAgentId") ?? undefined,
        verdict:
          (url.searchParams.get("verdict") as "fail" | "flag" | "inconclusive" | "pass" | null) ??
          undefined,
      }),
    );
    return true;
  }

  const claimReviewIssuesMatch = url.pathname.match(/^\/claims\/(\d+)\/review-issues$/);
  if (claimReviewIssuesMatch) {
    json(
      response,
      200,
      await dependencies.readReviewIssuesPage(pool, {
        claimId: claimReviewIssuesMatch[1],
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        severity:
          (url.searchParams.get("severity") as "critical" | "high" | "low" | "medium" | null) ??
          undefined,
        status:
          (url.searchParams.get("status") as
            | "dismissed"
            | "open"
            | "resolved"
            | "responded"
            | null) ?? undefined,
      }),
    );
    return true;
  }

  const claimReviewResponsesMatch = url.pathname.match(/^\/claims\/(\d+)\/review-responses$/);
  if (claimReviewResponsesMatch) {
    json(
      response,
      200,
      await dependencies.readReviewAuthorResponsesPage(pool, {
        claimId: claimReviewResponsesMatch[1],
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
      }),
    );
    return true;
  }

  if (claimArtifactsMatch) {
    if (hasAnySearchParam(url, ["limit", "offset", "artifactType", "submitter"])) {
      json(
        response,
        200,
        await dependencies.readArtifactsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: claimArtifactsMatch[1],
          artifactType: parseIntegerParam(url, "artifactType"),
          submitter: url.searchParams.get("submitter") ?? undefined,
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readArtifactsByClaim(pool, claimArtifactsMatch[1]));
    return true;
  }

  const claimReplicationsMatch = url.pathname.match(/^\/claims\/(\d+)\/replications$/);
  if (claimReplicationsMatch) {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
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
          claimId: claimReplicationsMatch[1],
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

    json(
      response,
      200,
      await dependencies.readReplicationsByClaim(pool, claimReplicationsMatch[1]),
    );
    return true;
  }

  const claimReplicationJobsMatch = url.pathname.match(/^\/claims\/(\d+)\/replication-jobs$/);
  if (claimReplicationJobsMatch) {
    json(
      response,
      200,
      await dependencies.readClaimReplicationJobsPage(pool, claimReplicationJobsMatch[1], {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
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
  const claimForecastsMatch = url.pathname.match(/^\/claims\/(\d+)\/forecasts$/);
  if (claimForecastsMatch) {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "forecaster",
        "agentId",
        "revealed",
        "settled",
        "finalStatus",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readForecastsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: claimForecastsMatch[1],
          forecaster: url.searchParams.get("forecaster") ?? undefined,
          agentId: url.searchParams.get("agentId") ?? undefined,
          revealed: parseBooleanParam(url, "revealed"),
          settled: parseBooleanParam(url, "settled"),
          finalStatus: parseIntegerParam(url, "finalStatus"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readForecastsByClaim(pool, claimForecastsMatch[1]));
    return true;
  }

  const claimChallengesMatch = url.pathname.match(/^\/claims\/(\d+)\/challenges$/);
  if (claimChallengesMatch) {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "replicationId",
        "challenger",
        "agentId",
        "status",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readChallengesPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: claimChallengesMatch[1],
          replicationId: url.searchParams.get("replicationId") ?? undefined,
          challenger: url.searchParams.get("challenger") ?? undefined,
          agentId: url.searchParams.get("agentId") ?? undefined,
          status: parseIntegerParam(url, "status"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readChallengesByClaim(pool, claimChallengesMatch[1]));
    return true;
  }

  const claimAppealsMatch = url.pathname.match(/^\/claims\/(\d+)\/appeals$/);
  if (claimAppealsMatch) {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "replicationId",
        "challengeId",
        "appellant",
        "reason",
        "status",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readAppealsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: claimAppealsMatch[1],
          replicationId: url.searchParams.get("replicationId") ?? undefined,
          challengeId: url.searchParams.get("challengeId") ?? undefined,
          appellant: url.searchParams.get("appellant") ?? undefined,
          reason: parseIntegerParam(url, "reason"),
          status: parseIntegerParam(url, "status"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAppealsByClaim(pool, claimAppealsMatch[1]));
    return true;
  }
  if (url.pathname === "/forecasts") {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "claimId",
        "forecaster",
        "agentId",
        "revealed",
        "settled",
        "finalStatus",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readForecastsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: url.searchParams.get("claimId") ?? undefined,
          forecaster: url.searchParams.get("forecaster") ?? undefined,
          agentId: url.searchParams.get("agentId") ?? undefined,
          revealed: parseBooleanParam(url, "revealed"),
          settled: parseBooleanParam(url, "settled"),
          finalStatus: parseIntegerParam(url, "finalStatus"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAllForecasts(pool));
    return true;
  }

  if (url.pathname === "/challenges") {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "claimId",
        "replicationId",
        "challenger",
        "agentId",
        "status",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readChallengesPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: url.searchParams.get("claimId") ?? undefined,
          replicationId: url.searchParams.get("replicationId") ?? undefined,
          challenger: url.searchParams.get("challenger") ?? undefined,
          agentId: url.searchParams.get("agentId") ?? undefined,
          status: parseIntegerParam(url, "status"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAllChallenges(pool));
    return true;
  }

  if (url.pathname === "/appeals") {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "claimId",
        "replicationId",
        "challengeId",
        "appellant",
        "reason",
        "status",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readAppealsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: url.searchParams.get("claimId") ?? undefined,
          replicationId: url.searchParams.get("replicationId") ?? undefined,
          challengeId: url.searchParams.get("challengeId") ?? undefined,
          appellant: url.searchParams.get("appellant") ?? undefined,
          reason: parseIntegerParam(url, "reason"),
          status: parseIntegerParam(url, "status"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAllAppeals(pool));
    return true;
  }

  return false;
}
