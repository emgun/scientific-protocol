import { Contract, type ContractRunner, type InterfaceAbi, JsonRpcProvider } from "ethers";
import { generatedContractArtifacts } from "../generated/contracts.js";
import { readEnvValue } from "./secrets.js";

export type ContractName =
  | "AccessController"
  | "AgentRegistry"
  | "AppealsRegistry"
  | "ArtifactRegistry"
  | "BondEscrow"
  | "ClaimRewardVault"
  | "ClaimRegistry"
  | "EpistemicMarket"
  | "ProtocolGovernanceToken"
  | "ProtocolGovernor"
  | "ProtocolParameters"
  | "ProtocolTimelock"
  | "ProtocolTreasury"
  | "ReplicationRegistry"
  | "ReputationCheckpointRegistry"
  | "ResolutionModuleRegistry";

export type Artifact = {
  abi: InterfaceAbi;
  bytecode: string;
  contractName: string;
  sourceName: string;
};

export async function loadArtifact(name: ContractName): Promise<Artifact> {
  const artifact = generatedContractArtifacts[name];
  return {
    abi: artifact.abi as InterfaceAbi,
    bytecode: artifact.bytecode,
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
  };
}

export async function getContract(
  name: ContractName,
  address: string,
  runner: ContractRunner,
): Promise<Contract & Record<string, any>> {
  const artifact = await loadArtifact(name);
  return new Contract(address, artifact.abi, runner) as Contract & Record<string, any>;
}

export function getRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  return readEnvValue(env, "SP_RPC_URL") ?? "http://127.0.0.1:8545";
}

export function getProvider(rpcUrl = getRpcUrl()): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl);
}

export function extractContractEventId(
  contract: {
    interface: {
      parseLog(
        log: unknown,
      ): { args: Record<string, { toString(): string }>; name?: string } | null;
    };
  },
  receipt: { logs: Array<unknown> },
  eventName: string,
  argName: string,
): string | null {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed.args[argName].toString();
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  return null;
}

export function requireContractEventId(
  contract: Parameters<typeof extractContractEventId>[0],
  receipt: ({ hash?: string } & { logs: Array<unknown> }) | null,
  eventName: string,
  argName: string,
): string {
  if (!receipt) {
    throw new Error(`missing transaction receipt for ${eventName}.${argName}`);
  }
  const value = extractContractEventId(contract, receipt, eventName, argName);
  if (!value) {
    throw new Error(`missing ${eventName}.${argName} in transaction ${receipt.hash ?? "unknown"}`);
  }
  return value;
}
