import type { Pool } from "pg";
import { upsertPersistedArtifact } from "../coordinator/store.js";
import { getReadModelPath, syncReadModel } from "../indexer/projector.js";
import { getDatabaseUrl, ReadModelSyncInProgressError } from "../indexer/store.js";
import { getDeploymentPath } from "../shared/deployment.js";
import { createManagedOperatorSigner } from "../shared/operator.js";
import { persistJsonArtifact } from "../shared/persisted-artifacts.js";
import { createProductionClaim } from "../submission/actions.js";
import { decideSourceAutoPublication } from "./canonicalize.js";
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
  SourceAutoPublicationDecision,
  SourceExtractionCandidate,
  SourceRecordView,
} from "./types.js";

function sourceArtifactUri(source: SourceRecordView): string {
  if (source.snapshotArtifactKey) {
    return `persisted-artifact://${source.snapshotArtifactKey}`;
  }
  return String(source.sourceMetadata.locator ?? source.canonicalSourceKey);
}

function metadataForSourcePublication(source: SourceRecordView, winner: SourceExtractionCandidate) {
  return JSON.stringify({
    canonicalSourceKey: source.canonicalSourceKey,
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

export type SourceAutoPublicationDependencies = {
  createClaim?: typeof createProductionClaim;
  syncClaimReadModel?: typeof syncPublicationClaimReadModel;
};

async function persistSourceDecisionArtifact(
  pool: Pool,
  input: {
    candidates: SourceExtractionCandidate[];
    decision: SourceAutoPublicationDecision;
    env: NodeJS.ProcessEnv;
    publishedClaimId: string | null;
    source: SourceRecordView;
    winningCandidate: SourceExtractionCandidate | null;
  },
) {
  const artifact = await persistJsonArtifact(
    "source-publication-decision",
    {
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
      decision: input.decision,
      publishedClaimId: input.publishedClaimId,
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

export async function attemptSourceAutoPublication(
  pool: Pool,
  sourceId: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SourceAutoPublicationDependencies = {},
): Promise<{ publishedClaimId: string | null; reason: string; source: SourceRecordView | null }> {
  const createClaim = dependencies.createClaim ?? createProductionClaim;
  const syncClaimReadModel = dependencies.syncClaimReadModel ?? syncPublicationClaimReadModel;
  const source = await readSourceRecord(pool, sourceId);
  if (!source) {
    return { publishedClaimId: null, reason: "source_not_found", source: null };
  }
  if (source.publishedClaimId) {
    return {
      publishedClaimId: source.publishedClaimId,
      reason: "already_published",
      source,
    };
  }

  const candidates = await readSourceExtractionCandidates(pool, sourceId);
  const decision = decideSourceAutoPublication(candidates);
  let publishedClaimId: string | null = null;
  let sourceAfterDecision = source;
  let winningCandidate: SourceExtractionCandidate | null = null;
  let decisionReason = decision.reason;
  let shouldPublish = decision.shouldPublish;

  if (decision.shouldPublish && decision.winningCluster) {
    winningCandidate =
      candidates.find(
        (candidate) =>
          candidate.statement === decision.winningCluster?.statement &&
          candidate.scope === decision.winningCluster?.scope &&
          candidate.claimType === decision.winningCluster?.clusterKey.split("|")[2],
      ) ?? null;
    if (!winningCandidate) {
      const blockedDecision = {
        ...decision,
        reason: "winning_candidate_not_found",
        shouldPublish: false,
      } satisfies SourceAutoPublicationDecision;
      await recordSourcePublicationDecision(pool, {
        competingStrengthRatio: blockedDecision.competingStrengthRatio,
        decisionArtifactKey: await persistSourceDecisionArtifact(pool, {
          candidates,
          decision: blockedDecision,
          env,
          publishedClaimId: null,
          source,
          winningCandidate: null,
        }),
        publishedClaimId: null,
        reason: "winning_candidate_not_found",
        shouldPublish: false,
        sourceId,
        winningCluster: decision.winningCluster,
      });
      sourceAfterDecision =
        (await updateSourceRecordStatus(pool, {
          sourceId,
          status: "ready_for_publication",
        })) ?? source;
      return {
        publishedClaimId: null,
        reason: "winning_candidate_not_found",
        source: sourceAfterDecision,
      };
    }

    const machineSigner = createManagedOperatorSigner(
      [
        "SP_CLAIM_SUBMITTER_PRIVATE_KEY",
        "SP_PROTOCOL_ADMIN_PRIVATE_KEY",
        "SP_OPERATOR_PRIVATE_KEY",
      ],
      { env, localAccountIndex: 0 },
    );
    const machineProposedAuthor =
      source.submittedByActor && source.discoveryMode === "user_submitted"
        ? source.submittedByActor
        : await machineSigner.getAddress();

    const reservation = await reserveSourcePublicationAttempt(pool, {
      candidateId: winningCandidate.candidateId,
      publicationMode: "auto",
      sourceId,
    });
    if (!reservation.created) {
      if (
        reservation.attempt.candidateId !== winningCandidate.candidateId ||
        reservation.attempt.publicationMode !== "auto"
      ) {
        return {
          publishedClaimId: null,
          reason: "publication_attempt_conflict",
          source,
        };
      }
      if (reservation.attempt.status !== "claim_ready" || !reservation.attempt.claimId) {
        return {
          publishedClaimId: null,
          reason: "publication_requires_reconciliation",
          source,
        };
      }
      decisionReason = "awaiting_author_bond";
      shouldPublish = false;
    } else {
      try {
        const result = await createClaim(
          {
            artifactType: 5,
            artifactUri: sourceArtifactUri(source),
            domainId: sourcePublicationDomainId(source.sourceMetadata),
            metadata: metadataForSourcePublication(source, winningCandidate),
            methodology: winningCandidate.methodology,
            openReplicationJob: false,
            requestedBy: "source-auto-publish",
            scope: winningCandidate.scope,
            statement: winningCandidate.statement,
          },
          machineProposedAuthor,
          pool,
          {
            env,
            onClaimReady: async (checkpoint) => {
              await markSourcePublicationClaimReady(pool, {
                claimId: checkpoint.claimId,
                sourceId,
                transactionHashes: {
                  addArtifact: checkpoint.txHashes.addArtifact,
                  createClaim: checkpoint.txHashes.createClaim,
                },
              });
            },
          },
        );
        if (result.publicationStatus === "awaiting_author_bond") {
          decisionReason = "awaiting_author_bond";
          shouldPublish = false;
        } else {
          publishedClaimId = result.claimId;
        }
      } catch (error) {
        await markSourcePublicationReconciliationRequired(pool, {
          error: error instanceof Error ? error.message : String(error),
          sourceId,
        });
        throw error;
      }
    }
    if (publishedClaimId) {
      await syncClaimReadModel(env);
      sourceAfterDecision =
        (await markSourcePublished(pool, {
          publishedClaimId,
          sourceId,
        })) ?? source;
    } else {
      sourceAfterDecision =
        (await updateSourceRecordStatus(pool, {
          sourceId,
          status: "ready_for_publication",
        })) ?? source;
    }
  } else if (decision.winningCluster) {
    sourceAfterDecision =
      (await updateSourceRecordStatus(pool, {
        sourceId,
        status: "ready_for_publication",
      })) ?? source;
  }

  await recordSourcePublicationDecision(pool, {
    competingStrengthRatio: decision.competingStrengthRatio,
    decisionArtifactKey: await persistSourceDecisionArtifact(pool, {
      candidates,
      decision,
      env,
      publishedClaimId,
      source: sourceAfterDecision,
      winningCandidate,
    }),
    publishedClaimId,
    reason: decisionReason,
    shouldPublish,
    sourceId,
    winningCluster: decision.winningCluster,
  });
  if (publishedClaimId) {
    await markSourcePublicationAttemptCompleted(pool, sourceId);
  }
  return {
    publishedClaimId,
    reason: decisionReason,
    source: sourceAfterDecision,
  };
}
