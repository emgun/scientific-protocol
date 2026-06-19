import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ArtifactReplicaProviderMetadata } from "./artifact-provider-metadata.js";
import { parseEnumValue, readBooleanEnv } from "./cli.js";
import { createDefaultGcsClient, type GcsLikeClient, isGcsUrl, parseGcsUrl } from "./gcs.js";
import {
  createDefaultIpfsClient,
  type IpfsLikeClient,
  type IpfsObjectWrite,
  type IpfsProvider,
  isIpfsUrl,
  parseIpfsUrl,
} from "./ipfs.js";
import { readEnvValue } from "./secrets.js";
import { sha256Hex } from "./sha256.js";

export { sha256Hex } from "./sha256.js";

export const DEFAULT_ARTIFACT_STORE_ROOT = path.resolve(process.cwd(), "ops", "artifact-store");

export type ArtifactContent = string | Uint8Array;
export type ArtifactAuditKind = "agent_report" | "persist" | "verify";
export type ArtifactAuditStatus =
  | "hash_mismatch"
  | "replicated"
  | "replication_failed"
  | "unreachable"
  | "verified";

export type ArtifactFileReference = {
  filePath: string;
};

export type PersistedArtifactReplicaRecord = {
  isPrimary: boolean;
  locator: string;
  provider: string;
  providerMetadata?: ArtifactReplicaProviderMetadata | null;
  replicaKey: string;
};

export type PersistedArtifactAuditRecord = {
  checkKind: ArtifactAuditKind;
  checkedAt?: string;
  detail?: string | null;
  locator: string | null;
  observedSha256?: string | null;
  provider: string;
  replicaKey: string | null;
  status: ArtifactAuditStatus;
};

export type PersistedArtifactProvenanceRecord = {
  cid?: string | null;
  commitHash?: string | null;
  derivedFromArtifactKey?: string | null;
  finalUrl?: string | null;
  metadata?: Record<string, unknown>;
  ref?: string | null;
  sourceLocator: string;
  sourceType: string;
};

export type ArtifactIpfsReplicaTarget = {
  apiUrl?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
  gatewayUrl?: string;
  ipfsClient?: IpfsLikeClient;
  pinataApiUrl?: string;
  pinataGatewayUrl?: string;
  pinataJwt?: string;
  pinataNetwork?: "public" | "private";
  provider?: IpfsProvider;
  replicaKey: string;
};

export type PersistedArtifactInput = {
  content: ArtifactContent | ArtifactFileReference;
  contentType: string;
  extension: string;
  kind: string;
};

export type PersistedArtifactRecord = {
  artifactKey: string;
  audits?: PersistedArtifactAuditRecord[];
  byteLength: number;
  contentType: string;
  kind: string;
  provenance?: PersistedArtifactProvenanceRecord | null;
  replicas?: PersistedArtifactReplicaRecord[];
  sha256: string;
  storagePath: string;
};

export type ArtifactPersistenceBackend = "filesystem" | "http" | "s3" | "gcs" | "ipfs";

export type S3LikeClient = {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
};

export type PersistedArtifactContentStream = {
  contentLength: number | null;
  stream: NodeJS.ReadableStream;
};

export type ArtifactPersistenceOptions = {
  backend?: ArtifactPersistenceBackend;
  env?: NodeJS.ProcessEnv;
  filesystemRoot?: string;
  gcsBucket?: string;
  gcsClient?: GcsLikeClient;
  gcsPrefix?: string;
  httpBaseUrl?: string;
  ipfsApiUrl?: string;
  ipfsAuthHeaderName?: string;
  ipfsAuthHeaderValue?: string;
  ipfsClient?: IpfsLikeClient;
  ipfsGatewayUrl?: string;
  ipfsPin?: boolean;
  ipfsProvider?: IpfsProvider;
  ipfsReplicaTargets?: ArtifactIpfsReplicaTarget[];
  pinataApiUrl?: string;
  pinataGatewayUrl?: string;
  pinataJwt?: string;
  pinataNetwork?: "public" | "private";
  s3Bucket?: string;
  s3Client?: S3LikeClient;
  s3Endpoint?: string;
  s3ForcePathStyle?: boolean;
  s3Prefix?: string;
  s3Region?: string;
};

type ResolvedArtifactPersistenceOptions = Required<Omit<ArtifactPersistenceOptions, "env">>;

type PersistArtifactBackendResult = {
  primaryReplicaProviderMetadata?: ArtifactReplicaProviderMetadata | null;
  record: PersistedArtifactRecord;
};

type PreparedArtifactContent = {
  body?: Buffer;
  byteLength: number;
  filePath?: string;
  sha256: string;
};

function isArtifactFileReference(
  value: ArtifactContent | ArtifactFileReference,
): value is ArtifactFileReference {
  return typeof value === "object" && value !== null && "filePath" in value;
}

function toBuffer(content: ArtifactContent): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

async function hashFile(filePath: string): Promise<PreparedArtifactContent> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bufferChunk);
    byteLength += bufferChunk.byteLength;
  }
  return {
    byteLength,
    filePath,
    sha256: hash.digest("hex"),
  };
}

async function prepareArtifactContent(
  content: ArtifactContent | ArtifactFileReference,
): Promise<PreparedArtifactContent> {
  if (isArtifactFileReference(content)) {
    return hashFile(content.filePath);
  }
  const body = toBuffer(content);
  return {
    body,
    byteLength: body.byteLength,
    sha256: sha256Hex(body),
  };
}

function ipfsWriteInput(
  prepared: PreparedArtifactContent,
  contentType: string,
  filename: string,
  pin: boolean,
): IpfsObjectWrite {
  if (prepared.filePath) {
    return {
      contentType,
      filePath: prepared.filePath,
      filename,
      pin,
    };
  }
  return {
    body: new Uint8Array(prepared.body ?? Buffer.alloc(0)),
    contentType,
    filename,
    pin,
  };
}

async function sha256HexFromStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return hash.digest("hex");
}

function providerNameForIpfsProvider(provider: IpfsProvider): string {
  return `ipfs:${provider}`;
}

function normalizeReplicaKey(value: string, index: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`invalid SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].replicaKey`);
  }
  if (normalized === "primary") {
    throw new Error("artifact replica key 'primary' is reserved");
  }
  return normalized;
}

function parseIpfsReplicaTargets(raw: string | undefined): ArtifactIpfsReplicaTarget[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("SP_ARTIFACT_IPFS_REPLICA_TARGETS must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("SP_ARTIFACT_IPFS_REPLICA_TARGETS must be a JSON array");
  }

  const seenKeys = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`invalid SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}]`);
    }

    const source = entry as Record<string, unknown>;
    const replicaKey = normalizeReplicaKey(String(source.replicaKey ?? ""), index);
    if (seenKeys.has(replicaKey)) {
      throw new Error(`duplicate artifact replica key: ${replicaKey}`);
    }
    seenKeys.add(replicaKey);

    const provider = source.provider === "pinata" ? "pinata" : "kubo";
    const target: ArtifactIpfsReplicaTarget = {
      apiUrl: typeof source.apiUrl === "string" ? source.apiUrl : undefined,
      authHeaderName: typeof source.authHeaderName === "string" ? source.authHeaderName : undefined,
      authHeaderValue:
        typeof source.authHeaderValue === "string" ? source.authHeaderValue : undefined,
      gatewayUrl: typeof source.gatewayUrl === "string" ? source.gatewayUrl : undefined,
      pinataApiUrl: typeof source.pinataApiUrl === "string" ? source.pinataApiUrl : undefined,
      pinataGatewayUrl:
        typeof source.pinataGatewayUrl === "string" ? source.pinataGatewayUrl : undefined,
      pinataJwt: typeof source.pinataJwt === "string" ? source.pinataJwt : undefined,
      pinataNetwork: source.pinataNetwork === "private" ? "private" : "public",
      provider,
      replicaKey,
    };

    if (provider === "pinata") {
      if (!target.pinataJwt?.trim()) {
        throw new Error(`artifact replica target ${replicaKey} requires pinataJwt`);
      }
    } else if (!target.apiUrl?.trim()) {
      throw new Error(`artifact replica target ${replicaKey} requires apiUrl`);
    }

    return target;
  });
}

export function resolveArtifactIpfsReplicaTargets(
  options: ArtifactPersistenceOptions,
): ArtifactIpfsReplicaTarget[] {
  const env = options.env ?? process.env;
  const targets =
    options.ipfsReplicaTargets ??
    parseIpfsReplicaTargets(readEnvValue(env, "SP_ARTIFACT_IPFS_REPLICA_TARGETS"));
  const seenKeys = new Set<string>();
  for (const [index, target] of targets.entries()) {
    const replicaKey = normalizeReplicaKey(target.replicaKey, index);
    if (seenKeys.has(replicaKey)) {
      throw new Error(`duplicate artifact replica key: ${replicaKey}`);
    }
    seenKeys.add(replicaKey);
  }
  return targets.map((target) => ({
    ...target,
    provider: target.provider ?? "kubo",
    replicaKey: target.replicaKey.trim(),
  }));
}

function createReplicaClient(target: ArtifactIpfsReplicaTarget): IpfsLikeClient {
  return (
    target.ipfsClient ??
    createDefaultIpfsClient({
      apiUrl: target.apiUrl,
      authHeaderName: target.authHeaderName,
      authHeaderValue: target.authHeaderValue,
      gatewayUrl: target.gatewayUrl,
      pinataApiUrl: target.pinataApiUrl,
      pinataGatewayUrl: target.pinataGatewayUrl,
      pinataJwt: target.pinataJwt,
      pinataNetwork: target.pinataNetwork,
      provider: target.provider ?? "kubo",
    })
  );
}

export function findArtifactIpfsReplicaTarget(
  options: ArtifactPersistenceOptions,
  replicaKey: string,
): ArtifactIpfsReplicaTarget | undefined {
  return resolveArtifactPersistenceOptions(options).ipfsReplicaTargets.find(
    (target) => target.replicaKey === replicaKey,
  );
}

export function resolveArtifactPersistenceOptions(
  options: ArtifactPersistenceOptions = {},
): ResolvedArtifactPersistenceOptions {
  const env = options.env ?? process.env;
  const ipfsProvider =
    options.ipfsProvider ??
    parseEnumValue(readEnvValue(env, "SP_ARTIFACT_IPFS_PROVIDER"), "SP_ARTIFACT_IPFS_PROVIDER", [
      "kubo",
      "pinata",
    ]);
  const pinataNetwork =
    options.pinataNetwork ??
    parseEnumValue(readEnvValue(env, "SP_ARTIFACT_PINATA_NETWORK"), "SP_ARTIFACT_PINATA_NETWORK", [
      "public",
      "private",
    ]);
  const backend =
    options.backend ??
    parseEnumValue(readEnvValue(env, "SP_ARTIFACT_BACKEND"), "SP_ARTIFACT_BACKEND", [
      "filesystem",
      "http",
      "s3",
      "gcs",
      "ipfs",
    ]);
  return {
    backend: backend ?? "filesystem",
    filesystemRoot:
      options.filesystemRoot ??
      readEnvValue(env, "SP_ARTIFACT_FILESYSTEM_ROOT") ??
      DEFAULT_ARTIFACT_STORE_ROOT,
    gcsBucket: options.gcsBucket ?? readEnvValue(env, "SP_ARTIFACT_GCS_BUCKET") ?? "",
    gcsClient: options.gcsClient ?? createDefaultGcsClient(),
    gcsPrefix: options.gcsPrefix ?? readEnvValue(env, "SP_ARTIFACT_GCS_PREFIX") ?? "",
    httpBaseUrl: options.httpBaseUrl ?? readEnvValue(env, "SP_ARTIFACT_HTTP_BASE_URL") ?? "",
    ipfsApiUrl: options.ipfsApiUrl ?? readEnvValue(env, "SP_ARTIFACT_IPFS_API_URL") ?? "",
    ipfsAuthHeaderName:
      options.ipfsAuthHeaderName ?? readEnvValue(env, "SP_ARTIFACT_IPFS_AUTH_HEADER_NAME") ?? "",
    ipfsAuthHeaderValue:
      options.ipfsAuthHeaderValue ?? readEnvValue(env, "SP_ARTIFACT_IPFS_AUTH_HEADER_VALUE") ?? "",
    ipfsClient:
      options.ipfsClient ??
      createDefaultIpfsClient({
        apiUrl: options.ipfsApiUrl ?? readEnvValue(env, "SP_ARTIFACT_IPFS_API_URL") ?? "",
        authHeaderName:
          options.ipfsAuthHeaderName ??
          readEnvValue(env, "SP_ARTIFACT_IPFS_AUTH_HEADER_NAME") ??
          "",
        authHeaderValue:
          options.ipfsAuthHeaderValue ??
          readEnvValue(env, "SP_ARTIFACT_IPFS_AUTH_HEADER_VALUE") ??
          "",
        gatewayUrl:
          options.ipfsGatewayUrl ?? readEnvValue(env, "SP_ARTIFACT_IPFS_GATEWAY_URL") ?? "",
        pinataApiUrl: options.pinataApiUrl ?? readEnvValue(env, "SP_ARTIFACT_PINATA_API_URL") ?? "",
        pinataGatewayUrl:
          options.pinataGatewayUrl ?? readEnvValue(env, "SP_ARTIFACT_PINATA_GATEWAY_URL") ?? "",
        pinataJwt: options.pinataJwt ?? readEnvValue(env, "SP_ARTIFACT_PINATA_JWT") ?? "",
        pinataNetwork: pinataNetwork ?? "public",
        provider: ipfsProvider ?? "kubo",
      }),
    ipfsGatewayUrl:
      options.ipfsGatewayUrl ?? readEnvValue(env, "SP_ARTIFACT_IPFS_GATEWAY_URL") ?? "",
    ipfsPin: options.ipfsPin ?? readBooleanEnv(env, "SP_ARTIFACT_IPFS_PIN", true),
    ipfsProvider: ipfsProvider ?? "kubo",
    ipfsReplicaTargets: resolveArtifactIpfsReplicaTargets(options),
    pinataApiUrl: options.pinataApiUrl ?? readEnvValue(env, "SP_ARTIFACT_PINATA_API_URL") ?? "",
    pinataGatewayUrl:
      options.pinataGatewayUrl ?? readEnvValue(env, "SP_ARTIFACT_PINATA_GATEWAY_URL") ?? "",
    pinataJwt: options.pinataJwt ?? readEnvValue(env, "SP_ARTIFACT_PINATA_JWT") ?? "",
    pinataNetwork: pinataNetwork ?? "public",
    s3Bucket: options.s3Bucket ?? readEnvValue(env, "SP_ARTIFACT_S3_BUCKET") ?? "",
    s3Client:
      options.s3Client ??
      createDefaultS3Client({
        endpoint: options.s3Endpoint ?? readEnvValue(env, "SP_ARTIFACT_S3_ENDPOINT") ?? undefined,
        forcePathStyle:
          options.s3ForcePathStyle ?? readBooleanEnv(env, "SP_ARTIFACT_S3_FORCE_PATH_STYLE", false),
        region: options.s3Region ?? readEnvValue(env, "SP_ARTIFACT_S3_REGION") ?? undefined,
      }),
    s3Endpoint: options.s3Endpoint ?? readEnvValue(env, "SP_ARTIFACT_S3_ENDPOINT") ?? "",
    s3ForcePathStyle:
      options.s3ForcePathStyle ?? readBooleanEnv(env, "SP_ARTIFACT_S3_FORCE_PATH_STYLE", false),
    s3Prefix: options.s3Prefix ?? readEnvValue(env, "SP_ARTIFACT_S3_PREFIX") ?? "",
    s3Region: options.s3Region ?? readEnvValue(env, "SP_ARTIFACT_S3_REGION") ?? "",
  };
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isS3Url(value: string): boolean {
  return value.startsWith("s3://");
}

function inferPrimaryReplicaProvider(
  artifact: Pick<PersistedArtifactRecord, "storagePath">,
  options: Pick<ResolvedArtifactPersistenceOptions, "ipfsProvider">,
): string {
  if (isIpfsUrl(artifact.storagePath)) {
    return providerNameForIpfsProvider(options.ipfsProvider);
  }
  if (isGcsUrl(artifact.storagePath)) {
    return "gcs";
  }
  if (isS3Url(artifact.storagePath)) {
    return "s3";
  }
  if (isHttpUrl(artifact.storagePath)) {
    return "http";
  }
  return "filesystem";
}

function normalizeObjectPrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, "");
}

function inferArtifactExtension(
  artifact: Pick<PersistedArtifactRecord, "contentType" | "storagePath">,
): string {
  const pathname = artifact.storagePath.replace(/^ipfs:\/\//, "");
  const ext = path.extname(pathname).replace(/^\./, "");
  if (ext) {
    return ext;
  }

  const normalizedContentType = artifact.contentType.split(";")[0]?.trim().toLowerCase();
  switch (normalizedContentType) {
    case "application/json":
      return "json";
    case "application/pdf":
      return "pdf";
    case "application/zip":
      return "zip";
    case "application/gzip":
      return "gz";
    case "text/markdown":
      return "md";
    case "text/plain":
      return "txt";
    default:
      return "bin";
  }
}

function getS3ObjectKey(input: PersistedArtifactInput, sha256: string, prefix: string): string {
  const normalizedPrefix = normalizeObjectPrefix(prefix);
  const suffix = `${input.kind}/${sha256}.${normalizeExtension(input.extension)}`;
  return normalizedPrefix ? `${normalizedPrefix}/${suffix}` : suffix;
}

function getGcsObjectKey(input: PersistedArtifactInput, sha256: string, prefix: string): string {
  const normalizedPrefix = normalizeObjectPrefix(prefix);
  const suffix = `${input.kind}/${sha256}.${normalizeExtension(input.extension)}`;
  return normalizedPrefix ? `${normalizedPrefix}/${suffix}` : suffix;
}

function createDefaultS3Client(input: {
  endpoint?: string;
  forcePathStyle?: boolean;
  region?: string;
}): S3LikeClient {
  const region = input.region ?? "us-east-1";
  return new S3Client({
    endpoint: input.endpoint,
    forcePathStyle: input.forcePathStyle,
    region,
  });
}

async function persistFilesystemArtifact(
  input: PersistedArtifactInput,
  root: string,
): Promise<PersistArtifactBackendResult> {
  const prepared = await prepareArtifactContent(input.content);
  const sha256 = prepared.sha256;
  const artifactKey = `${input.kind}-${sha256.slice(0, 16)}`;
  const directory = path.join(root, input.kind);
  const filePath = path.join(directory, `${sha256}.${normalizeExtension(input.extension)}`);

  await mkdir(directory, { recursive: true });
  try {
    await access(filePath);
  } catch {
    if (prepared.filePath) {
      await copyFile(prepared.filePath, filePath);
    } else {
      await writeFile(filePath, prepared.body ?? Buffer.alloc(0));
    }
  }

  return {
    record: {
      artifactKey,
      byteLength: prepared.byteLength,
      contentType: input.contentType,
      kind: input.kind,
      sha256: `0x${sha256}`,
      storagePath: filePath,
    },
  };
}

async function persistHttpArtifact(
  input: PersistedArtifactInput,
  baseUrl: string,
): Promise<PersistArtifactBackendResult> {
  if (!baseUrl) {
    throw new Error("http artifact backend requires SP_ARTIFACT_HTTP_BASE_URL");
  }

  const prepared = await prepareArtifactContent(input.content);
  const sha256 = prepared.sha256;
  const artifactKey = `${input.kind}-${sha256.slice(0, 16)}`;
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const objectUrl = `${normalizedBaseUrl}/${input.kind}/${sha256}.${normalizeExtension(input.extension)}`;
  const response = await fetch(objectUrl, {
    method: "PUT",
    headers: {
      "content-length": String(prepared.byteLength),
      "content-type": input.contentType,
      "x-content-sha256": `0x${sha256}`,
    },
    body: prepared.filePath
      ? (createReadStream(prepared.filePath) as unknown as BodyInit)
      : new Uint8Array(prepared.body ?? Buffer.alloc(0)),
    ...(prepared.filePath ? { duplex: "half" as const } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `http artifact persistence failed with status ${response.status} for ${objectUrl}`,
    );
  }

  return {
    record: {
      artifactKey,
      byteLength: prepared.byteLength,
      contentType: input.contentType,
      kind: input.kind,
      sha256: `0x${sha256}`,
      storagePath: objectUrl,
    },
  };
}

async function persistS3Artifact(
  input: PersistedArtifactInput,
  options: Pick<ResolvedArtifactPersistenceOptions, "s3Bucket" | "s3Client" | "s3Prefix">,
): Promise<PersistArtifactBackendResult> {
  if (!options.s3Bucket) {
    throw new Error("s3 artifact backend requires SP_ARTIFACT_S3_BUCKET");
  }

  const prepared = await prepareArtifactContent(input.content);
  const sha256 = prepared.sha256;
  const artifactKey = `${input.kind}-${sha256.slice(0, 16)}`;
  const objectKey = getS3ObjectKey(input, sha256, options.s3Prefix);
  await options.s3Client.send(
    new PutObjectCommand({
      Body: prepared.filePath ? createReadStream(prepared.filePath) : prepared.body,
      Bucket: options.s3Bucket,
      ContentLength: prepared.byteLength,
      ContentType: input.contentType,
      Key: objectKey,
      Metadata: {
        sha256: `0x${sha256}`,
      },
    }),
  );

  return {
    record: {
      artifactKey,
      byteLength: prepared.byteLength,
      contentType: input.contentType,
      kind: input.kind,
      sha256: `0x${sha256}`,
      storagePath: `s3://${options.s3Bucket}/${objectKey}`,
    },
  };
}

async function persistGcsArtifact(
  input: PersistedArtifactInput,
  options: Pick<ResolvedArtifactPersistenceOptions, "gcsBucket" | "gcsClient" | "gcsPrefix">,
): Promise<PersistArtifactBackendResult> {
  if (!options.gcsBucket) {
    throw new Error("gcs artifact backend requires SP_ARTIFACT_GCS_BUCKET");
  }

  const prepared = await prepareArtifactContent(input.content);
  const sha256 = prepared.sha256;
  const artifactKey = `${input.kind}-${sha256.slice(0, 16)}`;
  const objectKey = getGcsObjectKey(input, sha256, options.gcsPrefix);
  await options.gcsClient.saveObject({
    body: prepared.body,
    bucket: options.gcsBucket,
    contentType: input.contentType,
    filePath: prepared.filePath,
    key: objectKey,
    metadata: {
      sha256: `0x${sha256}`,
    },
  });

  return {
    record: {
      artifactKey,
      byteLength: prepared.byteLength,
      contentType: input.contentType,
      kind: input.kind,
      sha256: `0x${sha256}`,
      storagePath: `gs://${options.gcsBucket}/${objectKey}`,
    },
  };
}

async function persistIpfsArtifact(
  input: PersistedArtifactInput,
  options: Pick<ResolvedArtifactPersistenceOptions, "ipfsClient" | "ipfsPin">,
): Promise<PersistArtifactBackendResult> {
  const prepared = await prepareArtifactContent(input.content);
  const sha256 = prepared.sha256;
  const artifactKey = `${input.kind}-${sha256.slice(0, 16)}`;
  const filename = `${sha256}.${normalizeExtension(input.extension)}`;
  const result = await options.ipfsClient.addObject(
    ipfsWriteInput(prepared, input.contentType, filename, options.ipfsPin),
  );

  return {
    primaryReplicaProviderMetadata: result.providerMetadata ?? null,
    record: {
      artifactKey,
      byteLength: prepared.byteLength,
      contentType: input.contentType,
      kind: input.kind,
      sha256: `0x${sha256}`,
      storagePath: `ipfs://${result.cid}`,
    },
  };
}

export function buildPrimaryArtifactReplica(
  artifact: Pick<PersistedArtifactRecord, "storagePath">,
  options: ArtifactPersistenceOptions = {},
  providerMetadata: ArtifactReplicaProviderMetadata | null = null,
): PersistedArtifactReplicaRecord {
  const resolved = resolveArtifactPersistenceOptions(options);
  return {
    isPrimary: true,
    locator: artifact.storagePath,
    provider: inferPrimaryReplicaProvider(artifact, resolved),
    providerMetadata,
    replicaKey: "primary",
  };
}

async function replicateArtifactToIpfsTargets(
  record: PersistedArtifactRecord,
  input: PersistedArtifactInput,
  options: Pick<ResolvedArtifactPersistenceOptions, "ipfsReplicaTargets">,
): Promise<{
  audits: PersistedArtifactAuditRecord[];
  replicas: PersistedArtifactReplicaRecord[];
}> {
  const prepared = await prepareArtifactContent(input.content);
  const filename = `${record.sha256.replace(/^0x/i, "")}.${normalizeExtension(input.extension)}`;
  const audits: PersistedArtifactAuditRecord[] = [];
  const replicas: PersistedArtifactReplicaRecord[] = [];

  for (const target of options.ipfsReplicaTargets) {
    const provider = providerNameForIpfsProvider(target.provider ?? "kubo");
    try {
      const client = createReplicaClient(target);
      const result = await client.addObject(
        ipfsWriteInput(prepared, input.contentType, filename, true),
      );
      const locator = `ipfs://${result.cid}`;
      replicas.push({
        isPrimary: false,
        locator,
        provider,
        providerMetadata: result.providerMetadata ?? null,
        replicaKey: target.replicaKey,
      });
      audits.push({
        checkKind: "persist",
        checkedAt: new Date().toISOString(),
        locator,
        observedSha256: record.sha256,
        provider,
        replicaKey: target.replicaKey,
        status: "replicated",
      });
    } catch (error) {
      audits.push({
        checkKind: "persist",
        checkedAt: new Date().toISOString(),
        detail: error instanceof Error ? error.message : String(error),
        locator: null,
        provider,
        replicaKey: target.replicaKey,
        status: "replication_failed",
      });
    }
  }

  return { audits, replicas };
}

export async function persistArtifactReplicaToTarget(
  artifact: Pick<PersistedArtifactRecord, "contentType" | "sha256" | "storagePath">,
  content: ArtifactContent | ArtifactFileReference,
  target: ArtifactIpfsReplicaTarget,
): Promise<{
  audit: PersistedArtifactAuditRecord;
  replica: PersistedArtifactReplicaRecord;
}> {
  const prepared = await prepareArtifactContent(content);
  const filename = `${artifact.sha256.replace(/^0x/i, "")}.${inferArtifactExtension(artifact)}`;
  const provider = providerNameForIpfsProvider(target.provider ?? "kubo");
  const client = createReplicaClient(target);
  const result = await client.addObject(
    ipfsWriteInput(prepared, artifact.contentType, filename, true),
  );
  const locator = `ipfs://${result.cid}`;

  return {
    audit: {
      checkKind: "persist",
      checkedAt: new Date().toISOString(),
      locator,
      observedSha256: artifact.sha256,
      provider,
      replicaKey: target.replicaKey,
      status: "replicated",
    },
    replica: {
      isPrimary: false,
      locator,
      provider,
      providerMetadata: result.providerMetadata ?? null,
      replicaKey: target.replicaKey,
    },
  };
}

export async function persistArtifact(
  input: PersistedArtifactInput,
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactRecord> {
  const resolved = resolveArtifactPersistenceOptions(options);
  const persisted =
    resolved.backend === "filesystem"
      ? await persistFilesystemArtifact(input, resolved.filesystemRoot)
      : resolved.backend === "gcs"
        ? await persistGcsArtifact(input, resolved)
        : resolved.backend === "ipfs"
          ? await persistIpfsArtifact(input, resolved)
          : resolved.backend === "s3"
            ? await persistS3Artifact(input, resolved)
            : await persistHttpArtifact(input, resolved.httpBaseUrl);

  const primaryReplica = buildPrimaryArtifactReplica(
    persisted.record,
    resolved,
    persisted.primaryReplicaProviderMetadata ?? null,
  );
  const audits: PersistedArtifactAuditRecord[] = [
    {
      checkKind: "persist",
      checkedAt: new Date().toISOString(),
      locator: primaryReplica.locator,
      observedSha256: persisted.record.sha256,
      provider: primaryReplica.provider,
      replicaKey: primaryReplica.replicaKey,
      status: "replicated",
    },
  ];
  const replicas: PersistedArtifactReplicaRecord[] = [primaryReplica];

  if (resolved.ipfsReplicaTargets.length > 0) {
    const replicated = await replicateArtifactToIpfsTargets(persisted.record, input, resolved);
    audits.push(...replicated.audits);
    replicas.push(...replicated.replicas);
  }

  return {
    ...persisted.record,
    audits,
    replicas,
  };
}

export async function persistBinaryArtifact(
  kind: string,
  content: ArtifactContent | ArtifactFileReference,
  metadata: {
    contentType: string;
    extension: string;
  },
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactRecord> {
  return persistArtifact(
    {
      kind,
      content,
      contentType: metadata.contentType,
      extension: metadata.extension,
    },
    options,
  );
}

export async function persistFileArtifact(
  kind: string,
  filePath: string,
  metadata: {
    contentType: string;
    extension: string;
  },
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactRecord> {
  return persistArtifact(
    {
      kind,
      content: {
        filePath,
      },
      contentType: metadata.contentType,
      extension: metadata.extension,
    },
    options,
  );
}

export async function persistTextArtifact(
  kind: string,
  content: string,
  metadata: {
    contentType?: string;
    extension?: string;
  } = {},
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactRecord> {
  return persistBinaryArtifact(
    kind,
    content,
    {
      contentType: metadata.contentType ?? "text/plain; charset=utf-8",
      extension: metadata.extension ?? "txt",
    },
    options,
  );
}

export async function persistJsonArtifact(
  kind: string,
  payload: unknown,
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactRecord> {
  return persistBinaryArtifact(
    kind,
    `${JSON.stringify(payload, null, 2)}\n`,
    {
      contentType: "application/json",
      extension: "json",
    },
    options,
  );
}

async function readS3ArtifactBytes(
  artifact: Pick<PersistedArtifactRecord, "storagePath">,
  options: ArtifactPersistenceOptions,
): Promise<Buffer> {
  const resolved = resolveArtifactPersistenceOptions(options);
  const match = artifact.storagePath.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`invalid s3 artifact path: ${artifact.storagePath}`);
  }

  const response = (await resolved.s3Client.send(
    new GetObjectCommand({
      Bucket: match[1],
      Key: match[2],
    }),
  )) as {
    Body?: {
      arrayBuffer?: () => Promise<ArrayBuffer>;
      transformToByteArray?: () => Promise<Uint8Array>;
      transformToString?: () => Promise<string>;
    };
  };

  if (response.Body?.transformToByteArray) {
    return Buffer.from(await response.Body.transformToByteArray());
  }
  if (response.Body?.arrayBuffer) {
    return Buffer.from(await response.Body.arrayBuffer());
  }
  if (response.Body?.transformToString) {
    return Buffer.from(await response.Body.transformToString(), "utf8");
  }

  throw new Error(`s3 artifact retrieval returned no readable body for ${artifact.storagePath}`);
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "pipe" in value &&
    typeof (value as { pipe?: unknown }).pipe === "function"
  );
}

function readableFromWebStream(stream: ReadableStream<Uint8Array>): NodeJS.ReadableStream {
  const reader = stream.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
        if (result.value) {
          yield result.value;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Readable.from(chunks());
}

async function openS3ArtifactStream(
  artifact: Pick<PersistedArtifactRecord, "storagePath">,
  options: ArtifactPersistenceOptions,
): Promise<PersistedArtifactContentStream> {
  const resolved = resolveArtifactPersistenceOptions(options);
  const match = artifact.storagePath.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`invalid s3 artifact path: ${artifact.storagePath}`);
  }

  const response = (await resolved.s3Client.send(
    new GetObjectCommand({
      Bucket: match[1],
      Key: match[2],
    }),
  )) as {
    Body?:
      | {
          arrayBuffer?: () => Promise<ArrayBuffer>;
          transformToByteArray?: () => Promise<Uint8Array>;
          transformToString?: () => Promise<string>;
          transformToWebStream?: () => ReadableStream<Uint8Array>;
        }
      | NodeJS.ReadableStream;
    ContentLength?: number;
  };

  if (isNodeReadableStream(response.Body)) {
    return {
      contentLength: typeof response.ContentLength === "number" ? response.ContentLength : null,
      stream: response.Body,
    };
  }
  if (
    response.Body &&
    "transformToWebStream" in response.Body &&
    response.Body.transformToWebStream
  ) {
    return {
      contentLength: typeof response.ContentLength === "number" ? response.ContentLength : null,
      stream: readableFromWebStream(response.Body.transformToWebStream()),
    };
  }

  const bytes = await readS3ArtifactBytes(artifact, options);
  return {
    contentLength: bytes.byteLength,
    stream: Readable.from(bytes),
  };
}

async function openGcsArtifactStream(
  artifact: Pick<PersistedArtifactRecord, "byteLength" | "storagePath">,
  options: ArtifactPersistenceOptions,
): Promise<PersistedArtifactContentStream> {
  const resolved = resolveArtifactPersistenceOptions(options);
  const locator = parseGcsUrl(artifact.storagePath);
  if (resolved.gcsClient.openReadStream) {
    return resolved.gcsClient.openReadStream(locator);
  }
  const bytes = await resolved.gcsClient.readObject(locator);
  return {
    contentLength: bytes.byteLength,
    stream: Readable.from(bytes),
  };
}

async function openIpfsArtifactStream(
  artifact: Pick<PersistedArtifactRecord, "byteLength" | "storagePath">,
  options: ArtifactPersistenceOptions,
): Promise<PersistedArtifactContentStream> {
  const resolved = resolveArtifactPersistenceOptions(options);
  const locator = parseIpfsUrl(artifact.storagePath);
  if (resolved.ipfsClient.openReadStream) {
    return resolved.ipfsClient.openReadStream(locator);
  }
  const bytes = await resolved.ipfsClient.readObject(locator);
  return {
    contentLength: bytes.byteLength,
    stream: Readable.from(bytes),
  };
}

export async function openPersistedArtifactReadStream(
  artifact: Pick<PersistedArtifactRecord, "byteLength" | "storagePath">,
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactContentStream> {
  if (isHttpUrl(artifact.storagePath)) {
    const response = await fetch(artifact.storagePath);
    if (!response.ok) {
      throw new Error(
        `artifact retrieval failed with status ${response.status} for ${artifact.storagePath}`,
      );
    }
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        contentLength: bytes.byteLength,
        stream: Readable.from(bytes),
      };
    }
    const headerLength = response.headers.get("content-length");
    const parsedLength = headerLength ? Number(headerLength) : Number.NaN;
    return {
      contentLength: Number.isFinite(parsedLength) ? parsedLength : artifact.byteLength,
      stream: readableFromWebStream(response.body),
    };
  }

  if (isS3Url(artifact.storagePath)) {
    return openS3ArtifactStream(artifact, options);
  }

  if (isIpfsUrl(artifact.storagePath)) {
    return openIpfsArtifactStream(artifact, options);
  }

  if (isGcsUrl(artifact.storagePath)) {
    return openGcsArtifactStream(artifact, options);
  }

  const stats = await stat(artifact.storagePath);
  return {
    contentLength: stats.size,
    stream: createReadStream(artifact.storagePath),
  };
}

export async function openPersistedArtifactReplicaReadStream(
  replica: Pick<PersistedArtifactReplicaRecord, "locator" | "provider" | "replicaKey">,
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactContentStream> {
  if (!isIpfsUrl(replica.locator)) {
    return openPersistedArtifactReadStream(
      {
        byteLength: 0,
        storagePath: replica.locator,
      },
      options,
    );
  }

  const resolved = resolveArtifactPersistenceOptions(options);
  if (replica.replicaKey === "primary") {
    if (resolved.ipfsClient.openReadStream) {
      return resolved.ipfsClient.openReadStream(parseIpfsUrl(replica.locator));
    }
    const bytes = await resolved.ipfsClient.readObject(parseIpfsUrl(replica.locator));
    return {
      contentLength: bytes.byteLength,
      stream: Readable.from(bytes),
    };
  }

  const target = resolved.ipfsReplicaTargets.find(
    (entry) => entry.replicaKey === replica.replicaKey,
  );
  const client = target ? createReplicaClient(target) : resolved.ipfsClient;
  if (client.openReadStream) {
    return client.openReadStream(parseIpfsUrl(replica.locator));
  }
  const bytes = await client.readObject(parseIpfsUrl(replica.locator));
  return {
    contentLength: bytes.byteLength,
    stream: Readable.from(bytes),
  };
}

export async function readPersistedArtifactBytes(
  artifact: Pick<PersistedArtifactRecord, "storagePath">,
  options: ArtifactPersistenceOptions = {},
): Promise<Buffer> {
  if (isIpfsUrl(artifact.storagePath)) {
    const resolved = resolveArtifactPersistenceOptions(options);
    return resolved.ipfsClient.readObject(parseIpfsUrl(artifact.storagePath));
  }
  if (isHttpUrl(artifact.storagePath)) {
    const response = await fetch(artifact.storagePath);
    if (!response.ok) {
      throw new Error(
        `artifact retrieval failed with status ${response.status} for ${artifact.storagePath}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
  if (isGcsUrl(artifact.storagePath)) {
    const resolved = resolveArtifactPersistenceOptions(options);
    const locator = parseGcsUrl(artifact.storagePath);
    return resolved.gcsClient.readObject(locator);
  }
  if (isS3Url(artifact.storagePath)) {
    return readS3ArtifactBytes(artifact, options);
  }
  return readFile(artifact.storagePath);
}

export async function readPersistedArtifactReplicaBytes(
  replica: Pick<PersistedArtifactReplicaRecord, "locator" | "provider" | "replicaKey">,
  options: ArtifactPersistenceOptions = {},
): Promise<Buffer> {
  if (!isIpfsUrl(replica.locator)) {
    return readPersistedArtifactBytes({ storagePath: replica.locator }, options);
  }

  const resolved = resolveArtifactPersistenceOptions(options);
  if (replica.replicaKey === "primary") {
    return resolved.ipfsClient.readObject(parseIpfsUrl(replica.locator));
  }

  const target = resolved.ipfsReplicaTargets.find(
    (entry) => entry.replicaKey === replica.replicaKey,
  );
  if (!target) {
    return resolved.ipfsClient.readObject(parseIpfsUrl(replica.locator));
  }
  return createReplicaClient(target).readObject(parseIpfsUrl(replica.locator));
}

export async function readPersistedArtifactContent(
  artifact: Pick<PersistedArtifactRecord, "storagePath">,
  options: ArtifactPersistenceOptions = {},
): Promise<string> {
  return (await readPersistedArtifactBytes(artifact, options)).toString("utf8");
}

export async function verifyPersistedArtifact(
  artifact: Pick<PersistedArtifactRecord, "sha256" | "storagePath">,
  options: ArtifactPersistenceOptions = {},
): Promise<boolean> {
  const content = await openPersistedArtifactReadStream(
    {
      byteLength: 0,
      storagePath: artifact.storagePath,
    },
    options,
  );
  return (
    artifact.sha256.toLowerCase() === `0x${await sha256HexFromStream(content.stream)}`.toLowerCase()
  );
}

export async function auditPersistedArtifactReplicas(
  artifact: Pick<PersistedArtifactRecord, "replicas" | "sha256" | "storagePath">,
  options: ArtifactPersistenceOptions = {},
): Promise<PersistedArtifactAuditRecord[]> {
  const replicas =
    artifact.replicas && artifact.replicas.length > 0
      ? artifact.replicas
      : [buildPrimaryArtifactReplica(artifact, options)];

  return Promise.all(
    replicas.map(async (replica) => {
      try {
        const content = await openPersistedArtifactReplicaReadStream(replica, options);
        const observedSha256 = `0x${await sha256HexFromStream(content.stream)}`;
        if (observedSha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
          return {
            checkKind: "verify" as const,
            checkedAt: new Date().toISOString(),
            detail: `expected ${artifact.sha256}, found ${observedSha256}`,
            locator: replica.locator,
            observedSha256,
            provider: replica.provider,
            replicaKey: replica.replicaKey,
            status: "hash_mismatch" as const,
          };
        }

        return {
          checkKind: "verify" as const,
          checkedAt: new Date().toISOString(),
          locator: replica.locator,
          observedSha256,
          provider: replica.provider,
          replicaKey: replica.replicaKey,
          status: "verified" as const,
        };
      } catch (error) {
        return {
          checkKind: "verify" as const,
          checkedAt: new Date().toISOString(),
          detail: error instanceof Error ? error.message : String(error),
          locator: replica.locator,
          provider: replica.provider,
          replicaKey: replica.replicaKey,
          status: "unreachable" as const,
        };
      }
    }),
  );
}

export async function readVerifiedJsonArtifact<T>(
  artifact: Pick<PersistedArtifactRecord, "sha256" | "storagePath">,
  options: ArtifactPersistenceOptions = {},
): Promise<T> {
  const content = await readPersistedArtifactBytes(artifact, options);
  const actualHash = `0x${sha256Hex(content)}`;
  if (actualHash.toLowerCase() !== artifact.sha256.toLowerCase()) {
    throw new Error(
      `artifact integrity check failed for ${artifact.storagePath}: expected ${artifact.sha256}, found ${actualHash}`,
    );
  }
  try {
    return JSON.parse(content.toString("utf8")) as T;
  } catch (error) {
    throw new Error(
      `artifact JSON parse failed for ${artifact.storagePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
