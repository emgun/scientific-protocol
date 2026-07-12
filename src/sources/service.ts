import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  type ArtifactDraftInput,
  type ArtifactIngestionResult,
  ingestArtifactSource,
} from "../artifacts/ingestion.js";
import { readPersistedArtifact, upsertPersistedArtifact } from "../coordinator/store.js";
import { createReviewTask } from "../review/store.js";
import { readPersistedArtifactContent } from "../shared/persisted-artifacts.js";
import { canonicalizeSourceLocator } from "./canonicalize.js";
import {
  completeSourceIngestionAttempt,
  failSourceIngestionAttempt,
  insertSourceSubmissionRecord,
  readSourceByCanonicalKey,
  readSourceIngestionAttempt,
  readSourceRecord,
  reserveSourceIngestionAttempt,
  upsertSourceRecord,
} from "./store.js";
import type {
  SourceRecordView,
  SourceSubmissionOutcome,
  SourceSubmissionRecordView,
  SourceType,
} from "./types.js";

export type SourceIngestionResult = ArtifactIngestionResult & {
  source: SourceRecordView;
  submission: SourceSubmissionRecordView;
  submissionOutcome: SourceSubmissionOutcome;
};

export type SourceIngestOptions = {
  artifactIngestor?: typeof ingestArtifactSource;
  discoveryMode?: SourceRecordView["discoveryMode"];
  ingestionLeaseMs?: number;
  ingestionWaitMs?: number;
  ingestionWaitPollMs?: number;
  leaseOwner?: string;
  openSourceExtractionTasks?: typeof openSourceExtractionTasks;
  submittedByActor?: string | null;
  submittedByAgentId?: string | null;
};

const DEFAULT_INGESTION_LEASE_MS = 30_000;
const DEFAULT_INGESTION_WAIT_MS = 25_000;
const DEFAULT_INGESTION_WAIT_POLL_MS = 50;

type SourceQueryable = Pool | PoolClient;

type SourceIngestionTxResult = {
  openTaskInput: {
    snapshotArtifactKey: string;
    source: SourceRecordView;
  } | null;
  result: SourceIngestionResult;
};

function inferArtifactTypeFromSnapshotArtifact(
  artifact: Pick<ArtifactIngestionResult["snapshotArtifact"], "contentType">,
): number {
  const contentType = artifact.contentType.toLowerCase();
  if (contentType.includes("application/gzip") || contentType.includes("application/zip")) {
    return 1;
  }
  if (contentType.includes("application/pdf")) {
    return 5;
  }
  if (contentType.startsWith("text/")) {
    return 5;
  }
  return 7;
}

function sourceLocatorForInput(input: ArtifactDraftInput): { locator: string; ref: string | null } {
  if (input.sourceType === "repository") {
    return {
      locator: input.repositoryUrl,
      ref: input.ref?.trim() || null,
    };
  }
  return {
    locator: input.sourceUrl,
    ref: null,
  };
}

function sourceSubmissionLockKey(canonicalSourceKey: string): string {
  const digest = createHash("sha256").update(`source-submission:${canonicalSourceKey}`).digest();
  return BigInt.asIntN(64, digest.readBigInt64BE(0)).toString();
}

async function waitForSourceIngestion(
  pool: Pool,
  canonicalSourceKey: string,
  waitMs: number,
  pollMs: number,
): Promise<SourceRecordView | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const source = await readSourceByCanonicalKey(pool, canonicalSourceKey);
    if (source) return source;
    const attempt = await readSourceIngestionAttempt(pool, canonicalSourceKey);
    if (
      !attempt ||
      attempt.status === "failed" ||
      (attempt.leaseExpiresAt && Date.parse(attempt.leaseExpiresAt) <= Date.now())
    ) {
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("source_ingestion_in_progress");
}

async function withSourceSubmissionLock<T>(
  pool: Pool,
  canonicalSourceKey: string,
  callback: (queryable: SourceQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      sourceSubmissionLockKey(canonicalSourceKey),
    ]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sourceMetadataRecord(
  sourceMetadata: Record<string, unknown> | null,
): Record<string, unknown> {
  return sourceMetadata ?? {};
}

function isArtifactExtractionPreview(value: unknown): value is ArtifactIngestionResult["preview"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.candidateStatements) &&
    typeof record.extractedTextPreview === "string" &&
    typeof record.metadata === "string" &&
    typeof record.methodology === "string" &&
    typeof record.predictionHooks === "string" &&
    typeof record.scope === "string" &&
    typeof record.sourceDescriptor === "string" &&
    typeof record.statement === "string" &&
    typeof record.summary === "string" &&
    typeof record.title === "string"
  );
}

function isArtifactSourceVersion(
  value: unknown,
): value is ArtifactIngestionResult["sourceVersion"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.contentType === "string" && typeof record.extension === "string";
}

function sourceMetadataArtifactType(sourceMetadata: Record<string, unknown>): number | null {
  return typeof sourceMetadata.artifactType === "number" ? sourceMetadata.artifactType : null;
}

function sourceMetadataSourceType(
  sourceMetadata: Record<string, unknown>,
): ArtifactIngestionResult["sourceType"] | null {
  const value = sourceMetadata.sourceType;
  return value === "repository" || value === "url" ? value : null;
}

async function readLegacyReplayMetadata(
  extractionArtifact: Pick<ArtifactIngestionResult["extractionArtifact"], "storagePath">,
): Promise<{
  preview: ArtifactIngestionResult["preview"];
  sourceLocator: string | null;
  sourceType: ArtifactIngestionResult["sourceType"] | null;
  sourceVersion: ArtifactIngestionResult["sourceVersion"];
} | null> {
  try {
    const content = await readPersistedArtifactContent(extractionArtifact);
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      !isArtifactExtractionPreview(parsed.preview) ||
      !isArtifactSourceVersion(parsed.sourceVersion)
    ) {
      return null;
    }
    return {
      preview: parsed.preview,
      sourceLocator: typeof parsed.sourceLocator === "string" ? parsed.sourceLocator : null,
      sourceType:
        parsed.sourceType === "repository" || parsed.sourceType === "url"
          ? parsed.sourceType
          : null,
      sourceVersion: parsed.sourceVersion,
    };
  } catch {
    return null;
  }
}

export async function ingestSource(
  pool: Pool,
  input: ArtifactDraftInput,
  options: SourceIngestOptions = {},
): Promise<SourceIngestionResult> {
  const { locator, ref } = sourceLocatorForInput(input);
  const canonical = canonicalizeSourceLocator({
    locator,
    ref,
    sourceType: input.sourceType as SourceType,
  });
  const leaseOwner = options.leaseOwner ?? randomUUID();
  const leaseMs = options.ingestionLeaseMs ?? DEFAULT_INGESTION_LEASE_MS;
  const waitMs = options.ingestionWaitMs ?? DEFAULT_INGESTION_WAIT_MS;
  const waitPollMs = options.ingestionWaitPollMs ?? DEFAULT_INGESTION_WAIT_POLL_MS;
  let acquired = false;
  for (let reservationPass = 0; reservationPass < 3; reservationPass += 1) {
    const existing = await readSourceByCanonicalKey(pool, canonical.canonicalSourceKey);
    if (existing) {
      return replayDuplicateSourceSubmission(pool, input, canonical, existing, options);
    }
    const reservation = await reserveSourceIngestionAttempt(pool, {
      canonicalSourceKey: canonical.canonicalSourceKey,
      leaseMs,
      leaseOwner,
      normalizedLocator: canonical.normalizedLocator,
      rawLocator: locator,
      sourceType: input.sourceType,
    });
    if (reservation.acquired) {
      acquired = true;
      break;
    }
    const completed = await waitForSourceIngestion(
      pool,
      canonical.canonicalSourceKey,
      waitMs,
      waitPollMs,
    );
    if (completed) {
      return replayDuplicateSourceSubmission(pool, input, canonical, completed, options);
    }
  }
  if (!acquired) throw new Error("source_ingestion_in_progress");

  // Network, parsing, and artifact persistence run without a checked-out DB
  // connection or transaction. The short transaction below performs the
  // canonical-key compare-and-set. Concurrent callers may duplicate bounded,
  // content-addressed work, but can publish only one source record.
  let ingestion: ArtifactIngestionResult;
  try {
    ingestion = await (options.artifactIngestor ?? ingestArtifactSource)(input);
  } catch (error) {
    await failSourceIngestionAttempt(pool, {
      canonicalSourceKey: canonical.canonicalSourceKey,
      lastError: error instanceof Error ? error.message : String(error),
      leaseOwner,
    });
    throw error;
  }
  const txResult = await withSourceSubmissionLock<SourceIngestionTxResult>(
    pool,
    canonical.canonicalSourceKey,
    async (queryable) => {
      const existing = await readSourceByCanonicalKey(queryable, canonical.canonicalSourceKey);
      if (existing) {
        return {
          openTaskInput: null,
          result: await replayDuplicateSourceSubmission(
            queryable,
            input,
            canonical,
            existing,
            options,
          ),
        };
      }

      const snapshotArtifact = await upsertPersistedArtifact(queryable, ingestion.snapshotArtifact);
      const extractionArtifact = await upsertPersistedArtifact(
        queryable,
        ingestion.extractionArtifact,
      );
      const source = await upsertSourceRecord(queryable, {
        canonicalSourceKey: canonical.canonicalSourceKey,
        discoveryMode: options.discoveryMode ?? "user_submitted",
        extractionArtifactKey: extractionArtifact.artifactKey,
        snapshotArtifactKey: snapshotArtifact.artifactKey,
        sourceMetadata: {
          artifactType: ingestion.artifactType,
          locator: ingestion.sourceLocator,
          preview: ingestion.preview,
          ref: ingestion.sourceVersion.ref ?? null,
          sourceType: ingestion.sourceType,
          sourceVersion: ingestion.sourceVersion,
          title: ingestion.preview.title,
        },
        sourceType: ingestion.sourceType,
        status: "extracting",
        submittedByActor: options.submittedByActor ?? null,
        submittedByAgentId: options.submittedByAgentId ?? null,
      });
      const submission = await insertSourceSubmissionRecord(queryable, {
        canonicalSourceKey: canonical.canonicalSourceKey,
        discoveryMode: options.discoveryMode ?? "user_submitted",
        normalizedLocator: canonical.normalizedLocator,
        rawLocator: locator,
        sourceId: source.sourceId,
        submissionOutcome: "created",
        submittedByActor: options.submittedByActor ?? null,
        submittedByAgentId: options.submittedByAgentId ?? null,
      });
      const completed = await completeSourceIngestionAttempt(queryable, {
        canonicalSourceKey: canonical.canonicalSourceKey,
        leaseOwner,
        sourceId: source.sourceId,
      });
      if (!completed) throw new Error("source_ingestion_attempt_lease_lost");

      return {
        openTaskInput: {
          snapshotArtifactKey: snapshotArtifact.artifactKey,
          source,
        },
        result: {
          ...ingestion,
          extractionArtifact,
          snapshotArtifact,
          source,
          submission,
          submissionOutcome: "created",
        },
      };
    },
  );

  if (txResult.openTaskInput) {
    const openTasks = options.openSourceExtractionTasks ?? openSourceExtractionTasks;
    await openTasks(pool, txResult.openTaskInput);
  }

  return txResult.result;
}

async function replayDuplicateSourceSubmission(
  queryable: SourceQueryable,
  input: ArtifactDraftInput,
  canonical: ReturnType<typeof canonicalizeSourceLocator>,
  existing: SourceRecordView,
  options: SourceIngestOptions,
): Promise<SourceIngestionResult> {
  const metadata = sourceMetadataRecord(existing.sourceMetadata);
  let preview = metadata.preview as ArtifactIngestionResult["preview"] | undefined;
  let sourceVersion = metadata.sourceVersion as
    | ArtifactIngestionResult["sourceVersion"]
    | undefined;
  let sourceLocator =
    typeof metadata.locator === "string" ? metadata.locator : canonical.normalizedLocator;
  let sourceType = sourceMetadataSourceType(metadata) ?? existing.sourceType;
  if (existing.snapshotArtifactKey !== null && existing.extractionArtifactKey !== null) {
    const [snapshotArtifact, extractionArtifact] = await Promise.all([
      readPersistedArtifact(queryable, existing.snapshotArtifactKey as string),
      readPersistedArtifact(queryable, existing.extractionArtifactKey as string),
    ]);
    if (snapshotArtifact && extractionArtifact) {
      if (!preview || !sourceVersion) {
        const legacyMetadata = await readLegacyReplayMetadata(extractionArtifact);
        if (legacyMetadata) {
          preview = legacyMetadata.preview;
          sourceVersion = legacyMetadata.sourceVersion;
          sourceLocator = legacyMetadata.sourceLocator ?? sourceLocator;
          sourceType = legacyMetadata.sourceType ?? sourceType;
        }
      }
      if (!preview || !sourceVersion) {
        throw new Error(`source_duplicate_replay_unavailable:${existing.sourceId}`);
      }
      const submission = await insertSourceSubmissionRecord(queryable, {
        canonicalSourceKey: canonical.canonicalSourceKey,
        discoveryMode: options.discoveryMode ?? "user_submitted",
        normalizedLocator: canonical.normalizedLocator,
        rawLocator: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
        sourceId: existing.sourceId,
        submissionOutcome: "duplicate",
        submittedByActor: options.submittedByActor ?? null,
        submittedByAgentId: options.submittedByAgentId ?? null,
      });

      return {
        artifactType:
          sourceMetadataArtifactType(metadata) ??
          inferArtifactTypeFromSnapshotArtifact(snapshotArtifact),
        extractionArtifact,
        preview,
        snapshotArtifact,
        source: existing,
        sourceLocator,
        sourceType,
        sourceVersion,
        submission,
        submissionOutcome: "duplicate",
      };
    }
  }
  throw new Error(`source_duplicate_replay_unavailable:${existing.sourceId}`);
}

export async function openSourceExtractionTasks(
  pool: Pool,
  input: {
    snapshotArtifactKey: string;
    source: SourceRecordView;
  },
) {
  const sourceId = input.source.sourceId;
  const sourceScopeKey = `source:${sourceId}`;
  await createReviewTask(pool, {
    consensusPolicy: {
      maxSubmissions: 4,
      minSubmissions: 2,
      requireDistinctAgents: true,
    },
    inputArtifactKeys: [input.snapshotArtifactKey, input.source.extractionArtifactKey ?? ""].filter(
      (value) => value.length > 0,
    ),
    requestedBy: "source-ingress",
    requiredCapabilities: ["claim-extraction", "literature-scan"],
    scopeKey: `${sourceScopeKey}:extract`,
    sourceId,
    sourceSubjectId: sourceId,
    sourceSubjectType: "source_record",
    taskType: "claim_extraction_check",
  });
  await createReviewTask(pool, {
    consensusPolicy: {
      maxSubmissions: 2,
      minSubmissions: 1,
      requireDistinctAgents: true,
    },
    inputArtifactKeys: [input.snapshotArtifactKey, input.source.extractionArtifactKey ?? ""].filter(
      (value) => value.length > 0,
    ),
    requestedBy: "source-ingress",
    requiredCapabilities: ["claim-synthesis"],
    scopeKey: `${sourceScopeKey}:synth`,
    sourceId,
    sourceSubjectId: sourceId,
    sourceSubjectType: "source_record",
    taskType: "claim_extraction_synthesis_check",
  });

  return readSourceRecord(pool, sourceId);
}
