import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAddress } from "ethers";
import { readEnvValue } from "./secrets.js";

export type DeploymentAddresses = {
  accessController: string;
  protocolParameters: string;
  protocolGovernanceToken: string;
  protocolTimelock: string;
  protocolGovernor: string;
  protocolTreasury: string;
  resolutionModuleRegistry: string;
  claimRegistry: string;
  artifactRegistry: string;
  bondEscrow: string;
  claimRewardVault: string;
  agentRegistry: string;
  replicationRegistry: string;
  reputationCheckpointRegistry: string;
  epistemicMarket: string;
  appealsRegistry: string;
  computationalModule: string;
  benchmarkModule: string;
  wetLabModule: string;
};

export type DeploymentFile = {
  network: string;
  chainId: number;
  deploymentBlock: number;
  deployedAt: string;
  addresses: DeploymentAddresses;
};

export const DEFAULT_DEPLOYMENT_PATH = path.resolve(process.cwd(), "ops", "local.addresses.json");

export function getDeploymentPath(env: NodeJS.ProcessEnv = process.env): string {
  return readEnvValue(env, "SP_DEPLOYMENT_PATH") ?? DEFAULT_DEPLOYMENT_PATH;
}

type DeploymentFileOptions = {
  env?: NodeJS.ProcessEnv;
  gcsClient?: GcsLikeClient;
};

type GcsObjectLocator = {
  bucket: string;
  key: string;
};

type GcsLikeClient = {
  saveObject(
    input: GcsObjectLocator & {
      body?: string | Uint8Array;
      contentType: string;
      metadata?: Record<string, string>;
    },
  ): Promise<void>;
  readObject(input: GcsObjectLocator): Promise<Buffer>;
  objectExists(input: GcsObjectLocator): Promise<boolean>;
};

function isGcsUrl(value: string): boolean {
  return value.startsWith("gs://");
}

function parseGcsUrl(value: string): GcsObjectLocator {
  const match = value.match(/^gs:\/\/([^/]+)\/(.+)$/u);
  if (!match) {
    throw new Error(`invalid gcs path: ${value}`);
  }
  return { bucket: match[1], key: match[2] };
}

async function resolveDeploymentGcsClient(options: DeploymentFileOptions): Promise<GcsLikeClient> {
  if (options.gcsClient) {
    return options.gcsClient;
  }
  const { createDefaultGcsClient } = await import("./gcs.js");
  return createDefaultGcsClient();
}

const DEPLOYMENT_ADDRESS_KEYS = [
  "accessController",
  "agentRegistry",
  "appealsRegistry",
  "artifactRegistry",
  "benchmarkModule",
  "bondEscrow",
  "claimRegistry",
  "claimRewardVault",
  "computationalModule",
  "epistemicMarket",
  "protocolGovernor",
  "protocolGovernanceToken",
  "protocolParameters",
  "protocolTimelock",
  "protocolTreasury",
  "replicationRegistry",
  "reputationCheckpointRegistry",
  "resolutionModuleRegistry",
  "wetLabModule",
] as const satisfies readonly (keyof DeploymentAddresses)[];

function recordLike(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`deployment file from ${source} is missing ${key}`);
  }
  return value;
}

function requireNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  source: string,
): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`deployment file from ${source} has invalid ${key}`);
  }
  return value as number;
}

function requireTimestamp(record: Record<string, unknown>, key: string, source: string): string {
  const value = requireString(record, key, source);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`deployment file from ${source} has invalid ${key}`);
  }
  return value;
}

function validateDeploymentFile(value: unknown, source: string): DeploymentFile {
  const record = recordLike(value);
  if (!record) {
    throw new Error(`deployment file from ${source} must be an object`);
  }
  const addresses = recordLike(record.addresses);
  if (!addresses) {
    throw new Error(`deployment file from ${source} is missing addresses`);
  }
  for (const key of DEPLOYMENT_ADDRESS_KEYS) {
    const address = requireString(addresses, key, source);
    if (!isAddress(address)) {
      throw new Error(`deployment file from ${source} has invalid address for ${key}`);
    }
  }

  return {
    addresses: Object.fromEntries(
      DEPLOYMENT_ADDRESS_KEYS.map((key) => [key, addresses[key] as string]),
    ) as DeploymentAddresses,
    chainId: requireNonNegativeInteger(record, "chainId", source),
    deployedAt: requireTimestamp(record, "deployedAt", source),
    deploymentBlock: requireNonNegativeInteger(record, "deploymentBlock", source),
    network: requireString(record, "network", source),
  };
}

function parseDeploymentJson(raw: string, source: string): DeploymentFile {
  try {
    return validateDeploymentFile(JSON.parse(raw), source);
  } catch (error) {
    throw new Error(
      `failed to parse deployment file from ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function deploymentFileExists(
  filePath = DEFAULT_DEPLOYMENT_PATH,
  options: DeploymentFileOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const inline = readEnvValue(env, "SP_DEPLOYMENT_JSON");
  if (inline) {
    return true;
  }
  if (isGcsUrl(filePath)) {
    const gcsClient = await resolveDeploymentGcsClient(options);
    const locator = parseGcsUrl(filePath);
    return gcsClient.objectExists(locator);
  }
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadDeploymentFile(
  filePath = DEFAULT_DEPLOYMENT_PATH,
  options: DeploymentFileOptions = {},
): Promise<DeploymentFile> {
  const env = options.env ?? process.env;
  const inline = readEnvValue(env, "SP_DEPLOYMENT_JSON");
  if (inline) {
    return parseDeploymentJson(inline, "SP_DEPLOYMENT_JSON");
  }
  if (isGcsUrl(filePath)) {
    const gcsClient = await resolveDeploymentGcsClient(options);
    const locator = parseGcsUrl(filePath);
    const content = (await gcsClient.readObject(locator)).toString("utf8");
    return parseDeploymentJson(content, filePath);
  }
  return parseDeploymentJson(await readFile(filePath, "utf8"), filePath);
}

export async function saveDeploymentFile(
  deployment: DeploymentFile,
  filePath = DEFAULT_DEPLOYMENT_PATH,
  options: DeploymentFileOptions = {},
): Promise<void> {
  const serialized = `${JSON.stringify(deployment, null, 2)}\n`;
  if (isGcsUrl(filePath)) {
    const gcsClient = await resolveDeploymentGcsClient(options);
    const locator = parseGcsUrl(filePath);
    await gcsClient.saveObject({
      ...locator,
      body: serialized,
      contentType: "application/json",
      metadata: {
        chainId: String(deployment.chainId),
        deploymentBlock: String(deployment.deploymentBlock),
        network: deployment.network,
      },
    });
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serialized);
}
