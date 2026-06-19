import { getBytes, verifyMessage } from "ethers";
import { sha256Hex } from "./persisted-artifacts.js";

export type AgentRequestActionType =
  | "artifact_task_audit_submission"
  | "artifact_task_claim"
  | "artifact_task_heartbeat"
  | "artifact_task_repair_submission"
  | "replication_job_claim"
  | "replication_job_heartbeat"
  | "replication_job_submission"
  | "source_discovery_submission"
  | "webhook_subscription_create"
  | "webhook_subscription_delete"
  | "webhook_subscription_ping"
  | "review_task_heartbeat"
  | "review_task_claim"
  | "review_task_submission";

export type AgentRequestEnvelope = {
  actionType: AgentRequestActionType;
  actorAddress: string;
  agentId: string;
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

export function hashAgentRequestEnvelope(envelope: AgentRequestEnvelope): string {
  return `0x${sha256Hex(stableSerialize(envelope))}`;
}

export function verifyAgentRequestEnvelope(input: {
  envelope: AgentRequestEnvelope;
  signature: string;
}): {
  recoveredAddress: string;
  requestHash: string;
} {
  const requestHash = hashAgentRequestEnvelope(input.envelope);
  const recoveredAddress = verifyMessage(getBytes(requestHash), input.signature);
  if (recoveredAddress.toLowerCase() !== input.envelope.actorAddress.toLowerCase()) {
    throw new Error(
      `agent request signature mismatch: expected ${input.envelope.actorAddress}, recovered ${recoveredAddress}`,
    );
  }
  return { recoveredAddress, requestHash };
}

export type AgentRequestSigner = {
  getAddress(): Promise<string>;
  signMessage(message: string | Uint8Array): Promise<string>;
};

export type SignedAgentRequestEnvelope = {
  envelope: AgentRequestEnvelope;
  signature: string;
};

export async function signAgentRequestEnvelope(input: {
  envelope: AgentRequestEnvelope;
  signer: AgentRequestSigner;
}): Promise<SignedAgentRequestEnvelope> {
  const requestHash = hashAgentRequestEnvelope(input.envelope);
  const signature = await input.signer.signMessage(getBytes(requestHash));
  return {
    envelope: input.envelope,
    signature,
  };
}

export async function createSignedAgentRequest(input: {
  actionType: AgentRequestActionType;
  actorAddress?: string;
  agentId: string;
  issuedAt?: string;
  payload: Record<string, unknown>;
  requestNonce: string;
  scopeKey: string;
  signer: AgentRequestSigner;
}): Promise<SignedAgentRequestEnvelope> {
  const actorAddress = input.actorAddress ?? (await input.signer.getAddress());
  return signAgentRequestEnvelope({
    envelope: {
      actionType: input.actionType,
      actorAddress,
      agentId: input.agentId,
      issuedAt: input.issuedAt ?? new Date().toISOString(),
      payload: input.payload,
      requestNonce: input.requestNonce,
      scopeKey: input.scopeKey,
    },
    signer: input.signer,
  });
}
