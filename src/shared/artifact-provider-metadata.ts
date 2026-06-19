export type ArtifactFilecoinDealRecord = {
  activationEpoch?: number | null;
  dealId?: string | null;
  endEpoch?: number | null;
  miner?: string | null;
  pieceCid?: string | null;
  status?: string | null;
  verified?: boolean | null;
};

export type ArtifactReplicaProviderMetadata = {
  capturedAt?: string | null;
  filecoin?: {
    dealCount: number;
    deals: ArtifactFilecoinDealRecord[];
    network?: string | null;
    status?: string | null;
  } | null;
  gatewayUrl?: string | null;
  hostNodes?: string[];
  keyValues?: Record<string, string>;
  network?: string | null;
  objectId?: string | null;
  provider: string;
  raw?: Record<string, unknown> | null;
  status?: string | null;
};

function recordLike(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return null;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = recordLike(value);
  if (!record) {
    return undefined;
  }
  const entries = Object.entries(record)
    .map(([key, current]) => [key, stringValue(current)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseFilecoinDealsFromKeyValues(
  keyValues: Record<string, string> | undefined,
): ArtifactFilecoinDealRecord[] {
  if (!keyValues) {
    return [];
  }

  const serializedDeals =
    keyValues.filecoinDeals ??
    keyValues.filecoin_deals ??
    keyValues.filecoinDealJson ??
    keyValues.filecoin_deal_json;
  if (serializedDeals) {
    try {
      const parsed = JSON.parse(serializedDeals) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => parseFilecoinDeal(entry))
          .filter((entry): entry is ArtifactFilecoinDealRecord => entry !== null);
      }
    } catch {
      // Fall through to best-effort key parsing.
    }
  }

  const singleDealId =
    keyValues.filecoinDealId ?? keyValues.filecoin_deal_id ?? keyValues.dealId ?? keyValues.deal_id;
  if (!singleDealId) {
    return [];
  }

  return [
    {
      dealId: singleDealId,
      miner: keyValues.filecoinMiner ?? keyValues.filecoin_miner ?? keyValues.miner ?? keyValues.sp,
      pieceCid: keyValues.filecoinPieceCid ?? keyValues.filecoin_piece_cid ?? keyValues.pieceCid,
      status: keyValues.filecoinStatus ?? keyValues.filecoin_status ?? keyValues.status,
      verified:
        booleanValue(keyValues.filecoinVerified ?? keyValues.filecoin_verified ?? undefined) ??
        null,
    },
  ];
}

function parseFilecoinDeal(value: unknown): ArtifactFilecoinDealRecord | null {
  const record = recordLike(value);
  if (!record) {
    return null;
  }

  const candidate: ArtifactFilecoinDealRecord = {
    activationEpoch:
      numberValue(record.activationEpoch ?? record.activation_epoch ?? null) ?? undefined,
    dealId: stringValue(record.dealId ?? record.deal_id ?? record.chainDealId ?? null) ?? undefined,
    endEpoch: numberValue(record.endEpoch ?? record.end_epoch ?? null) ?? undefined,
    miner: stringValue(record.miner ?? record.provider ?? record.sp ?? null) ?? undefined,
    pieceCid: stringValue(record.pieceCid ?? record.piece_cid ?? null) ?? undefined,
    status: stringValue(record.status ?? record.state ?? null) ?? undefined,
    verified: booleanValue(record.verified ?? record.isVerified ?? null) ?? undefined,
  };

  return Object.values(candidate).some((entry) => entry !== undefined) ? candidate : null;
}

function parseFilecoinState(
  raw: Record<string, unknown>,
  keyValues: Record<string, string> | undefined,
): ArtifactReplicaProviderMetadata["filecoin"] {
  const filecoinRecord =
    recordLike(raw.filecoin) ??
    recordLike(raw.filecoinState) ??
    recordLike(raw.filecoin_state) ??
    null;
  const deals =
    (Array.isArray(filecoinRecord?.deals)
      ? filecoinRecord?.deals
          .map((entry) => parseFilecoinDeal(entry))
          .filter((entry): entry is ArtifactFilecoinDealRecord => entry !== null)
      : null) ?? parseFilecoinDealsFromKeyValues(keyValues);

  const network =
    stringValue(filecoinRecord?.network ?? null) ??
    keyValues?.filecoinNetwork ??
    keyValues?.filecoin_network ??
    null;
  const status =
    stringValue(filecoinRecord?.status ?? null) ??
    keyValues?.filecoinStatus ??
    keyValues?.filecoin_status ??
    null;

  if (deals.length === 0 && !network && !status) {
    return null;
  }

  return {
    dealCount: deals.length,
    deals,
    network,
    status,
  };
}

export function normalizeArtifactReplicaProviderMetadata(input: {
  fallbackNetwork?: string | null;
  fallbackStatus?: string | null;
  gatewayUrl?: string | null;
  provider: string;
  raw: unknown;
}): ArtifactReplicaProviderMetadata | null {
  const raw = recordLike(input.raw);
  if (!raw) {
    return null;
  }

  const keyValues =
    stringMap(raw.keyvalues) ??
    stringMap(raw.keyValues) ??
    stringMap(recordLike(raw.metadata)?.keyvalues) ??
    undefined;
  const filecoin = parseFilecoinState(raw, keyValues);
  const normalized: ArtifactReplicaProviderMetadata = {
    capturedAt: new Date().toISOString(),
    filecoin,
    gatewayUrl: input.gatewayUrl ?? stringValue(raw.gatewayUrl ?? raw.gateway_url ?? null) ?? null,
    hostNodes: (Array.isArray(raw.hostNodes)
      ? raw.hostNodes
      : Array.isArray(raw.host_nodes)
        ? raw.host_nodes
        : []
    )
      .map((entry) => stringValue(entry))
      .filter((entry): entry is string => entry !== null),
    keyValues,
    network:
      stringValue(raw.network ?? raw.pinningRegion ?? raw.region ?? null) ??
      input.fallbackNetwork ??
      null,
    objectId:
      stringValue(raw.id ?? raw.fileId ?? raw.file_id ?? raw.requestId ?? raw.request_id ?? null) ??
      null,
    provider: input.provider,
    raw,
    status:
      stringValue(raw.status ?? raw.state ?? raw.pinStatus ?? null) ?? input.fallbackStatus ?? null,
  };

  return normalized;
}
