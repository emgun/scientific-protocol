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

function parseIpv6(address: string): Uint8Array | null {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (isIP(normalized) !== 6) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (!part) return [];
    const rawGroups = part.split(":");
    const groups: number[] = [];
    for (const rawGroup of rawGroups) {
      const dotted = parseIpv4(rawGroup);
      if (dotted) {
        const [a = 0, b = 0, c = 0, d = 0] = dotted;
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(rawGroup)) return null;
      groups.push(Number.parseInt(rawGroup, 16));
    }
    return groups;
  };
  const left = parseGroups(halves[0] ?? "");
  const right = parseGroups(halves[1] ?? "");
  if (!left || !right) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (groups.length !== 8) return null;
  return Uint8Array.from(groups.flatMap((group) => [group >> 8, group & 0xff]));
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((bytes[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

function isPrivateOrSpecialIpv4(ipv4: number[]): boolean {
  const [a = 0, b = 0, c = 0] = ipv4;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isPrivateOrSpecialAddress(rawAddress: string): boolean {
  const address = normalizeHostname(rawAddress).split("%")[0] ?? normalizeHostname(rawAddress);
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const ipv4 = parseIpv4(mapped ?? address);
  if (ipv4) return isPrivateOrSpecialIpv4(ipv4);
  const ipv6 = parseIpv6(address);
  if (!ipv6) return true;

  // IPv4-mapped IPv6 is normalized by WHATWG URLs into hexadecimal form
  // (for example ::ffff:7f00:1), so classify the embedded IPv4 bytes directly.
  if (hasPrefix(ipv6, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
    return isPrivateOrSpecialIpv4(Array.from(ipv6.slice(12)));
  }

  // Fail closed outside ordinary global-unicast space, then exclude globally
  // scoped transition/documentation ranges that can tunnel or translate IPv4.
  if (!hasPrefix(ipv6, [0x20], 3)) return true;
  return (
    hasPrefix(ipv6, [0x20, 0x01, 0x00], 23) ||
    hasPrefix(ipv6, [0x20, 0x02], 16) ||
    hasPrefix(ipv6, [0x20, 0x01, 0x0d, 0xb8], 32)
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

export async function resolveSafeOutboundTarget(
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
