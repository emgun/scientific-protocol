import { NonceManager } from "ethers";
import {
  readPersistedArtifact,
  readReplicationJob,
  upsertPersistedArtifact,
} from "../coordinator/store.js";
import { getDatabaseUrl } from "../indexer/store.js";
import { getContract } from "../shared/contracts.js";
import { getDeploymentPath, loadDeploymentFile } from "../shared/deployment.js";
import { createOperatorSigner } from "../shared/operator.js";
import {
  buildOperatorRequestEnvelope,
  insertOperatorRequest,
  markOperatorRequestFailed,
  markOperatorRequestSubmitted,
  reserveOperatorRequestNonce,
  signOperatorRequestEnvelope,
} from "../shared/operator-requests.js";
import {
  persistJsonArtifact,
  readVerifiedJsonArtifact,
  sha256Hex,
  verifyPersistedArtifact,
} from "../shared/persisted-artifacts.js";
import {
  insertResolutionRun,
  markResolutionRunFailed,
  markResolutionRunSubmitted,
  prepareResolverStore,
  type ResolutionRunView,
  readResolutionRunsPage,
} from "./store.js";

const CLAIM_STATUS = {
  Draft: 0,
  Published: 1,
  UnderReplication: 2,
  ProvisionallySupported: 3,
  Qualified: 4,
  Refuted: 5,
  Fraudulent: 6,
  Deprecated: 7,
} as const;

const RESOLUTION_STATUS = {
  Pending: 0,
  Supported: 1,
  Qualified: 2,
  Inconclusive: 3,
  Refuted: 4,
  FraudSignal: 5,
  Escalated: 6,
} as const;

const RESOLVER_TYPE = {
  HumanResolver: 1,
  AgentWorker: 2,
  ComputationOracle: 3,
  BenchmarkOracle: 4,
  WetLabCouncil: 5,
  AppealCourt: 6,
} as const;

type ProposedResolution = {
  claimStatus: number | null;
  confidenceBps: number;
  resolutionStatus: number;
  resolverType: number;
};

type ResolveJobOptions = {
  claimStatus?: number | null;
  confidenceBps?: number;
  connectionString?: string;
  env?: NodeJS.ProcessEnv;
  jobId: string;
  resolutionStatus?: number;
};

function normalizeBytes32(hex: string): string {
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function defaultResolutionForDomain(domainId: number): ProposedResolution {
  if (domainId === 2) {
    return {
      claimStatus: CLAIM_STATUS.UnderReplication,
      confidenceBps: 6000,
      resolutionStatus: RESOLUTION_STATUS.Inconclusive,
      resolverType: RESOLVER_TYPE.WetLabCouncil,
    };
  }
  if (domainId === 3) {
    return {
      claimStatus: CLAIM_STATUS.Qualified,
      confidenceBps: 8800,
      resolutionStatus: RESOLUTION_STATUS.Qualified,
      resolverType: RESOLVER_TYPE.BenchmarkOracle,
    };
  }
  return {
    claimStatus: CLAIM_STATUS.Qualified,
    confidenceBps: 9200,
    resolutionStatus: RESOLUTION_STATUS.Supported,
    resolverType: RESOLVER_TYPE.ComputationOracle,
  };
}

function defaultClaimStatusForResolution(resolutionStatus: number): number | null {
  if (
    resolutionStatus === RESOLUTION_STATUS.Supported ||
    resolutionStatus === RESOLUTION_STATUS.Qualified
  ) {
    return CLAIM_STATUS.Qualified;
  }
  if (resolutionStatus === RESOLUTION_STATUS.Refuted) {
    return CLAIM_STATUS.Refuted;
  }
  if (resolutionStatus === RESOLUTION_STATUS.FraudSignal) {
    return CLAIM_STATUS.Fraudulent;
  }
  if (
    resolutionStatus === RESOLUTION_STATUS.Inconclusive ||
    resolutionStatus === RESOLUTION_STATUS.Escalated
  ) {
    return CLAIM_STATUS.UnderReplication;
  }
  return null;
}

async function maybeMoveClaimIntoReplication(
  claimRegistry: Awaited<ReturnType<typeof getContract>>,
  claimId: bigint,
  currentStatus: number,
  txHashes: string[],
): Promise<number> {
  if (currentStatus === CLAIM_STATUS.Published) {
    const tx = await claimRegistry.setClaimStatus(claimId, CLAIM_STATUS.UnderReplication);
    const receipt = await tx.wait();
    txHashes.push(receipt.hash);
    return CLAIM_STATUS.UnderReplication;
  }
  return currentStatus;
}

export async function resolveReplicationJob(
  options: ResolveJobOptions,
): Promise<ResolutionRunView> {
  const env = options.env ?? process.env;
  const pool = await prepareResolverStore(options.connectionString ?? getDatabaseUrl(env));
  let signer: NonceManager | undefined;
  try {
    const job = await readReplicationJob(pool, options.jobId);
    if (!job) {
      throw new Error(`replication job ${options.jobId} not found`);
    }
    if (job.status !== "completed") {
      throw new Error(`replication job ${options.jobId} must be completed before resolution`);
    }
    if (!job.onchainReplicationId) {
      throw new Error(`replication job ${options.jobId} has no onchain replication id`);
    }

    const existingRuns = await readResolutionRunsPage(pool, {
      limit: 1,
      offset: 0,
      replicationId: job.onchainReplicationId,
    });
    if (existingRuns.total > 0) {
      throw new Error(`replication ${job.onchainReplicationId} already has a resolution run`);
    }

    const persistedArtifact = job.resultArtifactKey
      ? await readPersistedArtifact(pool, job.resultArtifactKey)
      : undefined;
    if (!persistedArtifact) {
      throw new Error(`replication job ${options.jobId} is missing a persisted result artifact`);
    }
    const artifactVerified = await verifyPersistedArtifact(persistedArtifact);
    if (!artifactVerified) {
      throw new Error(
        `replication result artifact ${persistedArtifact.artifactKey} failed integrity verification`,
      );
    }
    const executionManifest =
      await readVerifiedJsonArtifact<Record<string, unknown>>(persistedArtifact);

    const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
    signer = new NonceManager(
      createOperatorSigner(["SP_RESOLVER_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"], {
        env,
        localAccountIndex: 4,
      }),
    );
    const [claimRegistry, replicationRegistry] = await Promise.all([
      getContract("ClaimRegistry", deployment.addresses.claimRegistry, signer),
      getContract("ReplicationRegistry", deployment.addresses.replicationRegistry, signer),
    ]);

    const claimIdBigInt = BigInt(job.claimId);
    const replicationIdBigInt = BigInt(job.onchainReplicationId);
    const claimRecord = await claimRegistry.getClaim(claimIdBigInt);
    const domainId = Number(claimRecord.summary.domainId);
    const defaults = defaultResolutionForDomain(domainId);
    const proposedResolution: ProposedResolution = {
      claimStatus:
        options.claimStatus === undefined
          ? defaultClaimStatusForResolution(options.resolutionStatus ?? defaults.resolutionStatus)
          : options.claimStatus,
      confidenceBps: options.confidenceBps ?? defaults.confidenceBps,
      resolutionStatus: options.resolutionStatus ?? defaults.resolutionStatus,
      resolverType: defaults.resolverType,
    };

    const rationalePayload = {
      artifactKey: persistedArtifact.artifactKey,
      artifactVerified,
      claimId: job.claimId,
      completedAt: job.completedAt,
      domainId,
      executionManifest,
      jobId: job.jobId,
      onchainReplicationId: job.onchainReplicationId,
      policyVersion: "resolver/default-v1",
      proposedResolution,
      resolver: await signer.getAddress(),
      resultHash: job.resultHash,
      reviewedAt: new Date().toISOString(),
    };
    const rationaleArtifact = await persistJsonArtifact("resolution-rationale", rationalePayload);
    await upsertPersistedArtifact(pool, rationaleArtifact);
    const operatorAddress = await signer.getAddress();
    const requestNonce = await reserveOperatorRequestNonce(pool, {
      actionType: "resolution_submission",
      operatorAddress,
    });
    const requestEnvelope = buildOperatorRequestEnvelope({
      actionType: "resolution_submission",
      chainId: deployment.chainId,
      operatorAddress,
      payload: {
        claimId: job.claimId,
        confidenceBps: proposedResolution.confidenceBps,
        jobId: job.jobId,
        rationaleArtifactKey: rationaleArtifact.artifactKey,
        replicationId: job.onchainReplicationId,
        resolutionStatus: proposedResolution.resolutionStatus,
        resolverType: proposedResolution.resolverType,
      },
      requestNonce,
      scopeKey: `replication:${job.onchainReplicationId}`,
    });
    const requestArtifact = await persistJsonArtifact("operator-request", requestEnvelope);
    await upsertPersistedArtifact(pool, requestArtifact);
    const requestSignature = await signOperatorRequestEnvelope(signer, requestEnvelope);
    const operatorRequest = await insertOperatorRequest(pool, {
      actionType: "resolution_submission",
      chainId: deployment.chainId,
      operatorAddress,
      payloadArtifactKey: requestArtifact.artifactKey,
      requestHash: requestSignature.requestHash,
      requestNonce,
      scopeKey: `replication:${job.onchainReplicationId}`,
      signature: requestSignature.signature,
    });

    let run: ResolutionRunView | null = null;
    try {
      run = await insertResolutionRun(pool, {
        claimId: job.claimId,
        claimStatus: proposedResolution.claimStatus,
        confidenceBps: proposedResolution.confidenceBps,
        evidenceHash: job.evidenceHash ?? persistedArtifact.sha256,
        evidenceURI: job.evidenceURI ?? persistedArtifact.storagePath,
        jobId: job.jobId,
        rationaleArtifactKey: rationaleArtifact.artifactKey,
        replicationId: job.onchainReplicationId,
        requestId: operatorRequest.requestId,
        resolutionHash: normalizeBytes32(
          sha256Hex(
            JSON.stringify({
              jobId: job.jobId,
              onchainReplicationId: job.onchainReplicationId,
              proposedResolution,
              rationaleArtifactKey: rationaleArtifact.artifactKey,
            }),
          ),
        ),
        resolutionStatus: proposedResolution.resolutionStatus,
        resolver: await signer.getAddress(),
        resolverType: proposedResolution.resolverType,
      });
      const txHashes: string[] = [];
      let currentClaimStatus = Number(claimRecord.status);
      currentClaimStatus = await maybeMoveClaimIntoReplication(
        claimRegistry,
        claimIdBigInt,
        currentClaimStatus,
        txHashes,
      );

      const resolutionTx = await replicationRegistry.resolveReplicationOutcome(
        replicationIdBigInt,
        {
          status: proposedResolution.resolutionStatus,
          confidenceBps: proposedResolution.confidenceBps,
          resolutionHash: run.resolutionHash,
          resolverType: proposedResolution.resolverType,
          evidenceHash: normalizeBytes32(run.evidenceHash),
          evidenceURI: run.evidenceURI ?? persistedArtifact.storagePath,
        },
      );
      txHashes.push((await resolutionTx.wait()).hash);

      if (
        proposedResolution.claimStatus !== null &&
        proposedResolution.claimStatus !== currentClaimStatus
      ) {
        const claimStatusTx = await claimRegistry.setClaimStatus(
          claimIdBigInt,
          proposedResolution.claimStatus,
        );
        txHashes.push((await claimStatusTx.wait()).hash);
      }

      await pool.query(
        `
          UPDATE resolution_runs
          SET payout_amount = COALESCE($2, payout_amount)
          WHERE run_id = $1
        `,
        [run.runId, null],
      );
      await markOperatorRequestSubmitted(pool, operatorRequest.requestId, txHashes.join(","));
      return await markResolutionRunSubmitted(pool, run.runId, txHashes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markOperatorRequestFailed(pool, operatorRequest.requestId, message);
      if (run) {
        await markResolutionRunFailed(pool, run.runId, message);
      }
      throw error;
    }
  } finally {
    await pool.end();
    const provider = signer?.provider;
    if (provider && typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}
