export type ArtifactDurabilityClass = "A" | "B" | "C" | "D";

export type ArtifactStorageCommitmentKind =
  | "filecoin"
  | "hot"
  | "institutional"
  | "mirror"
  | "provider"
  | "temporary";

export type ArtifactStoragePolicyInput = {
  bundleCid?: string | null;
  bundleMemberPath?: string | null;
  durabilityClass: ArtifactDurabilityClass;
  metadata?: Record<string, unknown>;
  repairPriority?: number;
  requiredIndependentRetrievalPaths?: number;
  requiredReplicaCount?: number;
  requiresFilecoinOrEquivalent?: boolean;
  retentionUntil?: string | null;
};

export type ArtifactStorageAttestationInput = {
  attestorAddress: string;
  cid: string;
  commitmentKind: ArtifactStorageCommitmentKind;
  evidenceRef?: string | null;
  nodeId?: string | null;
  provider: string;
  providerMetadata?: Record<string, unknown>;
  retentionUntil?: string | null;
  retrievalUrl?: string | null;
  signature: string;
  signedPayloadHash: string;
  storageClass: ArtifactDurabilityClass;
  storageStartedAt?: string;
};

export type ArtifactStorageClassPolicy = {
  durabilityClass: ArtifactDurabilityClass;
  repairPriority: number;
  requiredIndependentRetrievalPaths: number;
  requiredReplicaCount: number;
  requiresFilecoinOrEquivalent: boolean;
};

export const ARTIFACT_STORAGE_CLASS_POLICIES: Record<
  ArtifactDurabilityClass,
  ArtifactStorageClassPolicy
> = {
  A: {
    durabilityClass: "A",
    repairPriority: 100,
    requiredIndependentRetrievalPaths: 2,
    requiredReplicaCount: 2,
    requiresFilecoinOrEquivalent: true,
  },
  B: {
    durabilityClass: "B",
    repairPriority: 50,
    requiredIndependentRetrievalPaths: 1,
    requiredReplicaCount: 1,
    requiresFilecoinOrEquivalent: true,
  },
  C: {
    durabilityClass: "C",
    repairPriority: 80,
    requiredIndependentRetrievalPaths: 1,
    requiredReplicaCount: 1,
    requiresFilecoinOrEquivalent: true,
  },
  D: {
    durabilityClass: "D",
    repairPriority: 10,
    requiredIndependentRetrievalPaths: 0,
    requiredReplicaCount: 0,
    requiresFilecoinOrEquivalent: false,
  },
};

export function defaultArtifactStoragePolicy(
  durabilityClass: ArtifactDurabilityClass,
): ArtifactStorageClassPolicy {
  return ARTIFACT_STORAGE_CLASS_POLICIES[durabilityClass];
}

export function resolveArtifactStoragePolicyInput(
  input: ArtifactStoragePolicyInput,
): Required<
  Pick<
    ArtifactStoragePolicyInput,
    | "durabilityClass"
    | "metadata"
    | "repairPriority"
    | "requiredIndependentRetrievalPaths"
    | "requiredReplicaCount"
    | "requiresFilecoinOrEquivalent"
  >
> &
  Pick<ArtifactStoragePolicyInput, "bundleCid" | "bundleMemberPath" | "retentionUntil"> {
  const defaults = defaultArtifactStoragePolicy(input.durabilityClass);
  return {
    bundleCid: input.bundleCid ?? null,
    bundleMemberPath: input.bundleMemberPath ?? null,
    durabilityClass: input.durabilityClass,
    metadata: input.metadata ?? {},
    repairPriority: input.repairPriority ?? defaults.repairPriority,
    requiredIndependentRetrievalPaths:
      input.requiredIndependentRetrievalPaths ?? defaults.requiredIndependentRetrievalPaths,
    requiredReplicaCount: input.requiredReplicaCount ?? defaults.requiredReplicaCount,
    requiresFilecoinOrEquivalent:
      input.requiresFilecoinOrEquivalent ?? defaults.requiresFilecoinOrEquivalent,
    retentionUntil: input.retentionUntil ?? null,
  };
}
