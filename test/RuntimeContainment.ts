import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expect } from "chai";
import { parseWebhookSubscriptionCreatePayload } from "../src/api/params.js";
import {
  consumeConfiguredRateLimit,
  demoRateLimitScope,
  resolveRateLimitBackend,
} from "../src/api/rate-limit.js";
import { assertPublicServiceCredentialBoundary } from "../src/api/runtime-security.js";
import { buildPinnedGitCloneArgs } from "../src/artifacts/ingestion.js";
import { resolveReplicationJob } from "../src/resolver/engine.js";
import {
  assertSafeOutboundUrl,
  createPinnedLookup,
  fetchBoundedOutbound,
  isPrivateOrSpecialAddress,
  OutboundResponseLimitError,
  UnsafeOutboundDestinationError,
} from "../src/shared/outbound-request.js";
import { processReplicationJob } from "../src/workers/replication-worker.js";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

describe("RuntimeContainment", () => {
  it("rejects filesystem, credentialed, loopback, private, link-local, and metadata destinations", async () => {
    for (const destination of [
      "/etc/passwd",
      "file:///etc/passwd",
      "https://user:password@example.com/file",
      "http://127.0.0.1/internal",
      "http://10.2.3.4/internal",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/internal",
      "http://[::ffff:7f00:1]/internal",
      "http://[::ffff:a00:1]/internal",
      "http://metadata.google.internal/computeMetadata/v1",
    ]) {
      await assert.rejects(
        assertSafeOutboundUrl(destination, { dnsLookup: publicDns }),
        UnsafeOutboundDestinationError,
      );
    }
  });

  it("classifies mapped IPv4 and non-global IPv6 numerically", () => {
    for (const address of [
      "::ffff:7f00:1",
      "::ffff:a00:1",
      "::ffff:ac10:1",
      "::ffff:c0a8:1",
      "2001:db8::1",
      "2002:7f00:1::",
      "fc00::1",
      "fe80::1",
    ]) {
      expect(isPrivateOrSpecialAddress(address), address).to.equal(true);
    }
    expect(isPrivateOrSpecialAddress("2606:4700:4700::1111")).to.equal(false);
  });

  it("pins git/libcurl to the validated address while retaining the TLS hostname", () => {
    const args = buildPinnedGitCloneArgs({
      address: "93.184.216.34",
      family: 4,
      ref: "main",
      repositoryUrl: new URL("https://code.example/research/protocol.git"),
      repoPath: "/tmp/repository",
    });
    expect(args).to.include("http.curloptResolve=code.example:443:93.184.216.34");
    expect(
      args.filter((entry) => entry === "http.curloptResolve=code.example:443:93.184.216.34"),
    ).to.have.length(2);
    expect(args.filter((entry) => entry === "http.followRedirects=false")).to.have.length(2);
    expect(args).to.include("http.followRedirects=false");
    expect(args).to.include("--no-checkout");
    expect(args.slice(-3)).to.deep.equal([
      "--",
      "https://code.example/research/protocol.git",
      "/tmp/repository",
    ]);
    const ipv6 = buildPinnedGitCloneArgs({
      address: "2606:4700:4700::1111",
      family: 6,
      repositoryUrl: new URL("https://code.example/research/protocol.git"),
      repoPath: "/tmp/repository",
    });
    expect(ipv6).to.include("http.curloptResolve=code.example:443:[2606:4700:4700::1111]");
    const literal = buildPinnedGitCloneArgs({
      address: "2606:4700:4700::1111",
      family: 6,
      repositoryUrl: new URL("https://[2606:4700:4700::1111]/protocol.git"),
      repoPath: "/tmp/repository",
    });
    expect(literal.some((entry) => entry.startsWith("http.curloptResolve="))).to.equal(false);
  });

  it("revalidates redirect destinations before following them", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(null, {
        headers: { location: "http://169.254.169.254/latest/meta-data" },
        status: 302,
      });
    };
    await assert.rejects(
      fetchBoundedOutbound("https://example.com/paper", {}, { dnsLookup: publicDns, fetchImpl }),
      UnsafeOutboundDestinationError,
    );
    expect(calls).to.equal(1);
  });

  it("pins transport lookup to the exact address set that passed validation", async () => {
    const lookup = createPinnedLookup("example.com", [{ address: "93.184.216.34", family: 4 }]);
    const selected = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("example.com", {}, (error, address, family) => {
        if (error) return reject(error);
        if (typeof address !== "string" || family === undefined) {
          return reject(new Error("expected one pinned address"));
        }
        resolve({ address, family });
      });
    });
    expect(selected).to.deep.equal({ address: "93.184.216.34", family: 4 });
    const ipv6Lookup = createPinnedLookup("[fd00::1]", [{ address: "fd00::1", family: 6 }]);
    const ipv6 = await new Promise<string>((resolve, reject) => {
      ipv6Lookup("fd00::1", {}, (error, address) => {
        if (error) return reject(error);
        if (typeof address !== "string") return reject(new Error("expected pinned IPv6 address"));
        resolve(address);
      });
    });
    expect(ipv6).to.equal("fd00::1");
    await assert.rejects(
      new Promise((resolve, reject) => {
        lookup("rebound.example.com", {}, (error, address) =>
          error ? reject(error) : resolve(address),
        );
      }),
      UnsafeOutboundDestinationError,
    );
  });

  it("caps response bodies before returning them to parsers", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("0123456789", { headers: { "content-length": "10" }, status: 200 });
    await assert.rejects(
      fetchBoundedOutbound(
        "https://example.com/paper",
        {},
        {
          dnsLookup: publicDns,
          fetchImpl,
          maxBytes: 4,
        },
      ),
      OutboundResponseLimitError,
    );
  });

  it("rejects privileged credentials and reference canaries in a public service", () => {
    expect(() =>
      assertPublicServiceCredentialBoundary({
        SP_PUBLIC_SERVICE: "true",
        SP_RESOLVER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      }),
    ).to.throw(/SP_RESOLVER_PRIVATE_KEY/);
    expect(() =>
      assertPublicServiceCredentialBoundary({
        SP_PUBLIC_SERVICE: "true",
        SP_CLAIM_SUBMITTER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
      }),
    ).to.throw(/SP_CLAIM_SUBMITTER_PRIVATE_KEY/);
    expect(() =>
      assertPublicServiceCredentialBoundary({
        SP_PUBLIC_SERVICE: "true",
        SP_OPERATOR_PRIVATE_KEY_FILE: "/run/secrets/operator",
      }),
    ).to.throw(/SP_OPERATOR_PRIVATE_KEY/);
    expect(() =>
      assertPublicServiceCredentialBoundary({
        SP_PUBLIC_SERVICE: "true",
        SP_REWARD_SETTLER_PRIVATE_KEY_FILE: "/run/secrets/reward-settler",
      }),
    ).to.throw(/SP_REWARD_SETTLER_PRIVATE_KEY/);
    expect(() =>
      assertPublicServiceCredentialBoundary({
        SP_PUBLIC_SERVICE: "true",
        SP_REWARD_SETTLER_PRIVATE_KEY_SECRET_REF: "reward-settler:latest",
      }),
    ).to.throw(/SP_REWARD_SETTLER_PRIVATE_KEY/);
    expect(() =>
      assertPublicServiceCredentialBoundary({
        SP_PUBLIC_SERVICE: "true",
        SP_REFERENCE_CANARY_MODE: "true",
      }),
    ).to.throw(/must not enable/);
    expect(() =>
      assertPublicServiceCredentialBoundary({ SP_PUBLIC_SERVICE: "true" }),
    ).not.to.throw();
  });

  it("rate-limits the only supported admin sync method", () => {
    expect(demoRateLimitScope(new URL("https://api.example/admin/sync"), "GET", {})).to.equal(
      "adminActions",
    );
    expect(demoRateLimitScope(new URL("https://api.example/admin/sync"), "POST", {})).to.equal(
      null,
    );
  });

  it("requires shared rate limiting for remote write services", () => {
    expect(resolveRateLimitBackend({ SP_RPC_URL: "https://base.example/rpc" })).to.equal(
      "postgres",
    );
    expect(() =>
      resolveRateLimitBackend({
        SP_RATE_LIMIT_BACKEND: "memory",
        SP_RPC_URL: "https://base.example/rpc",
      }),
    ).to.throw(/require SP_RATE_LIMIT_BACKEND=postgres/);
  });

  it("fails closed when the shared limiter store is unavailable", async () => {
    await assert.rejects(
      consumeConfiguredRateLimit({
        backend: "postgres",
        bucketKey: "unavailable",
        buckets: new Map(),
        pool: {
          query: async () => {
            throw new Error("database down");
          },
        } as never,
        response: { setHeader() {} } as never,
        rule: { maxRequests: 1, windowMs: 60_000 },
      }),
      /rate_limit_store_unavailable/,
    );
  });

  it("rejects obvious unsafe webhook destinations at subscription time", () => {
    for (const targetUrl of [
      "file:///tmp/hook",
      "http://127.0.0.1/hook",
      "http://169.254.169.254/hook",
      "http://metadata.google.internal/hook",
      "https://user:pass@example.com/hook",
    ]) {
      expect(() => parseWebhookSubscriptionCreatePayload({ targetUrl })).to.throw(
        "invalid_agent_webhook_target_url",
      );
    }
  });

  it("fails reference replication and resolution closed before touching state", async () => {
    await assert.rejects(processReplicationJob({}, {}), /reference replication worker is disabled/);
    await assert.rejects(
      resolveReplicationJob({ jobId: "1", env: {} }),
      /reference resolver is disabled/,
    );
  });
});
