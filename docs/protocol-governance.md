# Protocol Governance

Scientific Protocol now includes a timelocked DAO layer for administrative control.

## Scope

The DAO governs:

- protocol parameter updates
- resolution-module assignments
- role grants and revocations through `AccessController`
- treasury disbursements
- governance settings such as quorum, voting delay, and voting period

The DAO does not directly determine scientific truth.

Scientific outcomes still flow through:

- claim lifecycle rules
- domain-specific resolution modules
- resolver roles
- checkpoint publication

This separation is intentional. Governance can control who has authority and how the protocol is administered, but it does not replace replication-first resolution.

## Contracts

- [ProtocolGovernanceToken.sol](../contracts/ProtocolGovernanceToken.sol)
- [ProtocolTimelock.sol](../contracts/ProtocolTimelock.sol)
- [ProtocolGovernor.sol](../contracts/ProtocolGovernor.sol)
- [ProtocolTreasury.sol](../contracts/ProtocolTreasury.sol)

## Governance Model

The governance stack is:

1. a non-transferable voting token
2. a timelock that owns sensitive admin power
3. a governor that proposes, votes, queues, and executes timelocked actions
4. a treasury owned by the timelock

Bootstrap voting units are intentionally non-transferable. This avoids silently introducing a liquid governance asset or premature tokenomics while still allowing the protocol to move admin power out of a single operator key.

## Bootstrap Handoff

Local and staging deployment now perform this handoff:

1. deploy core protocol contracts
2. deploy governance token, timelock, governor, and treasury
3. mint bootstrap voting units to configured operator accounts
4. grant the timelock proposer/canceller integration with the governor
5. grant the timelock `DEFAULT_ADMIN_ROLE`, `PARAMETER_ADMIN_ROLE`, and `MODULE_ADMIN_ROLE`
6. transfer token ownership and treasury ownership to the timelock
7. revoke the deployer's sensitive admin roles
8. retain operational roles such as resolver/checkpoint publisher on the existing operator accounts

That leaves governance in control of sensitive administration without breaking the existing resolver and demo flows.

## Deployment Knobs

The deploy script reads these optional governance settings:

- `SP_GOVERNANCE_TOKEN_NAME`
- `SP_GOVERNANCE_TOKEN_SYMBOL`
- `SP_GOVERNANCE_TIMELOCK_DELAY_SECONDS`
- `SP_GOVERNANCE_VOTING_DELAY_BLOCKS`
- `SP_GOVERNANCE_VOTING_PERIOD_BLOCKS`
- `SP_GOVERNANCE_PROPOSAL_THRESHOLD`
- `SP_GOVERNANCE_QUORUM_PERCENT`
- `SP_GOVERNANCE_BOOTSTRAP_VOTE_AMOUNT`
- `SP_GOVERNANCE_TREASURY_BOOTSTRAP_ETH`

These control only governance bootstrap configuration. They do not imply a public token launch.

## Trust Assumptions

- The timelock is the executor of sensitive admin actions.
- The governor is expected to be the only proposer/canceller after bootstrap.
- Governance can reconfigure protocol authority, so voting-unit distribution is security-critical.
- Governance is for administration and treasury control, not for arbitrary rewriting of historical scientific records.

## Test Coverage

Governance coverage lives in [ProtocolGovernance.ts](../test/ProtocolGovernance.ts).

The tests cover:

- batched proposal execution across parameters, roles, modules, and treasury
- non-transferable voting units
- timelock-owned treasury control
- proposal threshold enforcement
- timelock delay enforcement

## Governance Read Surface

The reference API exposes governance directly:

- `GET /governance`
- `GET /governance/events`
- `GET /governance/treasury`
- `GET /governance/proposals`
- `GET /governance/proposals/:proposalId`

This surface is intentionally read-only. It makes the governor, timelock, treasury, proposal
queue, recent lifecycle activity, vote totals, claim-local reward budgets, and treasury/reward-vault
capital split inspectable without treating governance as the primary claim workflow.

The local MVP seed now also creates, votes, queues, and executes one harmless governance proposal
so this surface comes up with representative activity in demo environments.
