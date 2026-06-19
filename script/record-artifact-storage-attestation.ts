import type { Pool } from "pg";
import {
  type PersistedArtifactStorageAttestationView,
  prepareCoordinatorStore,
  recordPersistedArtifactStorageAttestation,
} from "../src/coordinator/store.js";
import { getDatabaseUrl } from "../src/indexer/store.js";
import { toArtifactStorageAttestationRecordInput } from "../src/shared/artifact-storage-attestations.js";
import { isMainModule, parseCliArgs, runJsonCliCommand } from "../src/shared/cli.js";
import { readSignedArtifactStorageAttestationFile } from "./verify-artifact-storage-attestation.js";

export type ArtifactStorageAttestationRecordConfig = {
  databaseUrl: string;
  filePath: string;
};

export type ArtifactStorageAttestationRecordResult = {
  artifactKey: string;
  attestationId: string;
  cid: string;
  ok: boolean;
  provider: string;
  signedPayloadHash: string;
};

export type ArtifactStorageAttestationRecordDependencies = {
  prepareStore?: (databaseUrl: string, env: NodeJS.ProcessEnv) => Promise<Pool>;
  recordAttestation?: typeof recordPersistedArtifactStorageAttestation;
};

export function resolveArtifactStorageAttestationRecordConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStorageAttestationRecordConfig {
  const args = parseCliArgs(argv);
  const filePath = args.file?.trim();
  if (!filePath) {
    throw new Error("--file is required");
  }
  return {
    databaseUrl: args["database-url"]?.trim() || getDatabaseUrl(env),
    filePath,
  };
}

export async function recordArtifactStorageAttestationFromFile(
  filePath: string,
  dependencies: ArtifactStorageAttestationRecordDependencies = {},
  options: {
    databaseUrl?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ArtifactStorageAttestationRecordResult> {
  const env = options.env ?? process.env;
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl(env);
  const prepareStore = dependencies.prepareStore ?? prepareCoordinatorStore;
  const recordAttestation =
    dependencies.recordAttestation ?? recordPersistedArtifactStorageAttestation;
  const signed = readSignedArtifactStorageAttestationFile(filePath);
  const input = toArtifactStorageAttestationRecordInput(signed);
  const pool = await prepareStore(databaseUrl, env);
  const ownsPool = !dependencies.prepareStore;
  try {
    const stored: PersistedArtifactStorageAttestationView = await recordAttestation(
      pool,
      signed.envelope.artifactKey,
      input,
    );
    return {
      artifactKey: stored.artifactKey,
      attestationId: stored.attestationId,
      cid: stored.cid,
      ok: true,
      provider: stored.provider,
      signedPayloadHash: stored.signedPayloadHash,
    };
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

export async function recordArtifactStorageAttestationFromEnv(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ArtifactStorageAttestationRecordDependencies = {},
): Promise<ArtifactStorageAttestationRecordResult> {
  const config = resolveArtifactStorageAttestationRecordConfig(argv, env);
  return recordArtifactStorageAttestationFromFile(config.filePath, dependencies, {
    databaseUrl: config.databaseUrl,
    env,
  });
}

if (isMainModule(import.meta.url)) {
  await runJsonCliCommand(() => recordArtifactStorageAttestationFromEnv());
}
