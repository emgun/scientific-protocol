import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import { normalizePagination } from "../shared/pagination.js";
import {
  CLAIM_REVIEW_VECTOR_DIMENSIONS,
  REVIEW_TASK_TYPES,
  type ReviewAuthorResponseView,
  type ReviewConsensusPolicy,
  type ReviewDimensionScores,
  type ReviewIssueSeverity,
  type ReviewIssueStatus,
  type ReviewIssueView,
  type ReviewSubmissionVerdict,
  type ReviewSubmissionView,
  type ReviewTaskRunStatus,
  type ReviewTaskRunView,
  type ReviewTaskStatus,
  type ReviewTaskType,
  type ReviewTaskView,
} from "./types.js";

type Queryable = Pool | PoolClient;

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export type ReviewTaskListOptions = {
  claimId?: string;
  limit?: number;
  offset?: number;
  sourceId?: string;
  status?: ReviewTaskStatus;
  taskType?: ReviewTaskType;
};

export type ReviewSubmissionListOptions = {
  claimId?: string;
  limit?: number;
  offset?: number;
  reviewerAgentId?: string;
  sourceId?: string;
  taskId?: string;
  verdict?: ReviewSubmissionVerdict;
};

export type ReviewIssueListOptions = {
  claimId?: string;
  limit?: number;
  offset?: number;
  severity?: ReviewIssueSeverity;
  status?: ReviewIssueStatus;
  taskId?: string;
};

export type ReviewAuthorResponseListOptions = {
  claimId?: string;
  limit?: number;
  offset?: number;
};

const DEFAULT_CONSENSUS_POLICY: ReviewConsensusPolicy = {
  maxSubmissions: 1,
  minSubmissions: 1,
  requireDistinctAgents: false,
};

function clampInteger(input: unknown, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(input)) {
    return fallback;
  }
  const value = Math.floor(Number(input));
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeConsensusPolicy(input: unknown): ReviewConsensusPolicy {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const minSubmissions = clampInteger(
    raw.minSubmissions,
    1,
    10,
    DEFAULT_CONSENSUS_POLICY.minSubmissions,
  );
  const maxSubmissions = clampInteger(
    raw.maxSubmissions,
    minSubmissions,
    10,
    Math.max(DEFAULT_CONSENSUS_POLICY.maxSubmissions, minSubmissions),
  );
  return {
    maxSubmissions,
    minSubmissions,
    requireDistinctAgents:
      typeof raw.requireDistinctAgents === "boolean"
        ? raw.requireDistinctAgents
        : DEFAULT_CONSENSUS_POLICY.requireDistinctAgents,
  };
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeTaskType(input: unknown): ReviewTaskType {
  if (typeof input !== "string" || !REVIEW_TASK_TYPES.includes(input as ReviewTaskType)) {
    throw new Error(`unsupported_review_task_type:${String(input)}`);
  }
  return input as ReviewTaskType;
}

function normalizeVerdict(input: unknown): ReviewSubmissionVerdict {
  if (input !== "pass" && input !== "fail" && input !== "flag" && input !== "inconclusive") {
    throw new Error(`unsupported_review_submission_verdict:${String(input)}`);
  }
  return input;
}

function normalizeIssueSeverity(input: unknown): ReviewIssueSeverity {
  if (input !== "low" && input !== "medium" && input !== "high" && input !== "critical") {
    throw new Error(`unsupported_review_issue_severity:${String(input)}`);
  }
  return input;
}

function normalizeIssueStatus(input: unknown): ReviewIssueStatus {
  if (input !== "open" && input !== "responded" && input !== "resolved" && input !== "dismissed") {
    throw new Error(`unsupported_review_issue_status:${String(input)}`);
  }
  return input;
}

function normalizeTaskStatus(input: unknown): ReviewTaskStatus {
  if (input !== "open" && input !== "completed" && input !== "escalated" && input !== "canceled") {
    throw new Error(`unsupported_review_task_status:${String(input)}`);
  }
  return input;
}

function normalizeRunStatus(input: unknown): ReviewTaskRunStatus {
  if (input !== "running" && input !== "completed" && input !== "failed") {
    throw new Error(`unsupported_review_run_status:${String(input)}`);
  }
  return input;
}

function normalizeDimensionScores(input: unknown): ReviewDimensionScores {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const raw = input as Record<string, unknown>;
  const normalized: ReviewDimensionScores = {};
  for (const dimension of CLAIM_REVIEW_VECTOR_DIMENSIONS) {
    if (raw[dimension] === undefined) {
      continue;
    }
    normalized[dimension] = clampInteger(raw[dimension], 0, 10_000, 0);
  }
  return normalized;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

type ReviewTaskRow = {
  claimId: string | null;
  completedAt: Date | null;
  consensusPolicy: ReviewConsensusPolicy;
  createdAt: Date;
  failureReason: string | null;
  inputArtifactKeys: unknown;
  requestedBy: string;
  requiredCapabilities: unknown;
  resultArtifactKey: string | null;
  schemaVersion: string;
  scopeKey: string;
  sourceId: string | null;
  subjectId: string;
  subjectType: "claim" | "source_record";
  status: ReviewTaskStatus;
  taskId: string;
  taskType: ReviewTaskType;
  updatedAt: Date;
};

type ReviewTaskRunRow = {
  agentId: string | null;
  failureReason: string | null;
  finishedAt: Date | null;
  lastHeartbeatAt: Date | null;
  runId: string;
  startedAt: Date;
  status: ReviewTaskRunStatus;
  taskId: string;
  workerId: string;
};

type ReviewSubmissionRow = {
  claimId: string | null;
  confidenceBps: number;
  createdAt: Date;
  dimensions: unknown;
  evidenceArtifactKey: string | null;
  payload: Record<string, unknown> | null;
  resultArtifactKey: string | null;
  reviewType: ReviewTaskType;
  reviewerActor: string;
  reviewerAgentId: string | null;
  runId: string | null;
  schemaVersion: string;
  sourceId: string | null;
  submissionId: string;
  taskId: string;
  verdict: ReviewSubmissionVerdict;
};

type ReviewIssueRow = {
  artifactAnchor: Record<string, unknown> | null;
  category: string;
  createdAt: Date;
  issueId: string;
  severity: ReviewIssueSeverity;
  status: ReviewIssueStatus;
  submissionId: string;
  summary: string;
  updatedAt: Date;
};

type ReviewAuthorResponseRow = {
  claimId: string;
  createdAt: Date;
  issueIds: unknown;
  responderActor: string;
  responseArtifactKey: string;
  responseId: string;
  summary: string;
};

function mapReviewTaskRow(row: ReviewTaskRow): ReviewTaskView {
  return {
    claimId: row.claimId,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    consensusPolicy: normalizeConsensusPolicy(row.consensusPolicy),
    createdAt: row.createdAt.toISOString(),
    failureReason: row.failureReason,
    inputArtifactKeys: normalizeStringArray(row.inputArtifactKeys),
    requestedBy: row.requestedBy,
    requiredCapabilities: normalizeStringArray(row.requiredCapabilities),
    resultArtifactKey: row.resultArtifactKey,
    schemaVersion: row.schemaVersion,
    scopeKey: row.scopeKey,
    sourceId: row.sourceId,
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    status: normalizeTaskStatus(row.status),
    taskId: row.taskId,
    taskType: normalizeTaskType(row.taskType),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapReviewTaskRunRow(row: ReviewTaskRunRow): ReviewTaskRunView {
  return {
    agentId: row.agentId,
    failureReason: row.failureReason,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    lastHeartbeatAt: row.lastHeartbeatAt ? row.lastHeartbeatAt.toISOString() : null,
    runId: row.runId,
    startedAt: row.startedAt.toISOString(),
    status: normalizeRunStatus(row.status),
    taskId: row.taskId,
    workerId: row.workerId,
  };
}

function mapReviewSubmissionRow(row: ReviewSubmissionRow): ReviewSubmissionView {
  return {
    claimId: row.claimId,
    confidenceBps: clampInteger(row.confidenceBps, 0, 10_000, 0),
    createdAt: row.createdAt.toISOString(),
    dimensions: normalizeDimensionScores(row.dimensions),
    evidenceArtifactKey: row.evidenceArtifactKey,
    payload: row.payload ?? {},
    resultArtifactKey: row.resultArtifactKey,
    reviewType: normalizeTaskType(row.reviewType),
    reviewerActor: row.reviewerActor,
    reviewerAgentId: row.reviewerAgentId,
    runId: row.runId,
    schemaVersion: row.schemaVersion,
    sourceId: row.sourceId,
    submissionId: row.submissionId,
    taskId: row.taskId,
    verdict: normalizeVerdict(row.verdict),
  };
}

function mapReviewIssueRow(row: ReviewIssueRow): ReviewIssueView {
  return {
    artifactAnchor: row.artifactAnchor ?? {},
    category: row.category,
    createdAt: row.createdAt.toISOString(),
    issueId: row.issueId,
    severity: normalizeIssueSeverity(row.severity),
    status: normalizeIssueStatus(row.status),
    submissionId: row.submissionId,
    summary: row.summary,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapReviewAuthorResponseRow(row: ReviewAuthorResponseRow): ReviewAuthorResponseView {
  return {
    claimId: row.claimId,
    createdAt: row.createdAt.toISOString(),
    issueIds: normalizeStringArray(row.issueIds),
    responderActor: row.responderActor,
    responseArtifactKey: row.responseArtifactKey,
    responseId: row.responseId,
    summary: row.summary,
  };
}

export async function prepareReviewStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function createReviewTask(
  pool: Pool,
  input: {
    claimId?: string | null;
    consensusPolicy?: Partial<ReviewConsensusPolicy>;
    inputArtifactKeys?: string[];
    requestedBy: string;
    requiredCapabilities?: string[];
    schemaVersion?: string;
    scopeKey?: string;
    sourceId?: string | null;
    sourceSubjectId?: string;
    sourceSubjectType?: "source_record";
    taskType: ReviewTaskType;
  },
): Promise<ReviewTaskView> {
  const client = await pool.connect();
  const consensusPolicy = normalizeConsensusPolicy({
    ...DEFAULT_CONSENSUS_POLICY,
    ...input.consensusPolicy,
  });
  const scopeKey = input.scopeKey?.trim() || input.taskType;
  const claimId = input.claimId?.trim() || null;
  const sourceId = input.sourceId?.trim() || null;
  const subjectType = input.sourceSubjectType ?? "claim";
  const subjectId =
    subjectType === "source_record" ? input.sourceSubjectId?.trim() || sourceId : claimId;
  if (!subjectId) {
    throw new Error("review_task_subject_required");
  }

  try {
    await client.query("BEGIN");
    const existing = await client.query<{ task_id: string }>(
      `
        SELECT task_id
        FROM review_tasks
        WHERE subject_type = $1
          AND subject_id = $2
          AND task_type = $3
          AND scope_key = $4
          AND status = 'open'
        ORDER BY task_id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [subjectType, subjectId, input.taskType, scopeKey],
    );
    const existingTaskId = existing.rows[0]?.task_id;
    if (existingTaskId) {
      await client.query("COMMIT");
      const task = await readReviewTask(pool, existingTaskId);
      if (!task) {
        throw new Error("review_task_not_found_after_conflict");
      }
      return task;
    }

    const inserted = await client.query<{ task_id: string }>(
      `
        INSERT INTO review_tasks (
          claim_id,
          source_id,
          subject_type,
          subject_id,
          task_type,
          scope_key,
          schema_version,
          status,
          requested_by,
          required_capabilities,
          input_artifact_keys,
          consensus_policy
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9::jsonb, $10::jsonb, $11::jsonb)
        RETURNING task_id::text AS task_id
      `,
      [
        claimId,
        sourceId,
        subjectType,
        subjectId,
        input.taskType,
        scopeKey,
        input.schemaVersion ?? "review-task.v1",
        input.requestedBy,
        serializeJson(input.requiredCapabilities ?? []),
        serializeJson(input.inputArtifactKeys ?? []),
        serializeJson(consensusPolicy),
      ],
    );
    await client.query("COMMIT");
    const insertedTaskId = inserted.rows[0]?.task_id;
    if (!insertedTaskId) {
      throw new Error("review_task_insert_failed");
    }
    const task = await readReviewTask(pool, insertedTaskId);
    if (!task) {
      throw new Error("review_task_not_found_after_insert");
    }
    return task;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string } | undefined)?.code === "23505") {
      const page = await readReviewTasksPage(pool, {
        claimId: claimId ?? undefined,
        limit: 1,
        offset: 0,
        sourceId: sourceId ?? undefined,
        status: "open",
        taskType: input.taskType,
      });
      const task = page.items.find((item) => item.scopeKey === scopeKey);
      if (task) {
        return task;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function readReviewTask(
  queryable: Queryable,
  taskId: string,
): Promise<ReviewTaskView | undefined> {
  const result = await queryable.query<ReviewTaskRow>(
    `
      SELECT
        task_id::text AS "taskId",
        claim_id AS "claimId",
        source_id::text AS "sourceId",
        subject_type AS "subjectType",
        subject_id AS "subjectId",
        task_type AS "taskType",
        scope_key AS "scopeKey",
        schema_version AS "schemaVersion",
        status,
        requested_by AS "requestedBy",
        required_capabilities AS "requiredCapabilities",
        input_artifact_keys AS "inputArtifactKeys",
        consensus_policy AS "consensusPolicy",
        result_artifact_key AS "resultArtifactKey",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM review_tasks
      WHERE task_id = $1
    `,
    [taskId],
  );
  const row = result.rows[0];
  return row ? mapReviewTaskRow(row) : undefined;
}

export async function readReviewTaskRun(
  queryable: Queryable,
  runId: string,
): Promise<ReviewTaskRunView | undefined> {
  const result = await queryable.query<ReviewTaskRunRow>(
    `
      SELECT
        run_id::text AS "runId",
        task_id::text AS "taskId",
        worker_id AS "workerId",
        agent_id AS "agentId",
        status,
        failure_reason AS "failureReason",
        last_heartbeat_at AS "lastHeartbeatAt",
        started_at AS "startedAt",
        finished_at AS "finishedAt"
      FROM review_task_runs
      WHERE run_id = $1
    `,
    [runId],
  );
  const row = result.rows[0];
  return row ? mapReviewTaskRunRow(row) : undefined;
}

export async function readReviewTaskRuns(
  queryable: Queryable,
  taskId: string,
): Promise<ReviewTaskRunView[]> {
  const result = await queryable.query<ReviewTaskRunRow>(
    `
      SELECT
        run_id::text AS "runId",
        task_id::text AS "taskId",
        worker_id AS "workerId",
        agent_id AS "agentId",
        status,
        failure_reason AS "failureReason",
        last_heartbeat_at AS "lastHeartbeatAt",
        started_at AS "startedAt",
        finished_at AS "finishedAt"
      FROM review_task_runs
      WHERE task_id = $1
      ORDER BY started_at DESC, run_id DESC
    `,
    [taskId],
  );
  return result.rows.map(mapReviewTaskRunRow);
}

export async function readReviewTasksPage(
  queryable: Queryable,
  options: ReviewTaskListOptions = {},
): Promise<PageResult<ReviewTaskView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.sourceId) {
    values.push(options.sourceId);
    clauses.push(`source_id::text = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }
  if (options.taskType) {
    values.push(options.taskType);
    clauses.push(`task_type = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_tasks${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<ReviewTaskRow>(
    `
      SELECT
        task_id::text AS "taskId",
        claim_id AS "claimId",
        source_id::text AS "sourceId",
        subject_type AS "subjectType",
        subject_id AS "subjectId",
        task_type AS "taskType",
        scope_key AS "scopeKey",
        schema_version AS "schemaVersion",
        status,
        requested_by AS "requestedBy",
        required_capabilities AS "requiredCapabilities",
        input_artifact_keys AS "inputArtifactKeys",
        consensus_policy AS "consensusPolicy",
        result_artifact_key AS "resultArtifactKey",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM review_tasks
      ${whereClause}
      ORDER BY created_at DESC, task_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );

  return {
    items: result.rows.map(mapReviewTaskRow),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

async function countReviewTaskCompletedSubmissions(
  queryable: Queryable,
  taskId: string,
): Promise<number> {
  const result = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_submissions WHERE task_id = $1`,
    [taskId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function countReviewTaskRunningRuns(queryable: Queryable, taskId: string): Promise<number> {
  const result = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_task_runs WHERE task_id = $1 AND status = 'running'`,
    [taskId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function claimReviewTaskById(
  pool: Pool,
  input: {
    agentId?: string | null;
    taskId: string;
    workerId: string;
  },
): Promise<{ run: ReviewTaskRunView; task: ReviewTaskView } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockedTask = await client.query<ReviewTaskRow>(
      `
      SELECT
          task_id::text AS "taskId",
          claim_id AS "claimId",
          source_id::text AS "sourceId",
          subject_type AS "subjectType",
          subject_id AS "subjectId",
          task_type AS "taskType",
          scope_key AS "scopeKey",
          schema_version AS "schemaVersion",
          status,
          requested_by AS "requestedBy",
          required_capabilities AS "requiredCapabilities",
          input_artifact_keys AS "inputArtifactKeys",
          consensus_policy AS "consensusPolicy",
          result_artifact_key AS "resultArtifactKey",
          failure_reason AS "failureReason",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM review_tasks
        WHERE task_id = $1
        FOR UPDATE
      `,
      [input.taskId],
    );
    const taskRow = lockedTask.rows[0];
    if (!taskRow) {
      await client.query("ROLLBACK");
      return null;
    }
    const task = mapReviewTaskRow(taskRow);
    if (task.status !== "open") {
      await client.query("ROLLBACK");
      return null;
    }

    const completedSubmissions = await countReviewTaskCompletedSubmissions(client, input.taskId);
    if (completedSubmissions >= task.consensusPolicy.maxSubmissions) {
      await client.query("ROLLBACK");
      return null;
    }

    const runningRuns = await countReviewTaskRunningRuns(client, input.taskId);
    if (completedSubmissions + runningRuns >= task.consensusPolicy.maxSubmissions) {
      await client.query("ROLLBACK");
      return null;
    }

    if (input.agentId && task.consensusPolicy.requireDistinctAgents) {
      const priorSubmission = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM review_submissions
          WHERE task_id = $1 AND reviewer_agent_id = $2
        `,
        [input.taskId, input.agentId],
      );
      const priorRuns = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM review_task_runs
          WHERE task_id = $1
            AND agent_id = $2
            AND status = 'running'
        `,
        [input.taskId, input.agentId],
      );
      if (
        Number(priorSubmission.rows[0]?.count ?? "0") > 0 ||
        Number(priorRuns.rows[0]?.count ?? "0") > 0
      ) {
        await client.query("ROLLBACK");
        return null;
      }
    }

    const inserted = await client.query<{ run_id: string }>(
      `
        INSERT INTO review_task_runs (
          task_id,
          worker_id,
          agent_id,
          status,
          last_heartbeat_at
        ) VALUES ($1, $2, $3, 'running', NOW())
        RETURNING run_id::text AS run_id
      `,
      [input.taskId, input.workerId, input.agentId ?? null],
    );
    await client.query(`UPDATE review_tasks SET updated_at = NOW() WHERE task_id = $1`, [
      input.taskId,
    ]);
    await client.query("COMMIT");

    const insertedRunId = inserted.rows[0]?.run_id;
    if (!insertedRunId) {
      throw new Error("review_task_run_insert_failed");
    }
    const run = await readReviewTaskRun(pool, insertedRunId);
    if (!run) {
      throw new Error("review_task_run_not_found_after_insert");
    }
    const freshTask = await readReviewTask(pool, input.taskId);
    if (!freshTask) {
      throw new Error("review_task_not_found_after_claim");
    }
    return { run, task: freshTask };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failReviewTaskRun(
  pool: Pool,
  input: {
    failureReason: string;
    runId: string;
    taskId: string;
  },
): Promise<ReviewTaskRunView | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE review_task_runs
        SET
          status = 'failed',
          failure_reason = $2,
          finished_at = NOW()
        WHERE run_id = $1
      `,
      [input.runId, input.failureReason],
    );
    await client.query(`UPDATE review_tasks SET updated_at = NOW() WHERE task_id = $1`, [
      input.taskId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return readReviewTaskRun(pool, input.runId);
}

export async function heartbeatReviewTaskRun(
  pool: Pool,
  input: {
    agentId?: string | null;
    runId: string;
    taskId: string;
    workerId?: string | null;
  },
): Promise<ReviewTaskRunView | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const update = await client.query<{ updated: boolean }>(
      `
        UPDATE review_task_runs runs
        SET last_heartbeat_at = NOW()
        FROM review_tasks tasks
        WHERE runs.run_id = $1
          AND runs.task_id = $2
          AND runs.status = 'running'
          AND tasks.task_id = runs.task_id
          AND tasks.status = 'open'
          AND ($3::text IS NULL OR runs.agent_id = $3)
          AND ($4::text IS NULL OR runs.worker_id = $4)
        RETURNING true AS updated
      `,
      [input.runId, input.taskId, input.agentId ?? null, input.workerId ?? null],
    );
    if (!update.rows[0]?.updated) {
      await client.query("ROLLBACK");
      return undefined;
    }
    await client.query(`UPDATE review_tasks SET updated_at = NOW() WHERE task_id = $1`, [
      input.taskId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return readReviewTaskRun(pool, input.runId);
}

export type ExpiredReviewTaskRunView = {
  claimId: string | null;
  run: ReviewTaskRunView;
  sourceId: string | null;
  taskId: string;
  timedOutAt: string;
};

export async function expireStaleReviewTaskRuns(
  pool: Pool,
  input: {
    limit?: number;
    staleAfterMs: number;
  },
): Promise<ExpiredReviewTaskRunView[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const staleBefore = new Date(Date.now() - input.staleAfterMs);
  const timedOutAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidateResult = await client.query<{
      claimId: string | null;
      runId: string;
      sourceId: string | null;
      taskId: string;
    }>(
      `
        SELECT
          runs.run_id::text AS "runId",
          runs.task_id::text AS "taskId",
          tasks.claim_id AS "claimId",
          tasks.source_id::text AS "sourceId"
        FROM review_task_runs runs
        JOIN review_tasks tasks ON tasks.task_id = runs.task_id
        WHERE runs.status = 'running'
          AND tasks.status = 'open'
          AND COALESCE(runs.last_heartbeat_at, runs.started_at) < $1
        ORDER BY COALESCE(runs.last_heartbeat_at, runs.started_at) ASC, runs.run_id ASC
        LIMIT $2
        FOR UPDATE OF runs, tasks SKIP LOCKED
      `,
      [staleBefore.toISOString(), limit],
    );
    const expired: ExpiredReviewTaskRunView[] = [];
    for (const candidate of candidateResult.rows) {
      await client.query(
        `
          UPDATE review_task_runs
          SET
            status = 'failed',
            failure_reason = $2,
            finished_at = NOW()
          WHERE run_id = $1
        `,
        [candidate.runId, "heartbeat_timeout"],
      );
      await client.query(`UPDATE review_tasks SET updated_at = NOW() WHERE task_id = $1`, [
        candidate.taskId,
      ]);
      const run = await readReviewTaskRun(client, candidate.runId);
      if (run) {
        expired.push({
          claimId: candidate.claimId,
          run,
          sourceId: candidate.sourceId,
          taskId: candidate.taskId,
          timedOutAt,
        });
      }
    }
    await client.query("COMMIT");
    return expired;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordReviewSubmission(
  pool: Pool,
  input: {
    claimId?: string | null;
    confidenceBps: number;
    dimensions: ReviewDimensionScores;
    evidenceArtifactKey?: string | null;
    issues?: Array<{
      artifactAnchor?: Record<string, unknown>;
      category: string;
      severity: ReviewIssueSeverity;
      status?: ReviewIssueStatus;
      summary: string;
    }>;
    payload?: Record<string, unknown>;
    resultArtifactKey?: string | null;
    reviewType?: ReviewTaskType;
    reviewerActor: string;
    reviewerAgentId?: string | null;
    runId?: string | null;
    schemaVersion?: string;
    sourceId?: string | null;
    taskId: string;
    verdict: ReviewSubmissionVerdict;
  },
): Promise<{
  submission: ReviewSubmissionView;
  task: ReviewTaskView;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockedTask = await client.query<ReviewTaskRow>(
      `
      SELECT
          task_id::text AS "taskId",
          claim_id AS "claimId",
          source_id::text AS "sourceId",
          subject_type AS "subjectType",
          subject_id AS "subjectId",
          task_type AS "taskType",
          scope_key AS "scopeKey",
          schema_version AS "schemaVersion",
          status,
          requested_by AS "requestedBy",
          required_capabilities AS "requiredCapabilities",
          input_artifact_keys AS "inputArtifactKeys",
          consensus_policy AS "consensusPolicy",
          result_artifact_key AS "resultArtifactKey",
          failure_reason AS "failureReason",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM review_tasks
        WHERE task_id = $1
        FOR UPDATE
      `,
      [input.taskId],
    );
    const taskRow = lockedTask.rows[0];
    if (!taskRow) {
      throw new Error("review_task_not_found");
    }
    const task = mapReviewTaskRow(taskRow);

    let run: ReviewTaskRunView | undefined;
    if (input.runId) {
      const runResult = await client.query<ReviewTaskRunRow>(
        `
          SELECT
            run_id::text AS "runId",
            task_id::text AS "taskId",
            worker_id AS "workerId",
            agent_id AS "agentId",
            status,
            failure_reason AS "failureReason",
            last_heartbeat_at AS "lastHeartbeatAt",
            started_at AS "startedAt",
            finished_at AS "finishedAt"
          FROM review_task_runs
          WHERE run_id = $1
          FOR UPDATE
        `,
        [input.runId],
      );
      const runRow = runResult.rows[0];
      if (!runRow || runRow.taskId !== input.taskId) {
        throw new Error("review_task_run_not_found");
      }
      run = mapReviewTaskRunRow(runRow);
      if (run.status !== "running") {
        throw new Error("review_task_run_not_running");
      }
      if (input.reviewerAgentId && run.agentId && input.reviewerAgentId !== run.agentId) {
        throw new Error("review_task_run_agent_mismatch");
      }
    }

    if (input.reviewerAgentId && task.consensusPolicy.requireDistinctAgents) {
      const priorSubmission = await client.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM review_submissions
          WHERE task_id = $1 AND reviewer_agent_id = $2
        `,
        [input.taskId, input.reviewerAgentId],
      );
      if (Number(priorSubmission.rows[0]?.count ?? "0") > 0) {
        throw new Error("review_task_agent_already_submitted");
      }
    }

    const insertedSubmission = await client.query<{ submission_id: string }>(
      `
        INSERT INTO review_submissions (
          task_id,
          run_id,
          claim_id,
          source_id,
          reviewer_actor,
          reviewer_agent_id,
          review_type,
          verdict,
          confidence_bps,
          evidence_artifact_key,
          result_artifact_key,
          schema_version,
          dimensions,
          payload
        ) VALUES ($1, $2, $3, $4, lower($5), $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
        RETURNING submission_id::text AS submission_id
      `,
      [
        input.taskId,
        input.runId ?? null,
        input.claimId ?? task.claimId ?? null,
        input.sourceId ?? task.sourceId ?? null,
        input.reviewerActor,
        input.reviewerAgentId ?? null,
        input.reviewType ?? task.taskType,
        input.verdict,
        clampInteger(input.confidenceBps, 0, 10_000, 0),
        input.evidenceArtifactKey ?? null,
        input.resultArtifactKey ?? null,
        input.schemaVersion ?? task.schemaVersion,
        serializeJson(normalizeDimensionScores(input.dimensions)),
        serializeJson(input.payload ?? {}),
      ],
    );
    const submissionId = insertedSubmission.rows[0]?.submission_id;
    if (!submissionId) {
      throw new Error("review_submission_insert_failed");
    }

    for (const issue of input.issues ?? []) {
      await client.query(
        `
          INSERT INTO review_issues (
            submission_id,
            severity,
            category,
            summary,
            artifact_anchor,
            status
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        `,
        [
          submissionId,
          issue.severity,
          issue.category,
          issue.summary,
          serializeJson(issue.artifactAnchor ?? {}),
          issue.status ?? "open",
        ],
      );
    }

    if (input.runId) {
      await client.query(
        `
          UPDATE review_task_runs
          SET
            status = 'completed',
            finished_at = NOW()
          WHERE run_id = $1
        `,
        [input.runId],
      );
    }

    const completedSubmissions = await countReviewTaskCompletedSubmissions(client, input.taskId);
    if (completedSubmissions >= task.consensusPolicy.minSubmissions) {
      await client.query(
        `
          UPDATE review_tasks
          SET
            status = 'completed',
            result_artifact_key = COALESCE($2, result_artifact_key),
            updated_at = NOW(),
            completed_at = COALESCE(completed_at, NOW())
          WHERE task_id = $1
        `,
        [input.taskId, input.resultArtifactKey ?? null],
      );
    } else {
      await client.query(
        `
          UPDATE review_tasks
          SET
            updated_at = NOW(),
            result_artifact_key = COALESCE($2, result_artifact_key)
          WHERE task_id = $1
        `,
        [input.taskId, input.resultArtifactKey ?? null],
      );
    }

    await client.query("COMMIT");
    const submission = await readReviewSubmission(pool, submissionId);
    if (!submission) {
      throw new Error("review_submission_not_found_after_insert");
    }
    const freshTask = await readReviewTask(pool, input.taskId);
    if (!freshTask) {
      throw new Error("review_task_not_found_after_submission");
    }
    return {
      submission,
      task: freshTask,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readReviewSubmission(
  queryable: Queryable,
  submissionId: string,
): Promise<ReviewSubmissionView | undefined> {
  const result = await queryable.query<ReviewSubmissionRow>(
    `
      SELECT
        submission_id::text AS "submissionId",
        task_id::text AS "taskId",
        run_id::text AS "runId",
        claim_id AS "claimId",
        source_id::text AS "sourceId",
        reviewer_actor AS "reviewerActor",
        reviewer_agent_id AS "reviewerAgentId",
        review_type AS "reviewType",
        verdict,
        confidence_bps AS "confidenceBps",
        evidence_artifact_key AS "evidenceArtifactKey",
        result_artifact_key AS "resultArtifactKey",
        schema_version AS "schemaVersion",
        dimensions,
        payload,
        created_at AS "createdAt"
      FROM review_submissions
      WHERE submission_id = $1
    `,
    [submissionId],
  );
  const row = result.rows[0];
  return row ? mapReviewSubmissionRow(row) : undefined;
}

export async function readReviewSubmissionsPage(
  queryable: Queryable,
  options: ReviewSubmissionListOptions = {},
): Promise<PageResult<ReviewSubmissionView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.sourceId) {
    values.push(options.sourceId);
    clauses.push(`source_id::text = $${values.length}`);
  }
  if (options.taskId) {
    values.push(options.taskId);
    clauses.push(`task_id = $${values.length}`);
  }
  if (options.reviewerAgentId) {
    values.push(options.reviewerAgentId);
    clauses.push(`reviewer_agent_id = $${values.length}`);
  }
  if (options.verdict) {
    values.push(options.verdict);
    clauses.push(`verdict = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_submissions${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<ReviewSubmissionRow>(
    `
      SELECT
        submission_id::text AS "submissionId",
        task_id::text AS "taskId",
        run_id::text AS "runId",
        claim_id AS "claimId",
        source_id::text AS "sourceId",
        reviewer_actor AS "reviewerActor",
        reviewer_agent_id AS "reviewerAgentId",
        review_type AS "reviewType",
        verdict,
        confidence_bps AS "confidenceBps",
        evidence_artifact_key AS "evidenceArtifactKey",
        result_artifact_key AS "resultArtifactKey",
        schema_version AS "schemaVersion",
        dimensions,
        payload,
        created_at AS "createdAt"
      FROM review_submissions
      ${whereClause}
      ORDER BY created_at DESC, submission_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );

  return {
    items: result.rows.map(mapReviewSubmissionRow),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

export async function readReviewIssuesPage(
  queryable: Queryable,
  options: ReviewIssueListOptions = {},
): Promise<PageResult<ReviewIssueView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let fromClause = "FROM review_issues issues";

  if (options.claimId || options.taskId) {
    fromClause +=
      " JOIN review_submissions submissions ON submissions.submission_id = issues.submission_id";
  }
  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`submissions.claim_id = $${values.length}`);
  }
  if (options.taskId) {
    values.push(options.taskId);
    clauses.push(`submissions.task_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`issues.status = $${values.length}`);
  }
  if (options.severity) {
    values.push(options.severity);
    clauses.push(`issues.severity = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count ${fromClause}${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<ReviewIssueRow>(
    `
      SELECT
        issues.issue_id::text AS "issueId",
        issues.submission_id::text AS "submissionId",
        issues.severity,
        issues.category,
        issues.summary,
        issues.artifact_anchor AS "artifactAnchor",
        issues.status,
        issues.created_at AS "createdAt",
        issues.updated_at AS "updatedAt"
      ${fromClause}
      ${whereClause}
      ORDER BY issues.created_at DESC, issues.issue_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );
  return {
    items: result.rows.map(mapReviewIssueRow),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

export async function createReviewAuthorResponse(
  queryable: Queryable,
  input: {
    claimId: string;
    issueIds: string[];
    responderActor: string;
    responseArtifactKey: string;
    summary: string;
  },
): Promise<ReviewAuthorResponseView> {
  const result = await queryable.query<{ response_id: string }>(
    `
      INSERT INTO review_author_responses (
        claim_id,
        responder_actor,
        response_artifact_key,
        issue_ids,
        summary
      ) VALUES ($1, lower($2), $3, $4::jsonb, $5)
      RETURNING response_id::text AS response_id
    `,
    [
      input.claimId,
      input.responderActor,
      input.responseArtifactKey,
      serializeJson(input.issueIds),
      input.summary,
    ],
  );
  const responseId = result.rows[0]?.response_id;
  if (!responseId) {
    throw new Error("review_author_response_insert_failed");
  }
  const response = await readReviewAuthorResponse(queryable, responseId);
  if (!response) {
    throw new Error("review_author_response_not_found_after_insert");
  }
  return response;
}

export async function readReviewAuthorResponse(
  queryable: Queryable,
  responseId: string,
): Promise<ReviewAuthorResponseView | undefined> {
  const result = await queryable.query<ReviewAuthorResponseRow>(
    `
      SELECT
        response_id::text AS "responseId",
        claim_id AS "claimId",
        responder_actor AS "responderActor",
        response_artifact_key AS "responseArtifactKey",
        issue_ids AS "issueIds",
        summary,
        created_at AS "createdAt"
      FROM review_author_responses
      WHERE response_id = $1
    `,
    [responseId],
  );
  const row = result.rows[0];
  return row ? mapReviewAuthorResponseRow(row) : undefined;
}

export async function readReviewAuthorResponsesPage(
  queryable: Queryable,
  options: ReviewAuthorResponseListOptions = {},
): Promise<PageResult<ReviewAuthorResponseView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM review_author_responses${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<ReviewAuthorResponseRow>(
    `
      SELECT
        response_id::text AS "responseId",
        claim_id AS "claimId",
        responder_actor AS "responderActor",
        response_artifact_key AS "responseArtifactKey",
        issue_ids AS "issueIds",
        summary,
        created_at AS "createdAt"
      FROM review_author_responses
      ${whereClause}
      ORDER BY created_at DESC, response_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );
  return {
    items: result.rows.map(mapReviewAuthorResponseRow),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}
