import { getRpcUrl } from "../../shared/contracts.js";
import { json } from "../http.js";
import { parseGovernanceProposalState, parseIntegerParam } from "../params.js";
import type { RouteContext } from "./context.js";

export async function handleGovernanceRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, deploymentPath, env, pool, response, url } = context;
  if (url.pathname === "/governance") {
    json(response, 200, await dependencies.readGovernanceOverview(deploymentPath, getRpcUrl(env)));
    return true;
  }

  if (url.pathname === "/governance/events") {
    json(
      response,
      200,
      await dependencies.readGovernanceEvents(
        {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          proposalId: url.searchParams.get("proposalId") ?? undefined,
        },
        deploymentPath,
        getRpcUrl(env),
      ),
    );
    return true;
  }

  if (url.pathname === "/governance/treasury") {
    json(
      response,
      200,
      await dependencies.readGovernanceTreasury(
        pool,
        {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
        },
        deploymentPath,
        getRpcUrl(env),
      ),
    );
    return true;
  }

  if (url.pathname === "/governance/proposals") {
    json(
      response,
      200,
      await dependencies.readGovernanceProposals(
        {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          state: parseGovernanceProposalState(url),
        },
        deploymentPath,
        getRpcUrl(env),
      ),
    );
    return true;
  }

  const governanceProposalMatch = url.pathname.match(/^\/governance\/proposals\/([^/]+)$/);
  if (governanceProposalMatch) {
    const detail = await dependencies.readGovernanceProposalDetail(
      decodeURIComponent(governanceProposalMatch[1]),
      {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
      },
      deploymentPath,
      getRpcUrl(env),
    );
    if (!detail) {
      json(response, 404, { error: "governance_proposal_not_found" });
      return true;
    }
    json(response, 200, detail);
    return true;
  }

  return false;
}
