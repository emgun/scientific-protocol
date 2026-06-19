export enum ClaimStatus {
  Draft = "Draft",
  Published = "Published",
  UnderReplication = "UnderReplication",
  ProvisionallySupported = "ProvisionallySupported",
  Qualified = "Qualified",
  Refuted = "Refuted",
  Fraudulent = "Fraudulent",
  Deprecated = "Deprecated",
}

export enum ResolutionStatus {
  Pending = "Pending",
  Supported = "Supported",
  Qualified = "Qualified",
  Inconclusive = "Inconclusive",
  Refuted = "Refuted",
  FraudSignal = "FraudSignal",
  Escalated = "Escalated",
}

export enum CheckpointSubjectType {
  Actor = "actor",
  Claim = "claim",
  ActorClaimPair = "actorClaimPair",
  Agent = "agent",
  Module = "module",
}

export type ResolutionModuleShape = {
  status: ResolutionStatus;
  confidenceBps: number;
  resolutionHash: string;
  resolverType: string;
  evidenceHash: string;
  evidenceURI: string | null;
};
