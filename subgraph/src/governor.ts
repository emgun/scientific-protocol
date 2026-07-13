import { Bytes } from "@graphprotocol/graph-ts";
import {
  ProposalCanceled,
  ProposalCreated,
  ProposalExecuted,
  ProposalQueued,
} from "../generated/ProtocolGovernor/ProtocolGovernor";
import { GovernanceProposal } from "../generated/schema";

export function handleProposalCreated(event: ProposalCreated): void {
  const proposal = new GovernanceProposal(event.params.proposalId.toString());
  proposal.proposer = event.params.proposer;
  const targets = new Array<Bytes>();
  for (let i = 0; i < event.params.targets.length; i++) targets.push(event.params.targets[i]);
  proposal.targets = targets;
  proposal.values = event.params.values;
  proposal.signatures = event.params.signatures;
  proposal.calldatas = event.params.calldatas;
  proposal.voteStart = event.params.voteStart;
  proposal.voteEnd = event.params.voteEnd;
  proposal.description = event.params.description;
  proposal.status = "created";
  proposal.createdAtBlock = event.block.number;
  proposal.updatedAtBlock = event.block.number;
  proposal.save();
}

export function handleProposalQueued(event: ProposalQueued): void {
  const proposal = GovernanceProposal.load(event.params.proposalId.toString());
  if (proposal === null) return;
  proposal.status = "queued";
  proposal.etaSeconds = event.params.etaSeconds;
  proposal.updatedAtBlock = event.block.number;
  proposal.save();
}

export function handleProposalExecuted(event: ProposalExecuted): void {
  const proposal = GovernanceProposal.load(event.params.proposalId.toString());
  if (proposal === null) return;
  proposal.status = "executed";
  proposal.updatedAtBlock = event.block.number;
  proposal.save();
}

export function handleProposalCanceled(event: ProposalCanceled): void {
  const proposal = GovernanceProposal.load(event.params.proposalId.toString());
  if (proposal === null) return;
  proposal.status = "canceled";
  proposal.updatedAtBlock = event.block.number;
  proposal.save();
}
