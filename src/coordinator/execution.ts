import type { Pool } from "pg";
import { getContract, requireContractEventId } from "../shared/contracts.js";
import { getDeploymentPath, loadDeploymentFile } from "../shared/deployment.js";
import { createOperatorSigner, destroySignerProvider } from "../shared/operator.js";
import {
  buildOperatorRequestEnvelope,
  insertOperatorRequest,
  markOperatorRequestFailed,
  markOperatorRequestSubmitted,
  reserveOperatorRequestNonce,
  signOperatorRequestEnvelope,
} from "../shared/operator-requests.js";
import type { PersistedArtifactRecord } from "../shared/persisted-artifacts.js";
import { persistJsonArtifact, sha256Hex } from "../shared/persisted-artifacts.js";
import { upsertPersistedArtifact } from "./store.js";

function normalizeBytes32(hex: string): string {
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

async function submitOnchainReplication(input: {
  assignedAgentId: string | null;
  claimId: string;
  env?: NodeJS.ProcessEnv;
  resultHash: string;
  runId: string;
  workerId: string;
}): Promise<{
  onchainReplicationId: string;
  submissionActor: string;
  submissionTxHash: string;
}> {
  const env = input.env ?? process.env;
  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
  const signer = createOperatorSigner(
    ["SP_REPLICATION_SUBMITTER_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
    { env, localAccountIndex: 3 },
  );
  try {
    const replicationRegistry = await getContract(
      "ReplicationRegistry",
      deployment.addresses.replicationRegistry,
      signer,
    );
    const environmentHash = normalizeBytes32(
      sha256Hex(
        JSON.stringify({
          claimId: input.claimId,
          runId: input.runId,
          workerId: input.workerId,
        }),
      ),
    );
    const tx = await replicationRegistry.submitReplication(
      BigInt(input.claimId),
      environmentHash,
      normalizeBytes32(input.resultHash),
      normalizeBytes32(input.resultHash),
      BigInt(input.assignedAgentId ?? "0"),
    );
    const receipt = await tx.wait();
    const onchainReplicationId = requireContractEventId(
      replicationRegistry,
      receipt,
      "ReplicationSubmitted",
      "replicationId",
    );
    return {
      onchainReplicationId,
      submissionActor: await signer.getAddress(),
      submissionTxHash: receipt.hash,
    };
  } finally {
    destroySignerProvider(signer);
  }
}

export class ReplicationSubmissionExecutionError extends Error {
  readonly operatorRequestId: string | null;

  constructor(message: string, operatorRequestId: string | null = null) {
    super(message);
    this.name = "ReplicationSubmissionExecutionError";
    this.operatorRequestId = operatorRequestId;
  }
}

export async function submitPersistedReplicationResult(input: {
  assignedAgentId: string | null;
  claimId: string;
  env?: NodeJS.ProcessEnv;
  jobId: string;
  pool: Pool;
  resultArtifact: PersistedArtifactRecord;
  runId: string;
  workerId: string;
}): Promise<{
  onchainReplicationId: string;
  operatorRequestArtifactKey: string;
  operatorRequestId: string;
  submissionActor: string;
  submissionTxHash: string;
}> {
  let operatorRequestId: string | null = null;
  try {
    const env = input.env ?? process.env;
    const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
    const signer = createOperatorSigner(
      ["SP_REPLICATION_SUBMITTER_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
      { env, localAccountIndex: 3 },
    );
    let operatorRequest: Awaited<ReturnType<typeof insertOperatorRequest>>;
    let requestArtifact: Awaited<ReturnType<typeof persistJsonArtifact>>;
    try {
      const operatorAddress = await signer.getAddress();
      const requestNonce = await reserveOperatorRequestNonce(input.pool, {
        actionType: "replication_submission",
        operatorAddress,
      });
      const requestEnvelope = buildOperatorRequestEnvelope({
        actionType: "replication_submission",
        chainId: deployment.chainId,
        operatorAddress,
        payload: {
          assignedAgentId: input.assignedAgentId ?? "0",
          claimId: input.claimId,
          resultArtifactKey: input.resultArtifact.artifactKey,
          resultHash: input.resultArtifact.sha256,
          runId: input.runId,
          workerId: input.workerId,
        },
        requestNonce,
        scopeKey: `replication-job:${input.jobId}`,
      });
      requestArtifact = await persistJsonArtifact("operator-request", requestEnvelope);
      await upsertPersistedArtifact(input.pool, requestArtifact);
      const requestSignature = await signOperatorRequestEnvelope(signer, requestEnvelope);
      operatorRequest = await insertOperatorRequest(input.pool, {
        actionType: "replication_submission",
        chainId: deployment.chainId,
        operatorAddress,
        payloadArtifactKey: requestArtifact.artifactKey,
        requestHash: requestSignature.requestHash,
        requestNonce,
        scopeKey: `replication-job:${input.jobId}`,
        signature: requestSignature.signature,
      });
      operatorRequestId = operatorRequest.requestId;
    } finally {
      destroySignerProvider(signer);
    }
    const submission = await submitOnchainReplication({
      assignedAgentId: input.assignedAgentId,
      claimId: input.claimId,
      env,
      resultHash: input.resultArtifact.sha256,
      runId: input.runId,
      workerId: input.workerId,
    });
    await markOperatorRequestSubmitted(
      input.pool,
      operatorRequest.requestId,
      submission.submissionTxHash,
    );
    return {
      ...submission,
      operatorRequestArtifactKey: requestArtifact.artifactKey,
      operatorRequestId: operatorRequest.requestId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (operatorRequestId) {
      await markOperatorRequestFailed(input.pool, operatorRequestId, message);
    }
    throw new ReplicationSubmissionExecutionError(message, operatorRequestId);
  }
}
