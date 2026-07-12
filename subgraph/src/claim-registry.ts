import {
  ClaimCreated,
  ClaimRevised,
  ClaimStatusUpdated,
  ResolutionDecisionRecorded,
} from "../generated/ClaimRegistry/ClaimRegistry";
import { Claim, ResolutionDecision } from "../generated/schema";

export function handleClaimCreated(event: ClaimCreated): void {
  const id = event.params.claimId.toString();
  const claim = new Claim(id);
  claim.author = event.params.author;
  claim.domainId = event.params.domainId;
  claim.metadataHash = event.params.metadataHash;
  claim.resolutionModule = event.params.resolutionModule;
  claim.requiredAuthorBond = event.params.requiredAuthorBond;
  claim.status = 0;
  claim.createdAtBlock = event.block.number;
  claim.updatedAtBlock = event.block.number;
  claim.save();
}

export function handleClaimRevised(event: ClaimRevised): void {
  const claim = Claim.load(event.params.newClaimId.toString());
  if (claim === null) return;
  claim.revisionOf = event.params.priorClaimId.toString();
  claim.updatedAtBlock = event.block.number;
  claim.save();
}

export function handleClaimStatusUpdated(event: ClaimStatusUpdated): void {
  const claim = Claim.load(event.params.claimId.toString());
  if (claim === null) return;
  claim.status = event.params.newStatus;
  claim.updatedAtBlock = event.block.number;
  claim.save();
}

export function handleResolutionDecisionRecorded(event: ResolutionDecisionRecorded): void {
  const decision = new ResolutionDecision(event.params.decisionId.toString());
  decision.claim = event.params.claimId.toString();
  decision.replication = event.params.replicationId.toString();
  decision.resolutionModule = event.params.resolutionModule;
  decision.status = event.params.status;
  decision.claimStatus = event.params.claimStatus;
  decision.confidenceBps = event.params.confidenceBps;
  decision.resolutionHash = event.params.resolutionHash;
  decision.evidenceHash = event.params.evidenceHash;
  decision.resolverType = event.params.resolverType;
  decision.actor = event.params.actor;
  decision.createdAtBlock = event.block.number;
  decision.createdAtTimestamp = event.block.timestamp;
  decision.save();
}
