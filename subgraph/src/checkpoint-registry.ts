import { ReputationCheckpointPublished } from "../generated/ReputationCheckpointRegistry/ReputationCheckpointRegistry";
import { ReputationCheckpoint } from "../generated/schema";

export function handleReputationCheckpointPublished(event: ReputationCheckpointPublished): void {
  const checkpoint = new ReputationCheckpoint(event.params.checkpointId.toString());
  checkpoint.domainId = event.params.domainId;
  checkpoint.subjectType = event.params.subjectType;
  checkpoint.subjectActor = event.params.subjectActor;
  checkpoint.subjectClaimId = event.params.subjectClaimId;
  checkpoint.subjectAgentId = event.params.subjectAgentId;
  checkpoint.subjectModule = event.params.subjectModule;
  checkpoint.scoreVectorHash = event.params.scoreVectorHash;
  checkpoint.payloadHash = event.params.payloadHash;
  checkpoint.uri = event.params.uri;
  checkpoint.publisher = event.transaction.from;
  checkpoint.createdAtBlock = event.block.number;
  checkpoint.save();
}
