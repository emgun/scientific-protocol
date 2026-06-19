import {
  assertAuthorizedSourcePublicationActor,
  authenticateSignedPublicWriteRequest,
} from "../auth.js";
import { json } from "../http.js";
import {
  canonicalizeSourceDraft,
  parseArtifactDraftPayload,
  parseBooleanParam,
  parseIntegerParam,
} from "../params.js";
import {
  consumeDuplicateCooldown,
  recordDuplicateCooldown,
  sourceDuplicateCooldownKey,
} from "../rate-limit.js";
import {
  buildSourceEventsPayload,
  buildSourceFeedPayload,
  buildSourcePublicationDecisionsPayload,
  buildSourceWorkGraphPayload,
  buildWriteProtocolConfigPayload,
  readAllPages,
} from "../read-payloads.js";
import type { RouteContext } from "./context.js";

export async function handleSourceWriteRoutes(context: RouteContext): Promise<boolean> {
  const {
    databaseUrl,
    dependencies,
    deploymentPath,
    env,
    pool,
    rateLimitConfig,
    readModelPath,
    request,
    response,
    sourceDuplicateCooldownBuckets,
    url,
  } = context;
  if (
    (url.pathname === "/claim-drafts/from-artifact" || url.pathname === "/sources") &&
    request.method === "POST"
  ) {
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    const authenticated = await authenticateSignedPublicWriteRequest(dependencies, pool, request, {
      actionType:
        url.pathname === "/sources"
          ? ["source_submit", "claim_draft_from_artifact"]
          : "claim_draft_from_artifact",
      chainId: writeConfig.chainId,
    });
    try {
      const payload = authenticated.envelope.payload;
      const draftInput = parseArtifactDraftPayload(payload);
      if (url.pathname === "/sources") {
        const canonical = canonicalizeSourceDraft(draftInput);
        const duplicateCooldownBucketKey = sourceDuplicateCooldownKey(
          "sourceSubmission",
          canonical.canonicalSourceKey,
          authenticated.envelope.actorAddress,
        );
        const throttle = consumeDuplicateCooldown(
          response,
          sourceDuplicateCooldownBuckets,
          duplicateCooldownBucketKey,
          rateLimitConfig.sourceSubmission,
        );
        if (!throttle.allowed) {
          await dependencies.markPublicWriteRequestRejected(
            pool,
            authenticated.acceptedRequestId,
            "rate_limited:sourceSubmission",
          );
          json(response, 429, {
            error: "rate_limited",
            retryAfterSeconds: throttle.retryAfterSeconds,
            scope: "sourceSubmission",
          });
          return true;
        }
      }
      const result = await dependencies.createProductionArtifactDraft(
        draftInput,
        authenticated.envelope.actorAddress,
        pool,
      );
      if (url.pathname === "/sources" && result.submissionOutcome === "duplicate") {
        const canonical = canonicalizeSourceDraft(draftInput);
        recordDuplicateCooldown(
          sourceDuplicateCooldownBuckets,
          sourceDuplicateCooldownKey(
            "sourceSubmission",
            canonical.canonicalSourceKey,
            authenticated.envelope.actorAddress,
          ),
          rateLimitConfig.sourceSubmission,
        );
      }
      await dependencies.markPublicWriteRequestAccepted(
        pool,
        authenticated.acceptedRequestId,
        `source:${result.source.sourceId}`,
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

  const sourceConfirmMatch = url.pathname.match(/^\/sources\/(\d+)\/confirm$/);
  if (sourceConfirmMatch && request.method === "POST") {
    const sourceId = sourceConfirmMatch[1];
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    const authenticated = await authenticateSignedPublicWriteRequest(dependencies, pool, request, {
      actionType: "source_publication_confirm",
      chainId: writeConfig.chainId,
      scopeKeyValidator: (scopeKey, envelope) =>
        scopeKey === `source:${sourceId}:confirm` &&
        String(envelope.payload.sourceId ?? "") === sourceId,
    });
    try {
      const payload = authenticated.envelope.payload;
      const source = await dependencies.readSourceRecord(pool, sourceId);
      if (!source) {
        throw new Error("source_not_found");
      }
      await assertAuthorizedSourcePublicationActor(
        deploymentPath,
        source,
        authenticated.envelope.actorAddress,
        env,
      );
      const result = await dependencies.confirmSourcePublication(
        pool,
        {
          actorAddress: authenticated.envelope.actorAddress,
          candidateId: String(payload.candidateId ?? ""),
          sourceId,
        },
        env,
      );
      await dependencies.markPublicWriteRequestAccepted(
        pool,
        authenticated.acceptedRequestId,
        `claim:${result.publishedClaimId}`,
      );
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
      await dependencies.markPublicWriteRequestRejected(
        pool,
        authenticated.acceptedRequestId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return true;
  }

  const sourceRejectMatch = url.pathname.match(/^\/sources\/(\d+)\/reject$/);
  if (sourceRejectMatch && request.method === "POST") {
    const sourceId = sourceRejectMatch[1];
    const writeConfig = await buildWriteProtocolConfigPayload(deploymentPath, env);
    const authenticated = await authenticateSignedPublicWriteRequest(dependencies, pool, request, {
      actionType: "source_publication_reject",
      chainId: writeConfig.chainId,
      scopeKeyValidator: (scopeKey, envelope) =>
        scopeKey === `source:${sourceId}:reject` &&
        String(envelope.payload.sourceId ?? "") === sourceId,
    });
    try {
      const payload = authenticated.envelope.payload;
      const source = await dependencies.readSourceRecord(pool, sourceId);
      if (!source) {
        throw new Error("source_not_found");
      }
      await assertAuthorizedSourcePublicationActor(
        deploymentPath,
        source,
        authenticated.envelope.actorAddress,
        env,
      );
      const result = await dependencies.rejectSourcePublication(
        pool,
        {
          actorAddress: authenticated.envelope.actorAddress,
          reason: String(payload.reason ?? ""),
          sourceId,
        },
        env,
      );
      await dependencies.markPublicWriteRequestAccepted(
        pool,
        authenticated.acceptedRequestId,
        `source:${sourceId}:rejected`,
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

export async function handleSourceReadRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, pool, response, url } = context;
  if (url.pathname === "/sources") {
    json(
      response,
      200,
      await dependencies.readSourcesPage(pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        status:
          (url.searchParams.get("status") as
            | "discovered"
            | "snapshotted"
            | "extracting"
            | "ready_for_publication"
            | "published"
            | "rejected"
            | null) ?? undefined,
      }),
    );
    return true;
  }

  if (url.pathname === "/feeds/sources") {
    json(
      response,
      200,
      await buildSourceFeedPayload(dependencies, pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        status:
          (url.searchParams.get("status") as
            | "discovered"
            | "snapshotted"
            | "extracting"
            | "ready_for_publication"
            | "published"
            | "rejected"
            | null) ?? undefined,
      }),
    );
    return true;
  }
  if (url.pathname === "/events/sources") {
    json(
      response,
      200,
      await buildSourceEventsPayload(dependencies, pool, {
        eventType:
          (url.searchParams.get("eventType") as
            | "source.discovered"
            | "source.extracting_started"
            | "source.published"
            | "source.ready_for_publication"
            | "source.rejected"
            | "source.snapshotted"
            | null) ?? undefined,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        sourceId: url.searchParams.get("sourceId") ?? undefined,
      }),
    );
    return true;
  }
  const sourceMatch = url.pathname.match(/^\/sources\/(\d+)$/);
  if (sourceMatch) {
    const sourceId = sourceMatch[1];
    const source = await dependencies.readSourceRecord(pool, sourceId);
    if (!source) {
      json(response, 404, { error: "source_not_found" });
      return true;
    }
    const [candidates, publicationDecisions, recentSubmissions, tasks, workGraph] =
      await Promise.all([
        dependencies.readSourceExtractionCandidates(pool, sourceId),
        buildSourcePublicationDecisionsPayload(dependencies, pool, sourceId, {
          limit: 10,
          offset: 0,
        }),
        dependencies.readSourceSubmissionRecordsPage(pool, {
          limit: 10,
          offset: 0,
          sourceId,
        }),
        readAllPages((offset, limit) =>
          dependencies.readReviewTasksPage(pool, {
            sourceId,
            limit,
            offset,
          }),
        ).then((items) => ({
          items,
        })),
        buildSourceWorkGraphPayload(dependencies, pool, sourceId, { source }),
      ]);
    json(response, 200, {
      candidates,
      publicationDecisions,
      recentSubmissions,
      source,
      tasks: tasks.items,
      workGraph,
    });
    return true;
  }

  const sourceDecisionsMatch = url.pathname.match(/^\/sources\/(\d+)\/publication-decisions$/);
  if (sourceDecisionsMatch) {
    const source = await dependencies.readSourceRecord(pool, sourceDecisionsMatch[1]);
    if (!source) {
      json(response, 404, { error: "source_not_found" });
      return true;
    }
    json(
      response,
      200,
      await buildSourcePublicationDecisionsPayload(dependencies, pool, sourceDecisionsMatch[1], {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        shouldPublish: parseBooleanParam(url, "shouldPublish"),
      }),
    );
    return true;
  }

  const sourceWorkGraphMatch = url.pathname.match(/^\/sources\/(\d+)\/work-graph$/);
  if (sourceWorkGraphMatch) {
    const source = await dependencies.readSourceRecord(pool, sourceWorkGraphMatch[1]);
    if (!source) {
      json(response, 404, { error: "source_not_found" });
      return true;
    }
    json(
      response,
      200,
      await buildSourceWorkGraphPayload(dependencies, pool, sourceWorkGraphMatch[1], {
        source,
      }),
    );
    return true;
  }

  return false;
}
