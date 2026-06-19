import {
  type ArtifactStorageAttestationEnvelope,
  type SignedArtifactStorageAttestation,
  verifyArtifactStorageAttestation,
} from "../src/shared/artifact-storage-attestations.js";
import type {
  ArtifactDurabilityClass,
  ArtifactStorageCommitmentKind,
} from "../src/shared/artifact-storage-policy.js";
import { isMainModule, readJsonFileSync } from "../src/shared/cli.js";

const commitmentKinds = [
  "filecoin",
  "hot",
  "institutional",
  "mirror",
  "provider",
  "temporary",
] as const satisfies readonly ArtifactStorageCommitmentKind[];
const storageClasses = ["A", "B", "C", "D"] as const satisfies readonly ArtifactDurabilityClass[];

export type ArtifactStorageAttestationVerificationSummary = {
  artifactKey: string;
  attestorAddress: string;
  chainId: number;
  cid: string;
  commitmentKind: ArtifactStorageCommitmentKind;
  ok: boolean;
  provider: string;
  recoveredAddress: string;
  requestNonce: string;
  scopeKey: string;
  signedPayloadHash: string;
  storageClass: ArtifactDurabilityClass;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`artifact storage attestation ${key} is required`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`artifact storage attestation ${key} must be a string`);
  }
  return value.trim() || null;
}

function readEnum<const Value extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly Value[],
): Value {
  const value = readRequiredString(record, key);
  if ((values as readonly string[]).includes(value)) {
    return value as Value;
  }
  throw new Error(`artifact storage attestation ${key} must be one of: ${values.join(", ")}`);
}

function readPositiveSafeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`artifact storage attestation ${key} must be a positive safe integer`);
  }
  return value;
}

function readProviderMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const value = record.providerMetadata;
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("artifact storage attestation providerMetadata must be an object");
  }
  return value;
}

export function parseSignedArtifactStorageAttestation(
  value: unknown,
): SignedArtifactStorageAttestation {
  if (!isRecord(value)) {
    throw new Error("artifact storage attestation file must contain a JSON object");
  }
  if (!isRecord(value.envelope)) {
    throw new Error("artifact storage attestation envelope is required");
  }
  if (typeof value.signature !== "string" || value.signature.trim() === "") {
    throw new Error("artifact storage attestation signature is required");
  }

  const envelopeSource = value.envelope;
  const actionType = readRequiredString(envelopeSource, "actionType");
  if (actionType !== "artifact_storage_attestation") {
    throw new Error("artifact storage attestation actionType must be artifact_storage_attestation");
  }

  const envelope: ArtifactStorageAttestationEnvelope = {
    actionType,
    artifactKey: readRequiredString(envelopeSource, "artifactKey"),
    attestorAddress: readRequiredString(envelopeSource, "attestorAddress"),
    chainId: readPositiveSafeInteger(envelopeSource, "chainId"),
    cid: readRequiredString(envelopeSource, "cid"),
    commitmentKind: readEnum(envelopeSource, "commitmentKind", commitmentKinds),
    evidenceRef: readOptionalString(envelopeSource, "evidenceRef"),
    issuedAt: readRequiredString(envelopeSource, "issuedAt"),
    nodeId: readOptionalString(envelopeSource, "nodeId"),
    provider: readRequiredString(envelopeSource, "provider"),
    providerMetadata: readProviderMetadata(envelopeSource),
    requestNonce: readRequiredString(envelopeSource, "requestNonce"),
    retentionUntil: readOptionalString(envelopeSource, "retentionUntil"),
    retrievalUrl: readOptionalString(envelopeSource, "retrievalUrl"),
    scopeKey: readRequiredString(envelopeSource, "scopeKey"),
    storageClass: readEnum(envelopeSource, "storageClass", storageClasses),
    storageStartedAt: readRequiredString(envelopeSource, "storageStartedAt"),
  };

  return {
    envelope,
    signature: value.signature.trim(),
  };
}

export function readSignedArtifactStorageAttestationFile(
  filePath: string,
): SignedArtifactStorageAttestation {
  return parseSignedArtifactStorageAttestation(readJsonFileSync(filePath));
}

export function verifyArtifactStorageAttestationFile(
  filePath: string,
): ArtifactStorageAttestationVerificationSummary {
  const signed = readSignedArtifactStorageAttestationFile(filePath);
  const verification = verifyArtifactStorageAttestation(signed);
  return {
    artifactKey: signed.envelope.artifactKey,
    attestorAddress: signed.envelope.attestorAddress,
    chainId: signed.envelope.chainId,
    cid: signed.envelope.cid,
    commitmentKind: signed.envelope.commitmentKind,
    ok: true,
    provider: signed.envelope.provider,
    recoveredAddress: verification.recoveredAddress,
    requestNonce: signed.envelope.requestNonce,
    scopeKey: signed.envelope.scopeKey,
    signedPayloadHash: verification.signedPayloadHash,
    storageClass: signed.envelope.storageClass,
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const filePath = process.argv[2];
    if (!filePath) {
      throw new Error("usage: verify-artifact-storage-attestation.ts <attestation.json>");
    }
    console.log(JSON.stringify(verifyArtifactStorageAttestationFile(filePath), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
