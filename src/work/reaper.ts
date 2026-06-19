import {
  type ExpiredArtifactMaintenanceTaskRunView,
  type ExpiredReplicationJobRunView,
  expireStaleArtifactMaintenanceTaskRuns,
  expireStaleReplicationJobRuns,
  prepareCoordinatorStore,
} from "../coordinator/store.js";
import { DEFAULT_DATABASE_URL } from "../indexer/store.js";
import {
  type ExpiredReviewTaskRunView,
  expireStaleReviewTaskRuns,
  prepareReviewStore,
} from "../review/store.js";
import { toClaimWorkRunView } from "./graph.js";
import type { ClaimWorkItemKind, ClaimWorkRunView } from "./types.js";

export type ReapedClaimWorkLeaseView = {
  claimId: string | null;
  itemId: string;
  kind: ClaimWorkItemKind;
  run: ClaimWorkRunView;
  timedOutAt: string;
};

export type ReapClaimWorkLeasesResult = {
  artifactMaintenance: ExpiredArtifactMaintenanceTaskRunView[];
  byKind: Record<ClaimWorkItemKind, number>;
  items: ReapedClaimWorkLeaseView[];
  limits: {
    limit: number;
    staleAfterMs: number;
  };
  replication: ExpiredReplicationJobRunView[];
  requestedAt: string;
  review: ExpiredReviewTaskRunView[];
  totalExpired: number;
};

function normalizeArtifactMaintenanceExpiry(
  expired: ExpiredArtifactMaintenanceTaskRunView,
): ReapedClaimWorkLeaseView {
  return {
    claimId: null,
    itemId: `artifact-maintenance:${expired.reopenedTask.taskId}`,
    kind: "artifact_maintenance",
    run: toClaimWorkRunView(expired.run),
    timedOutAt: expired.timedOutAt,
  };
}

function normalizeReplicationExpiry(
  expired: ExpiredReplicationJobRunView,
): ReapedClaimWorkLeaseView {
  return {
    claimId: expired.reopenedJob.claimId,
    itemId: `replication-job:${expired.reopenedJob.jobId}`,
    kind: "replication_job",
    run: toClaimWorkRunView(expired.run),
    timedOutAt: expired.timedOutAt,
  };
}

function normalizeReviewExpiry(expired: ExpiredReviewTaskRunView): ReapedClaimWorkLeaseView {
  return {
    claimId: expired.claimId,
    itemId: `review-task:${expired.taskId}`,
    kind: "review_task",
    run: toClaimWorkRunView(expired.run),
    timedOutAt: expired.timedOutAt,
  };
}

export async function reapStaleClaimWorkLeases(input: {
  connectionString?: string;
  includeArtifactMaintenance?: boolean;
  includeReplication?: boolean;
  includeReview?: boolean;
  limit?: number;
  staleAfterMs: number;
}): Promise<ReapClaimWorkLeasesResult> {
  const connectionString = input.connectionString ?? DEFAULT_DATABASE_URL;
  const effectiveLimit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const coordinatorPool = await prepareCoordinatorStore(connectionString);
  const reviewPool = await prepareReviewStore(connectionString);

  try {
    const [artifactMaintenance, replication, review] = await Promise.all([
      input.includeArtifactMaintenance === false
        ? Promise.resolve([])
        : expireStaleArtifactMaintenanceTaskRuns(coordinatorPool, {
            limit: effectiveLimit,
            staleAfterMs: input.staleAfterMs,
          }),
      input.includeReplication === false
        ? Promise.resolve([])
        : expireStaleReplicationJobRuns(coordinatorPool, {
            limit: effectiveLimit,
            staleAfterMs: input.staleAfterMs,
          }),
      input.includeReview === false
        ? Promise.resolve([])
        : expireStaleReviewTaskRuns(reviewPool, {
            limit: effectiveLimit,
            staleAfterMs: input.staleAfterMs,
          }),
    ]);

    const items = [
      ...artifactMaintenance.map(normalizeArtifactMaintenanceExpiry),
      ...replication.map(normalizeReplicationExpiry),
      ...review.map(normalizeReviewExpiry),
    ].sort((left, right) => {
      if (left.timedOutAt !== right.timedOutAt) {
        return right.timedOutAt.localeCompare(left.timedOutAt);
      }
      return left.itemId.localeCompare(right.itemId);
    });

    return {
      artifactMaintenance,
      byKind: {
        artifact_maintenance: artifactMaintenance.length,
        replication_job: replication.length,
        review_task: review.length,
      },
      items,
      limits: {
        limit: effectiveLimit,
        staleAfterMs: input.staleAfterMs,
      },
      replication,
      requestedAt: new Date().toISOString(),
      review,
      totalExpired: items.length,
    };
  } finally {
    await Promise.all([coordinatorPool.end(), reviewPool.end()]);
  }
}
