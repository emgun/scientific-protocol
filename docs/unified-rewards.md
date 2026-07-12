# Unified Claim Rewards

## Purpose

The original MVP bounty flow was deliberately narrow:

- author bond in `BondEscrow`
- replication bounty in `BondEscrow`
- forecast/challenge incentives in `EpistemicMarket`
- agent budgets in `AgentRegistry`
- offchain work value reflected mainly through checkpoints and calibration

That was enough for the first claim -> replication -> resolution loop, but it was not a coherent
value layer for an agent-native protocol.

The protocol now includes a unified, claim-centric reward layer in
[ClaimRewardVault.sol](../contracts/ClaimRewardVault.sol).

## Design goals

- keep claims as the atomic economic object
- let value build continuously over time instead of forcing a one-shot payout
- support all major work families, not just replication
- keep settlement evidence offchain while keeping balances and pool depletion onchain
- make transfer into agent operating capacity seamless
- let open funding act as a first market signal for how much attention a claim deserves

## Core model

Each claim can now hold multiple onchain reward pools, keyed by work kind:

- `review`
- `replication`
- `maintenance`
- `challenge`
- `synthesis`
- `forecast`

Anyone can fund a claim-local work pool with `fundClaimRewards(claimId, workKind)`.

That means value is not determined by a single protocol constant. It is priced, first, by open
funding pressure into each claim/work class pool. A claim that attracts more review funding or
maintenance funding simply has more value available for those work families.

## Continuous accrual

The protocol does not treat reward as a delayed one-time jackpot.

Instead, value accrues through unique settlement entries:

- each settlement consumes some amount from one claim/work pool
- each settlement credits a pull-based recipient balance and optionally an agent budget
- later settlements can continue to accrue against the same work item or the same claim as new
  funding and new evidence arrive

The important unit is not “the final payout.” It is “the next economically justified accrual.”

That lets value grow naturally over epistemic time.

## Pull-based value flow

Reward settlement now has two destinations:

1. `accruedRewardBalances[recipient]`
   - pull-based ETH balance
   - withdrawable with `withdrawAccruedRewards(...)`

2. direct agent budget top-up in `AgentRegistry`
   - the reward vault calls `fundAgentBudget(agentId)` on the registry
   - this increases the agent’s available operating budget immediately

That split is controlled by `budgetTopUpBps` at settlement time.

Examples:

- `0` means all value goes to the recipient’s withdrawable balance
- `10_000` means all value goes directly into the agent budget
- `5_000` means half to the recipient and half to the agent budget

This is the “seamless transfer” path: useful work can directly strengthen the agent’s future
ability to keep working, without forcing every reward through an immediate external withdrawal.

## Onchain vs offchain boundary

Economic state is onchain:

- claim-local pool balances
- settlement uniqueness
- accrued recipient balances
- agent budget top-ups

Heavy scientific evidence stays offchain:

- full review reports
- execution manifests
- maintenance reports
- replication artifacts

This keeps the protocol aligned with the repo’s original constraint: narrow onchain state,
content-addressed artifacts offchain.

## Relation to the older bounty model

[BondEscrow.sol](../contracts/BondEscrow.sol) still exists because the MVP still needs:

- author bonds
- the original escrow primitives
- backwards-compatible low-level escrow tests

But the runtime is no longer built around “resolver drains the remaining replication bounty to the
replicator on success.”

For deployments that still use this legacy bounty path, a reservation is keyed to an existing
claim-local replication, derives its recipient from that replication's submitter, and cannot be
released before the replication is resolved. An escrow administrator may terminally cancel a
mistaken reservation without transferring value. These constraints protect accounting and binding;
they do not define which scientific outcomes deserve payment.

The resolver path now records resolution only. Reward movement is handled by the claim reward
vault and explicit reward settlement.

## Runtime integration

The integrated runtime routes reward movement through [ClaimRewardVault.sol](../contracts/ClaimRewardVault.sol)
and explicit settlement records. Public protocol users interact with the contract and SDK surfaces;
this repository does not expose reward operation as a top-level npm command surface.

Canonical settlement item keys are:

- review-task:<id>
- replication-job:<id>
- artifact-maintenance:<id>
- forecast:<id>
- challenge:<id>

Direct pool funding uses fundClaimRewards(claimId, workKind). Pull-based recipient withdrawal uses
withdrawAccruedRewards(...). The settlement label is part of the uniqueness key: reusing a label
for the same work item is a duplicate settlement, while a new label lets value continue to accrue
over time.

## Automatic reward policy

The automatic policy logic is implemented as reference source, not as a bundled public process
command. Downstream nodes can run their own reward worker against the same policy semantics or
settle manually through the contract and SDK. The policy logic:

- reads completed review, replication, maintenance, forecast, and challenge work from protocol state
- reads the current claim-local pool balance for each work kind from
  [ClaimRewardVault.sol](../contracts/ClaimRewardVault.sol)
- treats live pool balance as the first market signal for how much value is available for a
  claim/work class
- adds attention pressure from forecast and challenge activity where those signals should price
  scrutiny rather than decide truth
- combines that with work-quality inputs such as calibration, confidence, outcome quality, and
  agent capital maturity for agent-performed work
- computes a target total accrual for each eligible work item
- settles only the positive delta between the already accrued total and the newly justified target
- applies a conservative quality floor and redundancy discount so repetitive low-value work cannot
  drain a pool as if each contribution were equally scarce

This is the important shift from one-shot payout logic to continuous market-shaped accrual:
economic value can keep building and settling over time as funding and evidence evolve, without
requiring the protocol to pretend there is one final jackpot moment.

The claim reward read surface exposes the pricing inputs directly:

- per-work-kind market pressure from live pool balance vs funding target
- per-work-kind attention pressure derived from forecast and challenge activity
- current quality floor, base reward, and distribution fraction

## Why this is still market-shaped

The protocol does not let a market vote directly on scientific truth.

Instead:

- markets and sponsors fund claim-local work pools
- those pools price attention and labor
- agents and operators perform work
- the protocol updates claim state from evidence
- reward settlement allocates value from the relevant pool

So:

- markets price work
- evidence changes claim state
- the protocol records economic accrual

## Future Work

This first pass is intentionally narrower than a full autonomous onchain labor market.

Current protocol support:

- onchain claim/work reward pools
- pull-based recipient balances
- seamless agent budget top-ups
- generic reward settlement for review, replication, maintenance, forecast, and challenge items
- automatic delta-based reward policy over review, replication, maintenance, forecast, and
  challenge work
- a first anti-spam pass that discounts repeated same-recipient capture and prices down tiny
  forecast stakes or challenge bonds
- additional identity-sensitive pricing that discounts repeated same-agent capture and fresh review
  agents that have not yet built meaningful calibration history
- agent-capital maturity pricing that discounts agent-performed work when the operator has not yet
  built meaningful budget and spend envelope
- direct-work commitment pricing that discounts review, replication, and maintenance work that is
  not backed by an agent budget at all
- richer market-policy inputs that price forecast/challenge activity using capital at risk,
  participant diversity, and disagreement rather than raw counts alone
- public reward reads for claims, agents, and generic settlement history, plus claim-page
  value-layer surfacing
- a recipient-level reward surface so withdrawable balances and settlement history are visible even
  when value accrues directly to an operator or other payout address
- direct funding and withdrawal scripts plus SDK helpers for the reward vault
- wallet-assisted claim funding and recipient withdrawal in the public claim and recipient pages

What is still later work:

- deeper anti-Sybil and bond policy for broader open participation beyond the current
  recipient-concentration, agent-identity, operator-concentration, calibration-maturity,
  agent-capital, direct-work-commitment, and commitment-size discounts
- still broader reward-policy inputs if the protocol later wants to price more external market
  state than the current forecast/challenge capital and disagreement signals
- broader wallet and client polish on top of the current claim, agent, and recipient reward pages
- optional narrow onchain task markets for objective work

## Bottom line

The protocol now has a unified value layer.

It is claim-centric, continuous, and agent-compatible:

- value can accumulate over time
- rewards are no longer limited to replication
- rewards can strengthen future agent capacity directly
- economic commitments stay onchain without pushing heavy scientific evidence onchain
