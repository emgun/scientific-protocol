import { lookup as dnsLookupCallback } from "node:dns";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { Agent, type Dispatcher } from "undici";

const dnsLookup = promisify(dnsLookupCallback);

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000;
export const DEFAULT_OUTBOUND_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_OUTBOUND_MAX_REDIRECTS = 3;

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data.ec2.internal",
]);

export function isBlockedOutboundHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[|\]$/gu, "");
  return (
    !hostname ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (isIP(hostname) !== 0 && isPrivateOrSpecialAddress(hostname))
  );
}

export class UnsafeOutboundDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundDestinationError";
  }
}

export class OutboundResponseLimitError extends Error {
  constructor(maxBytes: number) {
    super(`outbound response exceeded ${maxBytes} bytes`);
    this.name = "OutboundResponseLimitError";
  }
}

type LookupResult = { address: string; family: number };

type PinnedLookupCallback = (
  error: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[|\]$/gu, "");
}

export type OutboundRequestPolicy = {
  allowPrivateNetworks?: boolean;
  dnsLookup?: (hostname: string) => Promise<LookupResult[]>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxRedirects?: number;
  method?: string;
  timeoutMs?: number;
};

export type BoundedOutboundResponse = {
  body: Buffer;
  finalUrl: string;
  headers: Headers;
  status: number;
};

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part < 256)
    ? parts
    : null;
}

export function isPrivateOrSpecialAddress(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().split("%")[0] ?? rawAddress.toLowerCase();
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const ipv4 = parseIpv4(mapped ?? address);
  if (ipv4) {
    const [a = 0, b = 0] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) !== 6) {
    return true;
  }
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/u.test(address) ||
    address.startsWith("ff")
  );
}

async function defaultLookup(hostname: string): Promise<LookupResult[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family }));
}

function parseSafeOutboundUrl(
  rawUrl: string,
  policy: Pick<OutboundRequestPolicy, "allowPrivateNetworks" | "dnsLookup"> = {},
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundDestinationError("outbound destination must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeOutboundDestinationError("outbound destination must use http or https");
  }
  if (url.username || url.password) {
    throw new UnsafeOutboundDestinationError("outbound destination must not contain credentials");
  }
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedOutboundHostname(hostname) && !(policy.allowPrivateNetworks && isIP(hostname))) {
    throw new UnsafeOutboundDestinationError("outbound destination host is blocked");
  }
  if (policy.allowPrivateNetworks) {
    return url;
  }
  if (isIP(hostname)) {
    return url;
  }
  return url;
}

export async function assertSafeOutboundUrl(
  rawUrl: string,
  policy: Pick<OutboundRequestPolicy, "allowPrivateNetworks" | "dnsLookup"> = {},
): Promise<URL> {
  const url = parseSafeOutboundUrl(rawUrl, policy);
  const hostname = normalizeHostname(url.hostname);
  if (policy.allowPrivateNetworks || isIP(hostname)) return url;
  const results = await (policy.dnsLookup ?? defaultLookup)(hostname);
  if (results.length === 0 || results.some((result) => isPrivateOrSpecialAddress(result.address))) {
    throw new UnsafeOutboundDestinationError(
      "outbound destination resolves to a private or special address",
    );
  }
  return url;
}

export function createPinnedLookup(
  expectedHostname: string,
  addresses: LookupResult[],
): (hostname: string, options: { all?: boolean }, callback: PinnedLookupCallback) => void {
  const normalizedExpected = normalizeHostname(expectedHostname);
  const pinned = addresses.map((result) => ({ ...result }));
  return (hostname, options, callback) => {
    const normalizedActual = normalizeHostname(hostname);
    if (normalizedActual !== normalizedExpected || pinned.length === 0) {
      callback(
        new UnsafeOutboundDestinationError("outbound transport hostname was not validated"),
        "",
      );
      return;
    }
    if (options.all) {
      callback(null, pinned);
      return;
    }
    const selected = pinned[0];
    if (!selected) {
      callback(new UnsafeOutboundDestinationError("outbound transport has no pinned address"), "");
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

async function resolveSafeOutboundTarget(
  rawUrl: string,
  policy: OutboundRequestPolicy,
): Promise<{ addresses: LookupResult[]; url: URL }> {
  const url = parseSafeOutboundUrl(rawUrl, policy);
  const hostname = normalizeHostname(url.hostname);
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await (policy.dnsLookup ?? defaultLookup)(hostname);
  if (addresses.length === 0) {
    throw new UnsafeOutboundDestinationError("outbound destination has no resolved address");
  }
  if (
    !policy.allowPrivateNetworks &&
    addresses.some((entry) => isPrivateOrSpecialAddress(entry.address))
  ) {
    throw new UnsafeOutboundDestinationError(
      "outbound destination resolves to a private or special address",
    );
  }
  return { addresses, url };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new OutboundResponseLimitError(maxBytes);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new OutboundResponseLimitError(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchBoundedOutbound(
  rawUrl: string,
  init: RequestInit = {},
  policy: OutboundRequestPolicy = {},
): Promise<BoundedOutboundResponse> {
  const fetchImpl = policy.fetchImpl ?? fetch;
  const maxBytes = policy.maxBytes ?? DEFAULT_OUTBOUND_MAX_BYTES;
  const maxRedirects = policy.maxRedirects ?? DEFAULT_OUTBOUND_MAX_REDIRECTS;
  const timeoutMs = policy.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("outbound request timed out")),
    timeoutMs,
  );
  let currentUrl = rawUrl;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const target = await resolveSafeOutboundTarget(currentUrl, policy);
      const dispatcher: Dispatcher = new Agent({
        connect: {
          lookup: createPinnedLookup(target.url.hostname, target.addresses),
        },
      });
      try {
        const response = await fetchImpl(target.url, {
          ...init,
          dispatcher,
          method: policy.method ?? init.method,
          redirect: "manual",
          signal: controller.signal,
        } as RequestInit & { dispatcher: Dispatcher });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location)
            throw new UnsafeOutboundDestinationError("outbound redirect is missing a location");
          if (redirects >= maxRedirects)
            throw new UnsafeOutboundDestinationError("outbound redirect limit exceeded");
          await response.body?.cancel();
          currentUrl = new URL(location, target.url).toString();
          continue;
        }
        return {
          body: await readBoundedBody(response, maxBytes),
          finalUrl: target.url.toString(),
          headers: response.headers,
          status: response.status,
        };
      } finally {
        await dispatcher.close();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
