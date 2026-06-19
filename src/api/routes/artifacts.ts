import { openPersistedArtifactReadStream } from "../../shared/persisted-artifacts.js";
import { json, streamBinary } from "../http.js";
import { hasAnySearchParam, parseIntegerParam } from "../params.js";
import { buildPersistedArtifactDetail } from "../read-payloads.js";
import type { RouteContext } from "./context.js";

export async function handleArtifactRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, pool, response, url } = context;
  if (url.pathname === "/artifacts") {
    if (hasAnySearchParam(url, ["limit", "offset", "claimId", "artifactType", "submitter"])) {
      json(
        response,
        200,
        await dependencies.readArtifactsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          claimId: url.searchParams.get("claimId") ?? undefined,
          artifactType: parseIntegerParam(url, "artifactType"),
          submitter: url.searchParams.get("submitter") ?? undefined,
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAllArtifacts(pool));
    return true;
  }

  const persistedArtifactMatch = url.pathname.match(/^\/persisted-artifacts\/([^/]+)$/);
  if (persistedArtifactMatch) {
    const detail = await buildPersistedArtifactDetail(
      pool,
      dependencies,
      decodeURIComponent(persistedArtifactMatch[1]),
    );
    if (!detail) {
      json(response, 404, { error: "persisted_artifact_not_found" });
      return true;
    }
    json(response, 200, detail);
    return true;
  }

  const persistedArtifactContentMatch = url.pathname.match(
    /^\/persisted-artifacts\/([^/]+)\/content$/,
  );
  if (persistedArtifactContentMatch) {
    const artifactKey = decodeURIComponent(persistedArtifactContentMatch[1]);
    const artifact = await dependencies.readPersistedArtifact(pool, artifactKey);
    if (!artifact) {
      json(response, 404, { error: "persisted_artifact_not_found" });
      return true;
    }
    const content = await openPersistedArtifactReadStream(artifact);
    await streamBinary(response, {
      contentLength: content.contentLength ?? artifact.byteLength,
      contentType: artifact.contentType,
      stream: content.stream,
    });
    return true;
  }

  const persistedArtifactAuditsMatch = url.pathname.match(
    /^\/persisted-artifacts\/([^/]+)\/audits$/,
  );
  if (persistedArtifactAuditsMatch) {
    const artifactKey = decodeURIComponent(persistedArtifactAuditsMatch[1]);
    const artifact = await dependencies.readPersistedArtifact(pool, artifactKey);
    if (!artifact) {
      json(response, 404, { error: "persisted_artifact_not_found" });
      return true;
    }
    json(
      response,
      200,
      await dependencies.readPersistedArtifactAuditsPage(pool, {
        artifactKey,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
      }),
    );
    return true;
  }

  const persistedArtifactMaintenanceTasksMatch = url.pathname.match(
    /^\/persisted-artifacts\/([^/]+)\/maintenance-tasks$/,
  );
  if (persistedArtifactMaintenanceTasksMatch) {
    const artifactKey = decodeURIComponent(persistedArtifactMaintenanceTasksMatch[1]);
    const artifact = await dependencies.readPersistedArtifact(pool, artifactKey);
    if (!artifact) {
      json(response, 404, { error: "persisted_artifact_not_found" });
      return true;
    }
    json(
      response,
      200,
      await dependencies.readPersistedArtifactMaintenanceTasksPage(pool, artifactKey, {
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

  return false;
}
