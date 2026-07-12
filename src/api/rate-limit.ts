import type http from "node:http";
import type { URL } from "node:url";
import type { Pool } from "pg";
import { parseIntegerValue, readBooleanEnv } from "../shared/cli.js";
import { getRpcUrl } from "../shared/contracts.js";
import { isLocalDevelopmentRpcUrl } from "../shared/env.js";
import { isSandboxAdminRoutesEnabled } from "./sandbox.js";

export type ApiRateLimitRule = {
  maxRequests: number;
  windowMs: number;
};

export type ApiRateLimitConfig = {
  adminActions: ApiRateLimitRule;
  agentSourceSubmission: ApiRateLimitRule;
  publicDemoActions: ApiRateLimitRule;
  sourceSubmission: ApiRateLimitRule;
  trustProxy: boolean;
};

export type PartialApiRateLimitConfig = {
  adminActions?: Partial<ApiRateLimitRule>;
  agentSourceSubmission?: Partial<ApiRateLimitRule>;
  publicDemoActions?: Partial<ApiRateLimitRule>;
  sourceSubmission?: Partial<ApiRateLimitRule>;
  trustProxy?: boolean;
};

export function defaultRateLimitConfig(env: NodeJS.ProcessEnv = process.env): ApiRateLimitConfig {
  const isRemoteRpc = !isLocalDevelopmentRpcUrl(getRpcUrl(env));
  const readRateLimitInteger = (key: string, fallback: number) =>
    env[key]?.trim() ? parseIntegerValue(env[key] ?? "", key, { min: 0 }) : fallback;
  return {
    trustProxy: readBooleanEnv(env, "SP_TRUST_PROXY", false),
    publicDemoActions: {
      windowMs: readRateLimitInteger("SP_PUBLIC_RATE_LIMIT_WINDOW_MS", 60_000),
      maxRequests: readRateLimitInteger("SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS", isRemoteRpc ? 20 : 0),
    },
    adminActions: {
      windowMs: readRateLimitInteger("SP_ADMIN_RATE_LIMIT_WINDOW_MS", 60_000),
      maxRequests: readRateLimitInteger("SP_ADMIN_RATE_LIMIT_MAX_REQUESTS", isRemoteRpc ? 10 : 0),
    },
    sourceSubmission: {
      windowMs: readRateLimitInteger("SP_SOURCE_RATE_LIMIT_WINDOW_MS", 60_000),
      maxRequests: readRateLimitInteger("SP_SOURCE_RATE_LIMIT_MAX_REQUESTS", isRemoteRpc ? 1 : 0),
    },
    agentSourceSubmission: {
      windowMs: readRateLimitInteger("SP_AGENT_SOURCE_RATE_LIMIT_WINDOW_MS", 60_000),
      maxRequests: readRateLimitInteger(
        "SP_AGENT_SOURCE_RATE_LIMIT_MAX_REQUESTS",
        isRemoteRpc ? 1 : 0,
      ),
    },
  };
}

export function resolveRateLimitConfig(
  override: PartialApiRateLimitConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ApiRateLimitConfig {
  const defaults = defaultRateLimitConfig(env);
  return {
    trustProxy: override?.trustProxy ?? defaults.trustProxy,
    publicDemoActions: {
      windowMs: override?.publicDemoActions?.windowMs ?? defaults.publicDemoActions.windowMs,
      maxRequests:
        override?.publicDemoActions?.maxRequests ?? defaults.publicDemoActions.maxRequests,
    },
    adminActions: {
      windowMs: override?.adminActions?.windowMs ?? defaults.adminActions.windowMs,
      maxRequests: override?.adminActions?.maxRequests ?? defaults.adminActions.maxRequests,
    },
    sourceSubmission: {
      windowMs: override?.sourceSubmission?.windowMs ?? defaults.sourceSubmission.windowMs,
      maxRequests: override?.sourceSubmission?.maxRequests ?? defaults.sourceSubmission.maxRequests,
    },
    agentSourceSubmission: {
      windowMs:
        override?.agentSourceSubmission?.windowMs ?? defaults.agentSourceSubmission.windowMs,
      maxRequests:
        override?.agentSourceSubmission?.maxRequests ?? defaults.agentSourceSubmission.maxRequests,
    },
  };
}

export type RateLimitScope = keyof Pick<
  ApiRateLimitConfig,
  "adminActions" | "agentSourceSubmission" | "publicDemoActions" | "sourceSubmission"
>;

export type RateLimitRecord = {
  count: number;
  resetAt: number;
};

export type RateLimitBackend = "memory" | "postgres";

export function resolveRateLimitBackend(env: NodeJS.ProcessEnv): RateLimitBackend {
  const configured = env.SP_RATE_LIMIT_BACKEND?.trim().toLowerCase();
  if (configured && configured !== "memory" && configured !== "postgres") {
    throw new Error("SP_RATE_LIMIT_BACKEND must be memory or postgres");
  }
  const remote = !isLocalDevelopmentRpcUrl(getRpcUrl(env));
  const backend = (configured ??
    (remote && env.NODE_ENV !== "test" ? "postgres" : "memory")) as RateLimitBackend;
  if (backend === "memory" && remote && env.NODE_ENV !== "test") {
    throw new Error("remote write services require SP_RATE_LIMIT_BACKEND=postgres");
  }
  return backend;
}

function setRateLimitHeaders(
  response: http.ServerResponse,
  rule: ApiRateLimitRule,
  count: number,
  resetAt: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  response.setHeader("x-ratelimit-limit", String(rule.maxRequests));
  response.setHeader("x-ratelimit-remaining", String(Math.max(0, rule.maxRequests - count)));
  response.setHeader("x-ratelimit-reset", String(Math.ceil(resetAt / 1000)));
  if (count > rule.maxRequests) response.setHeader("retry-after", String(retryAfterSeconds));
  return { allowed: count <= rule.maxRequests, retryAfterSeconds };
}

export async function consumeConfiguredRateLimit(input: {
  backend: RateLimitBackend;
  bucketKey: string;
  buckets: Map<string, RateLimitRecord>;
  pool: Pool;
  response: http.ServerResponse;
  rule: ApiRateLimitRule;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (input.rule.maxRequests <= 0 || input.rule.windowMs <= 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (input.backend === "memory") {
    return consumeRateLimit(
      input.response,
      input.buckets,
      "publicDemoActions",
      input.bucketKey,
      input.rule,
    );
  }
  try {
    await input.pool.query(`
      WITH expired AS (
        SELECT bucket_key FROM api_rate_limit_buckets
        WHERE reset_at <= NOW()
        ORDER BY reset_at ASC
        LIMIT 100
      )
      DELETE FROM api_rate_limit_buckets bucket
      USING expired
      WHERE bucket.bucket_key = expired.bucket_key
    `);
    const result = await input.pool.query<{ requestCount: number; resetAt: Date }>(
      `
        INSERT INTO api_rate_limit_buckets (bucket_key, request_count, reset_at)
        VALUES ($1, 1, NOW() + ($2::text || ' milliseconds')::interval)
        ON CONFLICT (bucket_key) DO UPDATE SET
          request_count = CASE
            WHEN api_rate_limit_buckets.reset_at <= NOW() THEN 1
            ELSE api_rate_limit_buckets.request_count + 1
          END,
          reset_at = CASE
            WHEN api_rate_limit_buckets.reset_at <= NOW()
              THEN NOW() + ($2::text || ' milliseconds')::interval
            ELSE api_rate_limit_buckets.reset_at
          END,
          updated_at = NOW()
        RETURNING request_count AS "requestCount", reset_at AS "resetAt"
      `,
      [input.bucketKey, input.rule.windowMs],
    );
    const row = result.rows[0];
    if (!row) throw new Error("rate limit bucket update returned no row");
    return setRateLimitHeaders(input.response, input.rule, row.requestCount, row.resetAt.getTime());
  } catch (error) {
    throw new Error("rate_limit_store_unavailable", { cause: error });
  }
}

export function demoRateLimitScope(
  url: URL,
  method: string | undefined,
  env: NodeJS.ProcessEnv,
): RateLimitScope | null {
  if (url.pathname === "/admin/sync" && method === "GET") {
    return "adminActions";
  }
  if (method !== "POST") {
    return null;
  }

  if (url.pathname === "/demo/admin/reseed-operational" && isSandboxAdminRoutesEnabled(env)) {
    return "adminActions";
  }

  if (
    /^\/replication-jobs\/\d+\/process$/.test(url.pathname) ||
    /^\/replication-jobs\/\d+\/resolve$/.test(url.pathname) ||
    /^\/domains\/\d+\/recompute$/.test(url.pathname)
  ) {
    return "adminActions";
  }

  if (
    url.pathname === "/claim-drafts/from-artifact" ||
    url.pathname === "/claims" ||
    /^\/claims\/\d+\/replication-jobs$/.test(url.pathname) ||
    url.pathname === "/demo/artifact-maintenance-tasks" ||
    url.pathname === "/demo/artifact-maintenance-tasks/enqueue-audits" ||
    url.pathname === "/demo/claim-drafts/from-artifact" ||
    url.pathname === "/demo/claims" ||
    url.pathname === "/demo/replication-jobs" ||
    /^\/demo\/replication-jobs\/\d+\/process$/.test(url.pathname) ||
    /^\/demo\/replication-jobs\/\d+\/resolve$/.test(url.pathname) ||
    /^\/demo\/domains\/\d+\/recompute$/.test(url.pathname)
  ) {
    return "publicDemoActions";
  }

  if (url.pathname === "/sources") {
    return "sourceSubmission";
  }

  if (url.pathname === "/agent/sources") {
    return "agentSourceSubmission";
  }

  return null;
}

export function requestClientKey(request: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const first = forwarded.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }
  }

  return request.socket.remoteAddress ?? "unknown";
}

export function consumeRateLimit(
  response: http.ServerResponse,
  buckets: Map<string, RateLimitRecord>,
  scope: RateLimitScope,
  clientKey: string,
  rule: ApiRateLimitRule,
): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  if (rule.maxRequests <= 0 || rule.windowMs <= 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const now = Date.now();
  if (buckets.size >= 256) {
    for (const [key, record] of buckets.entries()) {
      if (record.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }
  const bucketKey = `${scope}:${clientKey}`;
  const existing = buckets.get(bucketKey);
  const current =
    !existing || existing.resetAt <= now ? { count: 0, resetAt: now + rule.windowMs } : existing;

  current.count += 1;
  buckets.set(bucketKey, current);

  const remaining = Math.max(0, rule.maxRequests - current.count);
  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));

  response.setHeader("x-ratelimit-limit", String(rule.maxRequests));
  response.setHeader("x-ratelimit-remaining", String(remaining));
  response.setHeader("x-ratelimit-reset", String(Math.ceil(current.resetAt / 1000)));

  if (current.count > rule.maxRequests) {
    response.setHeader("retry-after", String(retryAfterSeconds));
    return {
      allowed: false,
      retryAfterSeconds,
    };
  }

  return {
    allowed: true,
    retryAfterSeconds,
  };
}

export function sourceDuplicateCooldownKey(
  scope: "agentSourceSubmission" | "sourceSubmission",
  canonicalSourceKey: string,
  actorAddress: string,
  agentId: string | null = null,
): string {
  const parts = [scope, canonicalSourceKey, actorAddress.toLowerCase()];
  if (agentId) {
    parts.push(agentId);
  }
  return parts.join(":");
}

export function consumeDuplicateCooldown(
  response: http.ServerResponse,
  buckets: Map<string, RateLimitRecord>,
  bucketKey: string,
  rule: ApiRateLimitRule,
): { allowed: boolean; retryAfterSeconds: number } {
  if (rule.maxRequests <= 0 || rule.windowMs <= 0) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const now = Date.now();
  if (buckets.size >= 256) {
    for (const [key, record] of buckets.entries()) {
      if (record.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  const existing = buckets.get(bucketKey);
  const current =
    !existing || existing.resetAt <= now ? { count: 0, resetAt: now + rule.windowMs } : existing;
  response.setHeader("x-ratelimit-limit", String(rule.maxRequests));
  response.setHeader(
    "x-ratelimit-remaining",
    String(Math.max(0, rule.maxRequests - current.count)),
  );
  response.setHeader("x-ratelimit-reset", String(Math.ceil(current.resetAt / 1000)));

  if (current.count >= rule.maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    response.setHeader("retry-after", String(retryAfterSeconds));
    return { allowed: false, retryAfterSeconds };
  }

  return {
    allowed: true,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export function recordDuplicateCooldown(
  buckets: Map<string, RateLimitRecord>,
  bucketKey: string,
  rule: ApiRateLimitRule,
): void {
  if (rule.maxRequests <= 0 || rule.windowMs <= 0) {
    return;
  }

  const now = Date.now();
  const existing = buckets.get(bucketKey);
  const current =
    !existing || existing.resetAt <= now ? { count: 0, resetAt: now + rule.windowMs } : existing;
  current.count += 1;
  buckets.set(bucketKey, current);
}
