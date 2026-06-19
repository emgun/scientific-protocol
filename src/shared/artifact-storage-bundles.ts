import type {
  ArtifactDurabilityClass,
  ArtifactStoragePolicyInput,
} from "./artifact-storage-policy.js";
import { sha256Hex } from "./persisted-artifacts.js";

export type ArtifactStorageBundleManifestArtifactInput = {
  artifactKey: string;
  byteLength: number;
  cid: string;
  contentType: string;
  durabilityClass: ArtifactDurabilityClass;
  memberPath: string;
  metadata?: Record<string, unknown>;
  sha256: string;
  sourceUri?: string | null;
};

export type ArtifactStorageBundleManifestInput = {
  artifacts: ArtifactStorageBundleManifestArtifactInput[];
  bundleCid?: string | null;
  bundleKey: string;
  bundleUri?: string | null;
  generatedAt?: string;
  metadata?: Record<string, unknown>;
  storageRail: string;
};

export type ArtifactStorageBundleManifestArtifact = Required<
  Omit<ArtifactStorageBundleManifestArtifactInput, "metadata" | "sourceUri">
> & {
  metadata: Record<string, unknown>;
  sourceUri: string | null;
};

export type ArtifactStorageBundleManifest = {
  artifacts: ArtifactStorageBundleManifestArtifact[];
  bundleCid: string | null;
  bundleKey: string;
  bundleUri: string | null;
  generatedAt: string;
  kind: "scientific.artifact-storage-bundle";
  manifestDigest: string;
  metadata: Record<string, unknown>;
  storageRail: string;
  version: 1;
};

export type ArtifactStorageBundlePolicyInput = {
  artifactKey: string;
  policy: Pick<
    ArtifactStoragePolicyInput,
    "bundleCid" | "bundleMemberPath" | "durabilityClass" | "metadata"
  >;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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
  return JSON.stringify(value) ?? "null";
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

function normalizeMemberPath(value: string): string {
  const normalized = normalizeRequiredText(value, "artifact bundle memberPath").replace(
    /\\/gu,
    "/",
  );
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("artifact bundle memberPath must be relative and safe");
  }
  return normalized;
}

function normalizeByteLength(value: number, artifactKey: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`artifact ${artifactKey} byteLength must be a non-negative safe integer`);
  }
  return value;
}

function normalizeSha256(value: string, artifactKey: string): string {
  const normalized = normalizeRequiredText(value, `artifact ${artifactKey} sha256`).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`artifact ${artifactKey} sha256 must be 64 lowercase hex characters`);
  }
  return normalized;
}

function normalizeArtifact(
  artifact: ArtifactStorageBundleManifestArtifactInput,
): ArtifactStorageBundleManifestArtifact {
  const artifactKey = normalizeRequiredText(artifact.artifactKey, "artifactKey");
  return {
    artifactKey,
    byteLength: normalizeByteLength(artifact.byteLength, artifactKey),
    cid: normalizeRequiredText(artifact.cid, `artifact ${artifactKey} cid`),
    contentType: normalizeRequiredText(artifact.contentType, `artifact ${artifactKey} contentType`),
    durabilityClass: artifact.durabilityClass,
    memberPath: normalizeMemberPath(artifact.memberPath),
    metadata: artifact.metadata ?? {},
    sha256: normalizeSha256(artifact.sha256, artifactKey),
    sourceUri: normalizeOptionalText(artifact.sourceUri),
  };
}

export function buildArtifactStorageBundleManifest(
  input: ArtifactStorageBundleManifestInput,
): ArtifactStorageBundleManifest {
  const bundleKey = normalizeRequiredText(input.bundleKey, "bundleKey");
  const storageRail = normalizeRequiredText(input.storageRail, "storageRail");
  if (input.artifacts.length === 0) {
    throw new Error("artifact storage bundle must include at least one artifact");
  }
  const artifacts = input.artifacts
    .map(normalizeArtifact)
    .sort((left, right) => left.artifactKey.localeCompare(right.artifactKey));
  const duplicatePaths = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const artifact of artifacts) {
    if (duplicatePaths.has(artifact.memberPath)) {
      throw new Error(`artifact bundle memberPath duplicates ${artifact.memberPath}`);
    }
    if (duplicateKeys.has(artifact.artifactKey)) {
      throw new Error(`artifact bundle artifactKey duplicates ${artifact.artifactKey}`);
    }
    duplicatePaths.add(artifact.memberPath);
    duplicateKeys.add(artifact.artifactKey);
  }
  const baseManifest = {
    artifacts,
    bundleCid: normalizeOptionalText(input.bundleCid),
    bundleKey,
    bundleUri: normalizeOptionalText(input.bundleUri),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    kind: "scientific.artifact-storage-bundle" as const,
    metadata: input.metadata ?? {},
    storageRail,
    version: 1 as const,
  };
  return {
    ...baseManifest,
    manifestDigest: `sha256:${sha256Hex(stableSerialize(baseManifest))}`,
  };
}

export function verifyArtifactStorageBundleManifest(
  manifest: ArtifactStorageBundleManifest,
): string {
  const { manifestDigest: declaredDigest, ...digestInput } = manifest;
  const expectedDigest = `sha256:${sha256Hex(stableSerialize(digestInput))}`;
  if (declaredDigest !== expectedDigest) {
    throw new Error(
      `artifact storage bundle manifestDigest mismatch: expected ${expectedDigest}, received ${declaredDigest}`,
    );
  }
  return expectedDigest;
}

export function createArtifactStorageBundlePolicyInputs(
  manifest: ArtifactStorageBundleManifest,
): ArtifactStorageBundlePolicyInput[] {
  verifyArtifactStorageBundleManifest(manifest);
  return manifest.artifacts.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    policy: {
      bundleCid: manifest.bundleCid,
      bundleMemberPath: artifact.memberPath,
      durabilityClass: artifact.durabilityClass,
      metadata: {
        artifactCid: artifact.cid,
        bundleKey: manifest.bundleKey,
        bundleUri: manifest.bundleUri,
        manifestDigest: manifest.manifestDigest,
        storageRail: manifest.storageRail,
      },
    },
  }));
}
