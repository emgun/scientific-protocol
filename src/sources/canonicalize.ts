import type {
  CanonicalSourceLocator,
  SourceAutoPublicationDecision,
  SourceExtractionCandidate,
  SourcePublicationCluster,
  SourceType,
} from "./types.js";

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeLower(value: string): string {
  return normalizeText(value).toLowerCase();
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function toUrl(locator: string): URL | null {
  try {
    return new URL(locator);
  } catch {
    return null;
  }
}

function canonicalizeDoi(locator: string): CanonicalSourceLocator | null {
  const normalized = normalizeText(locator);
  const direct = normalized.match(/^doi:(.+)$/i)?.[1]?.trim();
  const url = toUrl(normalized);
  let fromUrl: string | null = null;
  if (url && /^(doi\.org|dx\.doi\.org)$/i.test(url.hostname)) {
    try {
      fromUrl = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  }
  const doi = normalizeLower(direct ?? fromUrl ?? "");
  if (!doi) {
    return null;
  }
  return {
    canonicalSourceKey: `doi:${doi}`,
    normalizedLocator: `https://doi.org/${doi}`,
    ref: null,
    sourceType: "url",
  };
}

function canonicalizeGithub(locator: string, ref: string | null): CanonicalSourceLocator | null {
  const url = toUrl(locator);
  const hostname = url?.hostname.toLowerCase() ?? "";
  if (!url || (hostname !== "github.com" && hostname !== "www.github.com")) {
    return null;
  }
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const owner = segments[0].toLowerCase();
  const repo = segments[1].replace(/\.git$/i, "").toLowerCase();
  if (segments.length === 2) {
    const normalizedRef = normalizeText(ref ?? "") || "head";
    return {
      canonicalSourceKey: `github:${owner}/${repo}@${normalizedRef}`,
      normalizedLocator: `https://github.com/${owner}/${repo}`,
      ref: normalizedRef,
      sourceType: "repository",
    };
  }
  const pathMode = segments[2]?.toLowerCase() ?? null;
  if (!pathMode || !["blob", "tree"].includes(pathMode)) {
    return null;
  }
  const normalizedRefInput = normalizeText(ref ?? "") || null;
  const suffix = segments
    .slice(3)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
  const commonSimpleRefs = new Set(["main", "master", "develop", "dev", "trunk", "stable"]);
  if (pathMode === "tree") {
    let pathRef = normalizedRefInput;
    if (!pathRef) {
      if (suffix.length === 1) {
        pathRef = suffix[0] ?? null;
      } else if (suffix.length === 2) {
        const first = suffix[0] ?? "";
        const second = suffix[1] ?? "";
        pathRef =
          commonSimpleRefs.has(first.toLowerCase()) || second.includes(".")
            ? first || null
            : `${first}/${second}`;
      } else if (suffix.length > 2) {
        pathRef = suffix[0] ?? null;
      }
    }
    if (!pathRef) {
      return null;
    }
    return {
      canonicalSourceKey: `github:${owner}/${repo}@${pathRef}`,
      normalizedLocator: `https://github.com/${owner}/${repo}`,
      ref: pathRef,
      sourceType: "repository",
    };
  }

  let pathRef = normalizedRefInput;
  if (!pathRef) {
    if (suffix.length === 1) {
      pathRef = suffix[0] ?? null;
    } else if (suffix.length === 2) {
      pathRef = suffix[0] ?? null;
    } else if (suffix.length === 3) {
      const first = suffix[0] ?? "";
      const second = suffix[1] ?? "";
      const last = suffix[2] ?? "";
      if (last.includes(".")) {
        pathRef =
          commonSimpleRefs.has(first.toLowerCase()) || /^[0-9a-f]{7,40}$/i.test(first)
            ? first || null
            : `${first}/${second}`;
      }
    }
  }
  if (!pathRef) {
    return null;
  }
  return {
    canonicalSourceKey: `github:${owner}/${repo}@${pathRef}`,
    normalizedLocator: `https://github.com/${owner}/${repo}`,
    ref: pathRef,
    sourceType: "repository",
  };
}

function canonicalizeArxiv(locator: string): CanonicalSourceLocator | null {
  const normalized = normalizeText(locator);
  const rawMatch = normalized.match(
    /^(?:arxiv:)?((?:\d{4}\.\d{4,5})|(?:[a-z][a-z.-]*\/\d{7}))(v\d+)?(?:\.pdf)?$/i,
  );
  if (rawMatch) {
    const version = rawMatch[2] ?? "";
    return {
      canonicalSourceKey: `arxiv:${rawMatch[1].toLowerCase()}${version.toLowerCase()}`,
      normalizedLocator: `https://arxiv.org/abs/${rawMatch[1]}${version}`,
      ref: null,
      sourceType: "url",
    };
  }
  const url = toUrl(normalized);
  if (!url || url.hostname.toLowerCase() !== "arxiv.org") {
    return null;
  }
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const mode = segments[0].toLowerCase();
  if (!["abs", "pdf"].includes(mode)) {
    return null;
  }
  let rawId: string;
  try {
    rawId = decodeURIComponent(segments.slice(1).join("/"));
  } catch {
    return null;
  }
  const match = rawId.match(/^((?:\d{4}\.\d{4,5})|(?:[a-z][a-z.-]*\/\d{7}))(v\d+)?(?:\.pdf)?$/i);
  if (!match) {
    return null;
  }
  const version = match[2] ?? "";
  return {
    canonicalSourceKey: `arxiv:${match[1].toLowerCase()}${version.toLowerCase()}`,
    normalizedLocator: `https://arxiv.org/abs/${match[1]}${version}`,
    ref: null,
    sourceType: "url",
  };
}

function canonicalizeGenericUrl(
  locator: string,
  sourceType: SourceType,
  ref: string | null,
): CanonicalSourceLocator {
  const url = toUrl(locator);
  if (!url) {
    return {
      canonicalSourceKey: `url:${normalizeLower(locator)}`,
      normalizedLocator: normalizeText(locator),
      ref,
      sourceType,
    };
  }
  url.hash = "";
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  const kept = [...url.searchParams.entries()]
    .filter(([key, value]) => {
      const loweredKey = key.toLowerCase();
      if (/^utm_/i.test(key) || ["ref", "fbclid", "gclid"].includes(loweredKey)) {
        return false;
      }
      if (loweredKey !== "source") {
        return true;
      }
      return !["feed"].includes(value.toLowerCase());
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    );
  url.search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/") || "/";
  const normalizedLocator = url.toString();
  return {
    canonicalSourceKey: `url:${normalizedLocator}`,
    normalizedLocator,
    ref,
    sourceType,
  };
}

export function canonicalizeSourceLocator(input: {
  locator: string;
  ref?: string | null;
  sourceType: SourceType;
}): CanonicalSourceLocator {
  const trimmedLocator = normalizeText(input.locator);
  const normalizedRef = normalizeText(input.ref ?? "") || null;

  const arxiv = canonicalizeArxiv(trimmedLocator);
  if (arxiv) {
    return arxiv;
  }

  const doi = canonicalizeDoi(trimmedLocator);
  if (doi) {
    return doi;
  }

  if (input.sourceType === "repository") {
    const github = canonicalizeGithub(trimmedLocator, normalizedRef);
    if (github) {
      return github;
    }
  }

  return canonicalizeGenericUrl(trimmedLocator, input.sourceType, normalizedRef);
}

function candidateClusterKey(candidate: SourceExtractionCandidate): string {
  return [
    normalizeLower(candidate.statement),
    normalizeLower(candidate.scope),
    normalizeLower(candidate.claimType),
  ].join("|");
}

function clusterStrength(cluster: SourcePublicationCluster): number {
  return cluster.memberCount * cluster.averageConfidenceBps;
}

export function decideSourceAutoPublication(
  candidates: SourceExtractionCandidate[],
): SourceAutoPublicationDecision {
  if (candidates.length === 0) {
    return {
      competingStrengthRatio: null,
      reason: "No extraction candidates were submitted.",
      shouldPublish: false,
      winningCluster: null,
    };
  }

  const grouped = new Map<string, SourceExtractionCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateClusterKey(candidate);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(candidate);
    } else {
      grouped.set(key, [candidate]);
    }
  }

  const clusters: SourcePublicationCluster[] = [...grouped.entries()].map(
    ([clusterKey, entries]) => {
      const distinctAgents = new Set(
        entries
          .map((entry) => entry.reviewerAgentId?.trim() || null)
          .filter((entry): entry is string => Boolean(entry)),
      ).size;
      const averageConfidenceBps =
        entries.reduce((sum, entry) => sum + clampBps(entry.confidenceBps), 0) / entries.length;
      const representative = entries[0];
      return {
        averageConfidenceBps: Math.round(averageConfidenceBps),
        clusterKey,
        distinctAgents,
        memberCount: entries.length,
        methodology: representative?.methodology ?? "",
        scope: representative?.scope ?? "",
        statement: representative?.statement ?? "",
      };
    },
  );

  clusters.sort((left, right) => clusterStrength(right) - clusterStrength(left));
  const winningCluster = clusters[0] ?? null;
  const competingCluster = clusters[1] ?? null;
  if (!winningCluster) {
    return {
      competingStrengthRatio: null,
      reason: "No extraction candidates were submitted.",
      shouldPublish: false,
      winningCluster: null,
    };
  }

  const competingStrengthRatio =
    competingCluster && clusterStrength(winningCluster) > 0
      ? clusterStrength(competingCluster) / clusterStrength(winningCluster)
      : null;

  const winningMembers = grouped.get(winningCluster.clusterKey) ?? [];
  const hasAnchors = winningMembers.every((candidate) => candidate.anchors.length > 0);

  if (competingStrengthRatio !== null && competingStrengthRatio >= 0.8) {
    return {
      competingStrengthRatio,
      reason: "Competing extraction clusters are still too strong to auto-publish safely.",
      shouldPublish: false,
      winningCluster,
    };
  }
  if (winningCluster.distinctAgents < 2) {
    return {
      competingStrengthRatio,
      reason: "The leading extraction cluster still needs additional distinct agents.",
      shouldPublish: false,
      winningCluster,
    };
  }
  if (winningCluster.averageConfidenceBps < 7_000) {
    return {
      competingStrengthRatio,
      reason: "The leading extraction cluster is still below the confidence threshold.",
      shouldPublish: false,
      winningCluster,
    };
  }
  if (!hasAnchors) {
    return {
      competingStrengthRatio,
      reason: "The leading extraction cluster is missing anchored source support.",
      shouldPublish: false,
      winningCluster,
    };
  }

  return {
    competingStrengthRatio,
    reason: "The leading extraction cluster clears the auto-publication policy.",
    shouldPublish: true,
    winningCluster,
  };
}
