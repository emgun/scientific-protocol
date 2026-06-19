import { json } from "../http.js";
import { hasAnySearchParam, parseIntegerParam } from "../params.js";
import type { RouteContext } from "./context.js";

export async function handleCheckpointRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, pool, response, url } = context;
  const domainLeaderboardMatch = url.pathname.match(/^\/domains\/(\d+)\/leaderboard$/);
  if (domainLeaderboardMatch) {
    const domainId = Number(domainLeaderboardMatch[1]);
    json(response, 200, {
      payload: await dependencies.readLatestReputationPayload(pool, domainId),
      leaderboard: await dependencies.readDomainLeaderboard(pool, domainId, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
      }),
    });
    return true;
  }

  const domainCheckpointPublicationsMatch = url.pathname.match(
    /^\/domains\/(\d+)\/checkpoint-publications$/,
  );
  if (domainCheckpointPublicationsMatch) {
    json(
      response,
      200,
      await dependencies.readCheckpointPublicationsPage(pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        domainId: Number(domainCheckpointPublicationsMatch[1]),
        payloadId: url.searchParams.get("payloadId") ?? undefined,
        status:
          (url.searchParams.get("status") as "failed" | "prepared" | "submitted" | null) ??
          undefined,
        subjectType: parseIntegerParam(url, "subjectType"),
        subjectActor: url.searchParams.get("subjectActor") ?? undefined,
        subjectAgentId: url.searchParams.get("subjectAgentId") ?? undefined,
      }),
    );
    return true;
  }
  const actorCheckpointMatch = url.pathname.match(/^\/actors\/(0x[a-fA-F0-9]{40})\/checkpoints$/);
  if (actorCheckpointMatch) {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "claimId",
        "domainId",
        "subjectType",
        "subjectAgentId",
        "subjectModule",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readCheckpointsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          subjectActor: actorCheckpointMatch[1],
          claimId: url.searchParams.get("claimId") ?? undefined,
          domainId: parseIntegerParam(url, "domainId"),
          subjectType: parseIntegerParam(url, "subjectType"),
          subjectAgentId: url.searchParams.get("subjectAgentId") ?? undefined,
          subjectModule: url.searchParams.get("subjectModule") ?? undefined,
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readCheckpointsByActor(pool, actorCheckpointMatch[1]));
    return true;
  }
  if (url.pathname === "/checkpoints") {
    if (
      hasAnySearchParam(url, [
        "limit",
        "offset",
        "claimId",
        "domainId",
        "subjectType",
        "subjectActor",
        "subjectAgentId",
        "subjectModule",
      ])
    ) {
      json(
        response,
        200,
        await dependencies.readCheckpointsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: url.searchParams.get("claimId") ?? undefined,
          domainId: parseIntegerParam(url, "domainId"),
          subjectType: parseIntegerParam(url, "subjectType"),
          subjectActor: url.searchParams.get("subjectActor") ?? undefined,
          subjectAgentId: url.searchParams.get("subjectAgentId") ?? undefined,
          subjectModule: url.searchParams.get("subjectModule") ?? undefined,
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAllCheckpoints(pool));
    return true;
  }

  if (url.pathname === "/checkpoint-publications") {
    json(
      response,
      200,
      await dependencies.readCheckpointPublicationsPage(pool, {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        domainId: parseIntegerParam(url, "domainId"),
        payloadId: url.searchParams.get("payloadId") ?? undefined,
        status:
          (url.searchParams.get("status") as "failed" | "prepared" | "submitted" | null) ??
          undefined,
        subjectType: parseIntegerParam(url, "subjectType"),
        subjectActor: url.searchParams.get("subjectActor") ?? undefined,
        subjectAgentId: url.searchParams.get("subjectAgentId") ?? undefined,
      }),
    );
    return true;
  }

  const checkpointPublicationMatch = url.pathname.match(/^\/checkpoint-publications\/(\d+)$/);
  if (checkpointPublicationMatch) {
    const publication = await dependencies.readCheckpointPublication(
      pool,
      checkpointPublicationMatch[1],
    );
    if (!publication) {
      json(response, 404, { error: "checkpoint_publication_not_found" });
      return true;
    }
    json(response, 200, {
      ...publication,
      operatorRequest: publication.requestId
        ? await dependencies.readOperatorRequest(pool, publication.requestId)
        : null,
    });
    return true;
  }

  return false;
}
