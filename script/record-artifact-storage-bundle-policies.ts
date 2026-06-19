import type { Pool } from "pg";
import {
  type PersistedArtifactStoragePolicyView,
  prepareCoordinatorStore,
  upsertPersistedArtifactStoragePolicy,
} from "../src/coordinator/store.js";
import { getDatabaseUrl } from "../src/indexer/store.js";
import {
  type ArtifactStorageBundleManifest,
  createArtifactStorageBundlePolicyInputs,
} from "../src/shared/artifact-storage-bundles.js";
import {
  isMainModule,
  parseCliArgs,
  readJsonFileSync,
  runJsonCliCommand,
} from "../src/shared/cli.js";

export type ArtifactStorageBundlePolicyRecordConfig = {
  databaseUrl: string;
  filePath: string;
};

export type ArtifactStorageBundlePolicyRecordResult = {
  artifactCount: number;
  bundleCid: string | null;
  bundleKey: string;
  manifestDigest: string;
  ok: boolean;
  recordedArtifacts: string[];
};

export type ArtifactStorageBundlePolicyRecordDependencies = {
  prepareStore?: (databaseUrl: string, env: NodeJS.ProcessEnv) => Promise<Pool>;
  upsertStoragePolicy?: typeof upsertPersistedArtifactStoragePolicy;
};

export function resolveArtifactStorageBundlePolicyRecordConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStorageBundlePolicyRecordConfig {
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

export async function recordArtifactStorageBundlePoliciesFromFile(
  filePath: string,
  dependencies: ArtifactStorageBundlePolicyRecordDependencies = {},
  options: {
    databaseUrl?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ArtifactStorageBundlePolicyRecordResult> {
  const manifest = readJsonFileSync<ArtifactStorageBundleManifest>(filePath);
  const policyInputs = createArtifactStorageBundlePolicyInputs(manifest);
  const env = options.env ?? process.env;
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl(env);
  const prepareStore = dependencies.prepareStore ?? prepareCoordinatorStore;
  const upsertStoragePolicy =
    dependencies.upsertStoragePolicy ?? upsertPersistedArtifactStoragePolicy;
  const pool = await prepareStore(databaseUrl, env);
  const ownsPool = !dependencies.prepareStore;
  try {
    const recorded: PersistedArtifactStoragePolicyView[] = [];
    for (const policyInput of policyInputs) {
      recorded.push(await upsertStoragePolicy(pool, policyInput.artifactKey, policyInput.policy));
    }
    return {
      artifactCount: recorded.length,
      bundleCid: manifest.bundleCid,
      bundleKey: manifest.bundleKey,
      manifestDigest: manifest.manifestDigest,
      ok: true,
      recordedArtifacts: recorded.map((artifact) => artifact.artifactKey),
    };
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

export async function recordArtifactStorageBundlePoliciesFromEnv(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ArtifactStorageBundlePolicyRecordDependencies = {},
): Promise<ArtifactStorageBundlePolicyRecordResult> {
  const config = resolveArtifactStorageBundlePolicyRecordConfig(argv, env);
  return recordArtifactStorageBundlePoliciesFromFile(config.filePath, dependencies, {
    databaseUrl: config.databaseUrl,
    env,
  });
}

if (isMainModule(import.meta.url)) {
  await runJsonCliCommand(() => recordArtifactStorageBundlePoliciesFromEnv());
}
