import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type Contract,
  ContractFactory,
  type ContractRunner,
  keccak256,
  parseEther,
  parseUnits,
  toUtf8Bytes,
  ZeroAddress,
} from "ethers";
import {
  type DeployableContractName,
  deployableContractArtifacts,
} from "../src/generated/contracts.js";
import { isCliEntrypoint, readOptionalTrimmedEnv } from "../src/shared/cli.js";
import { getProvider, getRpcUrl } from "../src/shared/contracts.js";
import { getDeploymentPath, saveDeploymentFile } from "../src/shared/deployment.js";
import { isGcsUrl } from "../src/shared/gcs.js";
import { createManagedOperatorSigner } from "../src/shared/operator.js";
import { readEnvValue } from "../src/shared/secrets.js";

const ROLE = (name: string) => keccak256(toUtf8Bytes(name));

const DEPLOYMENT_ARTIFACTS = {
  AccessController: deployableContractArtifacts.AccessController,
  AgentRegistry: deployableContractArtifacts.AgentRegistry,
  AppealsRegistry: deployableContractArtifacts.AppealsRegistry,
  ArtifactRegistry: deployableContractArtifacts.ArtifactRegistry,
  BenchmarkResolutionModule: deployableContractArtifacts.BenchmarkResolutionModule,
  BondEscrow: deployableContractArtifacts.BondEscrow,
  ClaimRewardVault: deployableContractArtifacts.ClaimRewardVault,
  ClaimRegistry: deployableContractArtifacts.ClaimRegistry,
  ComputationalResolutionModule: deployableContractArtifacts.ComputationalResolutionModule,
  EpistemicMarket: deployableContractArtifacts.EpistemicMarket,
  ProtocolGovernanceToken: deployableContractArtifacts.ProtocolGovernanceToken,
  ProtocolGovernor: deployableContractArtifacts.ProtocolGovernor,
  ProtocolParameters: deployableContractArtifacts.ProtocolParameters,
  ProtocolTimelock: deployableContractArtifacts.ProtocolTimelock,
  ProtocolTreasury: deployableContractArtifacts.ProtocolTreasury,
  ReplicationRegistry: deployableContractArtifacts.ReplicationRegistry,
  ReputationCheckpointRegistry: deployableContractArtifacts.ReputationCheckpointRegistry,
  ResolutionModuleRegistry: deployableContractArtifacts.ResolutionModuleRegistry,
  WetLabResolutionModule: deployableContractArtifacts.WetLabResolutionModule,
} as const satisfies Record<string, (typeof deployableContractArtifacts)[DeployableContractName]>;

type ArtifactName = keyof typeof DEPLOYMENT_ARTIFACTS;
type UntypedContract = Contract & Record<string, any>;

export const LOCAL_DEPLOYMENT_BOOTSTRAP_ROLES = [
  "CLAIM_SUBMITTER_ROLE",
  "PARAMETER_ADMIN_ROLE",
  "RESOLVER_ROLE",
  "CHECKPOINT_PUBLISHER_ROLE",
  "MODULE_ADMIN_ROLE",
  "BOUNTY_SETTLER_ROLE",
  "AGENT_BUDGET_MANAGER_ROLE",
  "MARKET_SETTLER_ROLE",
  "REWARD_SETTLER_ROLE",
  "COURT_ROLE",
  "PAUSER_ROLE",
] as const;

export const RESOLVER_OPERATOR_ROLES = [
  "RESOLVER_ROLE",
  "BOUNTY_SETTLER_ROLE",
  "AGENT_BUDGET_MANAGER_ROLE",
  "MARKET_SETTLER_ROLE",
  "REWARD_SETTLER_ROLE",
  "COURT_ROLE",
  "PAUSER_ROLE",
] as const;

export const CLAIM_SUBMITTER_OPERATOR_ROLES = ["CLAIM_SUBMITTER_ROLE"] as const;

export const CHECKPOINT_OPERATOR_ROLES = [
  "CHECKPOINT_PUBLISHER_ROLE",
  "REWARD_SETTLER_ROLE",
] as const;

export const TIMELOCK_MANAGED_ROLES = [
  "PARAMETER_ADMIN_ROLE",
  "MODULE_ADMIN_ROLE",
  "ESCROW_ADMIN_ROLE",
] as const;

export const PRODUCTION_DEPLOYMENT_KEY_ENV_KEYS = [
  "SP_PROTOCOL_ADMIN_PRIVATE_KEY",
  "SP_CLAIM_SUBMITTER_PRIVATE_KEY",
  "SP_REPLICATION_SUBMITTER_PRIVATE_KEY",
  "SP_RESOLVER_PRIVATE_KEY",
  "SP_CHECKPOINT_PUBLISHER_PRIVATE_KEY",
] as const;

export type DeploymentSignerAddresses = {
  admin: string;
  claimSubmitter: string;
  checkpointPublisher: string;
  replicationSubmitter: string;
  resolver: string;
};

export function validateDeploymentSignerTopology(
  chainId: bigint,
  env: NodeJS.ProcessEnv,
  addresses?: DeploymentSignerAddresses,
): void {
  if (chainId === 31337n) {
    return;
  }

  const missingKeys = PRODUCTION_DEPLOYMENT_KEY_ENV_KEYS.filter((key) => !readEnvValue(env, key));
  if (missingKeys.length > 0) {
    throw new Error(
      `remote deployments require dedicated signer keys; missing ${missingKeys.join(", ")}`,
    );
  }
  if (!addresses) {
    return;
  }

  const labelsByAddress = new Map<string, string[]>();
  for (const [label, address] of Object.entries(addresses)) {
    const normalized = address.toLowerCase();
    labelsByAddress.set(normalized, [...(labelsByAddress.get(normalized) ?? []), label]);
  }
  const collisions = [...labelsByAddress.values()].filter((labels) => labels.length > 1);
  if (collisions.length > 0) {
    throw new Error(
      `remote deployment signer addresses must be distinct; collisions: ${collisions
        .map((labels) => labels.join("/"))
        .join(", ")}`,
    );
  }
}

function getContractFactory(name: ArtifactName, signer: ContractRunner): ContractFactory {
  const artifact = DEPLOYMENT_ARTIFACTS[name];
  return new ContractFactory(artifact.abi, artifact.bytecode, signer);
}

function getEnvUint(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const value = readOptionalTrimmedEnv(env, name);
  if (!value) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer greater than or equal to 0`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new Error(`${name} must be an integer greater than or equal to 0`);
  }
  return parsed;
}

export type LocalGovernanceDeploymentConfig = {
  bootstrapVoteAmount: bigint;
  governanceTokenName: string;
  governanceTokenSymbol: string;
  proposalThreshold: bigint;
  quorumNumerator: bigint;
  timelockDelaySeconds: bigint;
  treasuryBootstrapEth: bigint;
  votingDelayBlocks: bigint;
  votingPeriodBlocks: bigint;
};

export function resolveMinimumAuthorBondWei(
  env: NodeJS.ProcessEnv = process.env,
  options: { localDevelopment?: boolean } = {},
): bigint {
  const wei = readOptionalTrimmedEnv(env, "SP_MIN_AUTHOR_BOND_WEI");
  const ether = readOptionalTrimmedEnv(env, "SP_MIN_AUTHOR_BOND_ETH");
  if (wei && ether) {
    throw new Error("configure only one of SP_MIN_AUTHOR_BOND_WEI or SP_MIN_AUTHOR_BOND_ETH");
  }
  if (!wei && !ether && !options.localDevelopment) {
    throw new Error("remote deployments require SP_MIN_AUTHOR_BOND_WEI or SP_MIN_AUTHOR_BOND_ETH");
  }
  const value = wei ? getEnvUint(env, "SP_MIN_AUTHOR_BOND_WEI", 0n) : parseEther(ether ?? "0.005");
  if (value < 0n) {
    throw new Error("minimum author bond cannot be negative");
  }
  if (value === 0n && !options.localDevelopment) {
    throw new Error("remote deployments require a nonzero minimum author bond");
  }
  return value;
}

export function resolveLocalGovernanceDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): LocalGovernanceDeploymentConfig {
  return {
    bootstrapVoteAmount: parseUnits(
      readOptionalTrimmedEnv(env, "SP_GOVERNANCE_BOOTSTRAP_VOTE_AMOUNT") ?? "100",
      18,
    ),
    governanceTokenName:
      readOptionalTrimmedEnv(env, "SP_GOVERNANCE_TOKEN_NAME") ??
      "Scientific Protocol Governance Vote",
    governanceTokenSymbol: readOptionalTrimmedEnv(env, "SP_GOVERNANCE_TOKEN_SYMBOL") ?? "OSGV",
    proposalThreshold: parseUnits(
      readOptionalTrimmedEnv(env, "SP_GOVERNANCE_PROPOSAL_THRESHOLD") ?? "10",
      18,
    ),
    quorumNumerator: getEnvUint(env, "SP_GOVERNANCE_QUORUM_PERCENT", 10n),
    timelockDelaySeconds: getEnvUint(env, "SP_GOVERNANCE_TIMELOCK_DELAY_SECONDS", 3600n),
    treasuryBootstrapEth: parseEther(
      readOptionalTrimmedEnv(env, "SP_GOVERNANCE_TREASURY_BOOTSTRAP_ETH") ?? "0",
    ),
    votingDelayBlocks: getEnvUint(env, "SP_GOVERNANCE_VOTING_DELAY_BLOCKS", 1n),
    votingPeriodBlocks: getEnvUint(env, "SP_GOVERNANCE_VOTING_PERIOD_BLOCKS", 20n),
  };
}

function resolveDeploymentNetworkName(env: NodeJS.ProcessEnv, chainId: bigint): string {
  const configuredNetwork = readOptionalTrimmedEnv(env, "HARDHAT_NETWORK");
  if (configuredNetwork) {
    return configuredNetwork;
  }
  if (chainId === 84532n) {
    return "base-sepolia";
  }
  if (chainId === 8453n) {
    return "base";
  }
  if (chainId === 31337n) {
    return "localhost";
  }
  return `chain-${chainId.toString()}`;
}

function sumBootstrapAllocations(
  allocations: Array<{ account: string; amount: bigint }>,
): Array<{ account: string; amount: bigint }> {
  const merged = new Map<string, bigint>();
  for (const allocation of allocations) {
    merged.set(allocation.account, (merged.get(allocation.account) ?? 0n) + allocation.amount);
  }

  return [...merged.entries()]
    .filter(([, amount]) => amount > 0n)
    .map(([account, amount]) => ({ account, amount }));
}

export function isDeployLocalEntrypoint(moduleUrl: string, argv: string[] = process.argv): boolean {
  return isCliEntrypoint(moduleUrl, argv);
}

export async function deployLocalFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = getProvider(getRpcUrl(env));
  const networkInfo = await provider.getNetwork();
  validateDeploymentSignerTopology(networkInfo.chainId, env);
  const signerKeys = (dedicatedKey: string): string[] =>
    networkInfo.chainId === 31337n ? [dedicatedKey, "SP_OPERATOR_PRIVATE_KEY"] : [dedicatedKey];
  const deployer = createManagedOperatorSigner(signerKeys("SP_PROTOCOL_ADMIN_PRIVATE_KEY"), {
    env,
    localAccountIndex: 0,
  });
  const replicationSubmitter = createManagedOperatorSigner(
    signerKeys("SP_REPLICATION_SUBMITTER_PRIVATE_KEY"),
    { env, localAccountIndex: 3 },
  );
  const claimSubmitter = createManagedOperatorSigner(signerKeys("SP_CLAIM_SUBMITTER_PRIVATE_KEY"), {
    env,
    localAccountIndex: 2,
  });
  const resolverOperator = createManagedOperatorSigner(signerKeys("SP_RESOLVER_PRIVATE_KEY"), {
    env,
    localAccountIndex: 4,
  });
  const checkpointPublisher = createManagedOperatorSigner(
    signerKeys("SP_CHECKPOINT_PUBLISHER_PRIVATE_KEY"),
    { env, localAccountIndex: 5 },
  );
  const deployerAddress = await deployer.getAddress();
  const replicationSubmitterAddress = await replicationSubmitter.getAddress();
  const claimSubmitterAddress = await claimSubmitter.getAddress();
  const resolverOperatorAddress = await resolverOperator.getAddress();
  const checkpointPublisherAddress = await checkpointPublisher.getAddress();
  const deploymentOperators = {
    deployer: deployerAddress,
    claimSubmitter: claimSubmitterAddress,
    replicationSubmitter: replicationSubmitterAddress,
    resolverOperator: resolverOperatorAddress,
    checkpointPublisher: checkpointPublisherAddress,
  };
  validateDeploymentSignerTopology(networkInfo.chainId, env, {
    admin: deployerAddress,
    claimSubmitter: claimSubmitterAddress,
    checkpointPublisher: checkpointPublisherAddress,
    replicationSubmitter: replicationSubmitterAddress,
    resolver: resolverOperatorAddress,
  });
  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const governanceConfig = resolveLocalGovernanceDeploymentConfig(env);
  const bootstrapVoteRecipients = sumBootstrapAllocations([
    { account: deployerAddress, amount: governanceConfig.bootstrapVoteAmount },
    { account: replicationSubmitterAddress, amount: governanceConfig.bootstrapVoteAmount },
    { account: claimSubmitterAddress, amount: governanceConfig.bootstrapVoteAmount },
    { account: resolverOperatorAddress, amount: governanceConfig.bootstrapVoteAmount },
    { account: checkpointPublisherAddress, amount: governanceConfig.bootstrapVoteAmount },
  ]);

  const minimumAuthorBondWei = resolveMinimumAuthorBondWei(env, {
    localDevelopment: networkInfo.chainId === 31337n,
  });
  const deployTxOverrides = { gasLimit: 8_000_000n };
  const setupTxOverrides = { gasLimit: 500_000n };
  try {
    const AccessController = getContractFactory("AccessController", deployer);
    const accessController = (await AccessController.deploy(
      deployerAddress,
      deployTxOverrides,
    )) as UntypedContract;
    await accessController.waitForDeployment();

    for (const role of LOCAL_DEPLOYMENT_BOOTSTRAP_ROLES) {
      await (
        await accessController.grantRole(ROLE(role), deployerAddress, setupTxOverrides)
      ).wait();
    }

    for (const role of RESOLVER_OPERATOR_ROLES) {
      await (
        await accessController.grantRole(ROLE(role), resolverOperatorAddress, setupTxOverrides)
      ).wait();
    }
    for (const role of CLAIM_SUBMITTER_OPERATOR_ROLES) {
      await (
        await accessController.grantRole(ROLE(role), claimSubmitterAddress, setupTxOverrides)
      ).wait();
    }
    for (const role of CHECKPOINT_OPERATOR_ROLES) {
      await (
        await accessController.grantRole(ROLE(role), checkpointPublisherAddress, setupTxOverrides)
      ).wait();
    }

    const ProtocolParameters = getContractFactory("ProtocolParameters", deployer);
    const protocolParameters = (await ProtocolParameters.deploy(
      await accessController.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await protocolParameters.waitForDeployment();
    await (
      await protocolParameters.setUintParameter(
        keccak256(toUtf8Bytes("osp.claim.minAuthorBond")),
        minimumAuthorBondWei,
        setupTxOverrides,
      )
    ).wait();

    const ResolutionModuleRegistry = getContractFactory("ResolutionModuleRegistry", deployer);
    const resolutionModuleRegistry = (await ResolutionModuleRegistry.deploy(
      await accessController.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await resolutionModuleRegistry.waitForDeployment();

    const ComputationalResolutionModule = getContractFactory(
      "ComputationalResolutionModule",
      deployer,
    );
    const computationalModule = (await ComputationalResolutionModule.deploy(
      deployTxOverrides,
    )) as UntypedContract;
    await computationalModule.waitForDeployment();

    const BenchmarkResolutionModule = getContractFactory("BenchmarkResolutionModule", deployer);
    const benchmarkModule = (await BenchmarkResolutionModule.deploy(
      deployTxOverrides,
    )) as UntypedContract;
    await benchmarkModule.waitForDeployment();

    const WetLabResolutionModule = getContractFactory("WetLabResolutionModule", deployer);
    const wetLabModule = (await WetLabResolutionModule.deploy(
      deployTxOverrides,
    )) as UntypedContract;
    await wetLabModule.waitForDeployment();

    for (const module of [computationalModule, benchmarkModule, wetLabModule]) {
      await (
        await resolutionModuleRegistry.registerModule(
          await module.getAddress(),
          `ipfs://metadata/${await module.getAddress()}`,
          setupTxOverrides,
        )
      ).wait();
    }

    await (
      await resolutionModuleRegistry.setDomainModule(
        1,
        await computationalModule.getAddress(),
        setupTxOverrides,
      )
    ).wait();
    await (
      await resolutionModuleRegistry.setDomainModule(
        2,
        await wetLabModule.getAddress(),
        setupTxOverrides,
      )
    ).wait();
    await (
      await resolutionModuleRegistry.setDomainModule(
        3,
        await benchmarkModule.getAddress(),
        setupTxOverrides,
      )
    ).wait();

    const ClaimRegistry = getContractFactory("ClaimRegistry", deployer);
    const claimRegistry = (await ClaimRegistry.deploy(
      await accessController.getAddress(),
      await resolutionModuleRegistry.getAddress(),
      await protocolParameters.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await claimRegistry.waitForDeployment();

    const ArtifactRegistry = getContractFactory("ArtifactRegistry", deployer);
    const artifactRegistry = (await ArtifactRegistry.deploy(
      await claimRegistry.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await artifactRegistry.waitForDeployment();

    const AgentRegistry = getContractFactory("AgentRegistry", deployer);
    const agentRegistry = (await AgentRegistry.deploy(
      await accessController.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await agentRegistry.waitForDeployment();

    const ClaimRewardVault = getContractFactory("ClaimRewardVault", deployer);
    const claimRewardVault = (await ClaimRewardVault.deploy(
      await accessController.getAddress(),
      await claimRegistry.getAddress(),
      await agentRegistry.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await claimRewardVault.waitForDeployment();

    const ReplicationRegistry = getContractFactory("ReplicationRegistry", deployer);
    const replicationRegistry = (await ReplicationRegistry.deploy(
      await accessController.getAddress(),
      await claimRegistry.getAddress(),
      await agentRegistry.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await replicationRegistry.waitForDeployment();

    const ProtocolTreasury = getContractFactory("ProtocolTreasury", deployer);
    const protocolTreasury = (await ProtocolTreasury.deploy(
      deployerAddress,
      deployTxOverrides,
    )) as UntypedContract;
    await protocolTreasury.waitForDeployment();

    const BondEscrow = getContractFactory("BondEscrow", deployer);
    const bondEscrow = (await BondEscrow.deploy(
      await accessController.getAddress(),
      await claimRegistry.getAddress(),
      await replicationRegistry.getAddress(),
      await protocolTreasury.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await bondEscrow.waitForDeployment();
    await (
      await claimRegistry.configureProtocolDependencies(
        await bondEscrow.getAddress(),
        await replicationRegistry.getAddress(),
        setupTxOverrides,
      )
    ).wait();

    const ReputationCheckpointRegistry = getContractFactory(
      "ReputationCheckpointRegistry",
      deployer,
    );
    const reputationCheckpointRegistry = (await ReputationCheckpointRegistry.deploy(
      await accessController.getAddress(),
      await claimRegistry.getAddress(),
      await agentRegistry.getAddress(),
      await resolutionModuleRegistry.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await reputationCheckpointRegistry.waitForDeployment();

    const EpistemicMarket = getContractFactory("EpistemicMarket", deployer);
    const epistemicMarket = (await EpistemicMarket.deploy(
      await accessController.getAddress(),
      await claimRegistry.getAddress(),
      await agentRegistry.getAddress(),
      await replicationRegistry.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await epistemicMarket.waitForDeployment();

    const AppealsRegistry = getContractFactory("AppealsRegistry", deployer);
    const appealsRegistry = (await AppealsRegistry.deploy(
      await accessController.getAddress(),
      await claimRegistry.getAddress(),
      await replicationRegistry.getAddress(),
      await epistemicMarket.getAddress(),
      await protocolTreasury.getAddress(),
      deployTxOverrides,
    )) as UntypedContract;
    await appealsRegistry.waitForDeployment();

    const ProtocolGovernanceToken = getContractFactory("ProtocolGovernanceToken", deployer);
    const protocolGovernanceToken = (await ProtocolGovernanceToken.deploy(
      governanceConfig.governanceTokenName,
      governanceConfig.governanceTokenSymbol,
      deployerAddress,
      deployTxOverrides,
    )) as UntypedContract;
    await protocolGovernanceToken.waitForDeployment();

    const ProtocolTimelock = getContractFactory("ProtocolTimelock", deployer);
    const protocolTimelock = (await ProtocolTimelock.deploy(
      governanceConfig.timelockDelaySeconds,
      [],
      [],
      deployerAddress,
      deployTxOverrides,
    )) as UntypedContract;
    await protocolTimelock.waitForDeployment();

    const ProtocolGovernor = getContractFactory("ProtocolGovernor", deployer);
    const protocolGovernor = (await ProtocolGovernor.deploy(
      "Scientific Protocol Governor",
      await protocolGovernanceToken.getAddress(),
      await protocolTimelock.getAddress(),
      governanceConfig.votingDelayBlocks,
      governanceConfig.votingPeriodBlocks,
      governanceConfig.proposalThreshold,
      governanceConfig.quorumNumerator,
      deployTxOverrides,
    )) as UntypedContract;
    await protocolGovernor.waitForDeployment();

    for (const allocation of bootstrapVoteRecipients) {
      await (
        await protocolGovernanceToken.mint(allocation.account, allocation.amount, setupTxOverrides)
      ).wait();
    }

    if (governanceConfig.treasuryBootstrapEth > 0n) {
      await (
        await deployer.sendTransaction({
          gasLimit: setupTxOverrides.gasLimit,
          to: await protocolTreasury.getAddress(),
          value: governanceConfig.treasuryBootstrapEth,
        })
      ).wait();
    }

    const timelockProposerRole = await protocolTimelock.PROPOSER_ROLE();
    const timelockCancellerRole = await protocolTimelock.CANCELLER_ROLE();
    const timelockExecutorRole = await protocolTimelock.EXECUTOR_ROLE();
    const timelockAdminRole = await protocolTimelock.DEFAULT_ADMIN_ROLE();

    await (
      await protocolTimelock.grantRole(
        timelockProposerRole,
        await protocolGovernor.getAddress(),
        setupTxOverrides,
      )
    ).wait();
    await (
      await protocolTimelock.grantRole(
        timelockCancellerRole,
        await protocolGovernor.getAddress(),
        setupTxOverrides,
      )
    ).wait();
    await (
      await protocolTimelock.grantRole(timelockExecutorRole, ZeroAddress, setupTxOverrides)
    ).wait();
    await (
      await accessController.grantRole(
        DEFAULT_ADMIN_ROLE,
        await protocolTimelock.getAddress(),
        setupTxOverrides,
      )
    ).wait();
    for (const role of TIMELOCK_MANAGED_ROLES) {
      await (
        await accessController.grantRole(
          ROLE(role),
          await protocolTimelock.getAddress(),
          setupTxOverrides,
        )
      ).wait();
    }
    await (
      await protocolGovernanceToken.transferOwnership(
        await protocolTimelock.getAddress(),
        setupTxOverrides,
      )
    ).wait();
    await (
      await protocolTreasury.transferOwnership(
        await protocolTimelock.getAddress(),
        setupTxOverrides,
      )
    ).wait();
    for (const role of LOCAL_DEPLOYMENT_BOOTSTRAP_ROLES) {
      await (
        await accessController.revokeRole(ROLE(role), deployerAddress, setupTxOverrides)
      ).wait();
    }
    await (
      await accessController.revokeRole(DEFAULT_ADMIN_ROLE, deployerAddress, setupTxOverrides)
    ).wait();
    await (
      await protocolTimelock.renounceRole(timelockAdminRole, deployerAddress, setupTxOverrides)
    ).wait();

    const deploymentPath = getDeploymentPath(env);
    if (!isGcsUrl(deploymentPath)) {
      await mkdir(path.dirname(deploymentPath), { recursive: true });
    }

    const latestBlock = await provider.getBlockNumber();

    await saveDeploymentFile(
      {
        network: resolveDeploymentNetworkName(env, networkInfo.chainId),
        chainId: Number(networkInfo.chainId),
        deploymentBlock: latestBlock,
        deployedAt: new Date().toISOString(),
        addresses: {
          accessController: await accessController.getAddress(),
          protocolGovernanceToken: await protocolGovernanceToken.getAddress(),
          protocolTimelock: await protocolTimelock.getAddress(),
          protocolGovernor: await protocolGovernor.getAddress(),
          protocolTreasury: await protocolTreasury.getAddress(),
          protocolParameters: await protocolParameters.getAddress(),
          resolutionModuleRegistry: await resolutionModuleRegistry.getAddress(),
          claimRegistry: await claimRegistry.getAddress(),
          artifactRegistry: await artifactRegistry.getAddress(),
          bondEscrow: await bondEscrow.getAddress(),
          claimRewardVault: await claimRewardVault.getAddress(),
          agentRegistry: await agentRegistry.getAddress(),
          replicationRegistry: await replicationRegistry.getAddress(),
          reputationCheckpointRegistry: await reputationCheckpointRegistry.getAddress(),
          epistemicMarket: await epistemicMarket.getAddress(),
          appealsRegistry: await appealsRegistry.getAddress(),
          computationalModule: await computationalModule.getAddress(),
          benchmarkModule: await benchmarkModule.getAddress(),
          wetLabModule: await wetLabModule.getAddress(),
        },
        operators: deploymentOperators,
        parameters: {
          minimumAuthorBondWei: minimumAuthorBondWei.toString(),
        },
      },
      deploymentPath,
    );

    console.log(
      JSON.stringify(
        {
          ...deploymentOperators,
          bootstrapVoters: bootstrapVoteRecipients.map((allocation) => ({
            account: allocation.account,
            amount: allocation.amount.toString(),
          })),
          deploymentBlock: latestBlock,
          deploymentFile: deploymentPath,
          minimumAuthorBondWei: minimumAuthorBondWei.toString(),
        },
        null,
        2,
      ),
    );
  } finally {
    if (typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}

if (isDeployLocalEntrypoint(import.meta.url)) {
  await deployLocalFromEnv();
}
