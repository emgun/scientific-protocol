import type http from "node:http";
import type { URL } from "node:url";
import type { Pool } from "pg";
import type { ApiDependencies } from "../dependencies.js";
import type { ApiRateLimitConfig, RateLimitRecord } from "../rate-limit.js";
import type { ServiceMode } from "../../service/mode.js";

export type RouteContext = {
  databaseUrl: string;
  dependencies: ApiDependencies;
  deploymentPath: string;
  env: NodeJS.ProcessEnv;
  includeReadBody: boolean;
  isReadRequest: boolean;
  pool: Pool;
  readModelOptionalApi: boolean;
  rateLimitConfig: ApiRateLimitConfig;
  readModelPath: string;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  serviceMode: ServiceMode;
  sourceDuplicateCooldownBuckets: Map<string, RateLimitRecord>;
  url: URL;
};

export type RouteHandler = (context: RouteContext) => Promise<boolean>;
