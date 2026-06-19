import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import {
  prepareArtifactStorageBundleFromArgv,
  resolveArtifactStorageBundlePrepareConfig,
} from "../script/prepare-artifact-storage-bundle.js";
import {
  recordArtifactStorageBundlePoliciesFromFile,
  resolveArtifactStorageBundlePolicyRecordConfig,
} from "../script/record-artifact-storage-bundle-policies.js";
import {
  buildArtifactStorageBundleManifest,
  createArtifactStorageBundlePolicyInputs,
} from "../src/shared/artifact-storage-bundles.js";

describe("ArtifactStorageBundles", () => {
  const bundleInput = {
    artifacts: [
      {
        artifactKey: "launch-paper-1",
        byteLength: 573104,
        cid: "bafylaunchpaper",
        contentType: "image/vnd.djvu",
        durabilityClass: "A",
        memberPath: "royal-society/1665/001/paper.djvu",
        sha256: "50ddf2d41dc4204c063562cdaa0ccf584fba70d112ce6b22afeb1264378222e5",
      },
      {
        artifactKey: "launch-paper-1-metadata",
        byteLength: 1024,
        cid: "bafylaunchmetadata",
        contentType: "application/json",
        durabilityClass: "B",
        memberPath: "royal-society/1665/001/metadata.json",
        sha256: "7553a76989b2e932cbd0de826d2a7d706e64e1b0378ff419d5b07fdfd4c84355",
      },
    ],
    bundleCid: "bafyarchivebundle",
    bundleKey: "royal-society-1665-001",
    bundleUri: "ipfs://bafyarchivebundle",
    generatedAt: "2026-05-16T12:00:00.000Z",
    storageRail: "filecoin-direct-deal",
  } as const;

  it("builds deterministic provider-neutral bundle manifests", () => {
    const manifest = buildArtifactStorageBundleManifest(bundleInput);
    const rebuilt = buildArtifactStorageBundleManifest({
      ...bundleInput,
      artifacts: [...bundleInput.artifacts].reverse(),
    });

    expect(manifest.kind).to.equal("scientific.artifact-storage-bundle");
    expect(manifest.version).to.equal(1);
    expect(manifest.artifacts.map((artifact) => artifact.artifactKey)).to.deep.equal([
      "launch-paper-1",
      "launch-paper-1-metadata",
    ]);
    expect(manifest.manifestDigest).to.match(/^sha256:[0-9a-f]{64}$/u);
    expect(rebuilt.manifestDigest).to.equal(manifest.manifestDigest);
  });

  it("derives bundle-backed storage policy inputs for every artifact", () => {
    const manifest = buildArtifactStorageBundleManifest(bundleInput);
    const policies = createArtifactStorageBundlePolicyInputs(manifest);

    expect(policies).to.have.length(2);
    expect(policies[0]).to.deep.equal({
      artifactKey: "launch-paper-1",
      policy: {
        bundleCid: "bafyarchivebundle",
        bundleMemberPath: "royal-society/1665/001/paper.djvu",
        durabilityClass: "A",
        metadata: {
          artifactCid: "bafylaunchpaper",
          bundleKey: "royal-society-1665-001",
          bundleUri: "ipfs://bafyarchivebundle",
          manifestDigest: manifest.manifestDigest,
          storageRail: "filecoin-direct-deal",
        },
      },
    });
  });

  it("rejects unsafe bundle member paths", () => {
    expect(() =>
      buildArtifactStorageBundleManifest({
        ...bundleInput,
        artifacts: [
          {
            ...bundleInput.artifacts[0],
            memberPath: "../paper.djvu",
          },
        ],
      }),
    ).to.throw("artifact bundle memberPath must be relative and safe");
  });

  it("prepares manifests and records bundle policies through operator CLI helpers", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifact-bundle-"));
    const inputPath = path.join(tempRoot, "bundle-input.json");
    const manifestPath = path.join(tempRoot, "bundle-manifest.json");
    await writeFile(inputPath, `${JSON.stringify(bundleInput, null, 2)}\n`, "utf8");

    try {
      const prepareConfig = resolveArtifactStorageBundlePrepareConfig([
        "--input",
        inputPath,
        "--out",
        manifestPath,
      ]);
      expect(prepareConfig).to.deep.equal({ inputPath, outPath: manifestPath });

      const prepared = await prepareArtifactStorageBundleFromArgv([
        "--input",
        inputPath,
        "--out",
        manifestPath,
      ]);
      expect(prepared.artifactCount).to.equal(2);
      expect(prepared.bundleCid).to.equal("bafyarchivebundle");

      const recordConfig = resolveArtifactStorageBundlePolicyRecordConfig(
        ["--file", manifestPath, "--database-url", "postgresql://postgres@example.org/osp"],
        {},
      );
      expect(recordConfig).to.deep.equal({
        databaseUrl: "postgresql://postgres@example.org/osp",
        filePath: manifestPath,
      });

      const recorded = await recordArtifactStorageBundlePoliciesFromFile(manifestPath, {
        prepareStore: async () => ({}) as never,
        upsertStoragePolicy: async (_pool, artifactKey, policy) => ({
          artifactKey,
          bundleCid: policy.bundleCid ?? null,
          bundleMemberPath: policy.bundleMemberPath ?? null,
          createdAt: "2026-05-16T12:00:00.000Z",
          durabilityClass: policy.durabilityClass,
          metadata: policy.metadata ?? {},
          repairPriority: 100,
          requiredIndependentRetrievalPaths: 2,
          requiredReplicaCount: 2,
          requiresFilecoinOrEquivalent: true,
          retentionUntil: policy.retentionUntil ?? null,
          updatedAt: "2026-05-16T12:00:00.000Z",
        }),
      });

      expect(recorded).to.deep.equal({
        artifactCount: 2,
        bundleCid: "bafyarchivebundle",
        bundleKey: "royal-society-1665-001",
        manifestDigest: prepared.manifestDigest,
        ok: true,
        recordedArtifacts: ["launch-paper-1", "launch-paper-1-metadata"],
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects tampered bundle manifests before recording policies", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifact-bundle-tamper-"));
    const manifestPath = path.join(tempRoot, "bundle-manifest.json");
    const manifest = buildArtifactStorageBundleManifest(bundleInput);
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, manifestDigest: "sha256:0".padEnd(71, "0") }, null, 2)}\n`,
      "utf8",
    );

    try {
      await assert.rejects(
        recordArtifactStorageBundlePoliciesFromFile(manifestPath, {
          prepareStore: async () => ({}) as never,
        }),
        /artifact storage bundle manifestDigest mismatch/,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
