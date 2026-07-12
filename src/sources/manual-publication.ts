import type { Pool } from "pg";
import { upsertPersistedArtifact } from "../coordinator/store.js";
import { getReadModelPath, syncReadModel } from "../indexer/projector.js";
import { getDatabaseUrl, ReadModelSyncInProgressError } from "../indexer/store.js";
import { getDeploymentPath } from "../shared/deployment.js";
import { createManagedOperatorSigner } from "../shared/operator.js";
import { persistJsonArtifact } from "../shared/persisted-artifacts.js";
import { createProductionClaim, publishProductionClaim } from "../submission/actions.js";
import { sourcePublicationDomainId } from "./publication.js";
import {
  markSourcePublicationAttemptCompleted,
  markSourcePublicationClaimReady,
  markSourcePublicationReconciliationRequired,
  markSourcePublished,
  readSourceExtractionCandidates,
  readSourceRecord,
  recordSourcePublicationDecision,
  reserveSourcePublicationAttempt,
  updateSourceRecordStatus,
} from "./store.js";
import type {
  SourceExtractionCandidate,
  SourcePublicationCluster,
  SourcePublicationDecisionView,
  SourceRecordView,
} from "./types.js";

export type ConfirmSourcePublicationResult = {
  decision: SourcePublicationDecisionView;
  draftClaimId: string | null;
  publicationStatus: "awaiting_author_bond" | "published";
  publishedClaimId: string | null;
  source: SourceRecordView;
};

export type RejectSourcePublicationResult = {
  decision: SourcePublicationDecisionView;
  source: SourceRecordView;
};

function sourceArtifactUri(source: SourceRecordView): string {
  if (source.snapshotArtifactKey) {
    return `persisted-artifact://${source.snapshotArtifactKey}`;
  }
  return String(source.sourceMetadata.locator ?? source.canonicalSourceKey);
}

function metadataForSourcePublication(
  source: SourceRecordView,
  winner: SourceExtractionCandidate,
  actorAddress: string | null,
) {
  return JSON.stringify({
    canonicalSourceKey: source.canonicalSourceKey,
    confirmedByActor: actorAddress,
    machineProposed: true,
    sourceId: source.sourceId,
    sourceLocator: source.sourceMetadata.locator ?? null,
    sourceTitle: source.sourceMetadata.title ?? null,
    sourceType: source.sourceType,
    winningSubmissionId: winner.submissionId,
  });
}

async function syncPublicationClaimReadModel(env: NodeJS.ProcessEnv): Promise<void> {
  // The published claim must be indexed before source finalization: the
  // source record's published_claim_id references the read-model claims
  // table. A concurrent scheduled sync holds the advisory lock and will
  // index the claim itself, so lock contention is retryable, not fatal —
  // and it must never surface as a failure that tempts a retry of the
  // onchain publication into a duplicate claim.
  for (let attempt = 1; ; attempt++) {
    try {
      await syncReadModel(getDeploymentPath(env), getReadModelPath(env), getDatabaseUrl(env), {
        env,
      });
      return;
    } catch (error) {
      if (!(error instanceof ReadModelSyncInProgressError) || attempt >= 12) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

export type ManualSourcePublicationDependencies = {
  createClaim?: typeof createProductionClaim;
  publishClaim?: typeof publishProductionClaim;
  syncClaimReadModel?: typeof syncPublicationClaimReadModel;
};

function clusterFromCandidate(candidate: SourceExtractionCandidate): SourcePublicationCluster {
  return {
    averageConfidenceBps: candidate.confidenceBps,
    clusterKey: [
      candidate.statement.trim().toLowerCase(),
      candidate.scope.trim().toLowerCase(),
      candidate.claimType.trim().toLowerCase(),
    ].join("|"),
    distinctAgents: candidate.reviewerAgentId ? 1 : 0,
    memberCount: 1,
    methodology: candidate.methodology,
    scope: candidate.scope,
    statement: candidate.statement,
  };
}

async function resolvePublicationAuthor(
  source: SourceRecordView,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (source.submittedByActor && source.discoveryMode === "user_submitted") {
    return source.submittedByActor;
  }
  const machineSigner = createManagedOperatorSigner(
    ["SP_CLAIM_SUBMITTER_PRIVATE_KEY", "SP_PROTOCOL_ADMIN_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
    { env, localAccountIndex: 0 },
  );
  return machineSigner.getAddress();
}

async function persistSourceDecisionArtifact(
  pool: Pool,
  input: {
    actorAddress: string | null;
    candidates: SourceExtractionCandidate[];
    decisionMode: "manual_confirm" | "manual_reject";
    env: NodeJS.ProcessEnv;
    publishedClaimId: string | null;
    reason: string;
    shouldPublish: boolean;
    source: SourceRecordView;
    winningCandidate: SourceExtractionCandidate | null;
  },
) {
  const artifact = await persistJsonArtifact(
    "source-publication-decision",
    {
      actorAddress: input.actorAddress,
      candidateCount: input.candidates.length,
      candidates: input.candidates.map((candidate) => ({
        anchors: candidate.anchors,
        candidateId: candidate.candidateId,
        claimType: candidate.claimType,
        confidenceBps: candidate.confidenceBps,
        createdAt: candidate.createdAt,
        methodology: candidate.methodology,
        reviewerAgentId: candidate.reviewerAgentId,
        scope: candidate.scope,
        statement: candidate.statement,
        submissionId: candidate.submissionId,
        taskId: candidate.taskId,
      })),
      decisionMode: input.decisionMode,
      publishedClaimId: input.publishedClaimId,
      reason: input.reason,
      shouldPublish: input.shouldPublish,
      source: {
        canonicalSourceKey: input.source.canonicalSourceKey,
        discoveryMode: input.source.discoveryMode,
        publishedClaimId: input.source.publishedClaimId,
        snapshotArtifactKey: input.source.snapshotArtifactKey,
        sourceId: input.source.sourceId,
        sourceMetadata: input.source.sourceMetadata,
        sourceType: input.source.sourceType,
        status: input.source.status,
        updatedAt: input.source.updatedAt,
      },
      winningCandidate: input.winningCandidate
        ? {
            anchors: input.winningCandidate.anchors,
            candidateId: input.winningCandidate.candidateId,
            claimType: input.winningCandidate.claimType,
            confidenceBps: input.winningCandidate.confidenceBps,
            methodology: input.winningCandidate.methodology,
            scope: input.winningCandidate.scope,
            statement: input.winningCandidate.statement,
            submissionId: input.winningCandidate.submissionId,
            taskId: input.winningCandidate.taskId,
          }
        : null,
    },
    { env: input.env },
  );
  const persisted = await upsertPersistedArtifact(pool, artifact);
  return persisted.artifactKey;
}

export async function confirmSourcePublication(
  pool: Pool,
  input: {
    actorAddress: string;
    candidateId: string;
    sourceId: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ManualSourcePublicationDependencies = {},
): Promise<ConfirmSourcePublicationResult> {
  const createClaim = dependencies.createClaim ?? createProductionClaim;
  const publishClaim = dependencies.publishClaim ?? publishProductionClaim;
  const syncClaimReadModel = dependencies.syncClaimReadModel ?? syncPublicationClaimReadModel;
  const source = await readSourceRecord(pool, input.sourceId);
  if (!source) {
    throw new Error("source_not_found");
  }
  if (source.publishedClaimId) {
    throw new Error("source_already_published");
  }
  if (source.status === "rejected") {
    throw new Error("source_rejected");
  }
  const candidates = await readSourceExtractionCandidates(pool, input.sourceId);
  const winningCandidate = candidates.find(
    (candidate) => candidate.candidateId === input.candidateId,
  );
  if (!winningCandidate) {
    throw new Error("source_candidate_not_found");
  }

  const reservation = await reserveSourcePublicationAttempt(pool, {
    candidateId: winningCandidate.candidateId,
    publicationMode: "manual",
    sourceId: input.sourceId,
  });
  let publishedClaimId: string;
  let draftClaimId: string | null = null;
  if (!reservation.created) {
    if (
      reservation.attempt.candidateId !== winningCandidate.candidateId ||
      reservation.attempt.publicationMode !== "manual"
    ) {
      throw new Error("source_publication_attempt_conflict");
    }
    if (reservation.attempt.status !== "claim_ready" || !reservation.attempt.claimId) {
      throw new Error("source_publication_requires_reconciliation");
    }
    publishedClaimId = reservation.attempt.claimId;
    await publishClaim(publishedClaimId, input.actorAddress, env);
  } else {
    const authorAddress = await resolvePublicationAuthor(source, env);
    try {
      const claim = await createClaim(
        {
          artifactType: 5,
          artifactUri: sourceArtifactUri(source),
          domainId: sourcePublicationDomainId(source.sourceMetadata),
          metadata: metadataForSourcePublication(source, winningCandidate, input.actorAddress),
          methodology: winningCandidate.methodology,
          openReplicationJob: false,
          requestedBy: "source-manual-confirm",
          scope: winningCandidate.scope,
          statement: winningCandidate.statement,
        },
        authorAddress,
        pool,
        {
          env,
          onClaimReady: async (checkpoint) => {
            await markSourcePublicationClaimReady(pool, {
              claimId: checkpoint.claimId,
              sourceId: input.sourceId,
              transactionHashes: {
                addArtifact: checkpoint.txHashes.addArtifact,
                createClaim: checkpoint.txHashes.createClaim,
              },
            });
          },
        },
      );
      publishedClaimId = claim.claimId;
      if (claim.publicationStatus === "awaiting_author_bond") {
        draftClaimId = claim.claimId;
        const readySource =
          (await updateSourceRecordStatus(pool, {
            sourceId: input.sourceId,
            status: "ready_for_publication",
          })) ?? source;
        const decision = await recordSourcePublicationDecision(pool, {
          decisionArtifactKey: await persistSourceDecisionArtifact(pool, {
            actorAddress: input.actorAddress,
            candidates,
            decisionMode: "manual_confirm",
            env,
            publishedClaimId: null,
            reason: "awaiting_author_bond",
            shouldPublish: false,
            source: readySource,
            winningCandidate,
          }),
          publishedClaimId: null,
          reason: "awaiting_author_bond",
          shouldPublish: false,
          sourceId: input.sourceId,
          winningCluster: clusterFromCandidate(winningCandidate),
        });
        return {
          decision,
          draftClaimId,
          publicationStatus: "awaiting_author_bond",
          publishedClaimId: null,
          source: readySource,
        };
      }
    } catch (error) {
      await markSourcePublicationReconciliationRequired(pool, {
        error: error instanceof Error ? error.message : String(error),
        sourceId: input.sourceId,
      });
      throw error;
    }
  }
  await syncClaimReadModel(env);
  const publishedSource = await markSourcePublished(pool, {
    publishedClaimId,
    sourceId: input.sourceId,
  });
  if (!publishedSource) {
    throw new Error("source_publish_record_missing");
  }
  const decision = await recordSourcePublicationDecision(pool, {
    decisionArtifactKey: await persistSourceDecisionArtifact(pool, {
      actorAddress: input.actorAddress,
      candidates,
      decisionMode: "manual_confirm",
      env,
      publishedClaimId,
      reason: "Confirmed manually from source review.",
      shouldPublish: true,
      source: publishedSource,
      winningCandidate,
    }),
    publishedClaimId,
    reason: "Confirmed manually from source review.",
    shouldPublish: true,
    sourceId: input.sourceId,
    winningCluster: clusterFromCandidate(winningCandidate),
  });
  await markSourcePublicationAttemptCompleted(pool, input.sourceId);
  return {
    decision,
    draftClaimId,
    publicationStatus: "published",
    publishedClaimId,
    source: publishedSource,
  };
}

export async function rejectSourcePublication(
  pool: Pool,
  input: {
    actorAddress: string;
    reason: string;
    sourceId: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<RejectSourcePublicationResult> {
  const source = await readSourceRecord(pool, input.sourceId);
  if (!source) {
    throw new Error("source_not_found");
  }
  if (source.publishedClaimId) {
    throw new Error("source_already_published");
  }
  const rejectedSource = await updateSourceRecordStatus(pool, {
    sourceId: input.sourceId,
    status: "rejected",
  });
  if (!rejectedSource) {
    throw new Error("source_reject_record_missing");
  }
  const candidates = await readSourceExtractionCandidates(pool, input.sourceId);
  const normalizedReason = input.reason.trim() || "Rejected manually from source review.";
  const decision = await recordSourcePublicationDecision(pool, {
    decisionArtifactKey: await persistSourceDecisionArtifact(pool, {
      actorAddress: input.actorAddress,
      candidates,
      decisionMode: "manual_reject",
      env,
      publishedClaimId: null,
      reason: normalizedReason,
      shouldPublish: false,
      source: rejectedSource,
      winningCandidate: null,
    }),
    publishedClaimId: null,
    reason: normalizedReason,
    shouldPublish: false,
    sourceId: input.sourceId,
    winningCluster: null,
  });
  return {
    decision,
    source: rejectedSource,
  };
}
