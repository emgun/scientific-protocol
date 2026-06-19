import { getContract, getProvider, getRpcUrl } from "../shared/contracts.js";
import { DEFAULT_DEPLOYMENT_PATH, loadDeploymentFile } from "../shared/deployment.js";
import { CLAIM_REWARD_WORK_KIND_CODES, CLAIM_REWARD_WORK_KINDS } from "./types.js";
import type { ClaimRewardPoolView } from "./views.js";

export async function readClaimRewardPools(
  claimId: string,
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<ClaimRewardPoolView[]> {
  const deployment = await loadDeploymentFile(deploymentPath);
  const provider = getProvider(rpcUrl);
  try {
    const claimRewardVault = await getContract(
      "ClaimRewardVault",
      deployment.addresses.claimRewardVault,
      provider,
    );
    return await Promise.all(
      CLAIM_REWARD_WORK_KINDS.map(async (workKind) => ({
        balanceWei: (
          await claimRewardVault.claimRewardPools(
            BigInt(claimId),
            CLAIM_REWARD_WORK_KIND_CODES[workKind],
          )
        ).toString(),
        workKind,
      })),
    );
  } finally {
    if (typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}

export async function readRecipientAccruedRewardBalance(
  recipient: string,
  deploymentPath = DEFAULT_DEPLOYMENT_PATH,
  rpcUrl = getRpcUrl(),
): Promise<string> {
  const deployment = await loadDeploymentFile(deploymentPath);
  const provider = getProvider(rpcUrl);
  try {
    const claimRewardVault = await getContract(
      "ClaimRewardVault",
      deployment.addresses.claimRewardVault,
      provider,
    );
    return (await claimRewardVault.accruedRewardBalances(recipient)).toString();
  } finally {
    if (typeof provider.destroy === "function") {
      await provider.destroy();
    }
  }
}
