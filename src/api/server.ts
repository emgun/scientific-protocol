import http from "node:http";
import { URL } from "node:url";
import type { Pool } from "pg";
import { SandboxDemoResetInProgressError } from "../demo/reset.js";
import { getReadModelPath } from "../indexer/projector.js";
import {
  createReadModelPool,
  getDatabaseUrl,
  migrateReadModelDb,
  ReadModelSyncInProgressError,
} from "../indexer/store.js";
import { resolveServiceMode, type ServiceMode, serviceWritesEnabled } from "../service/mode.js";
import { isMainModule, readBooleanEnv, readPositiveIntegerEnv } from "../shared/cli.js";
import { getRpcUrl } from "../shared/contracts.js";
import { getDeploymentPath } from "../shared/deployment.js";
import {
  type ApiDependencies,
  createUnavailableReadModelPool,
  defaultDependencies,
  isReadModelOptionalApi,
  ReadModelUnavailableError,
  readCurrentChainHeadBlock,
} from "./dependencies.js";
import {
  applyPublicCorsHeaders,
  applySecurityHeaders,
  handlePublicCorsPreflight,
  json,
  MAX_JSON_BODY_BYTES,
} from "./http.js";
import {
  consumeConfiguredRateLimit,
  demoRateLimitScope,
  type PartialApiRateLimitConfig,
  type RateLimitRecord,
  requestClientKey,
  resolveRateLimitBackend,
  resolveRateLimitConfig,
} from "./rate-limit.js";
import { handleAgentActionRoutes, handleAgentReadRoutes } from "./routes/agents.js";
import { handleArtifactRoutes } from "./routes/artifacts.js";
import { handleCheckpointRoutes } from "./routes/checkpoints.js";
import { handleClaimReadRoutes, handleClaimWriteRoutes } from "./routes/claims.js";
import type { RouteContext, RouteHandler } from "./routes/context.js";
import { handleSandboxDemoRoutes } from "./routes/demo.js";
import { handleGovernanceRoutes } from "./routes/governance.js";
import { handlePageRoutes } from "./routes/pages.js";
import { handleRewardRoutes } from "./routes/rewards.js";
import { handleSourceReadRoutes, handleSourceWriteRoutes } from "./routes/sources.js";
import { handleOperatorRequestRoutes, handleSystemRoutes } from "./routes/system.js";
import { handleWorkLifecycleRoutes, handleWorkReadRoutes } from "./routes/work.js";
import { assertPublicServiceCredentialBoundary } from "./runtime-security.js";

export type { ApiDependencies } from "./dependencies.js";
export type {
  ApiRateLimitConfig,
  ApiRateLimitRule,
  PartialApiRateLimitConfig,
} from "./rate-limit.js";

const API_REQUEST_TIMEOUT_MS = 30_000;
const API_HEADERS_TIMEOUT_MS = 10_000;
const API_KEEP_ALIVE_TIMEOUT_MS = 5_000;

export type ApiServerOptions = {
  databaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  deploymentPath?: string;
  pool?: Pool;
  rateLimitConfig?: PartialApiRateLimitConfig;
  readModelPath?: string;
  runMigrations?: boolean;
  serviceMode?: ServiceMode;
  dependencies?: Partial<ApiDependencies>;
};

export type ApiServerInstance = {
  close: () => Promise<void>;
  server: http.Server;
};

// Ordered route table. Write handlers (signed/authenticated POST surfaces) are
// dispatched before the read handlers that match the same paths without a
// method guard, mirroring the original single-function branch order.
const routeHandlers: RouteHandler[] = [
  handlePageRoutes,
  handleSystemRoutes,
  handleGovernanceRoutes,
  handleRewardRoutes,
  handleClaimWriteRoutes,
  handleSourceWriteRoutes,
  handleWorkLifecycleRoutes,
  handleSandboxDemoRoutes,
  handleAgentActionRoutes,
  handleSourceReadRoutes,
  handleClaimReadRoutes,
  handleCheckpointRoutes,
  handleWorkReadRoutes,
  handleArtifactRoutes,
  handleAgentReadRoutes,
  handleOperatorRequestRoutes,
];

export async function createApiServer(options: ApiServerOptions = {}): Promise<ApiServerInstance> {
  const env = options.env ?? process.env;
  assertPublicServiceCredentialBoundary(env);
  const readModelOptionalApi = isReadModelOptionalApi(env);
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl(env);
  const deploymentPath = options.deploymentPath ?? getDeploymentPath(env);
  const readModelPath = options.readModelPath ?? getReadModelPath(env);
  const pool =
    options.pool ??
    (readModelOptionalApi
      ? createUnavailableReadModelPool()
      : createReadModelPool(databaseUrl, env));
  const ownsPool = !options.pool;
  const dependencies = {
    ...defaultDependencies,
    getChainHeadBlock: async () => readCurrentChainHeadBlock(getRpcUrl(env)),
    ...options.dependencies,
  };
  const rateLimitConfig = resolveRateLimitConfig(options.rateLimitConfig, env);
  const rateLimitBackend = options.dependencies
    ? resolveRateLimitBackend({ ...env, NODE_ENV: "test", SP_RATE_LIMIT_BACKEND: "memory" })
    : resolveRateLimitBackend(env);
  const serviceMode = options.serviceMode ?? resolveServiceMode(env);
  const rateLimitBuckets = new Map<string, RateLimitRecord>();
  const sourceDuplicateCooldownBuckets = new Map<string, RateLimitRecord>();

  if (!readModelOptionalApi && (options.runMigrations ?? ownsPool)) {
    await migrateReadModelDb(pool);
  }

  const server = http.createServer(async (request, response) => {
    try {
      applySecurityHeaders(response);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (handlePublicCorsPreflight(request, response, url, env)) {
        return;
      }
      applyPublicCorsHeaders(request, response, url, env);
      const isReadRequest = request.method === "GET" || request.method === "HEAD";
      const includeReadBody = request.method !== "HEAD";
      const readOnlyMutation =
        !serviceWritesEnabled(serviceMode) &&
        ((!isReadRequest && request.method !== "OPTIONS") || url.pathname === "/admin/sync");
      if (readOnlyMutation) {
        response.setHeader("Allow", "GET, HEAD, OPTIONS");
        json(response, 405, { error: "service_read_only", serviceMode });
        return;
      }
      const rateLimitScope = demoRateLimitScope(url, request.method, env);
      if (
        rateLimitScope &&
        rateLimitScope !== "sourceSubmission" &&
        rateLimitScope !== "agentSourceSubmission"
      ) {
        const result = await consumeConfiguredRateLimit({
          backend: rateLimitBackend,
          bucketKey: `${rateLimitScope}:${requestClientKey(request, rateLimitConfig.trustProxy)}`,
          buckets: rateLimitBuckets,
          pool,
          response,
          rule: rateLimitConfig[rateLimitScope],
        });
        if (!result.allowed) {
          json(response, 429, {
            error: "rate_limited",
            retryAfterSeconds: result.retryAfterSeconds,
            scope: rateLimitScope,
          });
          return;
        }
      }

      const context: RouteContext = {
        databaseUrl,
        dependencies,
        deploymentPath,
        env,
        includeReadBody,
        isReadRequest,
        pool,
        readModelOptionalApi,
        rateLimitConfig,
        rateLimitBackend,
        readModelPath,
        request,
        response,
        serviceMode,
        sourceDuplicateCooldownBuckets,
        url,
      };
      for (const routeHandler of routeHandlers) {
        if (await routeHandler(context)) {
          return;
        }
      }

      json(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }

      if (error instanceof Error && error.message.startsWith("invalid_integer:")) {
        json(response, 400, {
          error: "invalid_query_parameter",
          parameter: error.message.split(":")[1],
          expected: "integer",
        });
        return;
      }

      if (error instanceof Error && error.message.startsWith("invalid_boolean:")) {
        json(response, 400, {
          error: "invalid_query_parameter",
          parameter: error.message.split(":")[1],
          expected: "boolean",
        });
        return;
      }

      if (error instanceof Error && error.message.startsWith("invalid_timestamp:")) {
        json(response, 400, {
          error: "invalid_query_parameter",
          parameter: error.message.split(":")[1],
          expected: "iso8601 timestamp",
        });
        return;
      }

      if (error instanceof Error && error.message.startsWith("invalid_view:")) {
        json(response, 400, {
          error: "invalid_query_parameter",
          parameter: error.message.split(":")[1],
          expected: "full|summary",
        });
        return;
      }

      if (
        error instanceof Error &&
        (error.message === "invalid_content_length" || error.message === "invalid_json_body")
      ) {
        json(response, 400, {
          error: error.message,
        });
        return;
      }

      if (error instanceof Error && error.message === "json_body_too_large") {
        json(response, 413, {
          error: "json_body_too_large",
          maxBytes: MAX_JSON_BODY_BYTES,
        });
        return;
      }

      if (error instanceof Error && error.message === "source_ingestion_in_progress") {
        json(response, 409, { error: "source_ingestion_in_progress" });
        return;
      }

      if (error instanceof Error && error.message === "public_write_request_in_progress") {
        json(response, 409, { error: "public_write_request_in_progress" });
        return;
      }

      if (error instanceof Error && error.message === "rate_limit_store_unavailable") {
        json(response, 503, { error: "rate_limit_store_unavailable" });
        return;
      }

      if (
        error instanceof Error &&
        (error.message === "claim_author_bond_unsatisfied" || error.message === "claim_not_draft")
      ) {
        json(response, 409, { error: error.message });
        return;
      }

      if (
        error instanceof Error &&
        (error.message === "invalid_public_write_request_envelope" ||
          error.message === "invalid_public_write_request_signature" ||
          error.message === "invalid_public_write_issued_at" ||
          error.message === "public_write_request_duplicate" ||
          error.message === "public_write_chain_mismatch" ||
          error.message === "public_write_action_mismatch" ||
          error.message === "public_write_scope_mismatch" ||
          error.message === "claim_author_unauthorized" ||
          error.message === "source_publication_actor_unauthorized")
      ) {
        const status =
          error.message === "public_write_request_duplicate"
            ? 409
            : error.message === "claim_author_unauthorized" ||
                error.message === "source_publication_actor_unauthorized"
              ? 403
              : error.message === "public_write_action_mismatch" ||
                  error.message === "public_write_chain_mismatch" ||
                  error.message === "public_write_scope_mismatch"
                ? 401
                : 400;
        json(response, status, { error: error.message });
        return;
      }

      if (
        error instanceof Error &&
        (error.message === "invalid_agent_request_envelope" ||
          error.message === "invalid_agent_request_signature" ||
          error.message === "invalid_agent_request_issued_at" ||
          error.message === "invalid_agent_audit_status" ||
          error.message === "invalid_agent_webhook_event_types" ||
          error.message === "invalid_agent_webhook_label" ||
          error.message === "invalid_agent_webhook_signing_secret" ||
          error.message === "invalid_agent_webhook_target_url" ||
          error.message === "invalid_agent_repair_replica" ||
          error.message === "invalid_agent_result_artifact" ||
          error.message === "agent_result_artifact_hash_mismatch" ||
          error.message === "invalid_review_issue_severity" ||
          error.message === "invalid_review_issue_status" ||
          error.message === "invalid_review_submission_verdict")
      ) {
        json(response, 400, { error: error.message });
        return;
      }

      if (
        error instanceof Error &&
        (error.message === "agent_request_expired" ||
          error.message === "public_write_request_expired" ||
          error.message === "agent_request_action_mismatch" ||
          error.message === "agent_request_scope_mismatch")
      ) {
        json(response, 401, { error: error.message });
        return;
      }

      if (error instanceof Error && error.message === "agent_actor_unauthorized") {
        json(response, 403, { error: error.message });
        return;
      }

      if (error instanceof Error && error.message === "agent_not_found") {
        json(response, 404, { error: error.message });
        return;
      }

      if (
        error instanceof Error &&
        (error.message === "claim_not_found" || error.message === "source_not_found")
      ) {
        json(response, 404, { error: error.message });
        return;
      }

      if (
        error instanceof Error &&
        (error.message === "review_task_run_not_found" ||
          error.message === "review_task_run_not_running" ||
          error.message === "review_task_run_agent_mismatch" ||
          error.message === "review_task_agent_already_submitted")
      ) {
        json(response, 409, { error: error.message });
        return;
      }

      if (error instanceof Error && error.message === "review_task_not_found") {
        json(response, 404, { error: error.message });
        return;
      }

      if (error instanceof ReadModelSyncInProgressError) {
        json(response, 409, { error: "sync_in_progress" });
        return;
      }

      if (error instanceof SandboxDemoResetInProgressError) {
        json(response, 409, { error: "sandbox_demo_reset_in_progress" });
        return;
      }

      if (error instanceof ReadModelUnavailableError) {
        json(response, 503, {
          error: "read_model_unavailable",
          message: error.message,
        });
        return;
      }

      if ((error as { code?: string } | undefined)?.code === "23505") {
        json(response, 409, { error: "duplicate_request" });
        return;
      }

      json(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.requestTimeout = API_REQUEST_TIMEOUT_MS;
  server.headersTimeout = API_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = API_KEEP_ALIVE_TIMEOUT_MS;

  return {
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

export async function startApiServerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const port = readPositiveIntegerEnv(env, "PORT", 3000);
  const instance = await createApiServer({
    env,
    runMigrations: readBooleanEnv(env, "SP_RUN_MIGRATIONS", false),
  });
  const { server } = instance;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      console.log(`Scientific API listening on http://127.0.0.1:${port}`);
    });
    const shutdown = () => {
      void instance.close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

if (isMainModule(import.meta.url)) {
  await startApiServerFromEnv();
}
