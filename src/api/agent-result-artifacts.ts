import {
  MAX_INLINE_JSON_ARTIFACT_BYTES,
  type PersistedArtifactRecord,
  persistJsonArtifact,
  readPersistedArtifactBytes,
  sha256Hex,
} from "../shared/persisted-artifacts.js";

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid_agent_result_artifact");
  }
  return value;
}

export function parseAgentResultArtifact(
  value: unknown,
  expectedKind: string,
): PersistedArtifactRecord | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_agent_result_artifact");
  }
  const record = value as Record<string, unknown>;
  const sha256 = requiredString(record, "sha256");
  const artifactKey = requiredString(record, "artifactKey");
  const storagePath = requiredString(record, "storagePath");
  const byteLength = record.byteLength;
  if (
    record.kind !== expectedKind ||
    record.contentType !== "application/json" ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    !/^0x[0-9a-f]{64}$/i.test(sha256) ||
    artifactKey !== `${expectedKind}-${sha256.slice(2, 18)}` ||
    !/^(data:application\/json;base64,|https:\/\/|ipfs:\/\/)/.test(storagePath)
  ) {
    throw new Error("invalid_agent_result_artifact");
  }
  return {
    artifactKey,
    byteLength,
    contentType: "application/json",
    kind: expectedKind,
    sha256,
    storagePath,
  };
}

export async function resolveAgentResultArtifact(input: {
  fallbackPayload: unknown;
  kind: string;
  suppliedArtifact: unknown;
}): Promise<PersistedArtifactRecord> {
  const supplied = parseAgentResultArtifact(input.suppliedArtifact, input.kind);
  if (!supplied) {
    return persistJsonArtifact(input.kind, input.fallbackPayload);
  }
  const bytes = await readPersistedArtifactBytes(supplied);
  if (
    bytes.byteLength !== supplied.byteLength ||
    bytes.byteLength > MAX_INLINE_JSON_ARTIFACT_BYTES ||
    `0x${sha256Hex(bytes)}`.toLowerCase() !== supplied.sha256.toLowerCase()
  ) {
    throw new Error("agent_result_artifact_hash_mismatch");
  }
  return supplied;
}
