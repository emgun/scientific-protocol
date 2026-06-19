import type { ClaimWorkItemView } from "./types.js";

function timestampForItem(item: ClaimWorkItemView): string {
  return item.updatedAt ?? item.createdAt;
}

export function compareClaimWorkItemsForSelection(
  left: ClaimWorkItemView,
  right: ClaimWorkItemView,
): number {
  if (left.scheduling.needsMinimumCoverage !== right.scheduling.needsMinimumCoverage) {
    return left.scheduling.needsMinimumCoverage ? -1 : 1;
  }
  if (left.scheduling.reassignmentPreferred !== right.scheduling.reassignmentPreferred) {
    return left.scheduling.reassignmentPreferred ? -1 : 1;
  }
  if (left.scheduling.prefersFreshContributor !== right.scheduling.prefersFreshContributor) {
    return left.scheduling.prefersFreshContributor ? -1 : 1;
  }
  if (left.scheduling.needsRedundantCoverage !== right.scheduling.needsRedundantCoverage) {
    return left.scheduling.needsRedundantCoverage ? -1 : 1;
  }
  if (left.scheduling.desiredAdditionalClaims !== right.scheduling.desiredAdditionalClaims) {
    return right.scheduling.desiredAdditionalClaims - left.scheduling.desiredAdditionalClaims;
  }
  if (left.routing.priorityBps !== right.routing.priorityBps) {
    return right.routing.priorityBps - left.routing.priorityBps;
  }
  const leftUpdated = timestampForItem(left);
  const rightUpdated = timestampForItem(right);
  if (leftUpdated !== rightUpdated) {
    return rightUpdated.localeCompare(leftUpdated);
  }
  return left.itemId.localeCompare(right.itemId);
}
