import { openAsBlob } from "node:fs";
import { Readable } from "node:stream";
import type { ArtifactReplicaProviderMetadata } from "./artifact-provider-metadata.js";

type IpfsAuthConfig = {
  headerName?: string;
  headerValue?: string;
};

export type IpfsProvider = "kubo" | "pinata";

export type IpfsObjectLocator = {
  cid: string;
  path?: string;
};

export type IpfsObjectContentStream = {
  contentLength: number | null;
  stream: NodeJS.ReadableStream;
};

export type IpfsObjectWrite = (
  | {
      body: Uint8Array;
      filePath?: never;
    }
  | {
      body?: never;
      filePath: string;
    }
) & {
  contentType: string;
  filename: string;
  pin: boolean;
};

export type IpfsLikeClient = {
  addObject(
    input: IpfsObjectWrite,
  ): Promise<{ cid: string; providerMetadata?: ArtifactReplicaProviderMetadata | null }>;
  openReadStream?(input: IpfsObjectLocator): Promise<IpfsObjectContentStream>;
  readObject(input: IpfsObjectLocator): Promise<Buffer>;
};

type IpfsClientConfigInput = {
  apiUrl?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
  gatewayUrl?: string;
  pinataApiUrl?: string;
  pinataGatewayUrl?: string;
  pinataJwt?: string;
  pinataNetwork?: "public" | "private";
  provider?: IpfsProvider;
};

function normalizeIpfsApiBaseUrl(apiUrl: string): string {
  const normalized = apiUrl.replace(/\/+$/, "");
  return normalized.endsWith("/api/v0") ? normalized : `${normalized}/api/v0`;
}

function normalizePinataUploadUrl(apiUrl: string): string {
  const normalized = apiUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v3/files")) {
    return normalized;
  }
  if (normalized.endsWith("/v3")) {
    return `${normalized}/files`;
  }
  return `${normalized}/v3/files`;
}

function normalizeIpfsGatewayBaseUrl(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, "");
}

function buildHeaders(auth: IpfsAuthConfig): Record<string, string> {
  if (!auth.headerName || !auth.headerValue) {
    return {};
  }
  return {
    [auth.headerName]: auth.headerValue,
  };
}

function buildGatewayObjectUrl(gatewayUrl: string, locator: IpfsObjectLocator): string {
  const base = normalizeIpfsGatewayBaseUrl(gatewayUrl);
  const suffix = locator.path ? `/${locator.path}` : "";
  if (base.endsWith("/ipfs")) {
    return `${base}/${locator.cid}${suffix}`;
  }
  return `${base}/ipfs/${locator.cid}${suffix}`;
}

function readableFromWebStream(stream: ReadableStream<Uint8Array>): NodeJS.ReadableStream {
  const reader = stream.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
        if (result.value) {
          yield result.value;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Readable.from(chunks());
}

function providerMetadataFromPayload(input: {
  gatewayUrl: string | null;
  payload: unknown;
  pinataNetwork: "public" | "private";
  provider: IpfsProvider;
}): ArtifactReplicaProviderMetadata | null {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    return null;
  }

  const raw = input.payload as Record<string, unknown>;
  const status =
    (typeof raw.status === "string" && raw.status) ||
    (typeof raw.state === "string" && raw.state) ||
    (input.provider === "pinata" ? "pinned" : null);
  const objectId =
    (typeof raw.id === "string" && raw.id) ||
    (typeof raw.requestId === "string" && raw.requestId) ||
    (typeof raw.request_id === "string" && raw.request_id) ||
    null;
  const keyValues =
    raw.keyvalues && typeof raw.keyvalues === "object" && !Array.isArray(raw.keyvalues)
      ? Object.fromEntries(
          Object.entries(raw.keyvalues as Record<string, unknown>)
            .map(([key, value]) => [key, typeof value === "string" ? value : null] as const)
            .filter((entry): entry is readonly [string, string] => entry[1] !== null),
        )
      : undefined;

  const rawFilecoin = raw.filecoin;
  const filecoin =
    rawFilecoin && typeof rawFilecoin === "object" && !Array.isArray(rawFilecoin)
      ? {
          dealCount: Array.isArray((rawFilecoin as { deals?: unknown[] }).deals)
            ? (rawFilecoin as { deals: unknown[] }).deals.length
            : 0,
          deals: Array.isArray((rawFilecoin as { deals?: unknown[] }).deals)
            ? (
                (rawFilecoin as { deals: unknown[] }).deals.map((deal) => {
                  if (!deal || typeof deal !== "object" || Array.isArray(deal)) {
                    return null;
                  }
                  const entry = deal as Record<string, unknown>;
                  return {
                    activationEpoch:
                      typeof entry.activationEpoch === "number" ? entry.activationEpoch : null,
                    dealId:
                      typeof entry.dealId === "string"
                        ? entry.dealId
                        : typeof entry.deal_id === "string"
                          ? entry.deal_id
                          : null,
                    endEpoch: typeof entry.endEpoch === "number" ? entry.endEpoch : null,
                    miner:
                      typeof entry.miner === "string"
                        ? entry.miner
                        : typeof entry.provider === "string"
                          ? entry.provider
                          : null,
                    pieceCid:
                      typeof entry.pieceCid === "string"
                        ? entry.pieceCid
                        : typeof entry.piece_cid === "string"
                          ? entry.piece_cid
                          : null,
                    status:
                      typeof entry.status === "string"
                        ? entry.status
                        : typeof entry.state === "string"
                          ? entry.state
                          : null,
                    verified: typeof entry.verified === "boolean" ? entry.verified : null,
                  };
                }) ?? []
              ).filter((deal): deal is NonNullable<typeof deal> => deal !== null)
            : [],
          network:
            typeof (rawFilecoin as { network?: unknown }).network === "string"
              ? ((rawFilecoin as { network: string }).network ?? null)
              : input.provider === "pinata"
                ? input.pinataNetwork
                : null,
          status:
            typeof (rawFilecoin as { status?: unknown }).status === "string"
              ? ((rawFilecoin as { status: string }).status ?? null)
              : null,
        }
      : keyValues &&
          (keyValues.filecoinDealId ||
            keyValues.filecoin_deal_id ||
            keyValues.filecoinDeals ||
            keyValues.filecoin_deals)
        ? {
            dealCount: 0,
            deals: [],
            network: keyValues.filecoinNetwork ?? keyValues.filecoin_network ?? null,
            status: keyValues.filecoinStatus ?? keyValues.filecoin_status ?? null,
          }
        : null;

  return {
    capturedAt: new Date().toISOString(),
    filecoin,
    gatewayUrl: input.gatewayUrl,
    keyValues,
    network:
      typeof raw.network === "string"
        ? raw.network
        : input.provider === "pinata"
          ? input.pinataNetwork
          : null,
    objectId,
    provider: `ipfs:${input.provider}`,
    raw,
    status,
  };
}

async function blobForIpfsWrite(input: IpfsObjectWrite): Promise<Blob> {
  if ("filePath" in input) {
    const filePath = input.filePath;
    if (!filePath) {
      throw new Error("ipfs file uploads require a file path");
    }
    return openAsBlob(filePath, { type: input.contentType });
  }
  return new Blob([new Uint8Array(input.body)], { type: input.contentType });
}

export function isIpfsUrl(value: string): boolean {
  return value.startsWith("ipfs://");
}

export function parseIpfsUrl(value: string): IpfsObjectLocator {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid ipfs path: ${value}`);
  }
  if (parsed.protocol !== "ipfs:") {
    throw new Error(`invalid ipfs path: ${value}`);
  }

  if (parsed.host === "ipfs") {
    const pathname = parsed.pathname.replace(/^\/+/, "");
    const [cid, ...pathSegments] = pathname.split("/").filter((segment) => segment.length > 0);
    if (!cid) {
      throw new Error(`invalid ipfs path: ${value}`);
    }
    return {
      cid,
      path: pathSegments.length > 0 ? pathSegments.join("/") : undefined,
    };
  }

  return {
    cid: parsed.host,
    path: parsed.pathname.replace(/^\/+/, "") || undefined,
  };
}

function resolveIpfsConfig(input: IpfsClientConfigInput): {
  apiUrl: string | null;
  gatewayUrl: string | null;
  headers: Record<string, string>;
  pinataNetwork: "public" | "private";
  provider: IpfsProvider;
} {
  const provider = input.provider ?? "kubo";
  const pinataNetwork = input.pinataNetwork ?? "public";

  if (provider === "pinata") {
    const jwt = input.pinataJwt?.trim() ?? "";
    const headers: Record<string, string> = {};
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }
    return {
      apiUrl: input.pinataApiUrl?.trim()
        ? normalizePinataUploadUrl(input.pinataApiUrl)
        : normalizePinataUploadUrl("https://uploads.pinata.cloud"),
      gatewayUrl: input.pinataGatewayUrl?.trim()
        ? normalizeIpfsGatewayBaseUrl(input.pinataGatewayUrl)
        : normalizeIpfsGatewayBaseUrl("https://gateway.pinata.cloud/ipfs"),
      headers,
      pinataNetwork,
      provider,
    };
  }

  return {
    apiUrl: input.apiUrl?.trim() ? normalizeIpfsApiBaseUrl(input.apiUrl) : null,
    gatewayUrl: input.gatewayUrl?.trim() ? normalizeIpfsGatewayBaseUrl(input.gatewayUrl) : null,
    headers: buildHeaders({
      headerName: input.authHeaderName,
      headerValue: input.authHeaderValue,
    }),
    pinataNetwork,
    provider,
  };
}

export function createDefaultIpfsClient(input: IpfsClientConfigInput): IpfsLikeClient {
  const { apiUrl, gatewayUrl, headers, pinataNetwork, provider } = resolveIpfsConfig(input);

  return {
    async addObject(inputObject) {
      if (provider === "pinata") {
        if (!headers.Authorization) {
          throw new Error("pinata artifact backend requires SP_ARTIFACT_PINATA_JWT");
        }

        const form = new FormData();
        form.append("network", pinataNetwork);
        form.append("file", await blobForIpfsWrite(inputObject), inputObject.filename);
        form.append("name", inputObject.filename);

        const response = await fetch(apiUrl!, {
          method: "POST",
          headers,
          body: form,
        });
        if (!response.ok) {
          throw new Error(`pinata upload failed with status ${response.status}`);
        }

        const payload = (await response.json()) as {
          cid?: string;
          data?: Record<string, unknown> & { cid?: string };
        };
        const cid = payload.data?.cid ?? payload.cid;
        if (!cid || cid.trim().length === 0) {
          throw new Error("pinata upload returned no CID");
        }
        return {
          cid,
          providerMetadata: providerMetadataFromPayload({
            gatewayUrl,
            payload: payload.data ?? payload,
            pinataNetwork,
            provider,
          }),
        };
      }

      if (!apiUrl) {
        throw new Error("ipfs artifact backend requires SP_ARTIFACT_IPFS_API_URL");
      }

      const endpoint = new URL(`${apiUrl}/add`);
      endpoint.searchParams.set("cid-version", "1");
      endpoint.searchParams.set("pin", inputObject.pin ? "true" : "false");
      endpoint.searchParams.set("wrap-with-directory", "false");

      const form = new FormData();
      form.append("file", await blobForIpfsWrite(inputObject), inputObject.filename);

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: form,
      });
      if (!response.ok) {
        throw new Error(`ipfs add failed with status ${response.status}`);
      }

      const payload = (await response.json()) as { Hash?: string };
      if (!payload.Hash || payload.Hash.trim().length === 0) {
        throw new Error("ipfs add returned no CID");
      }
      return {
        cid: payload.Hash,
        providerMetadata: providerMetadataFromPayload({
          gatewayUrl,
          payload,
          pinataNetwork,
          provider,
        }),
      };
    },

    async openReadStream(locator) {
      if (provider === "kubo" && apiUrl) {
        const endpoint = new URL(`${apiUrl}/cat`);
        const objectPath = locator.path
          ? `/ipfs/${locator.cid}/${locator.path}`
          : `/ipfs/${locator.cid}`;
        endpoint.searchParams.set("arg", objectPath);
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
        });
        if (!response.ok) {
          throw new Error(`ipfs retrieval failed with status ${response.status}`);
        }
        if (!response.body) {
          const bytes = Buffer.from(await response.arrayBuffer());
          return {
            contentLength: bytes.byteLength,
            stream: Readable.from(bytes),
          };
        }
        const headerLength = response.headers.get("content-length");
        const parsedLength = headerLength ? Number(headerLength) : Number.NaN;
        return {
          contentLength: Number.isFinite(parsedLength) ? parsedLength : null,
          stream: readableFromWebStream(response.body),
        };
      }

      if (!gatewayUrl) {
        throw new Error(
          "ipfs artifact retrieval requires SP_ARTIFACT_IPFS_API_URL or SP_ARTIFACT_IPFS_GATEWAY_URL",
        );
      }

      const response = await fetch(buildGatewayObjectUrl(gatewayUrl, locator), {
        headers,
      });
      if (!response.ok) {
        throw new Error(`ipfs gateway retrieval failed with status ${response.status}`);
      }
      if (!response.body) {
        const bytes = Buffer.from(await response.arrayBuffer());
        return {
          contentLength: bytes.byteLength,
          stream: Readable.from(bytes),
        };
      }
      const headerLength = response.headers.get("content-length");
      const parsedLength = headerLength ? Number(headerLength) : Number.NaN;
      return {
        contentLength: Number.isFinite(parsedLength) ? parsedLength : null,
        stream: readableFromWebStream(response.body),
      };
    },

    async readObject(locator) {
      if (provider === "kubo" && apiUrl) {
        const endpoint = new URL(`${apiUrl}/cat`);
        const objectPath = locator.path
          ? `/ipfs/${locator.cid}/${locator.path}`
          : `/ipfs/${locator.cid}`;
        endpoint.searchParams.set("arg", objectPath);
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
        });
        if (!response.ok) {
          throw new Error(`ipfs retrieval failed with status ${response.status}`);
        }
        return Buffer.from(await response.arrayBuffer());
      }

      if (!gatewayUrl) {
        throw new Error(
          "ipfs artifact retrieval requires SP_ARTIFACT_IPFS_API_URL or SP_ARTIFACT_IPFS_GATEWAY_URL",
        );
      }

      const response = await fetch(buildGatewayObjectUrl(gatewayUrl, locator), {
        headers,
      });
      if (!response.ok) {
        throw new Error(`ipfs gateway retrieval failed with status ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
