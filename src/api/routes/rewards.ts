import { json } from "../http.js";
import { parseIntegerParam } from "../params.js";
import {
  buildAgentRewardStatePayload,
  buildClaimRewardStatePayload,
  buildRecipientRewardStatePayload,
  buildRewardProtocolConfigPayload,
  buildRewardSettlementHistoryPayload,
} from "../read-payloads.js";
import type { RouteContext } from "./context.js";

export async function handleRewardRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, deploymentPath, env, pool, response, url } = context;
  if (url.pathname === "/reward-config") {
    json(response, 200, await buildRewardProtocolConfigPayload(deploymentPath, env));
    return true;
  }
  if (url.pathname === "/reward-settlements") {
    json(
      response,
      200,
      await buildRewardSettlementHistoryPayload(dependencies, pool, {
        agentId: url.searchParams.get("agentId") ?? undefined,
        claimId: url.searchParams.get("claimId") ?? undefined,
        itemId: url.searchParams.get("itemId") ?? undefined,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        policyVersion: url.searchParams.get("policyVersion") ?? undefined,
        recipient: url.searchParams.get("recipient") ?? undefined,
        workKind: url.searchParams.get("workKind") as
          | "challenge"
          | "forecast"
          | "maintenance"
          | "replication"
          | "review"
          | "synthesis"
          | undefined,
      }),
    );
    return true;
  }
  const claimRewardsMatch = url.pathname.match(/^\/claims\/(\d+)\/rewards$/);
  if (claimRewardsMatch) {
    const claim = await dependencies.readClaim(pool, claimRewardsMatch[1]);
    if (!claim) {
      json(response, 404, { error: "claim_not_found" });
      return true;
    }
    json(
      response,
      200,
      await buildClaimRewardStatePayload(
        dependencies,
        pool,
        deploymentPath,
        claimRewardsMatch[1],
        {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          policyVersion: url.searchParams.get("policyVersion") ?? undefined,
          workKind: url.searchParams.get("workKind") ?? undefined,
        },
        {},
        env,
      ),
    );
    return true;
  }
  const agentRewardsMatch = url.pathname.match(/^\/agents\/(\d+)\/rewards$/);
  if (agentRewardsMatch) {
    const payload = await buildAgentRewardStatePayload(
      dependencies,
      pool,
      deploymentPath,
      agentRewardsMatch[1],
      {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        policyVersion: url.searchParams.get("policyVersion") ?? undefined,
        workKind: url.searchParams.get("workKind") ?? undefined,
      },
      env,
    );
    if (!payload) {
      json(response, 404, { error: "agent_not_found" });
      return true;
    }
    json(response, 200, payload);
    return true;
  }

  const recipientRewardsMatch = url.pathname.match(/^\/recipients\/(0x[a-fA-F0-9]{40})\/rewards$/);
  if (recipientRewardsMatch) {
    json(
      response,
      200,
      await buildRecipientRewardStatePayload(
        dependencies,
        pool,
        deploymentPath,
        recipientRewardsMatch[1],
        {
          itemId: url.searchParams.get("itemId") ?? undefined,
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          policyVersion: url.searchParams.get("policyVersion") ?? undefined,
          workKind: url.searchParams.get("workKind") ?? undefined,
        },
        env,
      ),
    );
    return true;
  }

  return false;
}
