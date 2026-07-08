import { readEnvValue } from "./secrets.js";

/// Minimum payload size accepted by Filecoin Onchain Cloud storage providers.
export const FILECOIN_MIN_UPLOAD_BYTES = 127;

export type FilecoinUploadResult = {
  dataSetId: string;
  pieceCid: string;
  providerId: string;
  retrievalUrl: string;
};

export type FilecoinLikeClient = {
  uploadObject(input: {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
  }): Promise<FilecoinUploadResult>;
};

export type FilecoinClientOptions = {
  chainId?: number;
  privateKey?: string;
  rpcUrl?: string;
  source?: string;
  withCdn?: boolean;
};

export function resolveFilecoinClientOptions(
  env: NodeJS.ProcessEnv = process.env,
): FilecoinClientOptions {
  return {
    chainId: Number(readEnvValue(env, "SP_FILECOIN_CHAIN_ID") ?? 314159),
    privateKey: readEnvValue(env, "SP_FILECOIN_ONCHAIN_CLOUD_PRIVATE_KEY"),
    rpcUrl: readEnvValue(env, "SP_FILECOIN_RPC_URL"),
    source: "artifact-ingestion",
    withCdn: (readEnvValue(env, "SP_FILECOIN_WITH_CDN") ?? "false") === "true",
  };
}

/// Real Synapse-backed client. Constructed lazily so environments that never
/// use the filecoin backend do not touch the SDK or require a key.
export function createDefaultFilecoinClient(options: FilecoinClientOptions): FilecoinLikeClient {
  let clientPromise: Promise<{
    storage: {
      upload(
        bytes: Uint8Array,
        opts: Record<string, unknown>,
      ): Promise<{
        copies?: Array<{ dataSetId?: unknown; providerId?: unknown; retrievalUrl?: unknown }>;
        pieceCid?: unknown;
      }>;
    };
  }> | null = null;

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        if (!options.privateKey) {
          throw new Error(
            "filecoin artifact backend requires SP_FILECOIN_ONCHAIN_CLOUD_PRIVATE_KEY",
          );
        }
        const [{ getChain, Synapse }, { http }, { privateKeyToAccount }] = await Promise.all([
          import("@filoz/synapse-sdk"),
          import("viem"),
          import("viem/accounts"),
        ]);
        return Synapse.create({
          account: privateKeyToAccount(options.privateKey as `0x${string}`),
          chain: getChain(options.chainId ?? 314159),
          source: options.source ?? "artifact-ingestion",
          transport: options.rpcUrl ? http(options.rpcUrl) : http(),
          withCDN: options.withCdn ?? false,
        }) as never;
      })();
    }
    return clientPromise;
  }

  // One storage context (= one Filecoin data set) is shared across uploads:
  // data-set creation carries a fixed USDFC lockup cost, so per-artifact data
  // sets exhaust the payment rail quickly and needlessly.
  let contextPromise: Promise<{
    dataSetId?: unknown;
    getPieceUrl(pieceCid: unknown): string;
    provider?: { id?: unknown };
    upload(bytes: Uint8Array, opts?: Record<string, unknown>): Promise<{ pieceCid?: unknown }>;
  }> | null = null;

  async function getContext() {
    if (!contextPromise) {
      contextPromise = getClient().then((synapse) =>
        (synapse.storage as unknown as { getDefaultContext(): Promise<never> }).getDefaultContext(),
      );
    }
    return contextPromise;
  }

  return {
    async uploadObject(input) {
      const context = await getContext();
      const result = await context.upload(input.bytes, {
        metadata: { filename: input.filename, mimeType: input.contentType },
      });
      const pieceCid = String(result.pieceCid ?? "");
      if (!pieceCid) {
        throw new Error("filecoin upload returned no piece CID");
      }
      return {
        dataSetId: String(context.dataSetId ?? ""),
        pieceCid,
        providerId: String(context.provider?.id ?? ""),
        retrievalUrl: context.getPieceUrl(result.pieceCid),
      };
    },
  };
}

/// Pads sub-minimum payloads with trailing newlines so providers accept them.
/// The persisted record's sha256 is computed over the stored (padded) bytes,
/// so integrity verification stays self-consistent.
export function padToFilecoinMinimum(bytes: Buffer): Buffer {
  if (bytes.byteLength >= FILECOIN_MIN_UPLOAD_BYTES) {
    return bytes;
  }
  return Buffer.concat([bytes, Buffer.alloc(FILECOIN_MIN_UPLOAD_BYTES - bytes.byteLength, "\n")]);
}
