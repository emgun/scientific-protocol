import type http from "node:http";
import { readBooleanEnv } from "../shared/cli.js";
import { getRpcUrl } from "../shared/contracts.js";
import { isLocalDevelopmentRpcUrl } from "../shared/env.js";
import { readEnvValue } from "../shared/secrets.js";
import { json } from "./http.js";

export function readDemoAdminToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = readEnvValue(env, "SP_DEMO_ADMIN_TOKEN");
  return token ? token : null;
}

export function isSandboxAdminRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env, "SP_ENABLE_SANDBOX_ADMIN_ROUTES", false);
}

export function isSandboxAdminRouteDisabled(
  response: http.ServerResponse,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isSandboxAdminRoutesEnabled(env)) {
    return false;
  }

  json(response, 404, { error: "sandbox_admin_routes_disabled" });
  return true;
}

export function isDemoAdminAuthorized(
  request: http.IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuredToken = readDemoAdminToken(env);
  if (!configuredToken) {
    return isLocalDevelopmentRpcUrl(getRpcUrl(env));
  }

  const headerToken = request.headers["x-sp-demo-admin-token"];
  if (typeof headerToken === "string" && headerToken === configuredToken) {
    return true;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  return authHeader.slice("Bearer ".length) === configuredToken;
}
