import type { Pool, PoolClient } from "pg";
import type { PageResult } from "../indexer/store.js";
import {
  readWorkRewardSettlementsPage,
  readWorkRewardSettlementTotals,
  type WorkRewardSettlementTotalsView,
  type WorkRewardSettlementView,
} from "../rewards/store.js";
import { CLAIM_REWARD_WORK_KINDS, type ClaimRewardWorkKind } from "../rewards/types.js";
import { getContract, getProvider, getRpcUrl } from "../shared/contracts.js";
import { DEFAULT_DEPLOYMENT_PATH, loadDeploymentFile } from "../shared/deployment.js";
import { normalizePagination } from "../shared/pagination.js";

export type GovernanceProposalState =
  | "Active"
  | "Canceled"
  | "Defeated"
  | "Executed"
  | "Expired"
  | "Pending"
  | "Queued"
  | "Succeeded";

export type GovernanceVoteSupport = "abstain" | "against" | "for";
export type GovernanceEventType =
  | "proposal_canceled"
  | "proposal_created"
  | "proposal_executed"
  | "proposal_queued"
  | "treasury_deposit"
  | "treasury_release"
  | "vote_cast";

export type GovernanceOverviewView = {
  chainId: number;
  claimRewardVaultAddress: string;
  deploymentBlock: number;
  governanceTokenAddress: string;
  governanceTokenName: string;
  governanceTokenSymbol: string;
  governanceTokenTotalSupply: string;
  governorAddress: string;
  governorName: string;
  latestBlock: number;
  proposalThreshold: string;
  quorumNumerator: number;
  timelockAddress: string;
  timelockDelaySeconds: number;
  treasuryAddress: string;
  treasuryBalanceWei: string;
  votingDelayBlocks: number;
  votingPeriodBlocks: number;
};

export type GovernanceTreasuryEventType = "deposit" | "ether_release";

export type GovernanceTreasuryEventView = {
  actor: string;
  amountWei: string;
  blockNumber: number;
  createdAt: string | null;
  eventType: GovernanceTreasuryEventType;
  recipient: string | null;
  txHash: string;
};

export type GovernanceRewardBudgetLaneView = {
  accruedWei: string;
  fundedWei: string;
  outstandingPoolWei: string;
  settlementCount: number;
  workKind: ClaimRewardWorkKind;
};

export type GovernanceTreasuryView = {
  accruedRewardLiabilityWei: string;
  claimRewardVaultAddress: string;
  claimRewardVaultBalanceWei: string;
  recentRewardSettlements: PageResult<WorkRewardSettlementView>;
  recentTreasuryEvents: PageResult<GovernanceTreasuryEventView>;
  rewardBudgetByWorkKind: GovernanceRewardBudgetLaneView[];
  rewardPoolOutstandingTotalWei: string;
  settledRewards: WorkRewardSettlementTotalsView;
  totalManagedCapitalWei: string;
  treasuryAddress: string;
  treasuryBalanceWei: string;
};

export type GovernanceEventView = {
  actor: string | null;
  blockNumber: number;
  createdAt: string | null;
  eventType: GovernanceEventType;
  proposalId: string | null;
  proposalTitle: string | null;
  summary: string;
  txHash: string;
};

export type GovernanceProposalActionView = {
  calldata: string;
  signature: string;
  summary: string;
  target: string;
  valueWei: string;
};

export type GovernanceProposalVoteView = {
  blockNumber: number;
  createdAt: string | null;
  reason: string;
  support: GovernanceVoteSupport;
  txHash: string;
  voter: string;
  weight: string;
};

export type GovernanceProposalVoteTotalsView = {
  abstain: string;
  against: string;
  for: string;
};

export type GovernanceProposalSummaryView = {
  createdAt: string | null;
  createdBlock: number;
  description: string;
  eta: string | null;
  operationCount: number;
  proposalId: string;
  proposer: string;
  quorumVotes: string;
  snapshotBlock: string;
  state: GovernanceProposalState;
  title: string;
  voteDeadlineBlock: string;
  votes: GovernanceProposalVoteTotalsView;
};

export type GovernanceProposalDetailView = GovernanceProposalSummaryView & {
  actions: GovernanceProposalActionView[];
  votesCast: PageResult<GovernanceProposalVoteView>;
};

type GovernanceContracts = {
  deploymentBlock: number;
  governanceToken: GovernanceTokenContract;
  governor: GovernanceGovernorContract;
  provider: ReturnType<typeof getProvider>;
  addresses: {
    claimRewardVaultAddress: string;
    governanceTokenAddress: string;
    governorAddress: string;
    timelockAddress: string;
    treasuryAddress: string;
  };
};

type GovernanceEventLog = {
  args: unknown;
  blockNumber: number;
  transactionHash: string;
};

type GovernanceGovernorContract = {
  filters: {
    ProposalCanceled: () => unknown;
    ProposalCreated: () => unknown;
    ProposalExecuted: () => unknown;
    ProposalQueued: () => unknown;
    VoteCast: () => unknown;
  };
  name(): Promise<string>;
  proposalEta(proposalId: bigint): Promise<bigint>;
  proposalThreshold(): Promise<bigint>;
  proposalVotes(proposalId: bigint): Promise<[bigint, bigint, bigint]>;
  queryFilter(filter: unknown, fromBlock: number, toBlock: number): Promise<GovernanceEventLog[]>;
  quorum(snapshotBlock: bigint): Promise<bigint>;
  quorumNumerator(): Promise<bigint>;
  state(proposalId: bigint): Promise<bigint>;
  timelock(): Promise<string>;
  votingDelay(): Promise<bigint>;
  votingPeriod(): Promise<bigint>;
};

type ClaimRewardVaultContract = {
  filters: {
    ClaimRewardFunded: () => unknown;
    WorkRewardAccrued: () => unknown;
  };
  queryFilter(filter: unknown, fromBlock: number, toBlock: number): Promise<GovernanceEventLog[]>;
};

type ProtocolTreasuryContract = {
  filters: {
    TreasuryEtherDeposited: () => unknown;
    TreasuryEtherReleased: () => unknown;
  };
  queryFilter(filter: unknown, fromBlock: number, toBlock: number): Promise<GovernanceEventLog[]>;
};

type GovernanceTokenContract = {
  name(): Promise<string>;
  symbol(): Promise<string>;
  totalSupply(): Promise<bigint>;
};

type ParsedProposalCreatedLog = {
  actions: GovernanceProposalActionView[];
  createdAt: string | null;
  createdBlock: number;
  description: string;
  operationCount: number;
  proposalId: string;
  proposer: string;
  snapshotBlock: bigint;
  title: string;
  voteDeadlineBlock: bigint;
};

type GovernanceRewardLaneAccumulator = {
  accruedWei: bigint;
  fundedWei: bigint;
  settlementCount: number;
  workKind: ClaimRewardWorkKind;
};

type GovernanceTreasuryQueryable = Pool | PoolClient;

const PROPOSAL_STATE_LABELS: GovernanceProposalState[] = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
];

const VOTE_SUPPORT_LABELS: GovernanceVoteSupport[] = ["against", "for", "abstain"];

function proposalStateLabel(value: bigint | number): GovernanceProposalState {
  const numeric = Number(value);
  return PROPOSAL_STATE_LABELS[numeric] ?? "Pending";
}

function voteSupportLabel(value: bigint | number): GovernanceVoteSupport {
  const numeric = Number(value);
  return VOTE_SUPPORT_LABELS[numeric] ?? "abstain";
}

function proposalTitle(description: string): string {
  const firstLine =
    description
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const normalized = firstLine.replace(/^#+\s*/u, "").trim();
  return normalized.length > 0 ? normalized : "Untitled proposal";
}

function actionSummary(target: string, signature: string, valueWei: bigint): string {
  const callLabel = signature.trim().length > 0 ? signature : "raw calldata";
  if (valueWei > 0n) {
    return `${callLabel} on ${target} with ${valueWei.toString()} wei`;
  }
  return `${callLabel} on ${target}`;
}

async function withGovernanceContracts<T>(
  fn: (contracts: GovernanceContracts) => Promise<T>,
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<T> {
  const deployment = await loadDeploymentFile(deploymentPath);
  const provider = getProvider(rpcUrl);
  try {
    const [governanceToken, governor] = await Promise.all([
      getContract(
        "ProtocolGovernanceToken",
        deployment.addresses.protocolGovernanceToken,
        provider,
      ),
      getContract("ProtocolGovernor", deployment.addresses.protocolGovernor, provider),
    ]);
    return await fn({
      addresses: {
        claimRewardVaultAddress: deployment.addresses.claimRewardVault,
        governanceTokenAddress: deployment.addresses.protocolGovernanceToken,
        governorAddress: deployment.addresses.protocolGovernor,
        timelockAddress: deployment.addresses.protocolTimelock,
        treasuryAddress: deployment.addresses.protocolTreasury,
      },
      deploymentBlock: deployment.deploymentBlock,
      governanceToken: governanceToken as unknown as GovernanceTokenContract,
      governor: governor as unknown as GovernanceGovernorContract,
      provider,
    });
  } finally {
    if (typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}

async function readBlockTimestamps(
  provider: ReturnType<typeof getProvider>,
  blockNumbers: number[],
): Promise<Map<number, string | null>> {
  const unique = [...new Set(blockNumbers)];
  const resolved = await Promise.all(
    unique.map(async (blockNumber) => {
      const block = await provider.getBlock(blockNumber);
      return [
        blockNumber,
        block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
      ] as const;
    }),
  );
  return new Map(resolved);
}

async function readProposalCreatedLogs(
  contracts: GovernanceContracts,
): Promise<Map<string, ParsedProposalCreatedLog>> {
  const latestBlock = await contracts.provider.getBlockNumber();
  const logs = await contracts.governor.queryFilter(
    contracts.governor.filters.ProposalCreated(),
    contracts.deploymentBlock,
    latestBlock,
  );
  const blockTimestamps = await readBlockTimestamps(
    contracts.provider,
    logs.map((log: { blockNumber: number }) => log.blockNumber),
  );
  return new Map(
    logs.map((log: { args: unknown; blockNumber: number }) => {
      const args = log.args as unknown as {
        calldatas: string[];
        description: string;
        proposalId: bigint;
        proposer: string;
        signatures: string[];
        targets: string[];
        values: bigint[];
        voteEnd: bigint;
        voteStart: bigint;
      };
      const actions = args.targets.map((target, index) => {
        const signature = args.signatures[index] ?? "";
        const valueWei = BigInt(args.values[index] ?? 0n);
        return {
          calldata: args.calldatas[index] ?? "0x",
          signature,
          summary: actionSummary(target, signature, valueWei),
          target,
          valueWei: valueWei.toString(),
        };
      });
      const proposalId = args.proposalId.toString();
      return [
        proposalId,
        {
          actions,
          createdAt: blockTimestamps.get(log.blockNumber) ?? null,
          createdBlock: log.blockNumber,
          description: args.description,
          operationCount: actions.length,
          proposalId,
          proposer: args.proposer,
          snapshotBlock: BigInt(args.voteStart),
          title: proposalTitle(args.description),
          voteDeadlineBlock: BigInt(args.voteEnd),
        },
      ] as const;
    }),
  );
}

async function buildGovernanceProposalSummary(
  contracts: GovernanceContracts,
  created: ParsedProposalCreatedLog,
): Promise<GovernanceProposalSummaryView> {
  const proposalId = BigInt(created.proposalId);
  const [eta, quorumVotes, state, votes] = await Promise.all([
    contracts.governor.proposalEta(proposalId) as Promise<bigint>,
    contracts.governor.quorum(created.snapshotBlock) as Promise<bigint>,
    contracts.governor.state(proposalId) as Promise<bigint>,
    contracts.governor.proposalVotes(proposalId) as Promise<[bigint, bigint, bigint]>,
  ]);
  return {
    createdAt: created.createdAt,
    createdBlock: created.createdBlock,
    description: created.description,
    eta: eta > 0n ? new Date(Number(eta) * 1000).toISOString() : null,
    operationCount: created.operationCount,
    proposalId: created.proposalId,
    proposer: created.proposer,
    quorumVotes: quorumVotes.toString(),
    snapshotBlock: created.snapshotBlock.toString(),
    state: proposalStateLabel(state),
    title: created.title,
    voteDeadlineBlock: created.voteDeadlineBlock.toString(),
    votes: {
      abstain: votes[2].toString(),
      against: votes[0].toString(),
      for: votes[1].toString(),
    },
  };
}

export async function readGovernanceOverview(
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<GovernanceOverviewView> {
  return withGovernanceContracts(
    async (contracts) => {
      const network = await contracts.provider.getNetwork();
      const [
        governorName,
        latestBlock,
        proposalThreshold,
        quorumNumerator,
        timelockDelaySeconds,
        treasuryBalanceWei,
        governanceTokenName,
        governanceTokenSymbol,
        governanceTokenTotalSupply,
        votingDelayBlocks,
        votingPeriodBlocks,
      ] = await Promise.all([
        contracts.governor.name() as Promise<string>,
        contracts.provider.getBlockNumber(),
        contracts.governor.proposalThreshold() as Promise<bigint>,
        contracts.governor.quorumNumerator() as Promise<bigint>,
        contracts.governor.timelock().then(async (timelockAddress: string) => {
          const timelock = await getContract(
            "ProtocolTimelock",
            timelockAddress,
            contracts.provider,
          );
          return timelock.getMinDelay() as Promise<bigint>;
        }),
        contracts.provider.getBalance(contracts.addresses.treasuryAddress),
        contracts.governanceToken.name() as Promise<string>,
        contracts.governanceToken.symbol() as Promise<string>,
        contracts.governanceToken.totalSupply() as Promise<bigint>,
        contracts.governor.votingDelay() as Promise<bigint>,
        contracts.governor.votingPeriod() as Promise<bigint>,
      ]);
      return {
        chainId: Number(network.chainId),
        claimRewardVaultAddress: contracts.addresses.claimRewardVaultAddress,
        deploymentBlock: contracts.deploymentBlock,
        governanceTokenAddress: contracts.addresses.governanceTokenAddress,
        governanceTokenName,
        governanceTokenSymbol,
        governanceTokenTotalSupply: governanceTokenTotalSupply.toString(),
        governorAddress: contracts.addresses.governorAddress,
        governorName,
        latestBlock,
        proposalThreshold: proposalThreshold.toString(),
        quorumNumerator: Number(quorumNumerator),
        timelockAddress: contracts.addresses.timelockAddress,
        timelockDelaySeconds: Number(timelockDelaySeconds),
        treasuryAddress: contracts.addresses.treasuryAddress,
        treasuryBalanceWei: treasuryBalanceWei.toString(),
        votingDelayBlocks: Number(votingDelayBlocks),
        votingPeriodBlocks: Number(votingPeriodBlocks),
      };
    },
    deploymentPath,
    rpcUrl,
  );
}

function mapTreasuryEventLog(
  eventType: GovernanceTreasuryEventType,
  log: GovernanceEventLog,
  createdAt: string | null,
): GovernanceTreasuryEventView {
  if (eventType === "deposit") {
    const args = log.args as unknown as {
      amount: bigint;
      funder: string;
    };
    return {
      actor: args.funder,
      amountWei: BigInt(args.amount).toString(),
      blockNumber: log.blockNumber,
      createdAt,
      eventType,
      recipient: null,
      txHash: log.transactionHash,
    };
  }
  const args = log.args as unknown as {
    actor: string;
    amount: bigint;
    recipient: string;
  };
  return {
    actor: args.actor,
    amountWei: BigInt(args.amount).toString(),
    blockNumber: log.blockNumber,
    createdAt,
    eventType,
    recipient: args.recipient,
    txHash: log.transactionHash,
  };
}

function sortGovernanceEvents<T extends { blockNumber: number; txHash: string }>(
  left: T,
  right: T,
): number {
  if (left.blockNumber === right.blockNumber) {
    return right.txHash.localeCompare(left.txHash);
  }
  return right.blockNumber - left.blockNumber;
}

export async function readGovernanceEvents(
  input: {
    limit?: number;
    offset?: number;
    proposalId?: string;
  } = {},
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<PageResult<GovernanceEventView>> {
  return withGovernanceContracts(
    async (contracts) => {
      const { limit, offset } = normalizePagination(input, { defaultLimit: 10 });
      const [protocolTreasury, latestBlock, createdByProposalId] = await Promise.all([
        getContract(
          "ProtocolTreasury",
          contracts.addresses.treasuryAddress,
          contracts.provider,
        ) as unknown as Promise<ProtocolTreasuryContract>,
        contracts.provider.getBlockNumber(),
        readProposalCreatedLogs(contracts),
      ]);

      const [
        proposalCanceledLogs,
        proposalCreatedLogs,
        proposalExecutedLogs,
        proposalQueuedLogs,
        voteCastLogs,
        treasuryDepositLogs,
        treasuryReleaseLogs,
      ] = await Promise.all([
        contracts.governor.queryFilter(
          contracts.governor.filters.ProposalCanceled(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        contracts.governor.queryFilter(
          contracts.governor.filters.ProposalCreated(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        contracts.governor.queryFilter(
          contracts.governor.filters.ProposalExecuted(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        contracts.governor.queryFilter(
          contracts.governor.filters.ProposalQueued(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        contracts.governor.queryFilter(
          contracts.governor.filters.VoteCast(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        protocolTreasury.queryFilter(
          protocolTreasury.filters.TreasuryEtherDeposited(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        protocolTreasury.queryFilter(
          protocolTreasury.filters.TreasuryEtherReleased(),
          contracts.deploymentBlock,
          latestBlock,
        ),
      ]);

      const timestamps = await readBlockTimestamps(contracts.provider, [
        ...proposalCanceledLogs.map((log) => log.blockNumber),
        ...proposalCreatedLogs.map((log) => log.blockNumber),
        ...proposalExecutedLogs.map((log) => log.blockNumber),
        ...proposalQueuedLogs.map((log) => log.blockNumber),
        ...voteCastLogs.map((log) => log.blockNumber),
        ...treasuryDepositLogs.map((log) => log.blockNumber),
        ...treasuryReleaseLogs.map((log) => log.blockNumber),
      ]);

      const events: GovernanceEventView[] = [];

      for (const log of proposalCreatedLogs) {
        const args = log.args as unknown as {
          description: string;
          proposalId: bigint;
          proposer: string;
        };
        const proposalId = args.proposalId.toString();
        const created = createdByProposalId.get(proposalId);
        events.push({
          actor: args.proposer,
          blockNumber: log.blockNumber,
          createdAt: timestamps.get(log.blockNumber) ?? null,
          eventType: "proposal_created",
          proposalId,
          proposalTitle: created?.title ?? proposalTitle(args.description),
          summary: `Proposal created by ${args.proposer}`,
          txHash: log.transactionHash,
        });
      }

      for (const log of proposalQueuedLogs) {
        const args = log.args as unknown as {
          eta: bigint;
          proposalId: bigint;
        };
        const proposalId = args.proposalId.toString();
        const created = createdByProposalId.get(proposalId);
        const etaLabel =
          BigInt(args.eta) > 0n
            ? new Date(Number(args.eta) * 1000).toISOString()
            : "no eta recorded";
        events.push({
          actor: null,
          blockNumber: log.blockNumber,
          createdAt: timestamps.get(log.blockNumber) ?? null,
          eventType: "proposal_queued",
          proposalId,
          proposalTitle: created?.title ?? null,
          summary: `Proposal queued with eta ${etaLabel}`,
          txHash: log.transactionHash,
        });
      }

      for (const log of proposalExecutedLogs) {
        const args = log.args as unknown as {
          proposalId: bigint;
        };
        const proposalId = args.proposalId.toString();
        const created = createdByProposalId.get(proposalId);
        events.push({
          actor: null,
          blockNumber: log.blockNumber,
          createdAt: timestamps.get(log.blockNumber) ?? null,
          eventType: "proposal_executed",
          proposalId,
          proposalTitle: created?.title ?? null,
          summary: "Proposal executed through the timelock",
          txHash: log.transactionHash,
        });
      }

      for (const log of proposalCanceledLogs) {
        const args = log.args as unknown as {
          proposalId: bigint;
        };
        const proposalId = args.proposalId.toString();
        const created = createdByProposalId.get(proposalId);
        events.push({
          actor: null,
          blockNumber: log.blockNumber,
          createdAt: timestamps.get(log.blockNumber) ?? null,
          eventType: "proposal_canceled",
          proposalId,
          proposalTitle: created?.title ?? null,
          summary: "Proposal canceled",
          txHash: log.transactionHash,
        });
      }

      for (const log of voteCastLogs) {
        const args = log.args as unknown as {
          proposalId: bigint;
          reason: string;
          support: bigint;
          voter: string;
          weight: bigint;
        };
        const proposalId = args.proposalId.toString();
        const created = createdByProposalId.get(proposalId);
        const support = voteSupportLabel(args.support);
        const reasonSuffix =
          typeof args.reason === "string" && args.reason.trim().length > 0
            ? `: ${args.reason.trim()}`
            : "";
        events.push({
          actor: args.voter,
          blockNumber: log.blockNumber,
          createdAt: timestamps.get(log.blockNumber) ?? null,
          eventType: "vote_cast",
          proposalId,
          proposalTitle: created?.title ?? null,
          summary: `Vote cast ${support} with ${BigInt(args.weight).toString()} weight${reasonSuffix}`,
          txHash: log.transactionHash,
        });
      }

      for (const log of treasuryDepositLogs) {
        const args = log.args as unknown as {
          amount: bigint;
          funder: string;
        };
        events.push({
          actor: args.funder,
          blockNumber: log.blockNumber,
          createdAt: timestamps.get(log.blockNumber) ?? null,
          eventType: "treasury_deposit",
          proposalId: null,
          proposalTitle: null,
          summary: `Treasury deposit of ${BigInt(args.amount).toString()} wei`,
          txHash: log.transactionHash,
        });
      }

      for (const log of treasuryReleaseLogs) {
        const args = log.args as unknown as {
          actor: string;
          amount: bigint;
          recipient: string;
        };
        events.push({
          actor: args.actor,
          blockNumber: log.blockNumber,
          createdAt: timestamps.get(log.blockNumber) ?? null,
          eventType: "treasury_release",
          proposalId: null,
          proposalTitle: null,
          summary: `Treasury release of ${BigInt(args.amount).toString()} wei to ${args.recipient}`,
          txHash: log.transactionHash,
        });
      }

      const filtered = events
        .filter((event) => (input.proposalId ? event.proposalId === input.proposalId : true))
        .sort(sortGovernanceEvents);

      return {
        items: filtered.slice(offset, offset + limit),
        limit,
        offset,
        total: filtered.length,
      };
    },
    deploymentPath,
    rpcUrl,
  );
}

export async function readGovernanceTreasury(
  queryable: GovernanceTreasuryQueryable,
  input: {
    limit?: number;
    offset?: number;
  } = {},
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<GovernanceTreasuryView> {
  return withGovernanceContracts(
    async (contracts) => {
      const { limit, offset } = normalizePagination(input, { defaultLimit: 10 });
      const [
        claimRewardVault,
        protocolTreasury,
        latestBlock,
        treasuryBalanceWei,
        claimRewardVaultBalanceWei,
      ] = await Promise.all([
        getContract(
          "ClaimRewardVault",
          contracts.addresses.claimRewardVaultAddress,
          contracts.provider,
        ) as unknown as Promise<ClaimRewardVaultContract>,
        getContract(
          "ProtocolTreasury",
          contracts.addresses.treasuryAddress,
          contracts.provider,
        ) as unknown as Promise<ProtocolTreasuryContract>,
        contracts.provider.getBlockNumber(),
        contracts.provider.getBalance(contracts.addresses.treasuryAddress),
        contracts.provider.getBalance(contracts.addresses.claimRewardVaultAddress),
      ]);

      const [
        rewardFundLogs,
        rewardAccrualLogs,
        treasuryDepositLogs,
        treasuryReleaseLogs,
        recentRewardSettlements,
        settledRewards,
      ] = await Promise.all([
        claimRewardVault.queryFilter(
          claimRewardVault.filters.ClaimRewardFunded(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        claimRewardVault.queryFilter(
          claimRewardVault.filters.WorkRewardAccrued(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        protocolTreasury.queryFilter(
          protocolTreasury.filters.TreasuryEtherDeposited(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        protocolTreasury.queryFilter(
          protocolTreasury.filters.TreasuryEtherReleased(),
          contracts.deploymentBlock,
          latestBlock,
        ),
        readWorkRewardSettlementsPage(queryable, { limit, offset }),
        readWorkRewardSettlementTotals(queryable),
      ]);

      const treasuryEventLogs = [
        ...treasuryDepositLogs.map((log) => ({ eventType: "deposit" as const, log })),
        ...treasuryReleaseLogs.map((log) => ({ eventType: "ether_release" as const, log })),
      ];
      const blockTimestamps = await readBlockTimestamps(contracts.provider, [
        ...treasuryEventLogs.map(({ log }) => log.blockNumber),
        ...rewardFundLogs.map((log) => log.blockNumber),
        ...rewardAccrualLogs.map((log) => log.blockNumber),
      ]);

      const rewardBudgetAccumulators = new Map<
        ClaimRewardWorkKind,
        GovernanceRewardLaneAccumulator
      >(
        CLAIM_REWARD_WORK_KINDS.map((workKind) => [
          workKind,
          {
            accruedWei: 0n,
            fundedWei: 0n,
            settlementCount: 0,
            workKind,
          },
        ]),
      );

      for (const log of rewardFundLogs) {
        const args = log.args as unknown as { amount: bigint; workKind: bigint };
        const workKind = CLAIM_REWARD_WORK_KINDS[Number(args.workKind)];
        if (!workKind) {
          continue;
        }
        const lane = rewardBudgetAccumulators.get(workKind);
        if (!lane) {
          continue;
        }
        lane.fundedWei += BigInt(args.amount);
      }

      for (const log of rewardAccrualLogs) {
        const args = log.args as unknown as {
          agentBudgetAmount: bigint;
          recipientAmount: bigint;
          workKind: bigint;
        };
        const workKind = CLAIM_REWARD_WORK_KINDS[Number(args.workKind)];
        if (!workKind) {
          continue;
        }
        const lane = rewardBudgetAccumulators.get(workKind);
        if (!lane) {
          continue;
        }
        lane.accruedWei += BigInt(args.recipientAmount) + BigInt(args.agentBudgetAmount);
        lane.settlementCount += 1;
      }

      const rewardBudgetByWorkKind = CLAIM_REWARD_WORK_KINDS.map((workKind) => {
        const lane = rewardBudgetAccumulators.get(workKind);
        const fundedWei = lane?.fundedWei ?? 0n;
        const accruedWei = lane?.accruedWei ?? 0n;
        const outstandingPoolWei = fundedWei > accruedWei ? fundedWei - accruedWei : 0n;
        return {
          accruedWei: accruedWei.toString(),
          fundedWei: fundedWei.toString(),
          outstandingPoolWei: outstandingPoolWei.toString(),
          settlementCount: lane?.settlementCount ?? 0,
          workKind,
        } satisfies GovernanceRewardBudgetLaneView;
      });

      const rewardPoolOutstandingTotalWei = rewardBudgetByWorkKind.reduce(
        (total, lane) => total + BigInt(lane.outstandingPoolWei),
        0n,
      );
      const accruedRewardLiabilityWei =
        claimRewardVaultBalanceWei > rewardPoolOutstandingTotalWei
          ? claimRewardVaultBalanceWei - rewardPoolOutstandingTotalWei
          : 0n;

      const sortedTreasuryEvents = treasuryEventLogs
        .map(({ eventType, log }) =>
          mapTreasuryEventLog(eventType, log, blockTimestamps.get(log.blockNumber) ?? null),
        )
        .sort((left, right) => {
          if (left.blockNumber === right.blockNumber) {
            return right.txHash.localeCompare(left.txHash);
          }
          return right.blockNumber - left.blockNumber;
        });

      return {
        accruedRewardLiabilityWei: accruedRewardLiabilityWei.toString(),
        claimRewardVaultAddress: contracts.addresses.claimRewardVaultAddress,
        claimRewardVaultBalanceWei: claimRewardVaultBalanceWei.toString(),
        recentRewardSettlements,
        recentTreasuryEvents: {
          items: sortedTreasuryEvents.slice(offset, offset + limit),
          limit,
          offset,
          total: sortedTreasuryEvents.length,
        },
        rewardBudgetByWorkKind,
        rewardPoolOutstandingTotalWei: rewardPoolOutstandingTotalWei.toString(),
        settledRewards,
        totalManagedCapitalWei: (treasuryBalanceWei + claimRewardVaultBalanceWei).toString(),
        treasuryAddress: contracts.addresses.treasuryAddress,
        treasuryBalanceWei: treasuryBalanceWei.toString(),
      };
    },
    deploymentPath,
    rpcUrl,
  );
}

export async function readGovernanceProposals(
  input: {
    limit?: number;
    offset?: number;
    state?: GovernanceProposalState;
  } = {},
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<PageResult<GovernanceProposalSummaryView>> {
  return withGovernanceContracts(
    async (contracts) => {
      const createdByProposalId = await readProposalCreatedLogs(contracts);
      const proposals = await Promise.all(
        [...createdByProposalId.values()].map((created) =>
          buildGovernanceProposalSummary(contracts, created),
        ),
      );
      const filtered = proposals
        .filter((proposal) => (input.state ? proposal.state === input.state : true))
        .sort((left, right) => {
          if (left.createdBlock === right.createdBlock) {
            return right.proposalId.localeCompare(left.proposalId);
          }
          return right.createdBlock - left.createdBlock;
        });
      const offset = input.offset ?? 0;
      const limit = input.limit ?? (filtered.length > 0 ? filtered.length : 20);
      return {
        items: filtered.slice(offset, offset + limit),
        limit,
        offset,
        total: filtered.length,
      };
    },
    deploymentPath,
    rpcUrl,
  );
}

export async function readGovernanceProposalDetail(
  proposalId: string,
  input: {
    limit?: number;
    offset?: number;
  } = {},
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<GovernanceProposalDetailView | null> {
  return withGovernanceContracts(
    async (contracts) => {
      const createdByProposalId = await readProposalCreatedLogs(contracts);
      const created = createdByProposalId.get(proposalId);
      if (!created) {
        return null;
      }
      const summary = await buildGovernanceProposalSummary(contracts, created);
      const latestBlock = await contracts.provider.getBlockNumber();
      const voteLogs = await contracts.governor.queryFilter(
        contracts.governor.filters.VoteCast(),
        contracts.deploymentBlock,
        latestBlock,
      );
      const matchingLogs = voteLogs.filter((log: { args: unknown }) => {
        const args = log.args as unknown as { proposalId: bigint };
        return args.proposalId.toString() === proposalId;
      });
      const blockTimestamps = await readBlockTimestamps(
        contracts.provider,
        matchingLogs.map((log: { blockNumber: number }) => log.blockNumber),
      );
      const votesCast = matchingLogs
        .map((log: { args: unknown; blockNumber: number; transactionHash: string }) => {
          const args = log.args as unknown as {
            proposalId: bigint;
            reason: string;
            support: bigint;
            voter: string;
            weight: bigint;
          };
          return {
            blockNumber: log.blockNumber,
            createdAt: blockTimestamps.get(log.blockNumber) ?? null,
            reason: args.reason,
            support: voteSupportLabel(args.support),
            txHash: log.transactionHash,
            voter: args.voter,
            weight: BigInt(args.weight).toString(),
          } satisfies GovernanceProposalVoteView;
        })
        .sort((left: GovernanceProposalVoteView, right: GovernanceProposalVoteView) => {
          if (left.blockNumber === right.blockNumber) {
            return left.voter.localeCompare(right.voter);
          }
          return right.blockNumber - left.blockNumber;
        });
      const offset = input.offset ?? 0;
      const limit = input.limit ?? (votesCast.length > 0 ? votesCast.length : 20);
      return {
        ...summary,
        actions: created.actions,
        votesCast: {
          items: votesCast.slice(offset, offset + limit),
          limit,
          offset,
          total: votesCast.length,
        },
      };
    },
    deploymentPath,
    rpcUrl,
  );
}
