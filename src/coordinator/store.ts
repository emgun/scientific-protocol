import type { Pool, PoolClient } from "pg";
import { createReadModelPool, getDatabaseUrl, migrateReadModelDb } from "../indexer/store.js";
import {
  type ArtifactStorageAttestationInput,
  type ArtifactStoragePolicyInput,
  resolveArtifactStoragePolicyInput,
} from "../shared/artifact-storage-policy.js";
import { normalizePagination } from "../shared/pagination.js";
import {
  type ArtifactAuditStatus,
  buildPrimaryArtifactReplica,
  type PersistedArtifactAuditRecord,
  type PersistedArtifactProvenanceRecord,
  type PersistedArtifactRecord,
  type PersistedArtifactReplicaRecord,
} from "../shared/persisted-artifacts.js";

type Queryable = Pool | PoolClient;

function expectPresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

export type ReplicationJobStatus = "assigned" | "completed" | "failed" | "open";
export type ReplicationJobRunStatus = "completed" | "failed" | "running";
export type ArtifactMaintenanceTaskType = "audit" | "repair";
export type ArtifactMaintenanceTaskStatus = "assigned" | "completed" | "failed" | "open";
export type ArtifactMaintenanceTaskRunStatus = "completed" | "failed" | "running";

export type ExpiredArtifactMaintenanceTaskRunView = {
  reopenedTask: ArtifactMaintenanceTaskView;
  run: ArtifactMaintenanceTaskRunView;
  timedOutAt: string;
};

export type ExpiredReplicationJobRunView = {
  reopenedJob: ReplicationJobView;
  run: ReplicationJobRunView;
  timedOutAt: string;
};

export type ReplicationJobView = {
  assignedAgentId: string | null;
  assignedAt: string | null;
  assignedWorker: string | null;
  claimId: string;
  completedAt: string | null;
  createdAt: string;
  evidenceHash: string | null;
  evidenceURI: string | null;
  failureReason: string | null;
  jobId: string;
  onchainReplicationId: string | null;
  requestedBy: string;
  requestId: string | null;
  resultArtifactKey: string | null;
  resultHash: string | null;
  specHash: string;
  specURI: string | null;
  status: ReplicationJobStatus;
  submissionActor: string | null;
  submissionTxHash: string | null;
  submittedAt: string | null;
  updatedAt: string;
};

export type ReplicationJobRunView = {
  agentId: string | null;
  evidenceHash: string | null;
  evidenceURI: string | null;
  executionManifestHash: string | null;
  failureReason: string | null;
  finishedAt: string | null;
  jobId: string;
  lastHeartbeatAt: string | null;
  requestId: string | null;
  resultArtifactKey: string | null;
  resultHash: string | null;
  runId: string;
  startedAt: string;
  status: ReplicationJobRunStatus;
  submissionTxHash: string | null;
  workerId: string;
};

export type ArtifactMaintenanceTaskView = {
  artifactKey: string;
  assignedAgentId: string | null;
  assignedAt: string | null;
  assignedWorker: string | null;
  completedAt: string | null;
  createdAt: string;
  failureReason: string | null;
  repairLocator: string | null;
  repairSourceReplicaKey: string | null;
  requestedBy: string;
  resultArtifactKey: string | null;
  status: ArtifactMaintenanceTaskStatus;
  targetProvider: string | null;
  targetReplicaKey: string | null;
  taskId: string;
  taskType: ArtifactMaintenanceTaskType;
  updatedAt: string;
};

export type ArtifactMaintenanceTaskRunView = {
  agentId: string | null;
  failureReason: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  runId: string;
  startedAt: string;
  status: ArtifactMaintenanceTaskRunStatus;
  summaryArtifactKey: string | null;
  taskId: string;
  workerId: string;
};

export type PersistedArtifactView = PersistedArtifactRecord & {
  createdAt: string;
};

export type PersistedArtifactReplicaView = PersistedArtifactReplicaRecord & {
  createdAt: string;
  lastCheckError: string | null;
  lastCheckStatus: ArtifactAuditStatus | null;
  lastCheckedAt: string | null;
  updatedAt: string;
};

export type PersistedArtifactAuditView = Omit<PersistedArtifactAuditRecord, "checkedAt"> & {
  artifactKey: string;
  auditId: string;
  checkedAt: string;
};

export type PersistedArtifactProvenanceView = Omit<
  PersistedArtifactProvenanceRecord,
  "metadata"
> & {
  artifactKey: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type PersistedArtifactStoragePolicyView = {
  artifactKey: string;
  bundleCid: string | null;
  bundleMemberPath: string | null;
  createdAt: string;
  durabilityClass: ArtifactStoragePolicyInput["durabilityClass"];
  metadata: Record<string, unknown>;
  repairPriority: number;
  requiredIndependentRetrievalPaths: number;
  requiredReplicaCount: number;
  requiresFilecoinOrEquivalent: boolean;
  retentionUntil: string | null;
  updatedAt: string;
};

export type PersistedArtifactStorageAttestationView = {
  artifactKey: string;
  attestationId: string;
  attestorAddress: string;
  cid: string;
  commitmentKind: ArtifactStorageAttestationInput["commitmentKind"];
  createdAt: string;
  evidenceRef: string | null;
  nodeId: string | null;
  provider: string;
  providerMetadata: Record<string, unknown>;
  retentionUntil: string | null;
  retrievalUrl: string | null;
  signature: string;
  signedPayloadHash: string;
  storageClass: ArtifactStorageAttestationInput["storageClass"];
  storageStartedAt: string;
  updatedAt: string;
};

export type PersistedArtifactListOptions = {
  kind?: string;
  limit?: number;
  offset?: number;
};

export type ArtifactMaintenanceTaskListOptions = {
  artifactKey?: string;
  assignedAgentId?: string;
  limit?: number;
  offset?: number;
  status?: ArtifactMaintenanceTaskStatus;
  targetReplicaKey?: string;
  taskType?: ArtifactMaintenanceTaskType;
};

export type ReplicationJobListOptions = {
  assignedAgentId?: string;
  assignedWorker?: string;
  claimId?: string;
  limit?: number;
  offset?: number;
  requestedBy?: string;
  status?: ReplicationJobStatus;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export async function prepareCoordinatorStore(
  connectionString = getDatabaseUrl(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function createReplicationJob(
  queryable: Queryable,
  input: {
    claimId: string;
    requestedBy: string;
    specHash: string;
    specURI?: string | null;
  },
): Promise<ReplicationJobView> {
  const result = await queryable.query(
    `
      INSERT INTO replication_jobs (
        claim_id,
        requested_by,
        status,
        spec_hash,
        spec_uri
      ) VALUES ($1, $2, 'open', $3, $4)
      RETURNING job_id
    `,
    [input.claimId, input.requestedBy, input.specHash, input.specURI ?? null],
  );
  const jobId = expectPresent(result.rows[0]?.job_id, "failed to insert replication job");
  return expectPresent(
    await readReplicationJob(queryable, String(jobId)),
    `failed to read replication job ${jobId} after insert`,
  );
}

export async function upsertPersistedArtifact(
  queryable: Queryable,
  artifact: PersistedArtifactRecord,
): Promise<PersistedArtifactView> {
  await queryable.query(
    `
      INSERT INTO persisted_artifacts (
        artifact_key,
        kind,
        sha256,
        content_type,
        byte_length,
        storage_path
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (artifact_key)
      DO UPDATE SET
        kind = EXCLUDED.kind,
        sha256 = EXCLUDED.sha256,
        content_type = EXCLUDED.content_type,
        byte_length = EXCLUDED.byte_length,
        storage_path = EXCLUDED.storage_path
    `,
    [
      artifact.artifactKey,
      artifact.kind,
      artifact.sha256,
      artifact.contentType,
      artifact.byteLength,
      artifact.storagePath,
    ],
  );

  if (artifact.provenance) {
    await upsertPersistedArtifactProvenance(queryable, artifact.artifactKey, artifact.provenance);
  }

  const replicas =
    artifact.replicas && artifact.replicas.length > 0
      ? artifact.replicas
      : [buildPrimaryArtifactReplica(artifact)];
  for (const replica of replicas) {
    await upsertPersistedArtifactReplica(queryable, artifact.artifactKey, replica);
  }

  for (const audit of artifact.audits ?? []) {
    await recordPersistedArtifactAudit(queryable, artifact.artifactKey, audit);
  }

  return expectPresent(
    await readPersistedArtifact(queryable, artifact.artifactKey),
    `failed to read persisted artifact ${artifact.artifactKey} after upsert`,
  );
}

export async function upsertPersistedArtifactReplica(
  queryable: Queryable,
  artifactKey: string,
  replica: PersistedArtifactReplicaRecord,
): Promise<void> {
  await queryable.query(
    `
      INSERT INTO persisted_artifact_replicas (
        artifact_key,
        replica_key,
        provider,
        locator,
        is_primary,
        provider_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (artifact_key, replica_key)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        locator = EXCLUDED.locator,
        is_primary = EXCLUDED.is_primary,
        provider_metadata = EXCLUDED.provider_metadata,
        updated_at = NOW()
    `,
    [
      artifactKey,
      replica.replicaKey,
      replica.provider,
      replica.locator,
      replica.isPrimary,
      JSON.stringify(replica.providerMetadata ?? {}),
    ],
  );
}

export async function recordPersistedArtifactAudit(
  queryable: Queryable,
  artifactKey: string,
  audit: PersistedArtifactAuditRecord,
): Promise<void> {
  const checkedAt = audit.checkedAt ? new Date(audit.checkedAt) : new Date();
  await queryable.query(
    `
      INSERT INTO persisted_artifact_audits (
        artifact_key,
        replica_key,
        provider,
        locator,
        check_kind,
        status,
        detail,
        observed_sha256,
        checked_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      artifactKey,
      audit.replicaKey,
      audit.provider,
      audit.locator,
      audit.checkKind,
      audit.status,
      audit.detail ?? null,
      audit.observedSha256 ?? null,
      checkedAt,
    ],
  );

  if (audit.replicaKey) {
    const updatesReplicaHealth = audit.checkKind !== "agent_report";
    if (!updatesReplicaHealth) {
      return;
    }
    await queryable.query(
      `
        UPDATE persisted_artifact_replicas
        SET
          last_checked_at = $3,
          last_check_status = $4,
          last_check_error = $5,
          updated_at = NOW()
        WHERE artifact_key = $1
          AND replica_key = $2
      `,
      [artifactKey, audit.replicaKey, checkedAt, audit.status, audit.detail ?? null],
    );
  }
}

export async function upsertPersistedArtifactProvenance(
  queryable: Queryable,
  artifactKey: string,
  provenance: PersistedArtifactProvenanceRecord,
): Promise<void> {
  await queryable.query(
    `
      INSERT INTO persisted_artifact_provenance (
        artifact_key,
        source_type,
        source_locator,
        ref,
        commit_hash,
        cid,
        final_url,
        derived_from_artifact_key,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (artifact_key)
      DO UPDATE SET
        source_type = EXCLUDED.source_type,
        source_locator = EXCLUDED.source_locator,
        ref = EXCLUDED.ref,
        commit_hash = EXCLUDED.commit_hash,
        cid = EXCLUDED.cid,
        final_url = EXCLUDED.final_url,
        derived_from_artifact_key = EXCLUDED.derived_from_artifact_key,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      artifactKey,
      provenance.sourceType,
      provenance.sourceLocator,
      provenance.ref ?? null,
      provenance.commitHash ?? null,
      provenance.cid ?? null,
      provenance.finalUrl ?? null,
      provenance.derivedFromArtifactKey ?? null,
      JSON.stringify(provenance.metadata ?? {}),
    ],
  );
}

export async function upsertPersistedArtifactStoragePolicy(
  queryable: Queryable,
  artifactKey: string,
  input: ArtifactStoragePolicyInput,
): Promise<PersistedArtifactStoragePolicyView> {
  const policy = resolveArtifactStoragePolicyInput(input);
  await queryable.query(
    `
      INSERT INTO persisted_artifact_storage_policies (
        artifact_key,
        durability_class,
        required_replica_count,
        required_independent_retrieval_paths,
        requires_filecoin_or_equivalent,
        repair_priority,
        bundle_cid,
        bundle_member_path,
        retention_until,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (artifact_key)
      DO UPDATE SET
        durability_class = EXCLUDED.durability_class,
        required_replica_count = EXCLUDED.required_replica_count,
        required_independent_retrieval_paths = EXCLUDED.required_independent_retrieval_paths,
        requires_filecoin_or_equivalent = EXCLUDED.requires_filecoin_or_equivalent,
        repair_priority = EXCLUDED.repair_priority,
        bundle_cid = EXCLUDED.bundle_cid,
        bundle_member_path = EXCLUDED.bundle_member_path,
        retention_until = EXCLUDED.retention_until,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      artifactKey,
      policy.durabilityClass,
      policy.requiredReplicaCount,
      policy.requiredIndependentRetrievalPaths,
      policy.requiresFilecoinOrEquivalent,
      policy.repairPriority,
      policy.bundleCid,
      policy.bundleMemberPath,
      policy.retentionUntil ? new Date(policy.retentionUntil) : null,
      JSON.stringify(policy.metadata),
    ],
  );
  return expectPresent(
    await readPersistedArtifactStoragePolicy(queryable, artifactKey),
    `failed to read persisted artifact storage policy ${artifactKey} after upsert`,
  );
}

export async function recordPersistedArtifactStorageAttestation(
  queryable: Queryable,
  artifactKey: string,
  input: ArtifactStorageAttestationInput,
): Promise<PersistedArtifactStorageAttestationView> {
  const storageStartedAt = input.storageStartedAt ? new Date(input.storageStartedAt) : new Date();
  const result = await queryable.query<{ attestationId: string }>(
    `
      INSERT INTO persisted_artifact_storage_attestations (
        artifact_key,
        attestor_address,
        node_id,
        cid,
        provider,
        retrieval_url,
        commitment_kind,
        storage_class,
        storage_started_at,
        retention_until,
        evidence_ref,
        signature,
        signed_payload_hash,
        provider_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
      ON CONFLICT (artifact_key, signed_payload_hash)
      DO UPDATE SET
        attestor_address = EXCLUDED.attestor_address,
        node_id = EXCLUDED.node_id,
        cid = EXCLUDED.cid,
        provider = EXCLUDED.provider,
        retrieval_url = EXCLUDED.retrieval_url,
        commitment_kind = EXCLUDED.commitment_kind,
        storage_class = EXCLUDED.storage_class,
        storage_started_at = EXCLUDED.storage_started_at,
        retention_until = EXCLUDED.retention_until,
        evidence_ref = EXCLUDED.evidence_ref,
        signature = EXCLUDED.signature,
        provider_metadata = EXCLUDED.provider_metadata,
        updated_at = NOW()
      RETURNING attestation_id::text AS "attestationId"
    `,
    [
      artifactKey,
      input.attestorAddress,
      input.nodeId ?? null,
      input.cid,
      input.provider,
      input.retrievalUrl ?? null,
      input.commitmentKind,
      input.storageClass,
      storageStartedAt,
      input.retentionUntil ? new Date(input.retentionUntil) : null,
      input.evidenceRef ?? null,
      input.signature,
      input.signedPayloadHash,
      JSON.stringify(input.providerMetadata ?? {}),
    ],
  );
  const attestationId = expectPresent(
    result.rows[0]?.attestationId,
    `failed to record persisted artifact storage attestation for ${artifactKey}`,
  );
  return expectPresent(
    await readPersistedArtifactStorageAttestation(queryable, attestationId),
    `failed to read persisted artifact storage attestation ${attestationId} after upsert`,
  );
}

export async function createArtifactMaintenanceTask(
  pool: Pool,
  input: {
    artifactKey: string;
    requestedBy: string;
    targetProvider?: string | null;
    targetReplicaKey?: string | null;
    taskType: ArtifactMaintenanceTaskType;
  },
): Promise<ArtifactMaintenanceTaskView> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ task_id: string }>(
      `
        SELECT task_id
        FROM artifact_maintenance_tasks
        WHERE artifact_key = $1
          AND task_type = $2
          AND COALESCE(target_replica_key, '') = COALESCE($3, '')
          AND status IN ('open', 'assigned')
        ORDER BY task_id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [input.artifactKey, input.taskType, input.targetReplicaKey ?? null],
    );
    const existingTaskId = existing.rows[0]?.task_id;
    if (existingTaskId) {
      await client.query("COMMIT");
      return expectPresent(
        await readArtifactMaintenanceTask(pool, existingTaskId),
        `failed to read artifact maintenance task ${existingTaskId} after existing-task commit`,
      );
    }

    const inserted = await client.query<{ task_id: string }>(
      `
        INSERT INTO artifact_maintenance_tasks (
          artifact_key,
          task_type,
          status,
          requested_by,
          target_replica_key,
          target_provider
        ) VALUES ($1, $2, 'open', $3, $4, $5)
        RETURNING task_id
      `,
      [
        input.artifactKey,
        input.taskType,
        input.requestedBy,
        input.targetReplicaKey ?? null,
        input.targetProvider ?? null,
      ],
    );

    await client.query("COMMIT");
    const insertedTaskId = expectPresent(
      inserted.rows[0]?.task_id,
      "failed to insert artifact maintenance task",
    );
    return expectPresent(
      await readArtifactMaintenanceTask(pool, insertedTaskId),
      `failed to read artifact maintenance task ${insertedTaskId} after insert`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string } | undefined)?.code === "23505") {
      const existing = await readArtifactMaintenanceTasksPage(pool, {
        artifactKey: input.artifactKey,
        limit: 1,
        offset: 0,
        status: "open",
        targetReplicaKey: input.targetReplicaKey ?? undefined,
        taskType: input.taskType,
      });
      const task = existing.items[0];
      if (task) {
        return task;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNextOpenArtifactMaintenanceTask(
  pool: Pool,
  input: {
    agentId?: string | null;
    taskType?: ArtifactMaintenanceTaskType;
    workerId: string;
  },
): Promise<{ run: ArtifactMaintenanceTaskRunView; task: ArtifactMaintenanceTaskView } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimResult = await client.query<{ task_id: string }>(
      `
        WITH next_task AS (
          SELECT task_id
          FROM artifact_maintenance_tasks
          WHERE status = 'open'
            AND ($3::text IS NULL OR task_type = $3)
          ORDER BY task_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE artifact_maintenance_tasks tasks
        SET
          status = 'assigned',
          assigned_worker = $1,
          assigned_agent_id = $2,
          assigned_at = NOW(),
          updated_at = NOW()
        FROM next_task
        WHERE tasks.task_id = next_task.task_id
        RETURNING tasks.task_id::text AS task_id
      `,
      [input.workerId, input.agentId ?? null, input.taskType ?? null],
    );
    const taskId = claimResult.rows[0]?.task_id;
    if (!taskId) {
      await client.query("ROLLBACK");
      return null;
    }

    const runResult = await client.query<{ run_id: string }>(
      `
        INSERT INTO artifact_maintenance_task_runs (
          task_id,
          worker_id,
          agent_id,
          status,
          last_heartbeat_at
        ) VALUES ($1, $2, $3, 'running', NOW())
        RETURNING run_id::text AS run_id
      `,
      [taskId, input.workerId, input.agentId ?? null],
    );

    await client.query("COMMIT");
    const runId = expectPresent(
      runResult.rows[0]?.run_id,
      `failed to insert artifact maintenance run for task ${taskId}`,
    );
    const task = expectPresent(
      await readArtifactMaintenanceTask(pool, taskId),
      `failed to read artifact maintenance task ${taskId} after claim`,
    );
    const run = expectPresent(
      await readArtifactMaintenanceTaskRun(pool, runId),
      `failed to read artifact maintenance run ${runId} after claim`,
    );
    return { task, run };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimArtifactMaintenanceTaskById(
  pool: Pool,
  input: {
    agentId?: string | null;
    taskId: string;
    workerId: string;
  },
): Promise<{ run: ArtifactMaintenanceTaskRunView; task: ArtifactMaintenanceTaskView } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimResult = await client.query<{ task_id: string }>(
      `
        UPDATE artifact_maintenance_tasks
        SET
          status = 'assigned',
          assigned_worker = $2,
          assigned_agent_id = $3,
          assigned_at = NOW(),
          updated_at = NOW()
        WHERE task_id = $1
          AND status = 'open'
        RETURNING task_id::text AS task_id
      `,
      [input.taskId, input.workerId, input.agentId ?? null],
    );
    const taskId = claimResult.rows[0]?.task_id;
    if (!taskId) {
      await client.query("ROLLBACK");
      return null;
    }

    const runResult = await client.query<{ run_id: string }>(
      `
        INSERT INTO artifact_maintenance_task_runs (
          task_id,
          worker_id,
          agent_id,
          status,
          last_heartbeat_at
        ) VALUES ($1, $2, $3, 'running', NOW())
        RETURNING run_id::text AS run_id
      `,
      [taskId, input.workerId, input.agentId ?? null],
    );

    await client.query("COMMIT");
    const runId = expectPresent(
      runResult.rows[0]?.run_id,
      `failed to insert artifact maintenance run for task ${taskId}`,
    );
    const task = expectPresent(
      await readArtifactMaintenanceTask(pool, taskId),
      `failed to read artifact maintenance task ${taskId} after claim`,
    );
    const run = expectPresent(
      await readArtifactMaintenanceTaskRun(pool, runId),
      `failed to read artifact maintenance run ${runId} after claim`,
    );
    return { task, run };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeArtifactMaintenanceTask(
  pool: Pool,
  input: {
    repairLocator?: string | null;
    repairSourceReplicaKey?: string | null;
    resultArtifactKey: string;
    runId: string;
    taskId: string;
  },
): Promise<ArtifactMaintenanceTaskView> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE artifact_maintenance_tasks
        SET
          status = 'completed',
          result_artifact_key = $2,
          repair_source_replica_key = $3,
          repair_locator = $4,
          completed_at = NOW(),
          updated_at = NOW()
        WHERE task_id = $1
      `,
      [
        input.taskId,
        input.resultArtifactKey,
        input.repairSourceReplicaKey ?? null,
        input.repairLocator ?? null,
      ],
    );
    await client.query(
      `
        UPDATE artifact_maintenance_task_runs
        SET
          status = 'completed',
          summary_artifact_key = $2,
          finished_at = NOW()
        WHERE run_id = $1
      `,
      [input.runId, input.resultArtifactKey],
    );
    await client.query("COMMIT");
    return expectPresent(
      await readArtifactMaintenanceTask(pool, input.taskId),
      `failed to read artifact maintenance task ${input.taskId} after completion`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failArtifactMaintenanceTask(
  pool: Pool,
  input: {
    failureReason: string;
    runId: string;
    taskId: string;
  },
): Promise<ArtifactMaintenanceTaskView> {
  const truncatedFailureReason = input.failureReason.slice(0, 2000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE artifact_maintenance_tasks
        SET
          status = 'failed',
          failure_reason = $2,
          updated_at = NOW()
        WHERE task_id = $1
      `,
      [input.taskId, truncatedFailureReason],
    );
    await client.query(
      `
        UPDATE artifact_maintenance_task_runs
        SET
          status = 'failed',
          failure_reason = $2,
          finished_at = NOW()
        WHERE run_id = $1
      `,
      [input.runId, truncatedFailureReason],
    );
    await client.query("COMMIT");
    return expectPresent(
      await readArtifactMaintenanceTask(pool, input.taskId),
      `failed to read artifact maintenance task ${input.taskId} after failure`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatArtifactMaintenanceTaskRun(
  pool: Pool,
  input: {
    agentId?: string | null;
    runId: string;
    taskId: string;
    workerId?: string | null;
  },
): Promise<ArtifactMaintenanceTaskRunView | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const update = await client.query<{ updated: boolean }>(
      `
        UPDATE artifact_maintenance_task_runs runs
        SET last_heartbeat_at = NOW()
        FROM artifact_maintenance_tasks tasks
        WHERE runs.run_id = $1
          AND runs.task_id = $2
          AND runs.status = 'running'
          AND tasks.task_id = runs.task_id
          AND tasks.status = 'assigned'
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
    await client.query(
      `UPDATE artifact_maintenance_tasks SET updated_at = NOW() WHERE task_id = $1`,
      [input.taskId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return readArtifactMaintenanceTaskRun(pool, input.runId);
}

export async function expireStaleArtifactMaintenanceTaskRuns(
  pool: Pool,
  input: {
    limit?: number;
    staleAfterMs: number;
  },
): Promise<ExpiredArtifactMaintenanceTaskRunView[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const staleBefore = new Date(Date.now() - input.staleAfterMs);
  const timedOutAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidateResult = await client.query<{
      runId: string;
      taskId: string;
    }>(
      `
        SELECT
          runs.run_id::text AS "runId",
          runs.task_id::text AS "taskId"
        FROM artifact_maintenance_task_runs runs
        JOIN artifact_maintenance_tasks tasks ON tasks.task_id = runs.task_id
        WHERE runs.status = 'running'
          AND tasks.status = 'assigned'
          AND COALESCE(runs.last_heartbeat_at, runs.started_at) < $1
        ORDER BY COALESCE(runs.last_heartbeat_at, runs.started_at) ASC, runs.run_id ASC
        LIMIT $2
        FOR UPDATE OF runs, tasks SKIP LOCKED
      `,
      [staleBefore.toISOString(), limit],
    );
    const expired: ExpiredArtifactMaintenanceTaskRunView[] = [];
    for (const candidate of candidateResult.rows) {
      await client.query(
        `
          UPDATE artifact_maintenance_task_runs
          SET
            status = 'failed',
            failure_reason = $2,
            finished_at = NOW()
          WHERE run_id = $1
        `,
        [candidate.runId, "heartbeat_timeout"],
      );
      await client.query(
        `
          UPDATE artifact_maintenance_tasks
          SET
            status = 'open',
            assigned_worker = NULL,
            assigned_agent_id = NULL,
            assigned_at = NULL,
            updated_at = NOW()
          WHERE task_id = $1
        `,
        [candidate.taskId],
      );
      const [run, reopenedTask] = await Promise.all([
        readArtifactMaintenanceTaskRun(client, candidate.runId),
        readArtifactMaintenanceTask(client, candidate.taskId),
      ]);
      if (run && reopenedTask) {
        expired.push({
          reopenedTask,
          run,
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

export async function claimNextOpenReplicationJob(
  pool: Pool,
  input: {
    agentId?: string | null;
    workerId: string;
  },
): Promise<{ job: ReplicationJobView; run: ReplicationJobRunView } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimResult = await client.query<{ job_id: string }>(
      `
        WITH next_job AS (
          SELECT job_id
          FROM replication_jobs
          WHERE status = 'open'
          ORDER BY job_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE replication_jobs jobs
        SET
          status = 'assigned',
          assigned_worker = $1,
          assigned_agent_id = $2,
          assigned_at = NOW(),
          updated_at = NOW()
        FROM next_job
        WHERE jobs.job_id = next_job.job_id
        RETURNING jobs.job_id
      `,
      [input.workerId, input.agentId ?? null],
    );
    const jobId = claimResult.rows[0]?.job_id;
    if (!jobId) {
      await client.query("ROLLBACK");
      return null;
    }

    const runResult = await client.query<{ run_id: string }>(
      `
        INSERT INTO replication_job_runs (
          job_id,
          worker_id,
          agent_id,
          status,
          last_heartbeat_at
        ) VALUES ($1, $2, $3, 'running', NOW())
        RETURNING run_id
      `,
      [jobId, input.workerId, input.agentId ?? null],
    );

    await client.query("COMMIT");
    const runId = expectPresent(
      runResult.rows[0]?.run_id,
      `failed to insert replication run for job ${jobId}`,
    );
    const job = expectPresent(
      await readReplicationJob(pool, jobId),
      `failed to read replication job ${jobId} after claim`,
    );
    const run = expectPresent(
      await readReplicationJobRun(pool, String(runId)),
      `failed to read replication run ${String(runId)} after claim`,
    );
    return { job, run };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimReplicationJobById(
  pool: Pool,
  input: {
    agentId?: string | null;
    jobId: string;
    workerId: string;
  },
): Promise<{ job: ReplicationJobView; run: ReplicationJobRunView } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimResult = await client.query<{ job_id: string }>(
      `
        UPDATE replication_jobs
        SET
          status = 'assigned',
          assigned_worker = $2,
          assigned_agent_id = $3,
          assigned_at = NOW(),
          updated_at = NOW()
        WHERE job_id = $1
          AND status = 'open'
        RETURNING job_id
      `,
      [input.jobId, input.workerId, input.agentId ?? null],
    );
    const jobId = claimResult.rows[0]?.job_id;
    if (!jobId) {
      await client.query("ROLLBACK");
      return null;
    }

    const runResult = await client.query<{ run_id: string }>(
      `
        INSERT INTO replication_job_runs (
          job_id,
          worker_id,
          agent_id,
          status,
          last_heartbeat_at
        ) VALUES ($1, $2, $3, 'running', NOW())
        RETURNING run_id
      `,
      [jobId, input.workerId, input.agentId ?? null],
    );

    await client.query("COMMIT");
    const runId = expectPresent(
      runResult.rows[0]?.run_id,
      `failed to insert replication run for job ${jobId}`,
    );
    const job = expectPresent(
      await readReplicationJob(pool, jobId),
      `failed to read replication job ${jobId} after claim`,
    );
    const run = expectPresent(
      await readReplicationJobRun(pool, String(runId)),
      `failed to read replication run ${String(runId)} after claim`,
    );
    return { job, run };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeReplicationJob(
  pool: Pool,
  input: {
    evidenceHash: string;
    evidenceURI: string;
    executionManifestHash: string;
    jobId: string;
    onchainReplicationId?: string | null;
    requestId?: string | null;
    resultArtifactKey: string;
    resultHash: string;
    runId: string;
    submissionActor?: string | null;
    submissionTxHash?: string | null;
  },
): Promise<ReplicationJobView> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE replication_jobs
        SET
          status = 'completed',
          request_id = COALESCE($9, request_id),
          result_artifact_key = $2,
          result_hash = $3,
          evidence_hash = $4,
          evidence_uri = $5,
          onchain_replication_id = $6,
          submission_tx_hash = $7,
          submission_actor = $8,
          submitted_at = NOW(),
          completed_at = NOW(),
          updated_at = NOW()
        WHERE job_id = $1
      `,
      [
        input.jobId,
        input.resultArtifactKey,
        input.resultHash,
        input.evidenceHash,
        input.evidenceURI,
        input.onchainReplicationId ?? null,
        input.submissionTxHash ?? null,
        input.submissionActor ?? null,
        input.requestId ?? null,
      ],
    );
    await client.query(
      `
        UPDATE replication_job_runs
        SET
          status = 'completed',
          request_id = COALESCE($8, request_id),
          execution_manifest_hash = $2,
          result_artifact_key = $3,
          result_hash = $4,
          evidence_hash = $5,
          evidence_uri = $6,
          submission_tx_hash = $7,
          finished_at = NOW()
        WHERE run_id = $1
      `,
      [
        input.runId,
        input.executionManifestHash,
        input.resultArtifactKey,
        input.resultHash,
        input.evidenceHash,
        input.evidenceURI,
        input.submissionTxHash ?? null,
        input.requestId ?? null,
      ],
    );
    await client.query("COMMIT");
    return expectPresent(
      await readReplicationJob(pool, input.jobId),
      `failed to read replication job ${input.jobId} after completion`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failReplicationJob(
  pool: Pool,
  input: {
    failureReason: string;
    jobId: string;
    requestId?: string | null;
    runId: string;
  },
): Promise<ReplicationJobView> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE replication_jobs
        SET
          status = 'failed',
          request_id = COALESCE($3, request_id),
          failure_reason = $2,
          updated_at = NOW()
        WHERE job_id = $1
      `,
      [input.jobId, input.failureReason.slice(0, 2000), input.requestId ?? null],
    );
    await client.query(
      `
        UPDATE replication_job_runs
        SET
          status = 'failed',
          request_id = COALESCE($3, request_id),
          failure_reason = $2,
          finished_at = NOW()
        WHERE run_id = $1
      `,
      [input.runId, input.failureReason.slice(0, 2000), input.requestId ?? null],
    );
    await client.query("COMMIT");
    return expectPresent(
      await readReplicationJob(pool, input.jobId),
      `failed to read replication job ${input.jobId} after failure`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatReplicationJobRun(
  pool: Pool,
  input: {
    agentId?: string | null;
    jobId: string;
    runId: string;
    workerId?: string | null;
  },
): Promise<ReplicationJobRunView | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const update = await client.query<{ updated: boolean }>(
      `
        UPDATE replication_job_runs runs
        SET last_heartbeat_at = NOW()
        FROM replication_jobs jobs
        WHERE runs.run_id = $1
          AND runs.job_id = $2
          AND runs.status = 'running'
          AND jobs.job_id = runs.job_id
          AND jobs.status = 'assigned'
          AND ($3::text IS NULL OR runs.agent_id = $3)
          AND ($4::text IS NULL OR runs.worker_id = $4)
        RETURNING true AS updated
      `,
      [input.runId, input.jobId, input.agentId ?? null, input.workerId ?? null],
    );
    if (!update.rows[0]?.updated) {
      await client.query("ROLLBACK");
      return undefined;
    }
    await client.query(`UPDATE replication_jobs SET updated_at = NOW() WHERE job_id = $1`, [
      input.jobId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return readReplicationJobRun(pool, input.runId);
}

export async function expireStaleReplicationJobRuns(
  pool: Pool,
  input: {
    limit?: number;
    staleAfterMs: number;
  },
): Promise<ExpiredReplicationJobRunView[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const staleBefore = new Date(Date.now() - input.staleAfterMs);
  const timedOutAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidateResult = await client.query<{
      jobId: string;
      runId: string;
    }>(
      `
        SELECT
          runs.run_id::text AS "runId",
          runs.job_id::text AS "jobId"
        FROM replication_job_runs runs
        JOIN replication_jobs jobs ON jobs.job_id = runs.job_id
        WHERE runs.status = 'running'
          AND jobs.status = 'assigned'
          AND COALESCE(runs.last_heartbeat_at, runs.started_at) < $1
        ORDER BY COALESCE(runs.last_heartbeat_at, runs.started_at) ASC, runs.run_id ASC
        LIMIT $2
        FOR UPDATE OF runs, jobs SKIP LOCKED
      `,
      [staleBefore.toISOString(), limit],
    );
    const expired: ExpiredReplicationJobRunView[] = [];
    for (const candidate of candidateResult.rows) {
      await client.query(
        `
          UPDATE replication_job_runs
          SET
            status = 'failed',
            failure_reason = $2,
            finished_at = NOW()
          WHERE run_id = $1
        `,
        [candidate.runId, "heartbeat_timeout"],
      );
      await client.query(
        `
          UPDATE replication_jobs
          SET
            status = 'open',
            assigned_worker = NULL,
            assigned_agent_id = NULL,
            assigned_at = NULL,
            updated_at = NOW()
          WHERE job_id = $1
        `,
        [candidate.jobId],
      );
      const [run, reopenedJob] = await Promise.all([
        readReplicationJobRun(client, candidate.runId),
        readReplicationJob(client, candidate.jobId),
      ]);
      if (run && reopenedJob) {
        expired.push({
          reopenedJob,
          run,
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

export async function readReplicationJobsPage(
  queryable: Queryable,
  options: ReplicationJobListOptions = {},
): Promise<PageResult<ReplicationJobView>> {
  const { whereClause, values } = buildReplicationJobWhereClause(options);
  return queryPage(
    queryable,
    "replication_jobs",
    whereClause,
    values,
    options,
    (innerQueryable, limitOffsetClause, queryValues) =>
      queryReplicationJobs(innerQueryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readClaimReplicationJobsPage(
  queryable: Queryable,
  claimId: string,
  options: Omit<ReplicationJobListOptions, "claimId"> = {},
): Promise<PageResult<ReplicationJobView>> {
  return readReplicationJobsPage(queryable, { ...options, claimId });
}

export async function readReplicationJob(
  queryable: Queryable,
  jobId: string,
): Promise<ReplicationJobView | undefined> {
  const rows = await queryReplicationJobs(queryable, " WHERE job_id = $1", [jobId]);
  return rows[0];
}

export async function readReplicationJobRun(
  queryable: Queryable,
  runId: string,
): Promise<ReplicationJobRunView | undefined> {
  const rows = await queryReplicationJobRuns(queryable, " WHERE run_id = $1", [runId]);
  return rows[0];
}

export async function readReplicationJobRuns(
  queryable: Queryable,
  jobId: string,
): Promise<ReplicationJobRunView[]> {
  return queryReplicationJobRuns(queryable, " WHERE job_id = $1", [jobId]);
}

export async function readPersistedArtifact(
  queryable: Queryable,
  artifactKey: string,
): Promise<PersistedArtifactView | undefined> {
  const result = await queryable.query<{
    artifactKey: string;
    byteLength: number;
    contentType: string;
    createdAt: Date;
    kind: string;
    sha256: string;
    storagePath: string;
  }>(
    `
      SELECT
        artifact_key AS "artifactKey",
        byte_length AS "byteLength",
        content_type AS "contentType",
        created_at AS "createdAt",
        kind,
        sha256,
        storage_path AS "storagePath"
      FROM persisted_artifacts
      WHERE artifact_key = $1
    `,
    [artifactKey],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function readPersistedArtifactsPage(
  queryable: Queryable,
  options: PersistedArtifactListOptions = {},
): Promise<PageResult<PersistedArtifactView>> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const values: unknown[] = [];
  let whereClause = "";
  if (options.kind) {
    values.push(options.kind);
    whereClause = ` WHERE kind = $${values.length}`;
  }

  const countResult = await queryable.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM persisted_artifacts${whereClause}`,
    values,
  );
  values.push(limit, offset);
  const rows = await queryable.query<{
    artifactKey: string;
    byteLength: number;
    contentType: string;
    createdAt: Date;
    kind: string;
    sha256: string;
    storagePath: string;
  }>(
    `
      SELECT
        artifact_key AS "artifactKey",
        byte_length AS "byteLength",
        content_type AS "contentType",
        created_at AS "createdAt",
        kind,
        sha256,
        storage_path AS "storagePath"
      FROM persisted_artifacts
      ${whereClause}
      ORDER BY created_at DESC, artifact_key ASC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `,
    values,
  );

  return {
    items: rows.rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
    limit,
    offset,
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

export async function readPersistedArtifactReplicas(
  queryable: Queryable,
  artifactKey: string,
): Promise<PersistedArtifactReplicaView[]> {
  const result = await queryable.query<{
    createdAt: Date;
    isPrimary: boolean;
    lastCheckError: string | null;
    lastCheckStatus: ArtifactAuditStatus | null;
    lastCheckedAt: Date | null;
    locator: string;
    provider: string;
    providerMetadata: Record<string, unknown>;
    replicaKey: string;
    updatedAt: Date;
  }>(
    `
      SELECT
        replica_key AS "replicaKey",
        provider,
        locator,
        is_primary AS "isPrimary",
        provider_metadata AS "providerMetadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_checked_at AS "lastCheckedAt",
        last_check_status AS "lastCheckStatus",
        last_check_error AS "lastCheckError"
      FROM persisted_artifact_replicas
      WHERE artifact_key = $1
      ORDER BY is_primary DESC, replica_key ASC
    `,
    [artifactKey],
  );

  return result.rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    providerMetadata:
      Object.keys(row.providerMetadata ?? {}).length > 0
        ? (row.providerMetadata as PersistedArtifactReplicaView["providerMetadata"])
        : null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function readPersistedArtifactAuditsPage(
  queryable: Queryable,
  input: {
    artifactKey: string;
    limit?: number;
    offset?: number;
  },
): Promise<PageResult<PersistedArtifactAuditView>> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const offset = Math.max(0, input.offset ?? 0);

  const countResult = await queryable.query<{ total: string }>(
    `
      SELECT COUNT(*)::text AS total
      FROM persisted_artifact_audits
      WHERE artifact_key = $1
    `,
    [input.artifactKey],
  );
  const result = await queryable.query<{
    artifactKey: string;
    auditId: string;
    checkKind: "persist" | "verify";
    checkedAt: Date;
    detail: string | null;
    locator: string | null;
    observedSha256: string | null;
    provider: string;
    replicaKey: string | null;
    status: ArtifactAuditStatus;
  }>(
    `
      SELECT
        audit_id::text AS "auditId",
        artifact_key AS "artifactKey",
        replica_key AS "replicaKey",
        provider,
        locator,
        check_kind AS "checkKind",
        status,
        detail,
        observed_sha256 AS "observedSha256",
        checked_at AS "checkedAt"
      FROM persisted_artifact_audits
      WHERE artifact_key = $1
      ORDER BY checked_at DESC, audit_id DESC
      LIMIT $2
      OFFSET $3
    `,
    [input.artifactKey, limit, offset],
  );

  return {
    items: result.rows.map((row) => ({
      ...row,
      checkedAt: row.checkedAt.toISOString(),
    })),
    limit,
    offset,
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

export async function readPersistedArtifactProvenance(
  queryable: Queryable,
  artifactKey: string,
): Promise<PersistedArtifactProvenanceView | undefined> {
  const result = await queryable.query<{
    artifactKey: string;
    cid: string | null;
    commitHash: string | null;
    createdAt: Date;
    derivedFromArtifactKey: string | null;
    finalUrl: string | null;
    metadata: Record<string, unknown>;
    ref: string | null;
    sourceLocator: string;
    sourceType: string;
    updatedAt: Date;
  }>(
    `
      SELECT
        artifact_key AS "artifactKey",
        source_type AS "sourceType",
        source_locator AS "sourceLocator",
        ref,
        commit_hash AS "commitHash",
        cid,
        final_url AS "finalUrl",
        derived_from_artifact_key AS "derivedFromArtifactKey",
        metadata,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM persisted_artifact_provenance
      WHERE artifact_key = $1
    `,
    [artifactKey],
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    metadata: row.metadata ?? {},
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function readPersistedArtifactStoragePolicy(
  queryable: Queryable,
  artifactKey: string,
): Promise<PersistedArtifactStoragePolicyView | undefined> {
  const result = await queryable.query<{
    artifactKey: string;
    bundleCid: string | null;
    bundleMemberPath: string | null;
    createdAt: Date;
    durabilityClass: PersistedArtifactStoragePolicyView["durabilityClass"];
    metadata: Record<string, unknown>;
    repairPriority: number;
    requiredIndependentRetrievalPaths: number;
    requiredReplicaCount: number;
    requiresFilecoinOrEquivalent: boolean;
    retentionUntil: Date | null;
    updatedAt: Date;
  }>(
    `
      SELECT
        artifact_key AS "artifactKey",
        durability_class AS "durabilityClass",
        required_replica_count AS "requiredReplicaCount",
        required_independent_retrieval_paths AS "requiredIndependentRetrievalPaths",
        requires_filecoin_or_equivalent AS "requiresFilecoinOrEquivalent",
        repair_priority AS "repairPriority",
        bundle_cid AS "bundleCid",
        bundle_member_path AS "bundleMemberPath",
        retention_until AS "retentionUntil",
        metadata,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM persisted_artifact_storage_policies
      WHERE artifact_key = $1
    `,
    [artifactKey],
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    metadata: row.metadata ?? {},
    retentionUntil: row.retentionUntil?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatPersistedArtifactStorageAttestationRow(row: {
  artifactKey: string;
  attestationId: string;
  attestorAddress: string;
  cid: string;
  commitmentKind: PersistedArtifactStorageAttestationView["commitmentKind"];
  createdAt: Date;
  evidenceRef: string | null;
  nodeId: string | null;
  provider: string;
  providerMetadata: Record<string, unknown>;
  retentionUntil: Date | null;
  retrievalUrl: string | null;
  signature: string;
  signedPayloadHash: string;
  storageClass: PersistedArtifactStorageAttestationView["storageClass"];
  storageStartedAt: Date;
  updatedAt: Date;
}): PersistedArtifactStorageAttestationView {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    providerMetadata: row.providerMetadata ?? {},
    retentionUntil: row.retentionUntil?.toISOString() ?? null,
    storageStartedAt: row.storageStartedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function readPersistedArtifactStorageAttestations(
  queryable: Queryable,
  artifactKey: string,
): Promise<PersistedArtifactStorageAttestationView[]> {
  const result = await queryable.query<{
    artifactKey: string;
    attestationId: string;
    attestorAddress: string;
    cid: string;
    commitmentKind: PersistedArtifactStorageAttestationView["commitmentKind"];
    createdAt: Date;
    evidenceRef: string | null;
    nodeId: string | null;
    provider: string;
    providerMetadata: Record<string, unknown>;
    retentionUntil: Date | null;
    retrievalUrl: string | null;
    signature: string;
    signedPayloadHash: string;
    storageClass: PersistedArtifactStorageAttestationView["storageClass"];
    storageStartedAt: Date;
    updatedAt: Date;
  }>(
    `
      SELECT
        attestation_id::text AS "attestationId",
        artifact_key AS "artifactKey",
        attestor_address AS "attestorAddress",
        node_id AS "nodeId",
        cid,
        provider,
        retrieval_url AS "retrievalUrl",
        commitment_kind AS "commitmentKind",
        storage_class AS "storageClass",
        storage_started_at AS "storageStartedAt",
        retention_until AS "retentionUntil",
        evidence_ref AS "evidenceRef",
        signature,
        signed_payload_hash AS "signedPayloadHash",
        provider_metadata AS "providerMetadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM persisted_artifact_storage_attestations
      WHERE artifact_key = $1
      ORDER BY created_at DESC, attestation_id DESC
    `,
    [artifactKey],
  );
  return result.rows.map(formatPersistedArtifactStorageAttestationRow);
}

export async function readPersistedArtifactStorageAttestation(
  queryable: Queryable,
  attestationId: string,
): Promise<PersistedArtifactStorageAttestationView | undefined> {
  const result = await queryable.query<
    Parameters<typeof formatPersistedArtifactStorageAttestationRow>[0]
  >(
    `
      SELECT
        attestation_id::text AS "attestationId",
        artifact_key AS "artifactKey",
        attestor_address AS "attestorAddress",
        node_id AS "nodeId",
        cid,
        provider,
        retrieval_url AS "retrievalUrl",
        commitment_kind AS "commitmentKind",
        storage_class AS "storageClass",
        storage_started_at AS "storageStartedAt",
        retention_until AS "retentionUntil",
        evidence_ref AS "evidenceRef",
        signature,
        signed_payload_hash AS "signedPayloadHash",
        provider_metadata AS "providerMetadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM persisted_artifact_storage_attestations
      WHERE attestation_id = $1
    `,
    [attestationId],
  );
  const row = result.rows[0];
  return row ? formatPersistedArtifactStorageAttestationRow(row) : undefined;
}

export async function readArtifactMaintenanceTasksPage(
  queryable: Queryable,
  options: ArtifactMaintenanceTaskListOptions = {},
): Promise<PageResult<ArtifactMaintenanceTaskView>> {
  const { whereClause, values } = buildArtifactMaintenanceTaskWhereClause(options);
  return queryGenericPage(
    queryable,
    "artifact_maintenance_tasks",
    whereClause,
    values,
    options,
    (innerQueryable, limitOffsetClause, queryValues) =>
      queryArtifactMaintenanceTasks(innerQueryable, whereClause, queryValues, limitOffsetClause),
  );
}

export async function readArtifactMaintenanceTask(
  queryable: Queryable,
  taskId: string,
): Promise<ArtifactMaintenanceTaskView | undefined> {
  const rows = await queryArtifactMaintenanceTasks(queryable, " WHERE task_id = $1", [taskId]);
  return rows[0];
}

export async function readArtifactMaintenanceTaskRun(
  queryable: Queryable,
  runId: string,
): Promise<ArtifactMaintenanceTaskRunView | undefined> {
  const rows = await queryArtifactMaintenanceTaskRuns(queryable, " WHERE run_id = $1", [runId]);
  return rows[0];
}

export async function readArtifactMaintenanceTaskRuns(
  queryable: Queryable,
  taskId: string,
): Promise<ArtifactMaintenanceTaskRunView[]> {
  return queryArtifactMaintenanceTaskRuns(queryable, " WHERE task_id = $1", [taskId]);
}

export async function readPersistedArtifactMaintenanceTasksPage(
  queryable: Queryable,
  artifactKey: string,
  options: Omit<ArtifactMaintenanceTaskListOptions, "artifactKey"> = {},
): Promise<PageResult<ArtifactMaintenanceTaskView>> {
  return readArtifactMaintenanceTasksPage(queryable, {
    ...options,
    artifactKey,
  });
}

export async function readLatestPersistedArtifactAuditAt(
  queryable: Queryable,
  artifactKey: string,
): Promise<string | null> {
  const result = await queryable.query<{ checkedAt: Date | null }>(
    `
      SELECT MAX(checked_at) AS "checkedAt"
      FROM persisted_artifact_audits
      WHERE artifact_key = $1
    `,
    [artifactKey],
  );
  return result.rows[0]?.checkedAt?.toISOString() ?? null;
}

async function queryReplicationJobs(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ReplicationJobView[]> {
  const result = await queryable.query<{
    assignedAgentId: string | null;
    assignedAt: Date | null;
    assignedWorker: string | null;
    claimId: string;
    completedAt: Date | null;
    createdAt: Date;
    evidenceHash: string | null;
    evidenceURI: string | null;
    failureReason: string | null;
    jobId: string;
    onchainReplicationId: string | null;
    requestedBy: string;
    requestId: string | null;
    resultArtifactKey: string | null;
    resultHash: string | null;
    specHash: string;
    specURI: string | null;
    status: ReplicationJobStatus;
    submissionActor: string | null;
    submissionTxHash: string | null;
    submittedAt: Date | null;
    updatedAt: Date;
  }>(
    `
      SELECT
        job_id::text AS "jobId",
        claim_id AS "claimId",
        requested_by AS "requestedBy",
        request_id::text AS "requestId",
        status,
        spec_hash AS "specHash",
        spec_uri AS "specURI",
        assigned_worker AS "assignedWorker",
        assigned_agent_id AS "assignedAgentId",
        assigned_at AS "assignedAt",
        result_artifact_key AS "resultArtifactKey",
        result_hash AS "resultHash",
        evidence_hash AS "evidenceHash",
        evidence_uri AS "evidenceURI",
        onchain_replication_id AS "onchainReplicationId",
        submission_tx_hash AS "submissionTxHash",
        submission_actor AS "submissionActor",
        submitted_at AS "submittedAt",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM replication_jobs
      ${whereClause}
      ORDER BY job_id ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows.map((row) => ({
    ...row,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function queryArtifactMaintenanceTasks(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
  suffixClause = "",
): Promise<ArtifactMaintenanceTaskView[]> {
  const result = await queryable.query<{
    artifactKey: string;
    assignedAgentId: string | null;
    assignedAt: Date | null;
    assignedWorker: string | null;
    completedAt: Date | null;
    createdAt: Date;
    failureReason: string | null;
    repairLocator: string | null;
    repairSourceReplicaKey: string | null;
    requestedBy: string;
    resultArtifactKey: string | null;
    status: ArtifactMaintenanceTaskStatus;
    targetProvider: string | null;
    targetReplicaKey: string | null;
    taskId: string;
    taskType: ArtifactMaintenanceTaskType;
    updatedAt: Date;
  }>(
    `
      SELECT
        task_id::text AS "taskId",
        artifact_key AS "artifactKey",
        task_type AS "taskType",
        status,
        requested_by AS "requestedBy",
        target_replica_key AS "targetReplicaKey",
        target_provider AS "targetProvider",
        assigned_worker AS "assignedWorker",
        assigned_agent_id AS "assignedAgentId",
        assigned_at AS "assignedAt",
        result_artifact_key AS "resultArtifactKey",
        failure_reason AS "failureReason",
        repair_source_replica_key AS "repairSourceReplicaKey",
        repair_locator AS "repairLocator",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM artifact_maintenance_tasks
      ${whereClause}
      ORDER BY task_id ASC
      ${suffixClause}
    `,
    values,
  );
  return result.rows.map((row) => ({
    ...row,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function queryArtifactMaintenanceTaskRuns(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
): Promise<ArtifactMaintenanceTaskRunView[]> {
  const result = await queryable.query<{
    agentId: string | null;
    failureReason: string | null;
    finishedAt: Date | null;
    lastHeartbeatAt: Date | null;
    runId: string;
    startedAt: Date;
    status: ArtifactMaintenanceTaskRunStatus;
    summaryArtifactKey: string | null;
    taskId: string;
    workerId: string;
  }>(
    `
      SELECT
        run_id::text AS "runId",
        task_id::text AS "taskId",
        worker_id AS "workerId",
        agent_id AS "agentId",
        status,
        summary_artifact_key AS "summaryArtifactKey",
        failure_reason AS "failureReason",
        last_heartbeat_at AS "lastHeartbeatAt",
        started_at AS "startedAt",
        finished_at AS "finishedAt"
      FROM artifact_maintenance_task_runs
      ${whereClause}
      ORDER BY run_id ASC
    `,
    values,
  );
  return result.rows.map((row) => ({
    ...row,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
  }));
}

async function queryReplicationJobRuns(
  queryable: Queryable,
  whereClause = "",
  values: unknown[] = [],
): Promise<ReplicationJobRunView[]> {
  const result = await queryable.query<{
    agentId: string | null;
    evidenceHash: string | null;
    evidenceURI: string | null;
    executionManifestHash: string | null;
    failureReason: string | null;
    finishedAt: Date | null;
    jobId: string;
    lastHeartbeatAt: Date | null;
    resultArtifactKey: string | null;
    resultHash: string | null;
    runId: string;
    requestId: string | null;
    startedAt: Date;
    status: ReplicationJobRunStatus;
    submissionTxHash: string | null;
    workerId: string;
  }>(
    `
      SELECT
        run_id::text AS "runId",
        job_id::text AS "jobId",
        worker_id AS "workerId",
        agent_id AS "agentId",
        request_id::text AS "requestId",
        status,
        execution_manifest_hash AS "executionManifestHash",
        result_artifact_key AS "resultArtifactKey",
        result_hash AS "resultHash",
        evidence_hash AS "evidenceHash",
        evidence_uri AS "evidenceURI",
        submission_tx_hash AS "submissionTxHash",
        failure_reason AS "failureReason",
        last_heartbeat_at AS "lastHeartbeatAt",
        started_at AS "startedAt",
        finished_at AS "finishedAt"
      FROM replication_job_runs
      ${whereClause}
      ORDER BY run_id ASC
    `,
    values,
  );
  return result.rows.map((row) => ({
    ...row,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
  }));
}

function buildReplicationJobWhereClause(options: ReplicationJobListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }
  if (options.requestedBy) {
    values.push(options.requestedBy);
    clauses.push(`lower(requested_by) = lower($${values.length})`);
  }
  if (options.assignedWorker) {
    values.push(options.assignedWorker);
    clauses.push(`assigned_worker = $${values.length}`);
  }
  if (options.assignedAgentId) {
    values.push(options.assignedAgentId);
    clauses.push(`assigned_agent_id = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function buildArtifactMaintenanceTaskWhereClause(options: ArtifactMaintenanceTaskListOptions): {
  whereClause: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.artifactKey) {
    values.push(options.artifactKey);
    clauses.push(`artifact_key = $${values.length}`);
  }
  if (options.taskType) {
    values.push(options.taskType);
    clauses.push(`task_type = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }
  if (options.assignedAgentId) {
    values.push(options.assignedAgentId);
    clauses.push(`assigned_agent_id = $${values.length}`);
  }
  if (options.targetReplicaKey) {
    values.push(options.targetReplicaKey);
    clauses.push(`target_replica_key = $${values.length}`);
  }

  return {
    whereClause: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

async function queryGenericPage<T>(
  queryable: Queryable,
  tableName: "artifact_maintenance_tasks" | "replication_jobs",
  whereClause: string,
  values: unknown[],
  options: { limit?: number; offset?: number },
  readItems: (
    queryable: Queryable,
    limitOffsetClause: string,
    queryValues: unknown[],
  ) => Promise<T[]>,
): Promise<PageResult<T>> {
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${tableName}${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const limitOffsetClause = `
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `;
  return {
    items: await readItems(queryable, limitOffsetClause, pageValues),
    total: Number(countResult.rows[0]?.count ?? "0"),
    limit,
    offset,
  };
}

async function queryPage<T>(
  queryable: Queryable,
  tableName: "replication_jobs",
  whereClause: string,
  values: unknown[],
  options: { limit?: number; offset?: number },
  readItems: (
    queryable: Queryable,
    limitOffsetClause: string,
    queryValues: unknown[],
  ) => Promise<T[]>,
): Promise<PageResult<T>> {
  return queryGenericPage(queryable, tableName, whereClause, values, options, readItems);
}
