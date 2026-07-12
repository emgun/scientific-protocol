import { URL } from "node:url";
import { type AgentWebhookEventType, normalizeAgentWebhookEventTypes } from "../agents/webhooks.js";
import type { ArtifactDraftInput } from "../artifacts/ingestion.js";
import type {
  ReviewIssueSeverity,
  ReviewIssueStatus,
  ReviewSubmissionVerdict,
} from "../review/types.js";
import { isBlockedOutboundHostname } from "../shared/outbound-request.js";
import { canonicalizeSourceLocator } from "../sources/canonicalize.js";

export function parseIntegerParam(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid_integer:${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid_integer:${key}`);
  }
  return parsed;
}

export function parseBooleanParam(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`invalid_boolean:${key}`);
}

export function parseTimestampParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid_timestamp:${key}`);
  }
  return parsed.toISOString();
}

export function hasAnySearchParam(url: URL, keys: string[]): boolean {
  return keys.some((key) => url.searchParams.has(key));
}

export function parseDetailView(url: URL): "full" | "summary" {
  const value = url.searchParams.get("view");
  if (value === null || value === "" || value === "full") {
    return "full";
  }
  if (value === "summary") {
    return "summary";
  }
  throw new Error("invalid_view:view");
}

export function parseGovernanceProposalState(
  url: URL,
):
  | "Active"
  | "Canceled"
  | "Defeated"
  | "Executed"
  | "Expired"
  | "Pending"
  | "Queued"
  | "Succeeded"
  | undefined {
  const value = url.searchParams.get("state");
  if (value === null || value === "") {
    return undefined;
  }
  if (
    value === "Active" ||
    value === "Canceled" ||
    value === "Defeated" ||
    value === "Executed" ||
    value === "Expired" ||
    value === "Pending" ||
    value === "Queued" ||
    value === "Succeeded"
  ) {
    return value;
  }
  throw new Error("invalid_governance_state:state");
}

export function parseReviewIssueSeverity(raw: unknown): ReviewIssueSeverity {
  if (raw !== "low" && raw !== "medium" && raw !== "high" && raw !== "critical") {
    throw new Error("invalid_review_issue_severity");
  }
  return raw;
}

export function parseReviewIssueStatus(raw: unknown): ReviewIssueStatus {
  if (raw !== "open" && raw !== "responded" && raw !== "resolved" && raw !== "dismissed") {
    throw new Error("invalid_review_issue_status");
  }
  return raw;
}

export function parseReviewSubmissionVerdict(raw: unknown): ReviewSubmissionVerdict {
  if (raw !== "pass" && raw !== "fail" && raw !== "flag" && raw !== "inconclusive") {
    throw new Error("invalid_review_submission_verdict");
  }
  return raw;
}

export function parseArtifactDraftPayload(payload: Record<string, unknown>): ArtifactDraftInput {
  const sourceType = payload.sourceType === "repository" ? "repository" : "url";
  if (sourceType === "repository") {
    return {
      artifactType: typeof payload.artifactType === "number" ? payload.artifactType : undefined,
      domainId: typeof payload.domainId === "number" ? payload.domainId : undefined,
      metadata: typeof payload.metadata === "string" ? payload.metadata : undefined,
      methodology: typeof payload.methodology === "string" ? payload.methodology : undefined,
      predictionHooks:
        typeof payload.predictionHooks === "string" ? payload.predictionHooks : undefined,
      ref: typeof payload.ref === "string" ? payload.ref : undefined,
      repositoryUrl: String(payload.repositoryUrl ?? ""),
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
      sourceType,
      statement: typeof payload.statement === "string" ? payload.statement : undefined,
    };
  }
  return {
    artifactType: typeof payload.artifactType === "number" ? payload.artifactType : undefined,
    domainId: typeof payload.domainId === "number" ? payload.domainId : undefined,
    metadata: typeof payload.metadata === "string" ? payload.metadata : undefined,
    methodology: typeof payload.methodology === "string" ? payload.methodology : undefined,
    predictionHooks:
      typeof payload.predictionHooks === "string" ? payload.predictionHooks : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    sourceType,
    sourceUrl: String(payload.sourceUrl ?? ""),
    statement: typeof payload.statement === "string" ? payload.statement : undefined,
  };
}

export function parseAgentWebhookEventTypes(raw: unknown): AgentWebhookEventType[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error("invalid_agent_webhook_event_types");
  }
  const normalized = normalizeAgentWebhookEventTypes(
    raw.map((entry) => {
      if (typeof entry !== "string") {
        throw new Error("invalid_agent_webhook_event_types");
      }
      return entry;
    }),
  );
  if (normalized.length === 0) {
    throw new Error("invalid_agent_webhook_event_types");
  }
  return normalized;
}

export function parseWebhookSubscriptionCreatePayload(payload: Record<string, unknown>): {
  eventTypes?: AgentWebhookEventType[];
  label?: string | null;
  signingSecret?: string;
  targetUrl: string;
} {
  const rawLabel = payload.label;
  const rawSigningSecret = payload.signingSecret;
  const rawTargetUrl = payload.targetUrl;

  if (typeof rawTargetUrl !== "string" || rawTargetUrl.trim().length === 0) {
    throw new Error("invalid_agent_webhook_target_url");
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawTargetUrl);
  } catch {
    throw new Error("invalid_agent_webhook_target_url");
  }
  if (
    (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") ||
    targetUrl.username ||
    targetUrl.password ||
    isBlockedOutboundHostname(targetUrl.hostname)
  ) {
    throw new Error("invalid_agent_webhook_target_url");
  }

  if (
    rawSigningSecret !== undefined &&
    (typeof rawSigningSecret !== "string" || rawSigningSecret.trim().length === 0)
  ) {
    throw new Error("invalid_agent_webhook_signing_secret");
  }

  if (
    rawLabel !== undefined &&
    rawLabel !== null &&
    (typeof rawLabel !== "string" || rawLabel.trim().length === 0)
  ) {
    throw new Error("invalid_agent_webhook_label");
  }

  return {
    eventTypes: parseAgentWebhookEventTypes(payload.eventTypes),
    label: typeof rawLabel === "string" ? rawLabel.trim() : null,
    signingSecret: typeof rawSigningSecret === "string" ? rawSigningSecret.trim() : undefined,
    targetUrl: targetUrl.toString(),
  };
}

export function canonicalizeSourceDraft(input: ArtifactDraftInput): {
  canonicalSourceKey: string;
  normalizedLocator: string;
  ref: string | null;
  sourceType: ArtifactDraftInput["sourceType"];
} {
  const canonical = canonicalizeSourceLocator(
    input.sourceType === "repository"
      ? {
          locator: input.repositoryUrl,
          ref: input.ref ?? null,
          sourceType: input.sourceType,
        }
      : {
          locator: input.sourceUrl,
          ref: null,
          sourceType: input.sourceType,
        },
  );
  if (canonical.sourceType === "url") {
    const doiAliasMatch =
      canonical.canonicalSourceKey.match(/^doi:10\.48550\/arxiv\.(\d{4}\.\d{4,5})(v\d+)?$/i) ??
      canonical.normalizedLocator.match(
        /^https:\/\/doi\.org\/10\.48550\/arxiv\.(\d{4}\.\d{4,5})(v\d+)?$/i,
      );
    if (doiAliasMatch) {
      const version = doiAliasMatch[2] ?? "";
      return {
        canonicalSourceKey: `arxiv:${doiAliasMatch[1].toLowerCase()}${version.toLowerCase()}`,
        normalizedLocator: `https://arxiv.org/abs/${doiAliasMatch[1]}${version}`,
        ref: null,
        sourceType: canonical.sourceType,
      };
    }
  }
  if (canonical.canonicalSourceKey.startsWith("arxiv:")) {
    const arxivMatch = canonical.canonicalSourceKey.match(
      /^arxiv:((?:\d{4}\.\d{4,5})|(?:[a-z][a-z.-]*\/\d{7}))(v\d+)?$/i,
    );
    if (arxivMatch) {
      return {
        canonicalSourceKey: `arxiv:${arxivMatch[1].toLowerCase()}`,
        normalizedLocator: `https://arxiv.org/abs/${arxivMatch[1]}`,
        ref: null,
        sourceType: canonical.sourceType,
      };
    }
  }
  return canonical;
}
