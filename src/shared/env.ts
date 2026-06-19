import { hasConfiguredEnvValue, hasSecretRef, readEnvValue } from "./secrets.js";

const LOCAL_RPC_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "localhost", "hardhat"]);

function parseUrl(raw: string, label: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
}

function parseOptionalUrl(raw: string | undefined, label: string): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  return parseUrl(trimmed, label);
}

function parseOptionalHttpUrl(raw: string | undefined, label: string): URL | null {
  const parsed = parseOptionalUrl(raw, label);
  if (!parsed) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return parsed;
}

function hasValueOrSecretRef(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(readEnvValue(env, key) || hasSecretRef(env, key));
}

function readEnvValueOrSecretRefPlaceholder(
  env: NodeJS.ProcessEnv,
  key: string,
  placeholder: string,
): string | undefined {
  return readEnvValue(env, key) ?? (hasSecretRef(env, key) ? placeholder : undefined);
}

function parseOptionalNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  const parsed = parseOptionalNonNegativeInteger(raw, fallback, label);
  if (parsed < 1) {
    throw new Error(`${label} must be an integer greater than or equal to 1`);
  }
  return parsed;
}

function parseOptionalBoolean(raw: string | undefined, fallback: boolean, label: string): boolean {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  throw new Error(`${label} must be true or false`);
}

function parseOptionalEnum<const Value extends string>(
  raw: string | undefined,
  fallback: Value,
  label: string,
  values: readonly Value[],
): Value {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  if ((values as readonly string[]).includes(trimmed)) {
    return trimmed as Value;
  }
  throw new Error(`${label} must be one of: ${values.join(", ")}`);
}

function parseOptionalJsonArray(
  raw: string | undefined,
  label: string,
): Array<Record<string, unknown>> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function readOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} must be a string`);
  }
  return value;
}

export function parseOptionalAddressCsv(raw: string | undefined, label: string): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  const seen = new Set<string>();
  return trimmed.split(",").map((entry, index) => {
    const value = entry.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
      throw new Error(`${label}[${index}] must be a 20-byte hex address`);
    }
    const canonical = value.toLowerCase();
    if (seen.has(canonical)) {
      throw new Error(`${label}[${index}] duplicates an earlier address`);
    }
    seen.add(canonical);
    return value;
  });
}

export function isLocalDevelopmentRpcUrl(rpcUrl: string): boolean {
  const parsed = parseUrl(rpcUrl, "SP_RPC_URL");
  return (
    parsed.protocol === "http:" && parsed.port === "8545" && LOCAL_RPC_HOSTS.has(parsed.hostname)
  );
}

export function validateRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env): {
  artifactBackend: "filesystem" | "http" | "s3" | "gcs" | "ipfs";
  databaseUrl: string;
  rpcUrl: string;
} {
  const databaseUrl =
    readEnvValueOrSecretRefPlaceholder(
      env,
      "SP_DATABASE_URL",
      "postgresql://secret-ref@localhost/scientific_protocol",
    ) ?? "postgresql://postgres@127.0.0.1:5432/scientific_protocol";
  const rpcUrl =
    readEnvValueOrSecretRefPlaceholder(env, "SP_RPC_URL", "https://secret-ref.invalid") ??
    "http://127.0.0.1:8545";
  const artifactBackend = parseOptionalEnum(
    readEnvValue(env, "SP_ARTIFACT_BACKEND"),
    "filesystem",
    "SP_ARTIFACT_BACKEND",
    ["filesystem", "http", "ipfs", "s3", "gcs"] as const,
  );

  parseUrl(databaseUrl, "SP_DATABASE_URL");
  parseUrl(rpcUrl, "SP_RPC_URL");
  parseOptionalHttpUrl(readEnvValue(env, "SP_PUBLIC_BASE_URL"), "SP_PUBLIC_BASE_URL");

  const publicDomain = readEnvValue(env, "SP_PUBLIC_DOMAIN");
  if (publicDomain && (/^https?:\/\//.test(publicDomain) || publicDomain.includes("/"))) {
    throw new Error("SP_PUBLIC_DOMAIN must be a bare hostname, not a URL");
  }

  parseOptionalNonNegativeInteger(
    readEnvValue(env, "SP_PUBLIC_RATE_LIMIT_WINDOW_MS"),
    60_000,
    "SP_PUBLIC_RATE_LIMIT_WINDOW_MS",
  );
  parseOptionalNonNegativeInteger(
    readEnvValue(env, "SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS"),
    20,
    "SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS",
  );
  parseOptionalNonNegativeInteger(
    readEnvValue(env, "SP_ADMIN_RATE_LIMIT_WINDOW_MS"),
    60_000,
    "SP_ADMIN_RATE_LIMIT_WINDOW_MS",
  );
  parseOptionalNonNegativeInteger(
    readEnvValue(env, "SP_ADMIN_RATE_LIMIT_MAX_REQUESTS"),
    10,
    "SP_ADMIN_RATE_LIMIT_MAX_REQUESTS",
  );
  parseOptionalBoolean(readEnvValue(env, "SP_TRUST_PROXY"), false, "SP_TRUST_PROXY");
  parseOptionalPositiveInteger(
    readEnvValue(env, "SP_DATABASE_POOL_MAX"),
    10,
    "SP_DATABASE_POOL_MAX",
  );
  parseOptionalNonNegativeInteger(
    readEnvValue(env, "SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS"),
    10_000,
    "SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS",
  );
  parseOptionalNonNegativeInteger(
    readEnvValue(env, "SP_DATABASE_POOL_IDLE_TIMEOUT_MS"),
    30_000,
    "SP_DATABASE_POOL_IDLE_TIMEOUT_MS",
  );
  const sandboxAdminRoutesEnabled = parseOptionalBoolean(
    readEnvValue(env, "SP_ENABLE_SANDBOX_ADMIN_ROUTES"),
    false,
    "SP_ENABLE_SANDBOX_ADMIN_ROUTES",
  );
  parseOptionalAddressCsv(
    readEnvValue(env, "SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES"),
    "SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES",
  );

  if (artifactBackend === "http") {
    parseUrl(
      readEnvValueOrSecretRefPlaceholder(
        env,
        "SP_ARTIFACT_HTTP_BASE_URL",
        "https://secret-ref.invalid",
      ) ?? "",
      "SP_ARTIFACT_HTTP_BASE_URL",
    );
  } else if (artifactBackend === "ipfs") {
    const provider = parseOptionalEnum(
      readEnvValue(env, "SP_ARTIFACT_IPFS_PROVIDER"),
      "kubo",
      "SP_ARTIFACT_IPFS_PROVIDER",
      ["kubo", "pinata"] as const,
    );
    if (provider === "pinata") {
      if (!hasValueOrSecretRef(env, "SP_ARTIFACT_PINATA_JWT")) {
        throw new Error("SP_ARTIFACT_PINATA_JWT is required when SP_ARTIFACT_IPFS_PROVIDER=pinata");
      }
      parseOptionalUrl(
        readEnvValue(env, "SP_ARTIFACT_PINATA_API_URL"),
        "SP_ARTIFACT_PINATA_API_URL",
      );
      parseOptionalUrl(
        readEnvValue(env, "SP_ARTIFACT_PINATA_GATEWAY_URL"),
        "SP_ARTIFACT_PINATA_GATEWAY_URL",
      );
      parseOptionalEnum(
        readEnvValue(env, "SP_ARTIFACT_PINATA_NETWORK"),
        "public",
        "SP_ARTIFACT_PINATA_NETWORK",
        ["public", "private"] as const,
      );
    } else {
      parseUrl(
        readEnvValueOrSecretRefPlaceholder(
          env,
          "SP_ARTIFACT_IPFS_API_URL",
          "https://secret-ref.invalid",
        ) ?? "",
        "SP_ARTIFACT_IPFS_API_URL",
      );
      parseOptionalUrl(
        readEnvValue(env, "SP_ARTIFACT_IPFS_GATEWAY_URL"),
        "SP_ARTIFACT_IPFS_GATEWAY_URL",
      );
    }
    const headerName = readEnvValue(env, "SP_ARTIFACT_IPFS_AUTH_HEADER_NAME");
    const hasHeaderValue = hasValueOrSecretRef(env, "SP_ARTIFACT_IPFS_AUTH_HEADER_VALUE");
    if ((headerName && !hasHeaderValue) || (!headerName && hasHeaderValue)) {
      throw new Error(
        "SP_ARTIFACT_IPFS_AUTH_HEADER_NAME and SP_ARTIFACT_IPFS_AUTH_HEADER_VALUE must be set together",
      );
    }

    const replicaTargets = parseOptionalJsonArray(
      readEnvValue(env, "SP_ARTIFACT_IPFS_REPLICA_TARGETS"),
      "SP_ARTIFACT_IPFS_REPLICA_TARGETS",
    );
    const replicaKeys = new Set<string>();
    for (const [index, target] of replicaTargets.entries()) {
      const replicaKey = String(target.replicaKey ?? "").trim();
      if (!replicaKey) {
        throw new Error(`SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].replicaKey is required`);
      }
      if (replicaKey === "primary") {
        throw new Error("artifact replica key 'primary' is reserved");
      }
      if (replicaKeys.has(replicaKey)) {
        throw new Error(`duplicate artifact replica key: ${replicaKey}`);
      }
      replicaKeys.add(replicaKey);

      const replicaProvider = parseOptionalEnum(
        readOptionalStringField(target, "provider", `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}]`),
        "kubo",
        `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].provider`,
        ["kubo", "pinata"] as const,
      );
      if (replicaProvider === "pinata") {
        const jwt = String(target.pinataJwt ?? "").trim();
        if (!jwt) {
          throw new Error(
            `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].pinataJwt is required for pinata targets`,
          );
        }
        if (typeof target.pinataApiUrl === "string") {
          parseUrl(target.pinataApiUrl, `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].pinataApiUrl`);
        }
        if (typeof target.pinataGatewayUrl === "string") {
          parseUrl(
            target.pinataGatewayUrl,
            `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].pinataGatewayUrl`,
          );
        }
      } else {
        const apiUrl = String(target.apiUrl ?? "").trim();
        if (!apiUrl) {
          throw new Error(
            `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].apiUrl is required for kubo targets`,
          );
        }
        parseUrl(apiUrl, `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].apiUrl`);
        if (typeof target.gatewayUrl === "string" && target.gatewayUrl.trim() !== "") {
          parseUrl(target.gatewayUrl, `SP_ARTIFACT_IPFS_REPLICA_TARGETS[${index}].gatewayUrl`);
        }
      }
    }
  } else if (artifactBackend === "gcs") {
    if (!hasValueOrSecretRef(env, "SP_ARTIFACT_GCS_BUCKET")) {
      throw new Error("SP_ARTIFACT_GCS_BUCKET is required when SP_ARTIFACT_BACKEND=gcs");
    }
  } else if (artifactBackend === "s3") {
    if (!hasValueOrSecretRef(env, "SP_ARTIFACT_S3_BUCKET")) {
      throw new Error("SP_ARTIFACT_S3_BUCKET is required when SP_ARTIFACT_BACKEND=s3");
    }
    if (!hasValueOrSecretRef(env, "SP_ARTIFACT_S3_REGION")) {
      throw new Error("SP_ARTIFACT_S3_REGION is required when SP_ARTIFACT_BACKEND=s3");
    }
    const s3Endpoint = readEnvValue(env, "SP_ARTIFACT_S3_ENDPOINT");
    if (s3Endpoint) {
      parseUrl(s3Endpoint, "SP_ARTIFACT_S3_ENDPOINT");
    }
  } else if (artifactBackend !== "filesystem") {
    throw new Error(`unsupported SP_ARTIFACT_BACKEND: ${artifactBackend}`);
  }

  if (!isLocalDevelopmentRpcUrl(rpcUrl)) {
    const hasOperatorKey = [
      "SP_PROTOCOL_ADMIN_PRIVATE_KEY",
      "SP_CLAIM_AUTHOR_PRIVATE_KEY",
      "SP_REPLICATOR_PRIVATE_KEY",
      "SP_AGENT_OPERATOR_PRIVATE_KEY",
      "SP_OPERATOR_PRIVATE_KEY",
      "SP_REPLICATION_SUBMITTER_PRIVATE_KEY",
      "SP_RESOLVER_PRIVATE_KEY",
      "SP_CHECKPOINT_PUBLISHER_PRIVATE_KEY",
    ].some((key) => hasConfiguredEnvValue(env, key));
    if (!hasOperatorKey) {
      throw new Error(
        "remote RPC detected; set explicit protocol or operator private keys instead of relying on local deterministic defaults",
      );
    }
    if (sandboxAdminRoutesEnabled && !hasValueOrSecretRef(env, "SP_DEMO_ADMIN_TOKEN")) {
      throw new Error(
        "SP_DEMO_ADMIN_TOKEN is required when SP_ENABLE_SANDBOX_ADMIN_ROUTES=true on a remote runtime",
      );
    }
  }

  return {
    artifactBackend,
    databaseUrl,
    rpcUrl,
  };
}
