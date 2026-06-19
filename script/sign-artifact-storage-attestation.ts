import { writeFile } from "node:fs/promises";
import { Wallet } from "ethers";
import {
  createSignedArtifactStorageAttestation,
  type SignedArtifactStorageAttestation,
  verifyArtifactStorageAttestation,
} from "../src/shared/artifact-storage-attestations.js";
import type {
  ArtifactDurabilityClass,
  ArtifactStorageCommitmentKind,
} from "../src/shared/artifact-storage-policy.js";
import {
  isMainModule,
  parseCliArgs,
  parseIntegerValue,
  parseJsonText,
  readJsonFileSync,
  runJsonCliCommand,
} from "../src/shared/cli.js";
import { readEnvValue } from "../src/shared/secrets.js";

const commitmentKinds = [
  "filecoin",
  "hot",
  "institutional",
  "mirror",
  "provider",
  "temporary",
] as const satisfies readonly ArtifactStorageCommitmentKind[];
const storageClasses = ["A", "B", "C", "D"] as const satisfies readonly ArtifactDurabilityClass[];

export type ArtifactStorageAttestationSignConfig = {
  artifactKey: string;
  chainId: number;
  cid: string;
  commitmentKind: ArtifactStorageCommitmentKind;
  evidenceRef: string | undefined;
  issuedAt: string | undefined;
  nodeId: string | undefined;
  outPath: string | undefined;
  privateKey: string;
  provider: string;
  providerMetadata: Record<string, unknown>;
  requestNonce: string;
  retentionUntil: string | undefined;
  retrievalUrl: string | undefined;
  scopeKey: string | undefined;
  storageClass: ArtifactDurabilityClass;
  storageStartedAt: string | undefined;
};

export type SignedArtifactStorageAttestationFile = SignedArtifactStorageAttestation & {
  kind: "scientific.artifact-storage-attestation";
  recoveredAddress: string;
  signedPayloadHash: string;
  version: 1;
};

function readArgOrEnv(
  args: Record<string, string>,
  argKey: string,
  env: NodeJS.ProcessEnv,
  envKey: string,
): string | undefined {
  return args[argKey]?.trim() || readEnvValue(env, envKey);
}

function readRequiredArgOrEnv(
  args: Record<string, string>,
  argKey: string,
  env: NodeJS.ProcessEnv,
  envKey: string,
): string {
  const value = readArgOrEnv(args, argKey, env, envKey);
  if (!value) {
    throw new Error(`--${argKey} or ${envKey} is required`);
  }
  return value;
}

function readEnumValue<const Value extends string>(
  value: string,
  key: string,
  values: readonly Value[],
): Value {
  if ((values as readonly string[]).includes(value)) {
    return value as Value;
  }
  throw new Error(`${key} must be one of: ${values.join(", ")}`);
}

function readProviderMetadata(args: Record<string, string>): Record<string, unknown> {
  const metadataJson = args["provider-metadata-json"]?.trim();
  const metadataFile = args["provider-metadata-file"]?.trim();
  if (metadataJson && metadataFile) {
    throw new Error("use either --provider-metadata-json or --provider-metadata-file, not both");
  }
  const parsed = metadataFile
    ? readJsonFileSync(metadataFile)
    : metadataJson
      ? parseJsonText(metadataJson, "--provider-metadata-json")
      : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("provider metadata must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function resolveArtifactStorageAttestationSignConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ArtifactStorageAttestationSignConfig {
  const args = parseCliArgs(argv);
  const privateKey = readEnvValue(env, "SP_STORAGE_ATTESTOR_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error("SP_STORAGE_ATTESTOR_PRIVATE_KEY is required for storage attestation signing");
  }
  const chainId = parseIntegerValue(
    readRequiredArgOrEnv(args, "chain-id", env, "SP_CHAIN_ID"),
    "chain-id",
  );
  return {
    artifactKey: readRequiredArgOrEnv(
      args,
      "artifact-key",
      env,
      "SP_ARTIFACT_STORAGE_ATTESTATION_ARTIFACT_KEY",
    ),
    chainId,
    cid: readRequiredArgOrEnv(args, "cid", env, "SP_ARTIFACT_STORAGE_ATTESTATION_CID"),
    commitmentKind: readEnumValue(
      readRequiredArgOrEnv(
        args,
        "commitment-kind",
        env,
        "SP_ARTIFACT_STORAGE_ATTESTATION_COMMITMENT_KIND",
      ),
      "commitment-kind",
      commitmentKinds,
    ),
    evidenceRef: readArgOrEnv(args, "evidence-ref", env, "SP_ARTIFACT_STORAGE_EVIDENCE_REF"),
    issuedAt: readArgOrEnv(args, "issued-at", env, "SP_ARTIFACT_STORAGE_ATTESTATION_ISSUED_AT"),
    nodeId: readArgOrEnv(args, "node-id", env, "SP_ARTIFACT_STORAGE_NODE_ID"),
    outPath: args.out?.trim() || undefined,
    privateKey,
    provider: readRequiredArgOrEnv(
      args,
      "provider",
      env,
      "SP_ARTIFACT_STORAGE_ATTESTATION_PROVIDER",
    ),
    providerMetadata: readProviderMetadata(args),
    requestNonce: readRequiredArgOrEnv(
      args,
      "request-nonce",
      env,
      "SP_ARTIFACT_STORAGE_ATTESTATION_NONCE",
    ),
    retentionUntil: readArgOrEnv(
      args,
      "retention-until",
      env,
      "SP_ARTIFACT_STORAGE_RETENTION_UNTIL",
    ),
    retrievalUrl: readArgOrEnv(args, "retrieval-url", env, "SP_ARTIFACT_STORAGE_RETRIEVAL_URL"),
    scopeKey: readArgOrEnv(args, "scope-key", env, "SP_ARTIFACT_STORAGE_ATTESTATION_SCOPE_KEY"),
    storageClass: readEnumValue(
      readRequiredArgOrEnv(args, "storage-class", env, "SP_ARTIFACT_STORAGE_CLASS"),
      "storage-class",
      storageClasses,
    ),
    storageStartedAt: readArgOrEnv(
      args,
      "storage-started-at",
      env,
      "SP_ARTIFACT_STORAGE_STARTED_AT",
    ),
  };
}

export async function signArtifactStorageAttestationFromEnv(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignedArtifactStorageAttestationFile> {
  const config = resolveArtifactStorageAttestationSignConfig(argv, env);
  const signed = await createSignedArtifactStorageAttestation({
    artifactKey: config.artifactKey,
    chainId: config.chainId,
    cid: config.cid,
    commitmentKind: config.commitmentKind,
    evidenceRef: config.evidenceRef,
    issuedAt: config.issuedAt,
    nodeId: config.nodeId,
    provider: config.provider,
    providerMetadata: config.providerMetadata,
    requestNonce: config.requestNonce,
    retentionUntil: config.retentionUntil,
    retrievalUrl: config.retrievalUrl,
    scopeKey: config.scopeKey,
    signer: new Wallet(config.privateKey),
    storageClass: config.storageClass,
    storageStartedAt: config.storageStartedAt,
  });
  const verified = verifyArtifactStorageAttestation(signed);
  const output: SignedArtifactStorageAttestationFile = {
    kind: "scientific.artifact-storage-attestation",
    recoveredAddress: verified.recoveredAddress,
    signedPayloadHash: verified.signedPayloadHash,
    version: 1,
    ...signed,
  };
  if (config.outPath) {
    await writeFile(config.outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  return output;
}

if (isMainModule(import.meta.url)) {
  await runJsonCliCommand(() => signArtifactStorageAttestationFromEnv());
}
