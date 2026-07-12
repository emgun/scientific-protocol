import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { expect } from "chai";
import { createDemoClaim } from "../src/demo/actions.js";
import { resolveIntegerInput } from "../src/shared/numbers.js";
import { runClaimCreationSaga, verifyProductionClaimArtifact } from "../src/submission/actions.js";

describe("production submission", () => {
  it("validates integer claim fields before chain setup", () => {
    expect(resolveIntegerInput(undefined, 1, "domainId")).to.equal(1);
    expect(resolveIntegerInput(0, 1, "domainId")).to.equal(0);
    expect(resolveIntegerInput(5, 1, "artifactType", { min: 1 })).to.equal(5);
    expect(() => resolveIntegerInput(0, 1, "artifactType", { min: 1 })).to.throw(
      "artifactType must be an integer greater than or equal to 1",
    );
    expect(() => resolveIntegerInput(Number.NaN, 1, "domainId")).to.throw(
      "domainId must be an integer greater than or equal to 0",
    );
  });

  it("anchors the SHA-256 of bounded retrieved artifact bytes", async () => {
    const bytes = Buffer.from("externally authored scientific artifact");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const result = await verifyProductionClaimArtifact(
      {
        artifactSha256: `sha256:${digest}`,
        artifactUri: "ipfs://bafy-claim/claim.json",
      },
      {
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async () => new Response(bytes, { status: 200 }),
      },
    );
    assert.equal(result.contentDigest, `0x${digest}`);
    assert.equal(result.sizeBytes, bytes.length);
  });

  it("fails artifact verification before chain setup on mismatch or retrieval failure", async () => {
    const options = {
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => new Response("different bytes", { status: 200 }),
    };
    await assert.rejects(
      verifyProductionClaimArtifact(
        {
          artifactSha256: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          artifactUri: "ar://arweave-transaction-id",
        },
        options,
      ),
      /claim artifact SHA-256 mismatch/,
    );
    await assert.rejects(
      verifyProductionClaimArtifact(
        {
          artifactSha256: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          artifactUri: "filecoin://bafy-filecoin-cid",
        },
        { ...options, fetchImpl: async () => new Response("missing", { status: 404 }) },
      ),
      /claim artifact retrieval failed with status 404/,
    );
    await assert.rejects(
      verifyProductionClaimArtifact(
        {
          artifactSha256: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          artifactUri: "https://mutable.example.org/artifact.json",
        },
        options,
      ),
      /must use ipfs:\/\/, ar:\/\/, or filecoin:\/\//,
    );
  });

  for (const faultInjection of [
    "before-create",
    "after-create-before-checkpoint",
    "after-artifact",
  ] as const) {
    it(`resumes the request-bound claim saga after ${faultInjection}`, async () => {
      let claim: { claimId: string; txHash: string } | null = null;
      let artifact: { artifactId: string; txHash: string } | null = null;
      let createCalls = 0;
      let attachCalls = 0;
      const dependencies = {
        findClaim: async () => claim,
        createClaim: async () => {
          createCalls += 1;
          claim = { claimId: "41", txHash: "0xcreate" };
          return claim;
        },
        checkpoint: async () => {},
        findArtifact: async () => artifact,
        attachArtifact: async () => {
          attachCalls += 1;
          artifact = { artifactId: "73", txHash: "0xartifact" };
          return artifact;
        },
      };
      await assert.rejects(
        runClaimCreationSaga({ ...dependencies, faultInjection }),
        /fault_injected/,
      );
      const resumed = await runClaimCreationSaga(dependencies);
      assert.equal(resumed.claimId, "41");
      assert.equal(resumed.artifactId, "73");
      assert.equal(createCalls, 1);
      assert.equal(attachCalls, 1);
    });
  }
});

describe("demo submission", () => {
  it("validates integer claim fields before loading deployment contracts", async () => {
    await assert.rejects(
      createDemoClaim({
        artifactType: 0,
        artifactUri: "ipfs://artifact",
        statement: "Sandbox claim",
      }),
      /artifactType must be an integer greater than or equal to 1/,
    );
  });
});
