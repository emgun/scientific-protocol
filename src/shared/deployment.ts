import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAddress } from "ethers";
import { type EnvRecord, readEnvValue } from "./secrets.js";

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

export type DeploymentOperators = {
  deployer: string;
  claimSubmitter: string;
  replicationSubmitter: string;
  resolverOperator: string;
  checkpointPublisher: string;
};

export type DeploymentFile = {
  network: string;
  chainId: number;
  deploymentBlock: number;
  deployedAt: string;
  addresses: DeploymentAddresses;
  operators: DeploymentOperators;
  parameters: {
    minimumAuthorBondWei: string;
  };
};

export const DEFAULT_DEPLOYMENT_PATH = path.resolve(process.cwd(), "ops", "local.addresses.json");

export function getDeploymentPath(env: EnvRecord = process.env): string {
  return readEnvValue(env, "SP_DEPLOYMENT_PATH") ?? DEFAULT_DEPLOYMENT_PATH;
}

type DeploymentFileOptions = {
  env?: EnvRecord;
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
  readObject(input: GcsObjectLocator): Promise<string | Uint8Array>;
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
  throw new Error("gs:// deployment paths require DeploymentFileOptions.gcsClient");
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

const DEPLOYMENT_OPERATOR_KEYS = [
  "deployer",
  "claimSubmitter",
  "replicationSubmitter",
  "resolverOperator",
  "checkpointPublisher",
] as const satisfies readonly (keyof DeploymentOperators)[];

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
  const parameters = recordLike(record.parameters);
  if (!parameters) {
    throw new Error(`deployment file from ${source} is missing parameters`);
  }
  const operators = recordLike(record.operators);
  if (!operators) {
    throw new Error(`deployment file from ${source} is missing operators`);
  }
  const minimumAuthorBondWei = requireString(parameters, "minimumAuthorBondWei", source);
  if (!/^\d+$/u.test(minimumAuthorBondWei)) {
    throw new Error(`deployment file from ${source} has invalid minimumAuthorBondWei`);
  }
  for (const key of DEPLOYMENT_ADDRESS_KEYS) {
    const address = requireString(addresses, key, source);
    if (!isAddress(address)) {
      throw new Error(`deployment file from ${source} has invalid address for ${key}`);
    }
  }
  for (const key of DEPLOYMENT_OPERATOR_KEYS) {
    const address = requireString(operators, key, source);
    if (!isAddress(address)) {
      throw new Error(`deployment file from ${source} has invalid operator address for ${key}`);
    }
  }
  const operatorAddresses = DEPLOYMENT_OPERATOR_KEYS.map((key) =>
    (operators[key] as string).toLowerCase(),
  );
  if (new Set(operatorAddresses).size !== operatorAddresses.length) {
    throw new Error(`deployment file from ${source} has duplicate operator addresses`);
  }

  return {
    addresses: Object.fromEntries(
      DEPLOYMENT_ADDRESS_KEYS.map((key) => [key, addresses[key] as string]),
    ) as DeploymentAddresses,
    chainId: requireNonNegativeInteger(record, "chainId", source),
    deployedAt: requireTimestamp(record, "deployedAt", source),
    deploymentBlock: requireNonNegativeInteger(record, "deploymentBlock", source),
    network: requireString(record, "network", source),
    operators: Object.fromEntries(
      DEPLOYMENT_OPERATOR_KEYS.map((key) => [key, operators[key] as string]),
    ) as DeploymentOperators,
    parameters: { minimumAuthorBondWei },
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
    const object = await gcsClient.readObject(locator);
    const content = typeof object === "string" ? object : new TextDecoder().decode(object);
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
        minimumAuthorBondWei: deployment.parameters.minimumAuthorBondWei,
        network: deployment.network,
        deployer: deployment.operators.deployer,
        claimSubmitter: deployment.operators.claimSubmitter,
        replicationSubmitter: deployment.operators.replicationSubmitter,
        resolverOperator: deployment.operators.resolverOperator,
        checkpointPublisher: deployment.operators.checkpointPublisher,
      },
    });
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serialized);
}
