import {
  Contract,
  type ContractRunner,
  type InterfaceAbi,
  JsonRpcProvider,
  keccak256,
} from "ethers";
import { generatedContractArtifacts } from "../generated/contracts.js";
import { type EnvRecord, readEnvValue } from "./secrets.js";

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

export function getRpcUrl(env: EnvRecord = process.env): string {
  return readEnvValue(env, "SP_RPC_URL") ?? "http://127.0.0.1:8545";
}

function isAlreadyKnownSendError(error: unknown): boolean {
  const candidate = error as {
    error?: { code?: number; message?: string };
    message?: string;
  } | null;
  const message = `${candidate?.error?.message ?? ""} ${candidate?.message ?? ""}`.toLowerCase();
  return message.includes("already known");
}

/// JsonRpcProvider that treats an "already known" eth_sendRawTransaction reply
/// as success. Some nodes return that error when a broadcast is retried for a
/// transaction already in their mempool; the transaction hash is deterministic
/// from the raw payload, so the correct behavior is to return it and let the
/// caller wait for the receipt instead of aborting a long transaction sequence.
class ResilientJsonRpcProvider extends JsonRpcProvider {
  override async send(method: string, params: Array<unknown>): Promise<unknown> {
    try {
      return await super.send(method, params);
    } catch (error) {
      if (
        method === "eth_sendRawTransaction" &&
        typeof params[0] === "string" &&
        isAlreadyKnownSendError(error)
      ) {
        return keccak256(params[0]);
      }
      throw error;
    }
  }
}

export function getProvider(rpcUrl = getRpcUrl()): JsonRpcProvider {
  return new ResilientJsonRpcProvider(rpcUrl);
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
