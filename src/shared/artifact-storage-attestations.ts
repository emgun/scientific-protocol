import { getBytes, type Signer, verifyMessage } from "ethers";
import type {
  ArtifactDurabilityClass,
  ArtifactStorageAttestationInput,
  ArtifactStorageCommitmentKind,
} from "./artifact-storage-policy.js";
import { sha256Hex } from "./sha256.js";

export type ArtifactStorageAttestationActionType = "artifact_storage_attestation";

export type ArtifactStorageAttestationEnvelope = {
  actionType: ArtifactStorageAttestationActionType;
  artifactKey: string;
  attestorAddress: string;
  chainId: number;
  cid: string;
  commitmentKind: ArtifactStorageCommitmentKind;
  evidenceRef: string | null;
  issuedAt: string;
  nodeId: string | null;
  provider: string;
  providerMetadata: Record<string, unknown>;
  requestNonce: string;
  retentionUntil: string | null;
  retrievalUrl: string | null;
  scopeKey: string;
  storageClass: ArtifactDurabilityClass;
  storageStartedAt: string;
};

export type ArtifactStorageAttestationSigner = Pick<Signer, "getAddress" | "signMessage">;

export type SignedArtifactStorageAttestation = {
  envelope: ArtifactStorageAttestationEnvelope;
  signature: string;
};

export type VerifiedArtifactStorageAttestation = {
  recoveredAddress: string;
  signedPayloadHash: string;
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  return JSON.stringify(value);
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildArtifactStorageAttestationScopeKey(input: {
  artifactKey: string;
  cid: string;
}): string {
  return `artifact:${normalizeRequiredText(input.artifactKey, "artifactKey")}:cid:${normalizeRequiredText(input.cid, "cid")}`;
}

export function buildArtifactStorageAttestationEnvelope(input: {
  artifactKey: string;
  attestorAddress: string;
  chainId: number;
  cid: string;
  commitmentKind: ArtifactStorageCommitmentKind;
  evidenceRef?: string | null;
  issuedAt?: string;
  nodeId?: string | null;
  provider: string;
  providerMetadata?: Record<string, unknown>;
  requestNonce: string;
  retentionUntil?: string | null;
  retrievalUrl?: string | null;
  scopeKey?: string;
  storageClass: ArtifactDurabilityClass;
  storageStartedAt?: string;
}): ArtifactStorageAttestationEnvelope {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("chainId must be a positive safe integer");
  }

  const artifactKey = normalizeRequiredText(input.artifactKey, "artifactKey");
  const cid = normalizeRequiredText(input.cid, "cid");
  return {
    actionType: "artifact_storage_attestation",
    artifactKey,
    attestorAddress: normalizeRequiredText(input.attestorAddress, "attestorAddress"),
    chainId: input.chainId,
    cid,
    commitmentKind: input.commitmentKind,
    evidenceRef: normalizeOptionalText(input.evidenceRef),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    nodeId: normalizeOptionalText(input.nodeId),
    provider: normalizeRequiredText(input.provider, "provider"),
    providerMetadata: input.providerMetadata ?? {},
    requestNonce: normalizeRequiredText(input.requestNonce, "requestNonce"),
    retentionUntil: normalizeOptionalText(input.retentionUntil),
    retrievalUrl: normalizeOptionalText(input.retrievalUrl),
    scopeKey: input.scopeKey ?? buildArtifactStorageAttestationScopeKey({ artifactKey, cid }),
    storageClass: input.storageClass,
    storageStartedAt: input.storageStartedAt ?? new Date().toISOString(),
  };
}

export function hashArtifactStorageAttestationEnvelope(
  envelope: ArtifactStorageAttestationEnvelope,
): string {
  return `0x${sha256Hex(stableSerialize(envelope))}`;
}

export async function signArtifactStorageAttestation(input: {
  envelope: ArtifactStorageAttestationEnvelope;
  signer: ArtifactStorageAttestationSigner;
}): Promise<SignedArtifactStorageAttestation> {
  const signedPayloadHash = hashArtifactStorageAttestationEnvelope(input.envelope);
  const signature = await input.signer.signMessage(getBytes(signedPayloadHash));
  return {
    envelope: input.envelope,
    signature,
  };
}

export async function createSignedArtifactStorageAttestation(
  input: Omit<Parameters<typeof buildArtifactStorageAttestationEnvelope>[0], "attestorAddress"> & {
    attestorAddress?: string;
    signer: ArtifactStorageAttestationSigner;
  },
): Promise<SignedArtifactStorageAttestation> {
  const attestorAddress = input.attestorAddress ?? (await input.signer.getAddress());
  return signArtifactStorageAttestation({
    envelope: buildArtifactStorageAttestationEnvelope({
      ...input,
      attestorAddress,
    }),
    signer: input.signer,
  });
}

export function verifyArtifactStorageAttestation(
  signed: SignedArtifactStorageAttestation,
): VerifiedArtifactStorageAttestation {
  const signedPayloadHash = hashArtifactStorageAttestationEnvelope(signed.envelope);
  const recoveredAddress = verifyMessage(getBytes(signedPayloadHash), signed.signature);
  if (recoveredAddress.toLowerCase() !== signed.envelope.attestorAddress.toLowerCase()) {
    throw new Error(
      `artifact storage attestation signature mismatch: expected ${signed.envelope.attestorAddress}, recovered ${recoveredAddress}`,
    );
  }
  return { recoveredAddress, signedPayloadHash };
}

export function toArtifactStorageAttestationRecordInput(
  signed: SignedArtifactStorageAttestation,
): ArtifactStorageAttestationInput {
  const { signedPayloadHash } = verifyArtifactStorageAttestation(signed);
  return {
    attestorAddress: signed.envelope.attestorAddress,
    cid: signed.envelope.cid,
    commitmentKind: signed.envelope.commitmentKind,
    evidenceRef: signed.envelope.evidenceRef,
    nodeId: signed.envelope.nodeId,
    provider: signed.envelope.provider,
    providerMetadata: signed.envelope.providerMetadata,
    retentionUntil: signed.envelope.retentionUntil,
    retrievalUrl: signed.envelope.retrievalUrl,
    signature: signed.signature,
    signedPayloadHash,
    storageClass: signed.envelope.storageClass,
    storageStartedAt: signed.envelope.storageStartedAt,
  };
}
