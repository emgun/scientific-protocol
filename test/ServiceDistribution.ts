import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expect } from "chai";
import { runServiceCommand, serviceUsage } from "../src/service/cli.js";
import { assertWriteEnabled, resolveServiceMode } from "../src/service/mode.js";
import { serviceProvenance } from "../src/service/provenance.js";

describe("reference service distribution", () => {
  it("defaults to read-only and validates explicit service modes", () => {
    expect(resolveServiceMode({})).to.equal("read-only");
    expect(resolveServiceMode({ SP_SERVICE_MODE: "write-enabled" })).to.equal("write-enabled");
    expect(() => resolveServiceMode({ SP_SERVICE_MODE: "invalid" })).to.throw(
      "SP_SERVICE_MODE must be one of: read-only, write-enabled",
    );
    expect(() => assertWriteEnabled({ SP_SERVICE_MODE: "read-only" })).to.throw(
      "SP_SERVICE_MODE=write-enabled",
    );
  });

  it("runs help and version without database, RPC, or signer credentials", async () => {
    expect(await runServiceCommand(["node", "service", "help"], {})).to.equal(serviceUsage());
    expect(
      await runServiceCommand(["node", "service", "version"], {
        SP_SERVICE_BUILD_DATE: "2026-07-12T00:00:00Z",
        SP_SERVICE_REVISION: "abc123",
        SP_SERVICE_VERSION: "0.3.0",
      }),
    ).to.deep.equal({
      buildDate: "2026-07-12T00:00:00Z",
      imageRevision: "abc123",
      version: "0.3.0",
    });
    expect(serviceProvenance({})).to.deep.equal({
      buildDate: null,
      imageRevision: null,
      version: "development",
    });
  });

  it("defines a non-root multi-stage production image with a liveness check", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).to.include("FROM node:22-bookworm-slim AS build");
    expect(dockerfile).to.include("FROM node:22-bookworm-slim AS runtime");
    expect(dockerfile).to.include("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).to.include("apt-get install --yes --no-install-recommends");
    expect(dockerfile).to.match(/\n\s+ca-certificates \\\n\s+git \\/u);
    expect(dockerfile).to.include("rm -rf /var/lib/apt/lists/*");
    expect(dockerfile).to.include("USER node");
    expect(dockerfile).to.include("HEALTHCHECK");
    expect(dockerfile).to.include('CMD ["node", "dist/service/cli.js", "healthcheck"]');
    expect(dockerfile).to.include("org.opencontainers.image.revision=$REVISION");
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).to.include(
      "docker run --rm --entrypoint git scientific-protocol-service:pr --version",
    );
  });
});
