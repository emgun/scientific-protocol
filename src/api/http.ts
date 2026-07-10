import { readFile } from "node:fs/promises";
import type http from "node:http";
import { pipeline } from "node:stream/promises";
import type { URL } from "node:url";
import { readEnvValue } from "../shared/secrets.js";

export const MAX_JSON_BODY_BYTES = 1_048_576;

export function json(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.end();
    }
    return;
  }
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

export const PUBLIC_CORS_READ_PATHS = new Set(["/write-config"]);
export const PUBLIC_CORS_METHODS = new Set(["GET", "HEAD"]);

/// Prefixes whose routes never get open CORS: authenticated or operator
/// surfaces where cross-origin reads would be misleading rather than useful.
const OPEN_CORS_EXCLUDED_PREFIXES = ["/admin", "/agent", "/demo", "/operator"];

/// The indexed read surface is public, read-only, and cookie-less, so any
/// origin may read it. Write and operator surfaces keep their own rules.
export function isOpenCorsReadPath(pathname: string): boolean {
  return !OPEN_CORS_EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function configuredPublicCorsOrigins(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (readEnvValue(env, "SP_PUBLIC_CORS_ORIGINS") ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function requestOrigin(request: http.IncomingMessage): string | null {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin.trim() ? origin.trim() : null;
}

export function appendVaryOrigin(response: http.ServerResponse): void {
  const existing = response.getHeader("vary");
  const values =
    typeof existing === "string"
      ? existing.split(",").map((value) => value.trim().toLowerCase())
      : Array.isArray(existing)
        ? existing.flatMap((value) =>
            String(value)
              .split(",")
              .map((part) => part.trim().toLowerCase()),
          )
        : [];
  if (!values.includes("origin")) {
    response.setHeader("vary", existing ? `${existing}, Origin` : "Origin");
  }
}

export function applyPublicCorsHeaders(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  env: NodeJS.ProcessEnv,
): boolean {
  if (PUBLIC_CORS_READ_PATHS.has(url.pathname)) {
    const origin = requestOrigin(request);
    if (!origin) return false;
    const allowedOrigins = configuredPublicCorsOrigins(env);
    if (!allowedOrigins.has(origin)) return false;

    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
    response.setHeader("access-control-allow-headers", "accept, content-type");
    response.setHeader("access-control-max-age", "600");
    response.setHeader("cross-origin-resource-policy", "cross-origin");
    appendVaryOrigin(response);
    return true;
  }

  if (
    (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") &&
    isOpenCorsReadPath(url.pathname)
  ) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
    response.setHeader("access-control-allow-headers", "accept, content-type");
    response.setHeader("access-control-max-age", "600");
    response.setHeader("cross-origin-resource-policy", "cross-origin");
    return true;
  }

  return false;
}

export function handlePublicCorsPreflight(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  env: NodeJS.ProcessEnv,
): boolean {
  if (request.method !== "OPTIONS") return false;
  if (!PUBLIC_CORS_READ_PATHS.has(url.pathname) && !isOpenCorsReadPath(url.pathname)) return false;
  const requestedMethod = String(
    request.headers["access-control-request-method"] ?? "",
  ).toUpperCase();
  const allowed = applyPublicCorsHeaders(request, response, url, env);
  response.writeHead(allowed && PUBLIC_CORS_METHODS.has(requestedMethod) ? 204 : 403);
  response.end();
  return true;
}

export async function html(
  response: http.ServerResponse,
  statusCode: number,
  filePath: string,
  options: { body?: boolean } = {},
): Promise<void> {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.end();
    }
    return;
  }
  const body = options.body === false ? undefined : await readFile(filePath, "utf8");
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

export function htmlText(
  response: http.ServerResponse,
  statusCode: number,
  body: string,
  options: { body?: boolean } = {},
): void {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.end();
    }
    return;
  }
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(options.body === false ? undefined : body);
}

export function redirect(
  response: http.ServerResponse,
  statusCode: 301 | 302 | 307 | 308,
  location: string,
): void {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.end();
    }
    return;
  }
  response.writeHead(statusCode, { location });
  response.end();
}

export async function staticAsset(
  response: http.ServerResponse,
  contentType: string,
  filePath: string,
  options: { body?: boolean } = {},
): Promise<void> {
  if (response.headersSent) {
    if (!response.writableEnded) {
      response.end();
    }
    return;
  }
  const body = options.body === false ? undefined : await readFile(filePath, "utf8");
  response.writeHead(200, { "content-type": contentType });
  response.end(body);
}

export async function streamBinary(
  response: http.ServerResponse,
  options: {
    contentLength?: number | null;
    contentType: string;
    stream: NodeJS.ReadableStream;
  },
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": options.contentType,
  };
  if (typeof options.contentLength === "number" && Number.isFinite(options.contentLength)) {
    headers["content-length"] = String(options.contentLength);
  }
  response.writeHead(200, headers);
  await pipeline(options.stream, response);
}

export async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (typeof declaredLength === "string") {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new Error("invalid_content_length");
    }
    const parsedLength = Number(declaredLength);
    if (parsedLength > MAX_JSON_BODY_BYTES) {
      throw new Error("json_body_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_JSON_BODY_BYTES) {
      throw new Error("json_body_too_large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid_json_body");
  }
}

export type HttpRequestError = Error & {
  responseStatus: number;
};

export function createHttpRequestError(responseStatus: number, message: string): HttpRequestError {
  return Object.assign(new Error(message), { responseStatus });
}

export function isHttpRequestError(error: unknown): error is HttpRequestError {
  return (
    error instanceof Error &&
    "responseStatus" in error &&
    typeof (error as { responseStatus?: unknown }).responseStatus === "number"
  );
}

export function applySecurityHeaders(response: http.ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://arxiv.org https://*.arxiv.org; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}
