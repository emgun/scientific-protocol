import { writeFile } from "node:fs/promises";
import {
  type ArtifactStorageBundleManifest,
  type ArtifactStorageBundleManifestInput,
  buildArtifactStorageBundleManifest,
} from "../src/shared/artifact-storage-bundles.js";
import {
  isMainModule,
  parseCliArgs,
  readJsonFileSync,
  runJsonCliCommand,
} from "../src/shared/cli.js";

export type ArtifactStorageBundlePrepareConfig = {
  inputPath: string;
  outPath: string;
};

export type ArtifactStorageBundlePrepareResult = {
  artifactCount: number;
  bundleCid: string | null;
  bundleKey: string;
  manifestDigest: string;
  outPath: string;
};

export function resolveArtifactStorageBundlePrepareConfig(
  argv: string[] = process.argv.slice(2),
): ArtifactStorageBundlePrepareConfig {
  const args = parseCliArgs(argv);
  const inputPath = args.input?.trim();
  const outPath = args.out?.trim();
  if (!inputPath) {
    throw new Error("--input is required");
  }
  if (!outPath) {
    throw new Error("--out is required");
  }
  return { inputPath, outPath };
}

export async function prepareArtifactStorageBundleFromArgv(
  argv: string[] = process.argv.slice(2),
): Promise<ArtifactStorageBundlePrepareResult> {
  const config = resolveArtifactStorageBundlePrepareConfig(argv);
  const manifest: ArtifactStorageBundleManifest = buildArtifactStorageBundleManifest(
    readJsonFileSync<ArtifactStorageBundleManifestInput>(config.inputPath),
  );
  await writeFile(config.outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    artifactCount: manifest.artifacts.length,
    bundleCid: manifest.bundleCid,
    bundleKey: manifest.bundleKey,
    manifestDigest: manifest.manifestDigest,
    outPath: config.outPath,
  };
}

if (isMainModule(import.meta.url)) {
  await runJsonCliCommand(() => prepareArtifactStorageBundleFromArgv());
}
