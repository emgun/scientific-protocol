import type http from "node:http";
import { keccak256, toUtf8Bytes } from "ethers";
import type { Pool } from "pg";
import {
  type AgentRequestActionType,
  type AgentRequestEnvelope,
  verifyAgentRequestEnvelope,
} from "../shared/agent-requests.js";
import { readBooleanEnv } from "../shared/cli.js";
import { getContract, getProvider, getRpcUrl } from "../shared/contracts.js";
import { loadDeploymentFile } from "../shared/deployment.js";
import { isLocalDevelopmentRpcUrl, parseOptionalAddressCsv } from "../shared/env.js";
import { createOperatorSigner, destroySignerProvider } from "../shared/operator.js";
import {
  type PublicWriteActionType,
  type PublicWriteEnvelope,
  verifyPublicWriteEnvelope,
} from "../shared/public-write-requests.js";
import { readEnvValue } from "../shared/secrets.js";
import type { SourceRecordView } from "../sources/types.js";
import type { ApiDependencies } from "./dependencies.js";
import { createHttpRequestError, type HttpRequestError, readJsonBody } from "./http.js";

export type SignedAgentRequestBody = {
  envelope: AgentRequestEnvelope;
  signature: string;
};

export type SignedPublicWriteRequestBody = {
  envelope: PublicWriteEnvelope;
  signature: string;
};

export type OperatorLifecycleAuthentication =
  | {
      acceptedRequestId: string;
      envelope: PublicWriteEnvelope;
      mode: "signed";
      payload: Record<string, unknown>;
    }
  | {
      mode: "token";
      payload: Record<string, unknown>;
    };

export async function readSignedAgentRequestBody(
  request: http.IncomingMessage,
): Promise<SignedAgentRequestBody> {
  const body = (await readJsonBody(request)) as Record<string, unknown>;
  const envelope = body.envelope;
  const signature = body.signature;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("invalid_agent_request_envelope");
  }
  if (typeof signature !== "string" || !signature.trim()) {
    throw new Error("invalid_agent_request_signature");
  }
  return {
    envelope: envelope as AgentRequestEnvelope,
    signature,
  };
}

export async function readSignedPublicWriteRequestBody(
  request: http.IncomingMessage,
): Promise<SignedPublicWriteRequestBody> {
  const body = (await readJsonBody(request)) as Record<string, unknown>;
  const envelope = body.envelope;
  const signature = body.signature;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("invalid_public_write_request_envelope");
  }
  if (typeof signature !== "string" || !signature.trim()) {
    throw new Error("invalid_public_write_request_signature");
  }
  return {
    envelope: envelope as PublicWriteEnvelope,
    signature,
  };
}

export function isSignedPublicWriteRequestBodyValue(
  value: unknown,
): value is SignedPublicWriteRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    !!body.envelope &&
    typeof body.envelope === "object" &&
    !Array.isArray(body.envelope) &&
    typeof body.signature === "string" &&
    body.signature.trim().length > 0
  );
}

export async function assertAuthorizedAgentActor(
  dependencies: ApiDependencies,
  pool: Pool,
  agentId: string,
  actorAddress: string,
): Promise<void> {
  const [agent, controllers] = await Promise.all([
    dependencies.readAgent(pool, agentId),
    dependencies.readAgentControllers(pool, agentId),
  ]);
  if (!agent) {
    throw new Error("agent_not_found");
  }
  const normalizedActor = actorAddress.toLowerCase();
  if (agent.operator.toLowerCase() === normalizedActor) {
    return;
  }
  const authorizedController = controllers.some(
    (controller) =>
      controller.authorized && controller.controller.toLowerCase() === normalizedActor,
  );
  if (!authorizedController) {
    throw new Error("agent_actor_unauthorized");
  }
}

export async function authenticateSignedAgentRequest(
  dependencies: ApiDependencies,
  pool: Pool,
  request: http.IncomingMessage,
  expected: {
    actionType: AgentRequestActionType;
    scopeKey?: string;
    scopeKeyValidator?: (scopeKey: string, envelope: AgentRequestEnvelope) => boolean;
  },
): Promise<{
  envelope: AgentRequestEnvelope;
  requestHash: string;
  signature: string;
}> {
  const signed = await readSignedAgentRequestBody(request);
  const { envelope, signature } = signed;
  if (envelope.actionType !== expected.actionType) {
    throw new Error("agent_request_action_mismatch");
  }
  if (expected.scopeKey !== undefined && envelope.scopeKey !== expected.scopeKey) {
    throw new Error("agent_request_scope_mismatch");
  }
  if (expected.scopeKeyValidator && !expected.scopeKeyValidator(envelope.scopeKey, envelope)) {
    throw new Error("agent_request_scope_mismatch");
  }
  const issuedAt = new Date(envelope.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error("invalid_agent_request_issued_at");
  }
  const maxAgeMs = 15 * 60 * 1000;
  if (Math.abs(Date.now() - issuedAt.getTime()) > maxAgeMs) {
    throw new Error("agent_request_expired");
  }
  const { requestHash } = verifyAgentRequestEnvelope(signed);
  await assertAuthorizedAgentActor(dependencies, pool, envelope.agentId, envelope.actorAddress);
  return {
    envelope,
    requestHash,
    signature,
  };
}

export async function authenticateSignedPublicWriteRequest(
  dependencies: ApiDependencies,
  pool: Pool,
  request: http.IncomingMessage,
  expected: {
    actionType: PublicWriteActionType | PublicWriteActionType[];
    allowRecordedReplay?: boolean;
    chainId: number;
    scopeKey?: string;
    scopeKeyValidator?: (scopeKey: string, envelope: PublicWriteEnvelope) => boolean;
  },
): Promise<{
  acceptedRequestId: string;
  envelope: PublicWriteEnvelope;
  requestHash: string;
  signature: string;
}> {
  const signed = await readSignedPublicWriteRequestBody(request);
  return authenticateSignedPublicWriteRequestBody(dependencies, pool, signed, expected);
}

export async function authenticateSignedPublicWriteRequestBody(
  dependencies: ApiDependencies,
  pool: Pool,
  signed: SignedPublicWriteRequestBody,
  expected: {
    actionType: PublicWriteActionType | PublicWriteActionType[];
    allowRecordedReplay?: boolean;
    chainId: number;
    scopeKey?: string;
    scopeKeyValidator?: (scopeKey: string, envelope: PublicWriteEnvelope) => boolean;
  },
): Promise<{
  acceptedRequestId: string;
  envelope: PublicWriteEnvelope;
  requestHash: string;
  signature: string;
}> {
  const { envelope, signature } = signed;
  const expectedActionTypes = Array.isArray(expected.actionType)
    ? expected.actionType
    : [expected.actionType];
  if (!expectedActionTypes.includes(envelope.actionType)) {
    throw new Error("public_write_action_mismatch");
  }
  if (envelope.chainId !== expected.chainId) {
    throw new Error("public_write_chain_mismatch");
  }
  if (expected.scopeKey !== undefined && envelope.scopeKey !== expected.scopeKey) {
    throw new Error("public_write_scope_mismatch");
  }
  if (expected.scopeKeyValidator && !expected.scopeKeyValidator(envelope.scopeKey, envelope)) {
    throw new Error("public_write_scope_mismatch");
  }
  const { requestHash } = verifyPublicWriteEnvelope(signed);
  const recorded = expected.allowRecordedReplay
    ? await dependencies.readPublicWriteRequestByHash(pool, requestHash)
    : undefined;
  if (recorded) {
    return {
      acceptedRequestId: recorded.requestId,
      envelope,
      requestHash,
      signature,
    };
  }
  const issuedAt = new Date(envelope.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error("invalid_public_write_issued_at");
  }
  const maxAgeMs = 15 * 60 * 1000;
  if (Math.abs(Date.now() - issuedAt.getTime()) > maxAgeMs) {
    throw new Error("public_write_request_expired");
  }
  let acceptedRequestId = "";
  try {
    const accepted = await dependencies.insertPublicWriteRequest(pool, {
      actionType: envelope.actionType,
      actorAddress: envelope.actorAddress,
      chainId: envelope.chainId,
      payload: envelope.payload,
      requestHash,
      requestNonce: envelope.requestNonce,
      scopeKey: envelope.scopeKey,
      signature,
      status: "pending",
    });
    acceptedRequestId = accepted.requestId;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      const existing = expected.allowRecordedReplay
        ? await dependencies.readPublicWriteRequestByHash(pool, requestHash)
        : undefined;
      if (existing) {
        acceptedRequestId = existing.requestId;
      } else {
        // Same actor/nonce with different signed bytes is never resumable.
        throw new Error("public_write_request_duplicate");
      }
    } else {
      throw error;
    }
  }
  return {
    acceptedRequestId,
    envelope,
    requestHash,
    signature,
  };
}

export const ROLE_HASH = {
  CHECKPOINT_PUBLISHER_ROLE: keccak256(toUtf8Bytes("CHECKPOINT_PUBLISHER_ROLE")),
  CLAIM_SUBMITTER_ROLE: keccak256(toUtf8Bytes("CLAIM_SUBMITTER_ROLE")),
  RESOLVER_ROLE: keccak256(toUtf8Bytes("RESOLVER_ROLE")),
} as const;

export function parseAuthorizedAddresses(raw: string | null | undefined): string[] {
  return parseOptionalAddressCsv(
    raw ?? undefined,
    "SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES",
  ).map((entry) => entry.toLowerCase());
}

export async function listReplicationSubmitterAuthorizedAddresses(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const configured = parseAuthorizedAddresses(
    readEnvValue(env, "SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES"),
  );
  if (configured.length > 0) {
    return configured;
  }
  const signer = createOperatorSigner(
    ["SP_REPLICATION_SUBMITTER_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
    { env, localAccountIndex: 3 },
  );
  try {
    return [(await signer.getAddress()).toLowerCase()];
  } finally {
    destroySignerProvider(signer);
  }
}

export async function listReplicationSubmitterAuthorizedAddressesForPublicConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  try {
    return await listReplicationSubmitterAuthorizedAddresses(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("missing operator private key")) {
      return [];
    }
    throw error;
  }
}

export async function accessControllerHasRole(
  deploymentPath: string,
  roleHash: string,
  account: string,
  rpcUrl = getRpcUrl(),
): Promise<boolean> {
  const deployment = await loadDeploymentFile(deploymentPath);
  const provider = getProvider(rpcUrl);
  try {
    const accessController = await getContract(
      "AccessController",
      deployment.addresses.accessController,
      provider,
    );
    return Boolean(await accessController.hasRole(roleHash, account));
  } finally {
    if (typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}

export function operatorTokenFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readBooleanEnv(env, "SP_ENABLE_OPERATOR_TOKEN_FALLBACK", false);
}

export async function assertAuthorizedSourcePublicationActor(
  deploymentPath: string,
  source: SourceRecordView,
  actorAddress: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const normalizedActor = actorAddress.toLowerCase();
  if (source.submittedByActor?.toLowerCase() === normalizedActor) {
    return;
  }
  if (
    !source.submittedByActor &&
    (await accessControllerHasRole(
      deploymentPath,
      ROLE_HASH.CLAIM_SUBMITTER_ROLE,
      normalizedActor,
      getRpcUrl(env),
    ))
  ) {
    return;
  }
  throw new Error("source_publication_actor_unauthorized");
}

export function mapSignedPublicWriteAuthError(error: unknown): HttpRequestError {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "json_body_too_large") {
    return createHttpRequestError(413, message);
  }
  if (
    message === "invalid_content_length" ||
    message === "invalid_json_body" ||
    message === "invalid_public_write_request_envelope" ||
    message === "invalid_public_write_request_signature" ||
    message === "public_write_action_mismatch" ||
    message === "public_write_chain_mismatch" ||
    message === "public_write_scope_mismatch" ||
    message === "invalid_public_write_issued_at" ||
    message === "public_write_request_expired"
  ) {
    return createHttpRequestError(400, message);
  }
  if (message === "public_write_request_duplicate") {
    return createHttpRequestError(409, message);
  }
  if (message.includes("public write request signature mismatch")) {
    return createHttpRequestError(401, "operator_unauthorized");
  }
  return createHttpRequestError(500, message);
}

export async function authenticateOperatorLifecycleRequest(
  dependencies: ApiDependencies,
  pool: Pool,
  request: http.IncomingMessage,
  body: unknown,
  expected: {
    actionType: Extract<
      PublicWriteActionType,
      "domain_recompute" | "replication_job_process" | "replication_job_resolve"
    >;
    chainId: number;
    authorizeSignedActor: (actorAddress: string) => Promise<boolean>;
    scopeKey: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<OperatorLifecycleAuthentication> {
  if (isSignedPublicWriteRequestBodyValue(body)) {
    let authenticated: Awaited<ReturnType<typeof authenticateSignedPublicWriteRequestBody>>;
    try {
      authenticated = await authenticateSignedPublicWriteRequestBody(dependencies, pool, body, {
        actionType: expected.actionType,
        chainId: expected.chainId,
        scopeKey: expected.scopeKey,
      });
    } catch (error) {
      throw mapSignedPublicWriteAuthError(error);
    }
    let authorized = false;
    try {
      authorized = await expected.authorizeSignedActor(authenticated.envelope.actorAddress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await dependencies.markPublicWriteRequestRejected(
        pool,
        authenticated.acceptedRequestId,
        message,
      );
      throw createHttpRequestError(500, message);
    }
    if (!authorized) {
      await dependencies.markPublicWriteRequestRejected(
        pool,
        authenticated.acceptedRequestId,
        "operator_forbidden",
      );
      throw createHttpRequestError(403, "operator_forbidden");
    }
    return {
      acceptedRequestId: authenticated.acceptedRequestId,
      envelope: authenticated.envelope,
      mode: "signed",
      payload: authenticated.envelope.payload,
    };
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const env = expected.env ?? process.env;
    if (operatorTokenFallbackEnabled(env) && isOperatorAuthorized(request, env)) {
      return {
        mode: "token",
        payload: body as Record<string, unknown>,
      };
    }
    throw createHttpRequestError(401, "operator_unauthorized");
  }

  throw createHttpRequestError(400, "invalid_json_body");
}

export function readOperatorApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = readEnvValue(env, "SP_OPERATOR_API_TOKEN");
  return token ? token : null;
}

export function isOperatorAuthorized(
  request: http.IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuredToken = readOperatorApiToken(env);
  if (!configuredToken) {
    return isLocalDevelopmentRpcUrl(getRpcUrl(env));
  }

  const headerToken = request.headers["x-sp-operator-token"];
  if (typeof headerToken === "string" && headerToken === configuredToken) {
    return true;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  return authHeader.slice("Bearer ".length) === configuredToken;
}
