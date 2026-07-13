import { randomUUID } from "node:crypto";
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
  consumeConfiguredRateLimit,
  requestClientKey,
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
    rateLimitBackend,
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
      allowRecordedReplayActionTypes: ["source_submit"],
      chainId: writeConfig.chainId,
    });
    const requestLeaseRequired = authenticated.envelope.actionType === "source_submit";
    const recordedRequest = authenticated.recordedReplay
      ? await dependencies.readPublicWriteRequestByHash(pool, authenticated.requestHash)
      : undefined;
    const leaseOwner = randomUUID();
    const leaseMs = 5 * 60 * 1000;
    let heartbeat: NodeJS.Timeout | null = null;
    let heartbeatError: Error | null = null;
    let heartbeatRunning = false;
    let acceptedReplay = false;
    const renewLease = async () => {
      if (!requestLeaseRequired) return;
      if (heartbeatError) throw heartbeatError;
      const renewed = await dependencies.renewPublicWriteRequestExecution(pool, {
        leaseMs,
        leaseOwner,
        requestId: authenticated.acceptedRequestId,
      });
      if (!renewed) {
        heartbeatError = new Error("public_write_request_execution_lease_lost");
        throw heartbeatError;
      }
    };
    if (requestLeaseRequired) {
      const leaseAcquired = await dependencies.reservePublicWriteRequestExecution(pool, {
        leaseMs,
        leaseOwner,
        requestId: authenticated.acceptedRequestId,
      });
      if (!leaseAcquired) throw new Error("public_write_request_in_progress");
      heartbeat = setInterval(() => {
        if (heartbeatRunning || heartbeatError) return;
        heartbeatRunning = true;
        renewLease()
          .catch((error) => {
            heartbeatError = error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            heartbeatRunning = false;
          });
      }, 30_000);
      heartbeat.unref();
    }
    try {
      const payload = authenticated.envelope.payload;
      const draftInput = parseArtifactDraftPayload(payload);
      if (url.pathname === "/sources") {
        const canonical = canonicalizeSourceDraft(draftInput);
        const recordedSourceId = recordedRequest?.outcomeDetail?.match(/^source:(\d+)$/u)?.[1];
        const recordedSource = recordedSourceId
          ? await dependencies.readSourceRecord(pool, recordedSourceId)
          : undefined;
        acceptedReplay =
          authenticated.recordedReplay &&
          recordedRequest?.status === "accepted" &&
          recordedSource?.canonicalSourceKey === canonical.canonicalSourceKey;
        if (!acceptedReplay) {
          for (const [dimension, bucketKey] of [
            [
              "client",
              `sourceSubmission:client:${requestClientKey(request, rateLimitConfig.trustProxy)}`,
            ],
            [
              "actor",
              `sourceSubmission:actor:${authenticated.envelope.actorAddress.toLowerCase()}`,
            ],
          ] as const) {
            const globalThrottle = await consumeConfiguredRateLimit({
              backend: rateLimitBackend,
              bucketKey,
              buckets: sourceDuplicateCooldownBuckets,
              pool,
              response,
              rule: rateLimitConfig.sourceSubmission,
            });
            if (!globalThrottle.allowed) {
              await dependencies.markPublicWriteRequestRejected(
                pool,
                authenticated.acceptedRequestId,
                `rate_limited:sourceSubmission:${dimension}`,
              );
              json(response, 429, {
                error: "rate_limited",
                retryAfterSeconds: globalThrottle.retryAfterSeconds,
                scope: "sourceSubmission",
              });
              return true;
            }
          }
        }
        const duplicateCooldownBucketKey = sourceDuplicateCooldownKey(
          "sourceSubmission",
          canonical.canonicalSourceKey,
          authenticated.envelope.actorAddress,
        );
        const throttle = acceptedReplay
          ? { allowed: true, retryAfterSeconds: 0 }
          : await consumeConfiguredRateLimit({
              backend: rateLimitBackend,
              bucketKey: duplicateCooldownBucketKey,
              buckets: sourceDuplicateCooldownBuckets,
              pool,
              response,
              rule: rateLimitConfig.sourceSubmission,
            });
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
      await renewLease();
      const result = await dependencies.createProductionArtifactDraft(
        draftInput,
        authenticated.envelope.actorAddress,
        pool,
        {
          requestHash:
            authenticated.envelope.actionType === "source_submit"
              ? authenticated.requestHash
              : null,
        },
      );
      await renewLease();
      if (!acceptedReplay) {
        await dependencies.markPublicWriteRequestAccepted(
          pool,
          authenticated.acceptedRequestId,
          `source:${result.source.sourceId}`,
        );
      }
      json(response, 200, {
        ok: true,
        requestId: authenticated.acceptedRequestId,
        result,
      });
    } catch (error) {
      const canUpdateRequest = requestLeaseRequired
        ? await dependencies
            .assertPublicWriteRequestExecution(pool, {
              leaseOwner,
              requestId: authenticated.acceptedRequestId,
            })
            .then(() => true)
            .catch(() => false)
        : true;
      if (canUpdateRequest) {
        await dependencies.markPublicWriteRequestRejected(
          pool,
          authenticated.acceptedRequestId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (requestLeaseRequired) {
        await dependencies.releasePublicWriteRequestExecution(pool, {
          leaseOwner,
          requestId: authenticated.acceptedRequestId,
        });
      }
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
