import type { Pool } from "pg";
import { readArtifactsByClaim, readClaim } from "../indexer/store.js";
import { defaultReviewConsensusPolicy, requiredCapabilitiesForReviewTask } from "../work/policy.js";
import { defaultReviewTaskTypesForClaim } from "./aggregation.js";
import { createReviewTask } from "./store.js";
import type { ReviewTaskView } from "./types.js";

export async function openDefaultReviewTasksForClaim(
  pool: Pool,
  input: {
    claimId: string;
    requestedBy: string;
  },
): Promise<ReviewTaskView[]> {
  const claim = await readClaim(pool, input.claimId);
  if (!claim) {
    throw new Error("claim_not_found");
  }

  const artifacts = await readArtifactsByClaim(pool, input.claimId);
  const taskTypes = defaultReviewTaskTypesForClaim(artifacts);
  const tasks: ReviewTaskView[] = [];
  for (const taskType of taskTypes) {
    tasks.push(
      await createReviewTask(pool, {
        claimId: input.claimId,
        consensusPolicy: defaultReviewConsensusPolicy(taskType),
        requestedBy: input.requestedBy,
        requiredCapabilities: requiredCapabilitiesForReviewTask(taskType),
        scopeKey: taskType,
        taskType,
      }),
    );
  }

  return tasks;
}
