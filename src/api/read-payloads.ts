import type { Pool } from "pg";
import { buildAgentRuntimeEvents } from "../agents/runtime-events.js";
import {
  type AgentWorkSummaryView,
  buildAgentWorkSummaries,
  defaultAgentWorkSummary,
} from "../agents/work-summary.js";
import type { CheckpointPublicationView } from "../checkpoints/store.js";
import type {
  ArtifactMaintenanceTaskView,
  ReplicationJobView,
  readClaimReplicationJobsPage,
} from "../coordinator/store.js";
import type {
  readArtifactsByClaim,
  readChallengesByClaim,
  readForecastsByClaim,
  readIndexerRuntimeStatus,
  readMetadata,
  readReplicationsByClaim,
} from "../indexer/store.js";
import { buildClaimReviewState } from "../review/aggregation.js";
import { buildAgentCalibrationHistory, defaultAgentCalibration } from "../review/calibration.js";
import type { readReviewSubmissionsPage, readReviewTasksPage } from "../review/store.js";
import type {
  AgentReviewCalibrationContributionView,
  ClaimReviewState,
  ReviewAuthorResponseView,
  ReviewIssueView,
  ReviewSubmissionView,
  ReviewTaskView,
} from "../review/types.js";
import { buildClaimRewardPolicyExplanation } from "../rewards/policy.js";
import type {
  AgentRequestActionType,
  AgentRequestStatus,
  AgentRequestView,
} from "../shared/agent-requests.js";
import { getRpcUrl } from "../shared/contracts.js";
import { loadDeploymentFile } from "../shared/deployment.js";
import { isLocalDevelopmentRpcUrl } from "../shared/env.js";
import type { ClaimView, ReplicationView } from "../shared/read-model.js";
import { readEnvValue } from "../shared/secrets.js";
import type { readSourceRecord } from "../sources/store.js";
import type {
  ClaimEventView,
  ClaimFeedItemView,
  SourceEventView,
  SourceFeedItemView,
  SourcePublicationDecisionView,
  SourceRecordView,
} from "../sources/types.js";
import {
  buildClaimWorkGraph,
  buildSourceWorkGraph,
  collectClaimWorkArtifactKeys,
  toClaimWorkRunView,
} from "../work/graph.js";
import { compareClaimWorkItemsForSelection } from "../work/selection.js";
import type {
  ClaimWorkGraphView,
  ClaimWorkItemDetailView,
  ClaimWorkItemView,
  SourceWorkGraphView,
} from "../work/types.js";
import {
  listReplicationSubmitterAuthorizedAddressesForPublicConfig,
  operatorTokenFallbackEnabled,
} from "./auth.js";
import type { ApiDependencies } from "./dependencies.js";

export async function buildPersistedArtifactDetail(
  pool: Pool,
  dependencies: ApiDependencies,
  artifactKey: string,
) {
  const artifact = await dependencies.readPersistedArtifact(pool, artifactKey);
  if (!artifact) {
    return null;
  }

  const [replicas, provenance, storagePolicy, storageAttestations, audits] = await Promise.all([
    dependencies.readPersistedArtifactReplicas(pool, artifactKey),
    dependencies.readPersistedArtifactProvenance(pool, artifactKey),
    dependencies.readPersistedArtifactStoragePolicy(pool, artifactKey),
    dependencies.readPersistedArtifactStorageAttestations(pool, artifactKey),
    dependencies.readPersistedArtifactAuditsPage(pool, {
      artifactKey,
      limit: 10,
      offset: 0,
    }),
  ]);

  return {
    ...artifact,
    provenance: provenance ?? null,
    recentAudits: audits,
    replicas,
    storageAttestations,
    storagePolicy: storagePolicy ?? null,
  };
}

export async function buildArtifactMaintenanceTaskDetail(
  pool: Pool,
  dependencies: ApiDependencies,
  taskId: string,
) {
  const task = await dependencies.readArtifactMaintenanceTask(pool, taskId);
  if (!task) {
    return null;
  }

  const [artifact, runs] = await Promise.all([
    buildPersistedArtifactDetail(pool, dependencies, task.artifactKey),
    dependencies.readArtifactMaintenanceTaskRuns(pool, taskId),
  ]);

  return {
    artifact,
    runs,
    task,
  };
}

export async function buildDemoScenarioPayloads(
  dependencies: ApiDependencies,
  pool: Pool,
  databaseUrl: string,
): Promise<
  Array<{
    claim: {
      claimId: string;
      author: string;
      domainId: number;
      metadataHash: string;
      resolutionModule: string;
      status: number;
      revisionOfClaimId: string | null;
      createdAtBlock: number;
      collectionCounts: Awaited<ReturnType<typeof buildClaimCollectionCounts>>;
    } | null;
    detail: string;
    domainId: number;
    eyebrow: string;
    proofPoint: string | null;
    scenarioKey: string;
    summary: string;
    title: string;
    updatedAt: string;
    whyItMatters: string | null;
  }>
> {
  const scenarios = await dependencies.listFeaturedDemoScenarios(databaseUrl);
  return Promise.all(
    scenarios.map(async (scenario) => {
      const claim = await dependencies.readClaim(pool, scenario.claimId);
      if (!claim) {
        return {
          ...scenario,
          claim: null,
        };
      }

      return {
        ...scenario,
        claim: {
          ...claim,
          collectionCounts: await buildClaimCollectionCounts(dependencies, pool, claim.claimId),
        },
      };
    }),
  );
}

export async function buildClaimCollectionCounts(
  dependencies: ApiDependencies,
  pool: Pool,
  claimId: string,
): Promise<{
  appeals: number;
  artifacts: number;
  challenges: number;
  checkpoints: number;
  forecasts: number;
  replications: number;
}> {
  const [artifacts, replications, checkpoints, forecasts, challenges, appeals] = await Promise.all([
    dependencies.readArtifactsPage(pool, { claimId, limit: 1, offset: 0 }),
    dependencies.readReplicationsPage(pool, { claimId, limit: 1, offset: 0 }),
    dependencies.readCheckpointsPage(pool, { claimId, limit: 1, offset: 0 }),
    dependencies.readForecastsPage(pool, { claimId, limit: 1, offset: 0 }),
    dependencies.readChallengesPage(pool, { claimId, limit: 1, offset: 0 }),
    dependencies.readAppealsPage(pool, { claimId, limit: 1, offset: 0 }),
  ]);

  return {
    artifacts: artifacts.total,
    replications: replications.total,
    checkpoints: checkpoints.total,
    forecasts: forecasts.total,
    challenges: challenges.total,
    appeals: appeals.total,
  };
}

export async function buildClaimReviewStatePayload(
  dependencies: ApiDependencies,
  pool: Pool,
  claimId: string,
  seeded: Partial<{
    artifacts: Awaited<ReturnType<typeof readArtifactsByClaim>>;
    challenges: Awaited<ReturnType<typeof readChallengesByClaim>>;
    forecasts: Awaited<ReturnType<typeof readForecastsByClaim>>;
    replications: Awaited<ReturnType<typeof readReplicationsByClaim>>;
    reviewWorkGraph: ClaimWorkGraphView;
    reviewSubmissions: Awaited<ReturnType<typeof readReviewSubmissionsPage>>["items"];
    reviewTasks: Awaited<ReturnType<typeof readReviewTasksPage>>["items"];
  }> = {},
): Promise<ClaimReviewState> {
  const [
    tasks,
    submissions,
    submissionHistory,
    issues,
    responses,
    artifacts,
    replications,
    forecasts,
    challenges,
    claims,
  ] = await Promise.all([
    seeded.reviewTasks ?? readAllReviewTasks(dependencies, pool, { claimId }),
    seeded.reviewSubmissions ?? readAllReviewSubmissions(dependencies, pool, { claimId }),
    readAllReviewSubmissions(dependencies, pool),
    readAllReviewIssues(dependencies, pool, { claimId }),
    readAllReviewResponses(dependencies, pool, { claimId }),
    seeded.artifacts ?? dependencies.readArtifactsByClaim(pool, claimId),
    seeded.replications ?? dependencies.readReplicationsByClaim(pool, claimId),
    seeded.forecasts ?? dependencies.readForecastsByClaim(pool, claimId),
    seeded.challenges ?? dependencies.readChallengesByClaim(pool, claimId),
    readAllClaims(dependencies, pool),
  ]);

  const workGraph =
    seeded.reviewWorkGraph ??
    (await buildClaimWorkGraphPayload(dependencies, pool, claimId, {
      artifacts,
      reviewSubmissions: submissions,
      reviewTasks: tasks,
    }));

  return buildClaimReviewState({
    artifacts,
    challenges,
    claims,
    currentClaimId: claimId,
    forecasts,
    issues,
    replications,
    responses,
    submissionHistory,
    submissions,
    tasks,
    workItems: workGraph.items,
  });
}

export async function buildClaimWorkGraphPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  claimId: string,
  seeded: Partial<{
    artifacts: Awaited<ReturnType<typeof readArtifactsByClaim>>;
    replicationJobs: Awaited<ReturnType<typeof readClaimReplicationJobsPage>>["items"];
    reviewSubmissions: Awaited<ReturnType<typeof readReviewSubmissionsPage>>["items"];
    reviewTasks: Awaited<ReturnType<typeof readReviewTasksPage>>["items"];
  }> = {},
): Promise<ClaimWorkGraphView> {
  const [artifacts, reviewTasks, reviewSubmissions, replicationJobs] = await Promise.all([
    seeded.artifacts ?? dependencies.readArtifactsByClaim(pool, claimId),
    seeded.reviewTasks ?? readAllReviewTasks(dependencies, pool, { claimId }),
    seeded.reviewSubmissions ?? readAllReviewSubmissions(dependencies, pool, { claimId }),
    seeded.replicationJobs ?? readAllClaimReplicationJobs(dependencies, pool, claimId),
  ]);

  const relatedArtifactKeys = [
    ...new Set(
      collectClaimWorkArtifactKeys({
        replicationJobs,
        reviewSubmissions,
        reviewTasks,
      }),
    ),
  ];
  const maintenanceTasks = (
    await Promise.all(
      relatedArtifactKeys.map((artifactKey) =>
        readAllArtifactMaintenanceTasks(dependencies, pool, artifactKey),
      ),
    )
  ).flat();

  const [reviewRuns, replicationRuns, maintenanceRuns] = await Promise.all([
    Promise.all(
      reviewTasks.map(
        async (task) =>
          [task.taskId, await dependencies.readReviewTaskRuns(pool, task.taskId)] as const,
      ),
    ),
    Promise.all(
      replicationJobs.map(
        async (job) =>
          [job.jobId, await dependencies.readReplicationJobRuns(pool, job.jobId)] as const,
      ),
    ),
    Promise.all(
      maintenanceTasks.map(
        async (task) =>
          [
            task.taskId,
            await dependencies.readArtifactMaintenanceTaskRuns(pool, task.taskId),
          ] as const,
      ),
    ),
  ]);

  return buildClaimWorkGraph({
    artifactMaintenanceRunsByTaskId: Object.fromEntries(
      maintenanceRuns.map(([taskId, runs]) => [taskId, runs.map(toClaimWorkRunView)]),
    ),
    artifactMaintenanceTasks: maintenanceTasks,
    artifacts,
    claimId,
    replicationJobs,
    replicationRunsByJobId: Object.fromEntries(
      replicationRuns.map(([jobId, runs]) => [jobId, runs.map(toClaimWorkRunView)]),
    ),
    reviewRunsByTaskId: Object.fromEntries(
      reviewRuns.map(([taskId, runs]) => [taskId, runs.map(toClaimWorkRunView)]),
    ),
    reviewSubmissionsByTaskId: reviewSubmissions.reduce<Record<string, ReviewSubmissionView[]>>(
      (acc, submission) => {
        const key = submission.taskId;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(submission);
        return acc;
      },
      {},
    ),
    reviewTasks,
  });
}

export async function buildSourceWorkGraphPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  sourceId: string,
  seeded: Partial<{
    source: Awaited<ReturnType<typeof readSourceRecord>>;
    reviewSubmissions: Awaited<ReturnType<typeof readReviewSubmissionsPage>>["items"];
    reviewTasks: Awaited<ReturnType<typeof readReviewTasksPage>>["items"];
  }> = {},
): Promise<SourceWorkGraphView> {
  const [source, reviewTasks, reviewSubmissions] = await Promise.all([
    seeded.source ?? dependencies.readSourceRecord(pool, sourceId),
    seeded.reviewTasks ??
      readAllPages((offset, limit) =>
        dependencies.readReviewTasksPage(pool, { sourceId, limit, offset }),
      ),
    seeded.reviewSubmissions ??
      readAllPages((offset, limit) =>
        dependencies.readReviewSubmissionsPage(pool, { sourceId, limit, offset }),
      ),
  ]);

  if (!source) {
    throw new Error(`source_not_found:${sourceId}`);
  }

  const reviewRuns = await Promise.all(
    reviewTasks.map(
      async (task) =>
        [task.taskId, await dependencies.readReviewTaskRuns(pool, task.taskId)] as const,
    ),
  );

  return buildSourceWorkGraph({
    reviewRunsByTaskId: Object.fromEntries(
      reviewRuns.map(([taskId, runs]) => [taskId, runs.map(toClaimWorkRunView)]),
    ),
    reviewSubmissionsByTaskId: reviewSubmissions.reduce<Record<string, ReviewSubmissionView[]>>(
      (acc, submission) => {
        const key = submission.taskId;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(submission);
        return acc;
      },
      {},
    ),
    reviewTasks,
    source,
  });
}

export async function readAllPages<T>(
  fetchPage: (
    offset: number,
    limit: number,
  ) => Promise<{
    items: T[];
    total: number;
  }>,
  pageSize = 200,
): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage(offset, pageSize);
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) {
      return items;
    }
    offset += page.items.length;
  }
}

export async function readAllClaims(
  dependencies: ApiDependencies,
  pool: Pool,
  options: {
    domainId?: number;
  } = {},
): Promise<ClaimView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readClaimsPage(pool, {
      ...options,
      limit,
      offset,
    }),
  );
}

export async function readAllReviewTasks(
  dependencies: ApiDependencies,
  pool: Pool,
  options: {
    claimId?: string;
    sourceId?: string;
    status?: "canceled" | "completed" | "escalated" | "open";
    taskType?: ReviewTaskView["taskType"];
  } = {},
): Promise<ReviewTaskView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readReviewTasksPage(pool, {
      ...options,
      limit,
      offset,
    }),
  );
}

export async function readAllReviewSubmissions(
  dependencies: ApiDependencies,
  pool: Pool,
  options: {
    claimId?: string;
    reviewerAgentId?: string;
    sourceId?: string;
    taskId?: string;
    verdict?: ReviewSubmissionView["verdict"];
  } = {},
): Promise<ReviewSubmissionView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readReviewSubmissionsPage(pool, {
      ...options,
      limit,
      offset,
    }),
  );
}

export async function readAllReviewIssues(
  dependencies: ApiDependencies,
  pool: Pool,
  options: {
    claimId?: string;
    severity?: ReviewIssueView["severity"];
    status?: ReviewIssueView["status"];
    taskId?: string;
  } = {},
): Promise<ReviewIssueView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readReviewIssuesPage(pool, {
      ...options,
      limit,
      offset,
    }),
  );
}

export async function readAllReviewResponses(
  dependencies: ApiDependencies,
  pool: Pool,
  options: {
    claimId?: string;
  } = {},
): Promise<ReviewAuthorResponseView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readReviewAuthorResponsesPage(pool, {
      ...options,
      limit,
      offset,
    }),
  );
}

export async function readAllClaimReplicationJobs(
  dependencies: ApiDependencies,
  pool: Pool,
  claimId: string,
): Promise<ReplicationJobView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readClaimReplicationJobsPage(pool, claimId, {
      limit,
      offset,
    }),
  );
}

export async function readAllReplicationJobs(
  dependencies: ApiDependencies,
  pool: Pool,
): Promise<ReplicationJobView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readReplicationJobsPage(pool, {
      limit,
      offset,
    }),
  );
}

export async function readAllReplicationsPageItems(
  dependencies: ApiDependencies,
  pool: Pool,
): Promise<ReplicationView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readReplicationsPage(pool, {
      limit,
      offset,
    }),
  );
}

export async function readAllAgentRequests(
  dependencies: ApiDependencies,
  pool: Pool,
  options: {
    actionType?: AgentRequestActionType;
    agentId?: string;
    scopeKey?: string;
    status?: AgentRequestStatus;
  } = {},
): Promise<AgentRequestView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readAgentRequestsPage(pool, {
      ...options,
      limit,
      offset,
    }),
  );
}

export async function readAllCheckpointPublications(
  dependencies: ApiDependencies,
  pool: Pool,
  options: {
    status?: CheckpointPublicationView["status"];
    subjectAgentId?: string;
  } = {},
): Promise<CheckpointPublicationView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readCheckpointPublicationsPage(pool, {
      ...options,
      limit,
      offset,
    }),
  );
}

export async function readAllArtifactMaintenanceTasks(
  dependencies: ApiDependencies,
  pool: Pool,
  artifactKey: string,
): Promise<ArtifactMaintenanceTaskView[]> {
  return readAllPages((offset, limit) =>
    dependencies.readPersistedArtifactMaintenanceTasksPage(pool, artifactKey, {
      limit,
      offset,
    }),
  );
}

export function titleForSource(source: {
  canonicalSourceKey: string;
  sourceMetadata: Record<string, unknown>;
}) {
  const title = source.sourceMetadata.title;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : source.canonicalSourceKey;
}

export async function listSourcesForFeed(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    status?: SourceRecordView["status"];
    sourceId?: string;
  } = {},
): Promise<SourceRecordView[]> {
  if (query.sourceId) {
    const source = await dependencies.readSourceRecord(pool, query.sourceId);
    return source ? [source] : [];
  }
  return readAllPages((offset, limit) =>
    dependencies.readSourcesPage(pool, {
      limit,
      offset,
      status: query.status,
    }),
  );
}

export async function buildSourcePublicationDecisionsPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  sourceId: string,
  query: {
    limit?: number;
    offset?: number;
    shouldPublish?: boolean;
  } = {},
) {
  return dependencies.readSourcePublicationDecisionsPage(pool, {
    limit: query.limit,
    offset: query.offset,
    shouldPublish: query.shouldPublish,
    sourceId,
  });
}

export async function latestSourceDecision(
  dependencies: ApiDependencies,
  pool: Pool,
  sourceId: string,
): Promise<SourcePublicationDecisionView | null> {
  const page = await dependencies.readSourcePublicationDecisionsPage(pool, {
    limit: 1,
    offset: 0,
    sourceId,
  });
  return page.items[0] ?? null;
}

export async function buildSourceFeedPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    limit?: number;
    offset?: number;
    status?: SourceRecordView["status"];
  } = {},
): Promise<{
  items: SourceFeedItemView[];
  limit: number;
  offset: number;
  total: number;
}> {
  const page = await dependencies.readSourcesPage(pool, query);
  const items = await Promise.all(
    page.items.map(async (source) => {
      const [latestDecision, candidates, openTasks] = await Promise.all([
        latestSourceDecision(dependencies, pool, source.sourceId),
        dependencies.readSourceExtractionCandidates(pool, source.sourceId),
        dependencies.readReviewTasksPage(pool, {
          limit: 1,
          offset: 0,
          sourceId: source.sourceId,
          status: "open",
        }),
      ]);
      return {
        candidateCount: candidates.length,
        latestDecision,
        openTaskCount: openTasks.total,
        source,
      } satisfies SourceFeedItemView;
    }),
  );
  return {
    items,
    limit: page.limit,
    offset: page.offset,
    total: page.total,
  };
}

export async function buildClaimFeedPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    claimId?: string;
    domainId?: number;
    limit?: number;
    machineProposed?: boolean;
    offset?: number;
    status?: number;
    view?: "record" | "summary";
  } = {},
): Promise<{
  items: ClaimFeedItemView[];
  limit: number;
  offset: number;
  total: number;
}> {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
  const offset = Math.max(0, query.offset ?? 0);
  const requestedClaim = query.claimId
    ? await dependencies.readClaim(pool, query.claimId)
    : undefined;
  const claimsPage = query.claimId
    ? {
        items: requestedClaim ? [requestedClaim] : [],
        limit,
        offset,
        total: requestedClaim ? 1 : 0,
      }
    : typeof query.machineProposed === "boolean"
      ? {
          items: await readAllPages((pageOffset, pageLimit) =>
            dependencies.readClaimsPage(pool, {
              domainId: query.domainId,
              limit: pageLimit,
              offset: pageOffset,
              status: query.status,
            }),
          ),
          limit,
          offset,
          total: 0,
        }
      : await dependencies.readClaimsPage(pool, {
          domainId: query.domainId,
          limit,
          offset,
          status: query.status,
        });
  const publishedSources = (
    await listSourcesForFeed(dependencies, pool, {
      status: "published",
    })
  ).filter((source) => source.publishedClaimId);
  const sourceByClaimId = new Map(
    publishedSources.map((source) => [source.publishedClaimId as string, source] as const),
  );
  const claimIds = claimsPage.items.map((claim) => claim.claimId);
  const recordData =
    query.view === "record" && claimIds.length > 0
      ? await Promise.all([
          readAllPages((pageOffset, pageLimit) =>
            dependencies.readArtifactsPage(pool, {
              claimIds,
              limit: pageLimit,
              offset: pageOffset,
            }),
          ),
          readAllPages((pageOffset, pageLimit) =>
            dependencies.readReplicationsPage(pool, {
              claimIds,
              limit: pageLimit,
              offset: pageOffset,
            }),
          ),
          dependencies.readSourceExtractionCandidatesForSources(
            pool,
            publishedSources.map((source) => source.sourceId),
          ),
        ])
      : null;
  const items = claimsPage.items
    .map((claim) => {
      const source = sourceByClaimId.get(claim.claimId) ?? null;
      const record = recordData
        ? {
            artifacts: recordData[0].filter((artifact) => artifact.claimId === claim.claimId),
            claim,
            replications: recordData[1].filter(
              (replication) => replication.claimId === claim.claimId,
            ),
            source: source
              ? {
                  candidates: recordData[2].get(source.sourceId) ?? [],
                  source,
                }
              : null,
          }
        : undefined;
      return {
        claim: {
          author: claim.author,
          claimId: claim.claimId,
          createdAtBlock: claim.createdAtBlock,
          domainId: claim.domainId,
          machineProposed: source !== null,
          sourceCanonicalKey: source?.canonicalSourceKey ?? null,
          sourceId: source?.sourceId ?? null,
          sourceTitle: source ? titleForSource(source) : null,
          status: claim.status,
        },
        ...(record ? { record } : {}),
      } satisfies ClaimFeedItemView;
    })
    .filter((item) =>
      typeof query.machineProposed === "boolean"
        ? item.claim.machineProposed === query.machineProposed
        : true,
    );
  return {
    items: typeof query.machineProposed === "boolean" ? items.slice(offset, offset + limit) : items,
    limit: typeof query.machineProposed === "boolean" ? limit : claimsPage.limit,
    offset: typeof query.machineProposed === "boolean" ? offset : claimsPage.offset,
    total: typeof query.machineProposed === "boolean" ? items.length : claimsPage.total,
  };
}

export async function buildSourceEventsPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    eventType?: SourceEventView["eventType"];
    limit?: number;
    offset?: number;
    sourceId?: string;
  } = {},
): Promise<{
  items: SourceEventView[];
  limit: number;
  offset: number;
  total: number;
}> {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
  const offset = Math.max(0, query.offset ?? 0);
  const sources = await listSourcesForFeed(dependencies, pool, { sourceId: query.sourceId });
  const events = (
    await Promise.all(
      sources.map(async (source) => {
        const decision = await latestSourceDecision(dependencies, pool, source.sourceId);
        const sourceTitle = titleForSource(source);
        const items: SourceEventView[] = [
          {
            claimId: null,
            eventId: `source:${source.sourceId}:discovered`,
            eventType: "source.discovered",
            occurredAt: source.createdAt,
            sourceId: source.sourceId,
            summary: `${sourceTitle} entered the source-ingestion pipeline.`,
            title: sourceTitle,
          },
        ];
        if (source.snapshotArtifactKey) {
          items.push({
            claimId: null,
            eventId: `source:${source.sourceId}:snapshotted`,
            eventType: "source.snapshotted",
            occurredAt: source.createdAt,
            sourceId: source.sourceId,
            summary: `${sourceTitle} was snapshotted into persisted artifact storage.`,
            title: sourceTitle,
          });
        }
        if (source.extractionArtifactKey) {
          items.push({
            claimId: null,
            eventId: `source:${source.sourceId}:extracting`,
            eventType: "source.extracting_started",
            occurredAt: source.createdAt,
            sourceId: source.sourceId,
            summary: `${sourceTitle} opened extraction work.`,
            title: sourceTitle,
          });
        }
        if (source.status === "ready_for_publication" && decision && !decision.shouldPublish) {
          items.push({
            claimId: decision.publishedClaimId,
            eventId: `source:${source.sourceId}:ready:${decision.decisionId}`,
            eventType: "source.ready_for_publication",
            occurredAt: decision.createdAt,
            sourceId: source.sourceId,
            summary: decision.reason,
            title: sourceTitle,
          });
        }
        if (source.status === "published" && decision?.shouldPublish) {
          items.push({
            claimId: source.publishedClaimId,
            eventId: `source:${source.sourceId}:published:${decision.decisionId}`,
            eventType: "source.published",
            occurredAt: decision.createdAt,
            sourceId: source.sourceId,
            summary: `${sourceTitle} auto-published as claim ${source.publishedClaimId}.`,
            title: sourceTitle,
          });
        }
        if (source.status === "rejected") {
          items.push({
            claimId: null,
            eventId: `source:${source.sourceId}:rejected:${decision?.decisionId ?? source.updatedAt}`,
            eventType: "source.rejected",
            occurredAt: decision?.createdAt ?? source.updatedAt,
            sourceId: source.sourceId,
            summary: decision?.reason ?? `${sourceTitle} was rejected from publication.`,
            title: sourceTitle,
          });
        }
        return items;
      }),
    )
  )
    .flat()
    .filter((event) => (query.eventType ? event.eventType === query.eventType : true))
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return right.occurredAt.localeCompare(left.occurredAt);
      }
      return right.eventId.localeCompare(left.eventId);
    });
  return {
    items: events.slice(offset, offset + limit),
    limit,
    offset,
    total: events.length,
  };
}

export async function buildClaimEventsPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    claimId?: string;
    domainId?: number;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  items: ClaimEventView[];
  limit: number;
  offset: number;
  total: number;
}> {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
  const offset = Math.max(0, query.offset ?? 0);
  const claims = await readAllPages((pageOffset, pageLimit) =>
    dependencies.readClaimsPage(pool, {
      domainId: query.domainId,
      limit: pageLimit,
      offset: pageOffset,
    }),
  );
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim] as const));
  const sources = (
    await listSourcesForFeed(dependencies, pool, {
      status: "published",
    })
  ).filter((source) => source.publishedClaimId);
  const events = (
    await Promise.all(
      sources.map(async (source) => {
        const decision = await latestSourceDecision(dependencies, pool, source.sourceId);
        if (!source.publishedClaimId || !decision?.shouldPublish) {
          return null;
        }
        const claim = claimById.get(source.publishedClaimId);
        if (!claim) {
          return null;
        }
        return {
          claimId: claim.claimId,
          domainId: claim.domainId,
          eventId: `claim:${claim.claimId}:machine-published:${decision.decisionId}`,
          eventType: "claim.published.machine_proposed",
          occurredAt: decision.createdAt,
          sourceId: source.sourceId,
          summary: `${titleForSource(source)} cleared source-extraction policy and published as claim ${claim.claimId}.`,
          title: `Claim ${claim.claimId} published`,
        } satisfies ClaimEventView;
      }),
    )
  )
    .flatMap((event) => (event ? [event] : []))
    .filter((event) => (query.claimId ? event.claimId === query.claimId : true))
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return right.occurredAt.localeCompare(left.occurredAt);
      }
      return right.eventId.localeCompare(left.eventId);
    });
  return {
    items: events.slice(offset, offset + limit),
    limit,
    offset,
    total: events.length,
  };
}

export async function listClaimWorkGraphs(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    claimId?: string;
  } = {},
): Promise<ClaimWorkGraphView[]> {
  const claimIds = query.claimId
    ? [query.claimId]
    : (await readAllClaims(dependencies, pool)).map((claim) => claim.claimId);
  return Promise.all(
    claimIds.map((claimId) => buildClaimWorkGraphPayload(dependencies, pool, claimId)),
  );
}

export async function listAllWorkItems(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    claimId?: string;
    claimable?: boolean;
    includeSources?: boolean;
    kind?: ClaimWorkItemView["kind"];
    lane?: ClaimWorkItemView["lane"];
    sourceId?: string;
    status?: ClaimWorkItemView["status"];
  },
): Promise<ClaimWorkItemView[]> {
  let graphs: Array<ClaimWorkGraphView | SourceWorkGraphView> = [];
  if (query.sourceId) {
    const source = await dependencies.readSourceRecord(pool, query.sourceId);
    if (!source) {
      return [];
    }
    graphs = [await buildSourceWorkGraphPayload(dependencies, pool, query.sourceId, { source })];
  } else if (query.claimId) {
    graphs = await listClaimWorkGraphs(dependencies, pool, { claimId: query.claimId });
  } else if (query.includeSources) {
    const [claimGraphs, sources] = await Promise.all([
      listClaimWorkGraphs(dependencies, pool),
      listSourcesForFeed(dependencies, pool),
    ]);
    const sourceGraphs = await Promise.all(
      sources.map((source) =>
        buildSourceWorkGraphPayload(dependencies, pool, source.sourceId, { source }),
      ),
    );
    graphs = [...claimGraphs, ...sourceGraphs];
  } else {
    graphs = await listClaimWorkGraphs(dependencies, pool);
  }
  return graphs
    .flatMap((graph) => graph.items)
    .filter((item) => (query.claimable ? item.scheduling.autoClaimable : true))
    .filter((item) => (query.kind ? item.kind === query.kind : true))
    .filter((item) => (query.lane ? item.lane === query.lane : true))
    .filter((item) => (query.status ? item.status === query.status : true))
    .sort(compareClaimWorkItemsForSelection);
}

export async function buildWorkItemsPagePayload(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    claimId?: string;
    claimable?: boolean;
    kind?: ClaimWorkItemView["kind"];
    lane?: ClaimWorkItemView["lane"];
    limit?: number;
    offset?: number;
    sourceId?: string;
    status?: ClaimWorkItemView["status"];
  },
): Promise<{
  items: ClaimWorkItemView[];
  limit: number;
  offset: number;
  total: number;
}> {
  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
  const offset = Math.max(0, query.offset ?? 0);
  const items = await listAllWorkItems(dependencies, pool, { ...query, includeSources: true });
  return {
    items: items.slice(offset, offset + limit),
    limit,
    offset,
    total: items.length,
  };
}

export async function buildWorkItemDetailPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  input: {
    claimId?: string;
    itemId: string;
    sourceId?: string;
  },
): Promise<ClaimWorkItemDetailView | null> {
  let graphs: Array<ClaimWorkGraphView | SourceWorkGraphView> = [];
  if (input.sourceId) {
    const source = await dependencies.readSourceRecord(pool, input.sourceId);
    if (!source) {
      return null;
    }
    graphs = [await buildSourceWorkGraphPayload(dependencies, pool, input.sourceId, { source })];
  } else {
    graphs = await listClaimWorkGraphs(dependencies, pool, { claimId: input.claimId });
  }
  for (const graph of graphs) {
    const item = graph.items.find((entry) => entry.itemId === input.itemId);
    if (!item) {
      continue;
    }
    let source: ClaimWorkItemDetailView["source"] = null;
    if (item.kind === "review_task") {
      const taskId = item.itemId.startsWith("review-task:")
        ? item.itemId.slice("review-task:".length)
        : item.itemId;
      const task = await dependencies.readReviewTask(pool, taskId);
      if (task) {
        source = {
          kind: "review_task",
          runs: await dependencies.readReviewTaskRuns(pool, taskId),
          submissions: await readAllReviewSubmissions(dependencies, pool, { taskId }),
          task,
        };
      }
    } else if (item.kind === "artifact_maintenance") {
      const taskId = item.itemId.startsWith("artifact-maintenance:")
        ? item.itemId.slice("artifact-maintenance:".length)
        : item.itemId;
      const task = await dependencies.readArtifactMaintenanceTask(pool, taskId);
      if (task) {
        source = {
          kind: "artifact_maintenance",
          runs: await dependencies.readArtifactMaintenanceTaskRuns(pool, taskId),
          task,
        };
      }
    } else if (item.kind === "replication_job") {
      const jobId = item.itemId.startsWith("replication-job:")
        ? item.itemId.slice("replication-job:".length)
        : item.itemId;
      const job = await dependencies.readReplicationJob(pool, jobId);
      if (job) {
        source = {
          job,
          kind: "replication_job",
          runs: await dependencies.readReplicationJobRuns(pool, jobId),
        };
      }
    }
    return {
      agentActions: item.agentActions,
      claimId: item.claimId,
      edges: graph.edges.filter((edge) => edge.fromId === item.itemId || edge.toId === item.itemId),
      item,
      source,
      subject: graph.subjects.find((subject) => subject.subjectId === item.subjectId) ?? null,
    };
  }
  return null;
}

export async function buildAgentReviewCalibrationPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  agentId: string,
  query: {
    limit?: number;
    offset?: number;
  } = {},
): Promise<{
  agentId: string;
  averageCalibrationBps: number | null;
  contributions: {
    items: AgentReviewCalibrationContributionView[];
    limit: number;
    offset: number;
    total: number;
  };
  reviewerActor: string | null;
  samples: number;
  weightBps: number;
} | null> {
  const agent = await dependencies.readAgent(pool, agentId);
  if (!agent) {
    return null;
  }

  const [claims, submissions] = await Promise.all([
    readAllClaims(dependencies, pool),
    readAllReviewSubmissions(dependencies, pool, {
      reviewerAgentId: agentId,
    }),
  ]);
  const history = buildAgentCalibrationHistory(claims, submissions);
  const calibration = history.get(agentId) ?? defaultAgentCalibration(agentId, agent.operator);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;

  return {
    agentId: calibration.agentId,
    averageCalibrationBps: calibration.averageCalibrationBps,
    contributions: {
      items: calibration.contributions.slice(offset, offset + limit),
      limit,
      offset,
      total: calibration.contributions.length,
    },
    reviewerActor: calibration.reviewerActor ?? agent.operator,
    samples: calibration.samples,
    weightBps: calibration.weightBps,
  };
}

export async function buildAgentWorkSummaryPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  agentId: string,
  query: {
    domainId?: number;
  } = {},
): Promise<{
  agentId: string;
  domainId: number | null;
  summary: AgentWorkSummaryView;
} | null> {
  const agent = await dependencies.readAgent(pool, agentId);
  if (!agent) {
    return null;
  }

  const [claims, replications, reviewTasks, reviewSubmissions, replicationJobs] = await Promise.all(
    [
      readAllClaims(dependencies, pool, {
        domainId: query.domainId,
      }),
      readAllReplicationsPageItems(dependencies, pool),
      readAllReviewTasks(dependencies, pool),
      readAllReviewSubmissions(dependencies, pool),
      readAllReplicationJobs(dependencies, pool),
    ],
  );

  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const filteredReplications = replications.filter((replication) =>
    claimIds.has(replication.claimId),
  );
  const filteredReviewTasks = reviewTasks.filter(
    (task) => typeof task.claimId === "string" && claimIds.has(task.claimId),
  );
  const filteredReviewSubmissions = reviewSubmissions.filter(
    (submission) => typeof submission.claimId === "string" && claimIds.has(submission.claimId),
  );
  const filteredReplicationJobs = replicationJobs.filter((job) => claimIds.has(job.claimId));
  const relatedArtifactKeys = collectClaimWorkArtifactKeys({
    replicationJobs: filteredReplicationJobs,
    reviewSubmissions: filteredReviewSubmissions,
    reviewTasks: filteredReviewTasks,
  });
  const maintenanceTasks = (
    await Promise.all(
      [...new Set(relatedArtifactKeys)].map((artifactKey) =>
        readAllArtifactMaintenanceTasks(dependencies, pool, artifactKey),
      ),
    )
  ).flat();
  const summary =
    buildAgentWorkSummaries({
      claims,
      maintenanceTasks,
      replicationJobs: filteredReplicationJobs,
      replications: filteredReplications,
      reviewSubmissions: filteredReviewSubmissions,
      reviewTasks: filteredReviewTasks,
    }).find((entry) => entry.agentId === agentId) ?? defaultAgentWorkSummary(agentId);

  return {
    agentId,
    domainId: query.domainId ?? null,
    summary,
  };
}

export async function buildRewardSettlementHistoryPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    agentId?: string;
    claimId?: string;
    itemId?: string;
    limit?: number;
    offset?: number;
    policyVersion?: string;
    recipient?: string;
    workKind?: "challenge" | "forecast" | "maintenance" | "replication" | "review" | "synthesis";
  } = {},
) {
  const [recentSettlements, settled] = await Promise.all([
    dependencies.readWorkRewardSettlementsPage(pool, {
      agentId: query.agentId,
      claimId: query.claimId,
      itemId: query.itemId,
      limit: query.limit,
      offset: query.offset,
      policyVersion: query.policyVersion,
      recipient: query.recipient,
      workKind: query.workKind,
    }),
    dependencies.readWorkRewardSettlementTotals(pool, {
      agentId: query.agentId,
      claimId: query.claimId,
      itemId: query.itemId,
      policyVersion: query.policyVersion,
      recipient: query.recipient,
      workKind: query.workKind,
    }),
  ]);
  return {
    recentSettlements,
    settled,
  };
}

export async function buildClaimRewardStatePayload(
  dependencies: ApiDependencies,
  pool: Pool,
  deploymentPath: string,
  claimId: string,
  query: {
    limit?: number;
    offset?: number;
    policyVersion?: string;
    workKind?: string;
  } = {},
  seeded: Partial<{
    challenges: Awaited<ReturnType<typeof readChallengesByClaim>>;
    forecasts: Awaited<ReturnType<typeof readForecastsByClaim>>;
    workGraph: ClaimWorkGraphView;
  }> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const workKind = query.workKind as
    | "challenge"
    | "forecast"
    | "maintenance"
    | "replication"
    | "review"
    | "synthesis"
    | undefined;
  const [pools, settlements, forecasts, challenges, workGraph] = await Promise.all([
    dependencies.readClaimRewardPools(claimId, deploymentPath, getRpcUrl(env)),
    buildRewardSettlementHistoryPayload(dependencies, pool, {
      claimId,
      limit: query.limit,
      offset: query.offset,
      policyVersion: query.policyVersion,
      workKind,
    }),
    seeded.forecasts ?? dependencies.readForecastsByClaim(pool, claimId),
    seeded.challenges ?? dependencies.readChallengesByClaim(pool, claimId),
    seeded.workGraph ?? buildClaimWorkGraphPayload(dependencies, pool, claimId),
  ]);
  return {
    claimId,
    policy: buildClaimRewardPolicyExplanation({
      challenges,
      forecasts,
      policyVersion: query.policyVersion,
      pools,
      workGraph,
    }),
    pools,
    recentSettlements: settlements.recentSettlements,
    settled: settlements.settled,
    totalPoolWei: pools.reduce((sum, entry) => sum + BigInt(entry.balanceWei), 0n).toString(),
  };
}

export async function buildAgentRewardStatePayload(
  dependencies: ApiDependencies,
  pool: Pool,
  deploymentPath: string,
  agentId: string,
  query: {
    limit?: number;
    offset?: number;
    policyVersion?: string;
    workKind?: string;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const agent = await dependencies.readAgent(pool, agentId);
  if (!agent) {
    return null;
  }
  const workKind = query.workKind as
    | "challenge"
    | "forecast"
    | "maintenance"
    | "replication"
    | "review"
    | "synthesis"
    | undefined;
  const [withdrawableRewardBalanceWei, settlements] = await Promise.all([
    dependencies.readRecipientAccruedRewardBalance(agent.operator, deploymentPath, getRpcUrl(env)),
    buildRewardSettlementHistoryPayload(dependencies, pool, {
      agentId,
      limit: query.limit,
      offset: query.offset,
      policyVersion: query.policyVersion,
      workKind,
    }),
  ]);

  return {
    agentId,
    budgetBalanceWei: agent.budgetBalance,
    operator: agent.operator,
    recentSettlements: settlements.recentSettlements,
    settled: settlements.settled,
    withdrawableRewardBalanceWei,
  };
}

export async function buildRecipientRewardStatePayload(
  dependencies: ApiDependencies,
  pool: Pool,
  deploymentPath: string,
  recipient: string,
  query: {
    itemId?: string;
    limit?: number;
    offset?: number;
    policyVersion?: string;
    workKind?: string;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const workKind = query.workKind as
    | "challenge"
    | "forecast"
    | "maintenance"
    | "replication"
    | "review"
    | "synthesis"
    | undefined;
  const [withdrawableRewardBalanceWei, settlements] = await Promise.all([
    dependencies.readRecipientAccruedRewardBalance(recipient, deploymentPath, getRpcUrl(env)),
    buildRewardSettlementHistoryPayload(dependencies, pool, {
      itemId: query.itemId,
      limit: query.limit,
      offset: query.offset,
      policyVersion: query.policyVersion,
      recipient,
      workKind,
    }),
  ]);
  return {
    recentSettlements: settlements.recentSettlements,
    recipient,
    settled: settlements.settled,
    withdrawableRewardBalanceWei,
  };
}

export async function buildRewardProtocolConfigPayload(
  deploymentPath: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const deployment = await loadDeploymentFile(deploymentPath);
  return {
    chainId: deployment.chainId,
    claimRewardVaultAddress: deployment.addresses.claimRewardVault,
    network: deployment.network,
    rpcUrl: publicRpcUrl(env, deployment.chainId),
  };
}

export async function buildWriteProtocolConfigPayload(
  deploymentPath: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const deployment = await loadDeploymentFile(deploymentPath);
  return {
    accessControllerAddress: deployment.addresses.accessController,
    artifactRegistryAddress: deployment.addresses.artifactRegistry,
    bondEscrowAddress: deployment.addresses.bondEscrow,
    chainId: deployment.chainId,
    claimRegistryAddress: deployment.addresses.claimRegistry,
    claimRewardVaultAddress: deployment.addresses.claimRewardVault,
    network: deployment.network,
    operatorLifecycleAuth: {
      bearerTokenFallbackEnabled: operatorTokenFallbackEnabled(env),
      canonicalMode: "wallet_signature" as const,
      checkpointPublisherRole: "CHECKPOINT_PUBLISHER_ROLE" as const,
      replicationSubmitterAuthorizedAddresses:
        await listReplicationSubmitterAuthorizedAddressesForPublicConfig(env),
      resolverRole: "RESOLVER_ROLE" as const,
    },
    rpcUrl: publicRpcUrl(env, deployment.chainId),
  };
}

export function publicRpcUrl(
  env: NodeJS.ProcessEnv = process.env,
  chainId?: number,
): string | undefined {
  const configured = readEnvValue(env, "SP_PUBLIC_RPC_URL");
  if (configured) {
    return configured;
  }
  const rawRpcUrl = getRpcUrl(env);
  if (!isLocalDevelopmentRpcUrl(rawRpcUrl)) {
    return undefined;
  }
  return chainId === undefined || chainId === 31337 ? rawRpcUrl : undefined;
}

export function redactAgentWebhookSubscriptionForPublic(subscription: Record<string, unknown>) {
  return {
    ...subscription,
    signingSecret: undefined,
    signingSecretPreview: subscription.signingSecretPreview ? "redacted" : undefined,
    targetUrl: subscription.targetUrl ? "redacted" : undefined,
  };
}

export function redactAgentWebhookDeliveryForPublic(delivery: Record<string, unknown>) {
  return {
    ...delivery,
    payload: undefined,
    responseBody: undefined,
    signature: undefined,
  };
}

export function redactPageItems<T>(
  page: { items?: T[] } & Record<string, unknown>,
  redact: (item: T) => Record<string, unknown>,
) {
  return {
    ...page,
    items: (page.items ?? []).map(redact),
  };
}

export async function buildAgentRuntimeEventsPayload(
  dependencies: ApiDependencies,
  pool: Pool,
  query: {
    agentId?: string;
    claimId?: string;
    limit?: number;
    offset?: number;
    since?: string;
  } = {},
) {
  const [workItems, agentRequests, checkpointPublications] = await Promise.all([
    listAllWorkItems(dependencies, pool, {
      claimId: query.claimId,
    }),
    readAllAgentRequests(dependencies, pool, {
      agentId: query.agentId,
    }),
    readAllCheckpointPublications(dependencies, pool, {
      subjectAgentId: query.agentId,
    }),
  ]);

  return buildAgentRuntimeEvents({
    agentId: query.agentId,
    checkpointPublications,
    claimId: query.claimId,
    limit: query.limit,
    offset: query.offset,
    requests: agentRequests,
    since: query.since,
    workItems,
  });
}

export async function buildAgentControllerCount(
  dependencies: ApiDependencies,
  pool: Pool,
  agentId: string,
): Promise<number> {
  const controllers = await dependencies.readAgentControllersPage(pool, {
    agentId,
    limit: 1,
    offset: 0,
  });
  return controllers.total;
}

export async function buildSyncStatus(
  dependencies: ApiDependencies,
  pool: Pool,
  metadata: Awaited<ReturnType<typeof readMetadata>>,
): Promise<{
  blocksRemaining: number | null;
  chainHeadBlock: number | null;
  cursorBlock: number | null;
  indexer: Awaited<ReturnType<typeof readIndexerRuntimeStatus>>;
  lagBlocks: number | null;
  rpcError: string | null;
  rpcReachable: boolean;
  syncedToHead: boolean | null;
}> {
  const [indexer, cursorBlock, chainHeadResult] = await Promise.all([
    dependencies.readIndexerRuntimeStatus(pool),
    dependencies.readSyncCursor(pool),
    dependencies
      .getChainHeadBlock()
      .then((chainHeadBlock) => ({ chainHeadBlock, rpcError: null }))
      .catch((error: unknown) => ({
        chainHeadBlock: null,
        rpcError: error instanceof Error ? error.message : String(error),
      })),
  ]);

  const chainHeadBlock = chainHeadResult.chainHeadBlock;
  const lagBlocks =
    chainHeadBlock === null ? null : Math.max(0, chainHeadBlock - metadata.latestBlock);
  const blocksRemaining =
    chainHeadBlock === null || cursorBlock === null
      ? null
      : Math.max(0, chainHeadBlock - cursorBlock);

  return {
    blocksRemaining,
    chainHeadBlock,
    cursorBlock,
    indexer,
    lagBlocks,
    rpcError: chainHeadResult.rpcError,
    rpcReachable: chainHeadBlock !== null,
    syncedToHead: blocksRemaining === null ? null : blocksRemaining === 0,
  };
}

export async function buildReadModelOptionalApiHealth(
  dependencies: ApiDependencies,
  deploymentPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  chainId: number | null;
  deploymentBlock: number | null;
  latestBlock: number;
  sync: {
    blocksRemaining: null;
    chainHeadBlock: number | null;
    cursorBlock: null;
    lagBlocks: null;
    rpcError: string | null;
    rpcReachable: boolean;
    syncedToHead: null;
  };
}> {
  const [deploymentResult, chainHeadResult] = await Promise.all([
    loadDeploymentFile(deploymentPath, { env })
      .then((deployment) => ({ deployment, error: null }))
      .catch((error: unknown) => ({
        deployment: null,
        error: error instanceof Error ? error.message : String(error),
      })),
    dependencies
      .getChainHeadBlock()
      .then((chainHeadBlock) => ({ chainHeadBlock, rpcError: null }))
      .catch((error: unknown) => ({
        chainHeadBlock: null,
        rpcError: error instanceof Error ? error.message : String(error),
      })),
  ]);
  const chainHeadBlock = chainHeadResult.chainHeadBlock;
  const deployment = deploymentResult.deployment;

  return {
    chainId: deployment?.chainId ?? null,
    deploymentBlock: deployment?.deploymentBlock ?? null,
    latestBlock: chainHeadBlock ?? deployment?.deploymentBlock ?? 0,
    sync: {
      blocksRemaining: null,
      chainHeadBlock,
      cursorBlock: null,
      lagBlocks: null,
      rpcError: chainHeadResult.rpcError ?? deploymentResult.error,
      rpcReachable: chainHeadBlock !== null,
      syncedToHead: null,
    },
  };
}
