import { NonceManager, ZeroAddress } from "ethers";
import { buildAgentWorkSummaries } from "../agents/work-summary.js";
import {
  readArtifactMaintenanceTasksPage,
  readReplicationJobsPage,
  upsertPersistedArtifact,
} from "../coordinator/store.js";
import { readClaimsPage, readReplicationsPage } from "../indexer/store.js";
import { readDomainLeaderboard, readLatestReputationPayload } from "../reputation/store.js";
import { readReviewSubmissionsPage, readReviewTasksPage } from "../review/store.js";
import { getContract, requireContractEventId } from "../shared/contracts.js";
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
import { readAllPages } from "../shared/pagination.js";
import { persistJsonArtifact } from "../shared/persisted-artifacts.js";
import { collectClaimWorkArtifactKeys } from "../work/graph.js";
import {
  type CheckpointPublicationView,
  insertCheckpointPublication,
  markCheckpointPublicationFailed,
  markCheckpointPublicationSubmitted,
  prepareCheckpointStore,
} from "./store.js";

const SUBJECT_TYPE = {
  Actor: 0,
  Agent: 3,
  Module: 4,
} as const;

type PublishOptions = {
  connectionString?: string;
  domainId: number;
  env?: NodeJS.ProcessEnv;
};

async function publishSubject(
  checkpointRegistry: Awaited<ReturnType<typeof getContract>>,
  pool: Awaited<ReturnType<typeof prepareCheckpointStore>>,
  signer: NonceManager,
  input: {
    chainId: number;
    domainId: number;
    payloadHash: string;
    payloadId: string;
    publisher: string;
    scorePayload: unknown;
    subjectActor: string;
    subjectAgentId: string;
    subjectClaimId: string;
    subjectModule: string;
    subjectType: number;
  },
): Promise<CheckpointPublicationView> {
  const persisted = await persistJsonArtifact("checkpoint-score-vector", input.scorePayload);
  await upsertPersistedArtifact(pool, persisted);
  const operatorAddress = await signer.getAddress();
  const requestNonce = await reserveOperatorRequestNonce(pool, {
    actionType: "checkpoint_publication",
    operatorAddress,
  });
  const requestEnvelope = buildOperatorRequestEnvelope({
    actionType: "checkpoint_publication",
    chainId: input.chainId,
    operatorAddress,
    payload: {
      domainId: input.domainId,
      payloadHash: input.payloadHash,
      payloadId: input.payloadId,
      scoreVectorHash: persisted.sha256,
      subjectActor: input.subjectActor,
      subjectAgentId: input.subjectAgentId,
      subjectClaimId: input.subjectClaimId,
      subjectModule: input.subjectModule,
      subjectType: input.subjectType,
    },
    requestNonce,
    scopeKey: `checkpoint:${input.domainId}:${input.subjectType}:${input.subjectActor}:${input.subjectAgentId}:${input.subjectModule}`,
  });
  const requestArtifact = await persistJsonArtifact("operator-request", requestEnvelope);
  await upsertPersistedArtifact(pool, requestArtifact);
  const requestSignature = await signOperatorRequestEnvelope(signer, requestEnvelope);
  const operatorRequest = await insertOperatorRequest(pool, {
    actionType: "checkpoint_publication",
    chainId: input.chainId,
    operatorAddress,
    payloadArtifactKey: requestArtifact.artifactKey,
    requestHash: requestSignature.requestHash,
    requestNonce,
    scopeKey: requestEnvelope.scopeKey,
    signature: requestSignature.signature,
  });
  let publication: CheckpointPublicationView | null = null;
  try {
    publication = await insertCheckpointPublication(pool, {
      domainId: input.domainId,
      payloadHash: input.payloadHash,
      payloadId: input.payloadId,
      publisher: input.publisher,
      requestId: operatorRequest.requestId,
      scoreVectorHash: persisted.sha256,
      subjectActor: input.subjectActor,
      subjectAgentId: input.subjectAgentId,
      subjectClaimId: input.subjectClaimId,
      subjectModule: input.subjectModule,
      subjectType: input.subjectType,
      uri: persisted.storagePath,
    });
    const tx = await checkpointRegistry.publishCheckpoint(
      input.domainId,
      input.subjectType,
      input.subjectActor,
      BigInt(input.subjectClaimId),
      BigInt(input.subjectAgentId),
      input.subjectModule,
      persisted.sha256,
      input.payloadHash,
      persisted.storagePath,
    );
    const receipt = await tx.wait();
    const checkpointId = requireContractEventId(
      checkpointRegistry,
      receipt,
      "ReputationCheckpointPublished",
      "checkpointId",
    );
    await markOperatorRequestSubmitted(pool, operatorRequest.requestId, receipt.hash);
    return markCheckpointPublicationSubmitted(
      pool,
      publication.publicationId,
      checkpointId,
      receipt.hash,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markOperatorRequestFailed(pool, operatorRequest.requestId, message);
    if (publication) {
      await markCheckpointPublicationFailed(pool, publication.publicationId, message);
    }
    throw error;
  }
}

export async function publishDomainCheckpoints(
  options: PublishOptions,
): Promise<CheckpointPublicationView[]> {
  const env = options.env ?? process.env;
  const pool = await prepareCheckpointStore(options.connectionString);
  let signer: NonceManager | null = null;
  try {
    const [payload, leaderboard, claims] = await Promise.all([
      readLatestReputationPayload(pool, options.domainId),
      readAllPages((pagination) => readDomainLeaderboard(pool, options.domainId, pagination)),
      readAllPages((pagination) =>
        readClaimsPage(pool, { ...pagination, domainId: options.domainId }),
      ),
    ]);
    if (!payload) {
      throw new Error(`no reputation payload found for domain ${options.domainId}`);
    }

    const claimIds = new Set(claims.map((claim) => claim.claimId));
    const [
      allReplications,
      allReviewTasks,
      allReviewSubmissions,
      allReplicationJobs,
      allMaintenanceTasks,
    ] = await Promise.all([
      readAllPages((pagination) => readReplicationsPage(pool, pagination)),
      readAllPages((pagination) => readReviewTasksPage(pool, pagination)),
      readAllPages((pagination) => readReviewSubmissionsPage(pool, pagination)),
      readAllPages((pagination) => readReplicationJobsPage(pool, pagination)),
      readAllPages((pagination) => readArtifactMaintenanceTasksPage(pool, pagination)),
    ]);
    const domainReplications = allReplications.filter((replication) =>
      claimIds.has(replication.claimId),
    );
    const domainReviewTasks = allReviewTasks.filter(
      (task) => typeof task.claimId === "string" && claimIds.has(task.claimId),
    );
    const domainReviewSubmissions = allReviewSubmissions.filter(
      (submission) => typeof submission.claimId === "string" && claimIds.has(submission.claimId),
    );
    const domainReplicationJobs = allReplicationJobs.filter((job) => claimIds.has(job.claimId));
    const domainArtifactKeys = new Set(
      collectClaimWorkArtifactKeys({
        replicationJobs: domainReplicationJobs,
        reviewSubmissions: domainReviewSubmissions,
        reviewTasks: domainReviewTasks,
      }),
    );
    const domainMaintenanceTasks = allMaintenanceTasks.filter((task) =>
      domainArtifactKeys.has(task.artifactKey),
    );
    const agentAggregates = buildAgentWorkSummaries({
      claims,
      maintenanceTasks: domainMaintenanceTasks,
      replicationJobs: domainReplicationJobs,
      replications: domainReplications,
      reviewSubmissions: domainReviewSubmissions,
      reviewTasks: domainReviewTasks,
    });

    const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
    signer = new NonceManager(
      createOperatorSigner(["SP_CHECKPOINT_PUBLISHER_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"], {
        env,
        localAccountIndex: 5,
      }),
    );
    const [checkpointRegistry, moduleRegistry] = await Promise.all([
      getContract(
        "ReputationCheckpointRegistry",
        deployment.addresses.reputationCheckpointRegistry,
        signer,
      ),
      getContract(
        "ResolutionModuleRegistry",
        deployment.addresses.resolutionModuleRegistry,
        signer,
      ),
    ]);
    const publisher = await signer.getAddress();
    const moduleAddress = await moduleRegistry.getDomainModule(options.domainId);

    const publications: CheckpointPublicationView[] = [];
    for (const entry of leaderboard) {
      publications.push(
        await publishSubject(checkpointRegistry, pool, signer, {
          chainId: deployment.chainId,
          domainId: options.domainId,
          payloadHash: payload.payloadHash,
          payloadId: payload.payloadId,
          publisher,
          scorePayload: {
            domainId: options.domainId,
            kind: "actor",
            payloadId: payload.payloadId,
            rank: entry.rank,
            subjectActor: entry.subjectActor,
            summary: entry,
          },
          subjectActor: entry.subjectActor,
          subjectAgentId: "0",
          subjectClaimId: "0",
          subjectModule: ZeroAddress,
          subjectType: SUBJECT_TYPE.Actor,
        }),
      );
    }

    for (const aggregate of agentAggregates) {
      publications.push(
        await publishSubject(checkpointRegistry, pool, signer, {
          chainId: deployment.chainId,
          domainId: options.domainId,
          payloadHash: payload.payloadHash,
          payloadId: payload.payloadId,
          publisher,
          scorePayload: {
            domainId: options.domainId,
            kind: "agent",
            payloadId: payload.payloadId,
            summary: aggregate,
          },
          subjectActor: ZeroAddress,
          subjectAgentId: aggregate.agentId,
          subjectClaimId: "0",
          subjectModule: ZeroAddress,
          subjectType: SUBJECT_TYPE.Agent,
        }),
      );
    }

    publications.push(
      await publishSubject(checkpointRegistry, pool, signer, {
        chainId: deployment.chainId,
        domainId: options.domainId,
        payloadHash: payload.payloadHash,
        payloadId: payload.payloadId,
        publisher,
        scorePayload: {
          claimCount: claims.length,
          domainId: options.domainId,
          kind: "module",
          moduleAddress,
          payloadId: payload.payloadId,
          replicationCount: domainReplications.length,
        },
        subjectActor: ZeroAddress,
        subjectAgentId: "0",
        subjectClaimId: "0",
        subjectModule: moduleAddress,
        subjectType: SUBJECT_TYPE.Module,
      }),
    );

    return publications;
  } finally {
    await pool.end();
    const provider = signer?.provider;
    if (provider && typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}
