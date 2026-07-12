import { BigInt } from "@graphprotocol/graph-ts";
import {
  AgentBudgetConsumed,
  AgentBudgetDeposited,
  AgentBudgetReleased,
  AgentBudgetReserved,
  AgentBudgetWithdrawn,
  AgentRegistered,
  AgentSpendLimitUpdated,
  AgentStatusUpdated,
} from "../generated/AgentRegistry/AgentRegistry";
import { Agent } from "../generated/schema";

function loadAgent(id: BigInt): Agent | null {
  return Agent.load(id.toString());
}

export function handleAgentRegistered(event: AgentRegistered): void {
  const agent = new Agent(event.params.agentId.toString());
  agent.operator = event.params.operator;
  agent.metadataHash = event.params.metadataHash;
  agent.uri = event.params.uri;
  agent.spendLimit = event.params.spendLimit;
  agent.budgetBalance = BigInt.zero();
  agent.reservedBudget = BigInt.zero();
  agent.spentBudget = BigInt.zero();
  agent.active = true;
  agent.createdAtBlock = event.block.number;
  agent.updatedAtBlock = event.block.number;
  agent.save();
}

export function handleAgentStatusUpdated(event: AgentStatusUpdated): void {
  const agent = loadAgent(event.params.agentId);
  if (agent === null) return;
  agent.active = event.params.active;
  agent.updatedAtBlock = event.block.number;
  agent.save();
}

export function handleAgentSpendLimitUpdated(event: AgentSpendLimitUpdated): void {
  const agent = loadAgent(event.params.agentId);
  if (agent === null) return;
  agent.spendLimit = event.params.newSpendLimit;
  agent.updatedAtBlock = event.block.number;
  agent.save();
}

export function handleAgentBudgetDeposited(event: AgentBudgetDeposited): void {
  const agent = loadAgent(event.params.agentId);
  if (agent === null) return;
  agent.budgetBalance = agent.budgetBalance.plus(event.params.amount);
  agent.updatedAtBlock = event.block.number;
  agent.save();
}

export function handleAgentBudgetReserved(event: AgentBudgetReserved): void {
  const agent = loadAgent(event.params.agentId);
  if (agent === null) return;
  agent.reservedBudget = agent.reservedBudget.plus(event.params.amount);
  agent.updatedAtBlock = event.block.number;
  agent.save();
}

export function handleAgentBudgetReleased(event: AgentBudgetReleased): void {
  const agent = loadAgent(event.params.agentId);
  if (agent === null) return;
  agent.reservedBudget = agent.reservedBudget.minus(event.params.amount);
  agent.updatedAtBlock = event.block.number;
  agent.save();
}

export function handleAgentBudgetConsumed(event: AgentBudgetConsumed): void {
  const agent = loadAgent(event.params.agentId);
  if (agent === null) return;
  agent.reservedBudget = agent.reservedBudget.minus(event.params.amount);
  agent.budgetBalance = agent.budgetBalance.minus(event.params.amount);
  agent.spentBudget = agent.spentBudget.plus(event.params.amount);
  agent.updatedAtBlock = event.block.number;
  agent.save();
}

export function handleAgentBudgetWithdrawn(event: AgentBudgetWithdrawn): void {
  const agent = loadAgent(event.params.agentId);
  if (agent === null) return;
  agent.budgetBalance = agent.budgetBalance.minus(event.params.amount);
  agent.updatedAtBlock = event.block.number;
  agent.save();
}
