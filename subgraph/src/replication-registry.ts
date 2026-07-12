import {
  ReplicationResolved,
  ReplicationSubmitted,
} from "../generated/ReplicationRegistry/ReplicationRegistry";
import { Replication } from "../generated/schema";

export function handleReplicationSubmitted(event: ReplicationSubmitted): void {
  const replication = new Replication(event.params.replicationId.toString());
  replication.claim = event.params.claimId.toString();
  replication.replicator = event.params.replicator;
  replication.agentId = event.params.agentId;
  replication.resultHash = event.params.resultHash;
  replication.submittedAtBlock = event.block.number;
  replication.save();
}

export function handleReplicationResolved(event: ReplicationResolved): void {
  const replication = Replication.load(event.params.replicationId.toString());
  if (replication === null) return;
  replication.outcome = event.params.outcome;
  replication.resolutionStatus = event.params.status;
  replication.resolutionHash = event.params.resolutionHash;
  replication.resolver = event.params.resolver;
  replication.confidenceBps = event.params.confidenceBps;
  replication.resolverType = event.params.resolverType;
  replication.evidenceHash = event.params.evidenceHash;
  replication.evidenceURI = event.params.evidenceURI;
  replication.resolvedAtBlock = event.block.number;
  replication.save();
}
