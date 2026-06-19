import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import { Wallet } from "ethers";
import {
  recordArtifactStorageAttestationFromFile,
  resolveArtifactStorageAttestationRecordConfig,
} from "../script/record-artifact-storage-attestation.js";
import {
  resolveArtifactStorageAttestationSignConfig,
  signArtifactStorageAttestationFromEnv,
} from "../script/sign-artifact-storage-attestation.js";
import { verifyArtifactStorageAttestationFile } from "../script/verify-artifact-storage-attestation.js";
import {
  buildArtifactStorageAttestationEnvelope,
  createSignedArtifactStorageAttestation,
  hashArtifactStorageAttestationEnvelope,
  toArtifactStorageAttestationRecordInput,
  verifyArtifactStorageAttestation,
} from "../src/shared/artifact-storage-attestations.js";

describe("ArtifactStorageAttestations", () => {
  it("creates replay-resistant wallet-attributable storage attestations", async () => {
    const wallet = Wallet.createRandom();
    const signed = await createSignedArtifactStorageAttestation({
      artifactKey: "launch-paper-1",
      chainId: 84532,
      cid: "bafylaunchpaper",
      commitmentKind: "filecoin",
      evidenceRef: "ipfs://bafyevidence",
      issuedAt: "2026-05-15T12:00:00.000Z",
      provider: "lighthouse",
      providerMetadata: {
        dealId: "deal-1",
      },
      requestNonce: "storage-attestation-1",
      retentionUntil: "2027-05-15T12:00:00.000Z",
      retrievalUrl: "https://gateway.example/ipfs/bafylaunchpaper",
      signer: wallet,
      storageClass: "A",
      storageStartedAt: "2026-05-15T11:55:00.000Z",
    });

    expect(signed.envelope.actionType).to.equal("artifact_storage_attestation");
    expect(signed.envelope.attestorAddress).to.equal(wallet.address);
    expect(signed.envelope.scopeKey).to.equal("artifact:launch-paper-1:cid:bafylaunchpaper");

    const verified = verifyArtifactStorageAttestation(signed);
    expect(verified.recoveredAddress).to.equal(wallet.address);
    expect(verified.signedPayloadHash).to.equal(
      hashArtifactStorageAttestationEnvelope(signed.envelope),
    );

    const recordInput = toArtifactStorageAttestationRecordInput(signed);
    expect(recordInput).to.include({
      attestorAddress: wallet.address,
      cid: "bafylaunchpaper",
      commitmentKind: "filecoin",
      evidenceRef: "ipfs://bafyevidence",
      provider: "lighthouse",
      retrievalUrl: "https://gateway.example/ipfs/bafylaunchpaper",
      signedPayloadHash: verified.signedPayloadHash,
      storageClass: "A",
      storageStartedAt: "2026-05-15T11:55:00.000Z",
    });
    expect(recordInput.providerMetadata).to.deep.equal({ dealId: "deal-1" });
  });

  it("rejects attestations whose signed payload is changed", async () => {
    const wallet = Wallet.createRandom();
    const signed = await createSignedArtifactStorageAttestation({
      artifactKey: "launch-paper-1",
      chainId: 84532,
      cid: "bafylaunchpaper",
      commitmentKind: "hot",
      issuedAt: "2026-05-15T12:00:00.000Z",
      provider: "institutional-gateway",
      requestNonce: "storage-attestation-2",
      signer: wallet,
      storageClass: "B",
      storageStartedAt: "2026-05-15T11:55:00.000Z",
    });

    expect(() =>
      verifyArtifactStorageAttestation({
        ...signed,
        envelope: {
          ...signed.envelope,
          cid: "bafytampered",
        },
      }),
    ).to.throw("artifact storage attestation signature mismatch");
  });

  it("includes chain and nonce in the signed hash", () => {
    const envelope = buildArtifactStorageAttestationEnvelope({
      artifactKey: "launch-paper-1",
      attestorAddress: Wallet.createRandom().address,
      chainId: 84532,
      cid: "bafylaunchpaper",
      commitmentKind: "mirror",
      issuedAt: "2026-05-15T12:00:00.000Z",
      provider: "library-node",
      requestNonce: "storage-attestation-3",
      storageClass: "A",
      storageStartedAt: "2026-05-15T11:55:00.000Z",
    });

    expect(
      hashArtifactStorageAttestationEnvelope({
        ...envelope,
        chainId: 8453,
      }),
    ).to.not.equal(hashArtifactStorageAttestationEnvelope(envelope));
    expect(
      hashArtifactStorageAttestationEnvelope({
        ...envelope,
        requestNonce: "storage-attestation-4",
      }),
    ).to.not.equal(hashArtifactStorageAttestationEnvelope(envelope));
  });

  it("signs, verifies, and records attestation files through operator CLI helpers", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-storage-attestation-"));
    const privateKeyPath = path.join(tempRoot, "attestor.key");
    const attestationPath = path.join(tempRoot, "attestation.json");
    const wallet = Wallet.createRandom();
    await writeFile(privateKeyPath, `${wallet.privateKey}\n`, "utf8");

    try {
      const signed = await signArtifactStorageAttestationFromEnv(
        [
          "--artifact-key",
          "launch-paper-1",
          "--chain-id",
          "84532",
          "--cid",
          "bafylaunchpaper",
          "--commitment-kind",
          "filecoin",
          "--evidence-ref",
          "ipfs://bafyevidence",
          "--out",
          attestationPath,
          "--provider",
          "lighthouse",
          "--provider-metadata-json",
          '{"dealId":"deal-1"}',
          "--request-nonce",
          "storage-attestation-cli-1",
          "--storage-class",
          "A",
          "--storage-started-at",
          "2026-05-15T11:55:00.000Z",
        ],
        {
          SP_STORAGE_ATTESTOR_PRIVATE_KEY_FILE: privateKeyPath,
        },
      );

      expect(signed.envelope.attestorAddress).to.equal(wallet.address);
      expect(signed.signedPayloadHash).to.match(/^0x[0-9a-f]{64}$/u);

      const verified = verifyArtifactStorageAttestationFile(attestationPath);
      expect(verified.ok).to.equal(true);
      expect(verified.artifactKey).to.equal("launch-paper-1");
      expect(verified.recoveredAddress).to.equal(wallet.address);

      const recorded = await recordArtifactStorageAttestationFromFile(attestationPath, {
        prepareStore: async () => ({}) as never,
        recordAttestation: async (_pool, artifactKey, input) => ({
          artifactKey,
          attestationId: "42",
          attestorAddress: input.attestorAddress,
          cid: input.cid,
          commitmentKind: input.commitmentKind,
          createdAt: "2026-05-15T12:00:00.000Z",
          evidenceRef: input.evidenceRef ?? null,
          nodeId: input.nodeId ?? null,
          provider: input.provider,
          providerMetadata: input.providerMetadata ?? {},
          retentionUntil: input.retentionUntil ?? null,
          retrievalUrl: input.retrievalUrl ?? null,
          signature: input.signature,
          signedPayloadHash: input.signedPayloadHash,
          storageClass: input.storageClass,
          storageStartedAt: input.storageStartedAt ?? "2026-05-15T11:55:00.000Z",
          updatedAt: "2026-05-15T12:00:00.000Z",
        }),
      });

      expect(recorded).to.deep.include({
        artifactKey: "launch-paper-1",
        attestationId: "42",
        cid: "bafylaunchpaper",
        ok: true,
        provider: "lighthouse",
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("resolves signing and recording CLI configuration without exposing private keys in output", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-storage-attestation-config-"));
    const privateKeyPath = path.join(tempRoot, "attestor.key");
    const attestationPath = path.join(tempRoot, "attestation.json");
    const wallet = Wallet.createRandom();
    await writeFile(privateKeyPath, `${wallet.privateKey}\n`, "utf8");

    try {
      const signConfig = resolveArtifactStorageAttestationSignConfig(
        [
          "--artifact-key=artifact-1",
          "--chain-id=84532",
          "--cid=bafyartifact",
          "--commitment-kind=mirror",
          "--provider=library-node",
          "--request-nonce=nonce-1",
          "--storage-class=B",
        ],
        {
          SP_STORAGE_ATTESTOR_PRIVATE_KEY_FILE: privateKeyPath,
        },
      );

      expect(signConfig.privateKey).to.equal(wallet.privateKey);
      expect(signConfig).to.include({
        artifactKey: "artifact-1",
        chainId: 84532,
        cid: "bafyartifact",
        commitmentKind: "mirror",
        provider: "library-node",
        requestNonce: "nonce-1",
        storageClass: "B",
      });

      const recordConfig = resolveArtifactStorageAttestationRecordConfig(
        ["--file", attestationPath, "--database-url", "postgresql://postgres@example.org/osp"],
        {},
      );
      expect(recordConfig).to.deep.equal({
        databaseUrl: "postgresql://postgres@example.org/osp",
        filePath: attestationPath,
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
