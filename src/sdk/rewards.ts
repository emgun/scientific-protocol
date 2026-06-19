import { type ContractRunner, parseEther } from "ethers";
import { getContract } from "../shared/contracts.js";
import { DEFAULT_DEPLOYMENT_PATH, loadDeploymentFile } from "../shared/deployment.js";

export type ClaimRewardWorkKind =
  | "challenge"
  | "forecast"
  | "maintenance"
  | "replication"
  | "review"
  | "synthesis";

const CLAIM_REWARD_WORK_KIND_CODES: Record<ClaimRewardWorkKind, number> = {
  challenge: 3,
  forecast: 5,
  maintenance: 2,
  replication: 1,
  review: 0,
  synthesis: 4,
};

type RewardAmountInput = {
  amountEth?: string;
  amountWei?: string;
};

type ClaimRewardVaultFundingContract = {
  fundClaimRewards(
    claimId: bigint,
    workKind: number,
    overrides: {
      value: bigint;
    },
  ): Promise<unknown>;
};

type ClaimRewardVaultWithdrawalContract = {
  withdrawAccruedRewards(amount: bigint, recipient: string): Promise<unknown>;
};

export type RewardContractOptions = {
  deploymentPath?: string;
  runner: ContractRunner;
};

export type FundClaimRewardPoolInput = RewardAmountInput &
  RewardContractOptions & {
    claimId: bigint | number | string;
    workKind: ClaimRewardWorkKind;
  };

export type WithdrawAccruedRewardsInput = RewardAmountInput &
  RewardContractOptions & {
    recipient: string;
  };

export function claimRewardWorkKindCode(workKind: ClaimRewardWorkKind): number {
  return CLAIM_REWARD_WORK_KIND_CODES[parseClaimRewardWorkKind(String(workKind))];
}

export function parseClaimRewardWorkKind(workKind: string): ClaimRewardWorkKind {
  if (workKind in CLAIM_REWARD_WORK_KIND_CODES) {
    return workKind as ClaimRewardWorkKind;
  }
  throw new Error(`unsupported reward work kind: ${workKind}`);
}

export function resolveRewardAmountWei(input: RewardAmountInput): bigint {
  let amount: bigint;
  if (typeof input.amountWei === "string") {
    const trimmed = input.amountWei.trim();
    if (trimmed.length === 0) {
      throw new Error("amountWei cannot be empty");
    }
    try {
      amount = BigInt(trimmed);
    } catch {
      throw new Error("amountWei must be an integer wei amount");
    }
  } else if (typeof input.amountEth === "string") {
    const trimmed = input.amountEth.trim();
    if (trimmed.length === 0) {
      throw new Error("amountEth cannot be empty");
    }
    try {
      amount = parseEther(trimmed);
    } catch {
      throw new Error("amountEth must be a decimal ETH amount");
    }
  } else {
    throw new Error("set amountWei or amountEth");
  }

  if (amount <= 0n) {
    throw new Error("reward amount must be greater than zero");
  }
  return amount;
}

export async function getClaimRewardVaultContract(
  options: RewardContractOptions,
): Promise<
  Awaited<ReturnType<typeof getContract>> &
    ClaimRewardVaultFundingContract &
    ClaimRewardVaultWithdrawalContract
> {
  const deployment = await loadDeploymentFile(options.deploymentPath ?? DEFAULT_DEPLOYMENT_PATH);
  return (await getContract(
    "ClaimRewardVault",
    deployment.addresses.claimRewardVault,
    options.runner,
  )) as Awaited<ReturnType<typeof getContract>> &
    ClaimRewardVaultFundingContract &
    ClaimRewardVaultWithdrawalContract;
}

export async function fundClaimRewardPoolWithContract(
  contract: ClaimRewardVaultFundingContract,
  input: {
    amountWei: bigint;
    claimId: bigint | number | string;
    workKind: ClaimRewardWorkKind;
  },
): Promise<unknown> {
  return contract.fundClaimRewards(BigInt(input.claimId), claimRewardWorkKindCode(input.workKind), {
    value: input.amountWei,
  });
}

export async function withdrawAccruedRewardsWithContract(
  contract: ClaimRewardVaultWithdrawalContract,
  input: {
    amountWei: bigint;
    recipient: string;
  },
): Promise<unknown> {
  return contract.withdrawAccruedRewards(input.amountWei, input.recipient);
}

export async function fundClaimRewardPool(input: FundClaimRewardPoolInput): Promise<unknown> {
  const amountWei = resolveRewardAmountWei(input);
  const workKind = parseClaimRewardWorkKind(input.workKind);
  const contract = await getClaimRewardVaultContract(input);
  return fundClaimRewardPoolWithContract(contract, {
    amountWei,
    claimId: input.claimId,
    workKind,
  });
}

export async function withdrawAccruedRewards(input: WithdrawAccruedRewardsInput): Promise<unknown> {
  const amountWei = resolveRewardAmountWei(input);
  const contract = await getClaimRewardVaultContract(input);
  return withdrawAccruedRewardsWithContract(contract, {
    amountWei,
    recipient: input.recipient,
  });
}
