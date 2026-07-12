import { getBytes, verifyMessage } from "ethers";
import { sha256Hex } from "./sha256.js";

export type PublicWriteActionType =
  | "claim_create"
  | "claim_publish"
  | "claim_draft_from_artifact"
  | "domain_recompute"
  | "replication_job_open"
  | "replication_job_process"
  | "replication_job_resolve"
  | "source_submit"
  | "source_publication_confirm"
  | "source_publication_reject";

export type PublicWriteEnvelope = {
  actionType: PublicWriteActionType;
  actorAddress: string;
  chainId: number;
  issuedAt: string;
  payload: Record<string, unknown>;
  requestNonce: string;
  scopeKey: string;
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

export function hashPublicWriteEnvelope(envelope: PublicWriteEnvelope): string {
  return `0x${sha256Hex(stableSerialize(envelope))}`;
}

export function verifyPublicWriteEnvelope(input: {
  envelope: PublicWriteEnvelope;
  signature: string;
}): {
  recoveredAddress: string;
  requestHash: string;
} {
  const requestHash = hashPublicWriteEnvelope(input.envelope);
  const recoveredAddress = verifyMessage(getBytes(requestHash), input.signature);
  if (recoveredAddress.toLowerCase() !== input.envelope.actorAddress.toLowerCase()) {
    throw new Error(
      `public write request signature mismatch: expected ${input.envelope.actorAddress}, recovered ${recoveredAddress}`,
    );
  }
  return { recoveredAddress, requestHash };
}
