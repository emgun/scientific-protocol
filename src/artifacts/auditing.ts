import type { Pool } from "pg";
import {
  type PersistedArtifactAuditView,
  type PersistedArtifactView,
  readPersistedArtifact,
  readPersistedArtifactReplicas,
  recordPersistedArtifactAudit,
  upsertPersistedArtifactReplica,
} from "../coordinator/store.js";
import {
  type ArtifactPersistenceOptions,
  auditPersistedArtifactReplicas,
  buildPrimaryArtifactReplica,
} from "../shared/persisted-artifacts.js";

export type PersistedArtifactAuditSummary = {
  artifact: PersistedArtifactView;
  audits: PersistedArtifactAuditView[];
  healthyReplicas: number;
  replicaCount: number;
};

export async function auditPersistedArtifactDurability(
  pool: Pool,
  artifactKey: string,
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactAuditSummary> {
  const artifact = await readPersistedArtifact(pool, artifactKey);
  if (!artifact) {
    throw new Error(`persisted artifact ${artifactKey} not found`);
  }

  let replicas = await readPersistedArtifactReplicas(pool, artifactKey);
  if (replicas.length === 0) {
    await upsertPersistedArtifactReplica(
      pool,
      artifactKey,
      buildPrimaryArtifactReplica(artifact, options),
    );
    replicas = await readPersistedArtifactReplicas(pool, artifactKey);
  }

  const audits = await auditPersistedArtifactReplicas(
    {
      ...artifact,
      replicas,
    },
    options,
  );

  for (const audit of audits) {
    await recordPersistedArtifactAudit(pool, artifactKey, audit);
  }

  return {
    artifact,
    audits: audits.map((audit, index) => ({
      ...audit,
      artifactKey,
      auditId: `runtime-${index}`,
      checkedAt: audit.checkedAt ?? new Date().toISOString(),
    })),
    healthyReplicas: audits.filter((audit) => audit.status === "verified").length,
    replicaCount: replicas.length,
  };
}
