import { HDNodeWallet, type JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { getProvider, getRpcUrl } from "./contracts.js";
import { isLocalDevelopmentRpcUrl } from "./env.js";
import { readEnvValue } from "./secrets.js";

const LOCAL_HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const managedSignerCache = new Map<string, { provider: JsonRpcProvider; signer: NonceManager }>();

export function resetManagedOperatorSigners(): void {
  for (const { provider } of managedSignerCache.values()) {
    provider.destroy();
  }
  managedSignerCache.clear();
}

export function getOperatorPrivateKey(
  envKeys: string[],
  options: {
    allowLocalDefault?: boolean;
    env?: NodeJS.ProcessEnv;
    localAccountIndex?: number;
    rpcUrl?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  for (const envKey of envKeys) {
    const value = readEnvValue(env, envKey);
    if (value) {
      return value;
    }
  }

  const rpcUrl = options.rpcUrl ?? getRpcUrl(env);
  if (options.allowLocalDefault !== false && isLocalDevelopmentRpcUrl(rpcUrl)) {
    const accountIndex = options.localAccountIndex ?? 0;
    return HDNodeWallet.fromPhrase(
      LOCAL_HARDHAT_MNEMONIC,
      undefined,
      `m/44'/60'/0'/0/${accountIndex}`,
    ).privateKey;
  }

  throw new Error(`missing operator private key; set one of ${envKeys.join(", ")}`);
}

export function createOperatorSigner(
  envKeys: string[],
  options: {
    allowLocalDefault?: boolean;
    env?: NodeJS.ProcessEnv;
    localAccountIndex?: number;
    rpcUrl?: string;
  } = {},
): Wallet {
  const rpcUrl = options.rpcUrl ?? getRpcUrl(options.env);
  const provider = getProvider(rpcUrl);
  return new Wallet(getOperatorPrivateKey(envKeys, options), provider);
}

export function createManagedOperatorSigner(
  envKeys: string[],
  options: {
    allowLocalDefault?: boolean;
    env?: NodeJS.ProcessEnv;
    localAccountIndex?: number;
    rpcUrl?: string;
  } = {},
): NonceManager {
  const privateKey = getOperatorPrivateKey(envKeys, options);
  const rpcUrl = options.rpcUrl ?? getRpcUrl(options.env);
  const cacheKey = `${rpcUrl}:${privateKey}`;
  const cached = managedSignerCache.get(cacheKey);
  if (cached) {
    return cached.signer;
  }

  const provider = getProvider(rpcUrl);
  const signer = new NonceManager(new Wallet(privateKey, provider));
  managedSignerCache.set(cacheKey, { provider, signer });
  return signer;
}

export function destroySignerProvider(signer: { provider?: unknown } | null | undefined): void {
  const provider = signer?.provider;
  if (provider && typeof (provider as { destroy?: unknown }).destroy === "function") {
    (provider as { destroy(): void }).destroy();
  }
}
