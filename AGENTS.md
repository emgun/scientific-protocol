# AGENTS.md — Scientific Protocol

## Mission

Preserve and extend the Scientific Protocol as an Ethereum-aligned, claim-centric protocol for
scientific publication, replication, challenge, coordination, and reward.

The founding mission still matters:

1. register scientific claims
2. bind them to evidence and artifacts via hashes and durable references
3. attach stake, bounties, and other economic commitments
4. allow replication, review, challenge, and related scientific work
5. resolve objective outcomes where possible
6. checkpoint reputation and other derived scores
7. expose clean APIs, events, and signed participation surfaces for downstream apps and agents

The original MVP loop is implemented. Future work should preserve the founding claim-centric
architecture while extending the current protocol safely and coherently.

## Founding principles

- Claims, not papers, are the atomic unit.
- Objective faults should be machine-resolvable where possible.
- Being wrong is not the same as being deceptive.
- Rewards should vest over epistemic time, not all at publication.
- Replication, negative results, and error discovery must be first-class.
- Onchain state should stay narrow; heavy artifacts stay offchain.
- Favor clarity, auditability, and boring correctness over cleverness.

## Original MVP and current state

### Original MVP scope

The original MVP aimed to prove the minimum coherent scientific settlement loop:

- claim registration and versioning
- artifact commitments
- author bonds
- replication bounties and escrow
- replication submission records
- basic objective outcome resolution
- reputation checkpoint ingestion
- read APIs and indexer support
- role-based admin controls with timelock-friendly design

That loop is implemented. Treat it as the historical baseline, not as the current product ceiling.

### Current implemented scope

The public protocol repository should stay centered on the reusable protocol package:

- the core claim -> artifact -> bounty -> replication -> resolution -> checkpoint lifecycle
- contract interfaces, deployment scripts, generated ABI surfaces, and schema definitions
- reference TypeScript modules that help downstream nodes and applications integrate with the
  protocol
- protocol documentation that explains semantics, events, payloads, and trust boundaries

Hosted product interfaces, Vercel configuration, beta rollout evidence, provider-specific runbooks,
and operated-service automation belong in downstream product or deployment repositories.

### Still out of scope or intentionally incomplete

The repository should not silently drift into solving every coordination problem.

Still out of scope, partial, or intentionally non-final:

- a full court or appeals system with rich adversarial procedure
- fully decentralized offchain compute or agent marketplace infrastructure
- ZK proving of every replication or review step
- privacy-preserving data rooms beyond simple interfaces or placeholders
- broad token-launch mechanics or speculative tokenomics redesign
- forcing every adjacent workflow onto the chain when append-only offchain coordination is cleaner

## Current product semantics

A claim is not truth. It is a structured assertion with stake, evidence commitments, work,
evaluation hooks, and lifecycle state.

A source is not the atomic publication object. It is a canonicalized ingress and provenance object
used to discover, snapshot, extract, and publish claims. Claims remain atomic.

A replication is not a comment. It is a typed object tied to a claim, environment description,
outcome classification, and evidence reference.

Review, maintenance, forecast, and challenge work are not generic chatter. They are attributable
protocol actions that should connect back to claim state, routing, and reward policy.

Reputation is not fungible capital. It is a checkpointed score vector by domain and actor.

## Preferred stack

- Solidity (>=0.8.24)
- OpenZeppelin for battle-tested primitives
- Hardhat for compilation, unit tests, local chain, and deployment scripts
- Foundry for fuzz tests, invariant tests, and gas snapshots
- TypeScript for generated bindings, schemas, SDK helpers, and reference modules
- Viem / Wagmi-compatible ABI generation
- JSON Schema for canonical payload definitions
- CI via GitHub Actions

## Architecture constraints

- Canonical chain target: Base-like Ethereum L2
- Contracts must remain portable to a future OP Stack appchain
- Storage layer should use content-addressed artifacts; store only hashes or URIs onchain
- Reputation should be checkpointed, not fully recomputed onchain
- Contract APIs must stay simple enough to index reliably
- Favor append-only history and immutable IDs over mutable in-place edits
- Treat read APIs, indexers, and worker loops as replaceable operated services, not as protocol
  truth anchors
- Prefer signed wallet-attributable public and operator actions over centralized bearer-token
  authority

## Repo conventions

Use this high-level repository structure:

- `contracts/`
- `script/`
- `test/`
- `src/generated/`
- `src/sdk/`
- `src/shared/`
- `schemas/`
- `docs/`
- `ops/`

## Coding rules

- Write small, composable contracts with explicit interfaces.
- Every contract needs NatSpec comments.
- Every state transition should emit a strongly named event.
- Favor custom errors over string reverts.
- Keep role boundaries explicit.
- Use pull-based payouts where practical.
- Include pause or guardian hooks only where genuinely useful.
- Avoid hidden magic constants; centralize protocol parameters.
- Prefer explicit enums and structs over opaque bytes blobs unless a strong reason exists.
- Build for testability first.

## Testing rules

For any non-trivial change, include:

- unit tests
- failure-path tests
- event assertions
- role and authorization tests
- property or invariant tests where relevant

Before considering a milestone done:

- all tests pass
- lint and formatting pass
- affected local end-to-end flow works
- docs, schemas, and ABIs are updated where applicable

## Security rules

Never:

- rely on timestamps for critical fairness without windows and tolerances
- assume offchain services are honest
- let a single privileged role unilaterally rewrite scientific outcomes
- mix accounting concerns into registries if separation is cleaner
- leave payout edge cases ambiguous
- allow unchecked reentrancy around value transfers

Always:

- protect escrow and payout flows
- design for replay resistance on signed offchain payloads
- validate enum transitions
- validate claim, source, replication, and work-item IDs exist before acting
- include emergency controls with constrained scope
- document trust assumptions near the code they affect

## Current operating guidance

When extending the protocol, use these current-state rules:

- keep claims as the canonical scientific object; do not reframe the system around papers or feeds
- treat sources as ingress and provenance objects that can lead to claims, not as replacements for
  claims
- prefer the generalized work runtime for new claim-local work where that unification is actually
  useful
- keep signed public-write and signed operator flows as protocol payload patterns, while hosted
  mutation services remain downstream deployment choices
- preserve the separation between protocol-authoritative state and replaceable operated services
- keep the public npm script surface small: build, lint, typecheck, test, local node, deploy, gas
  snapshot/check, contract generation, and env validation
- do not silently invent new tokenomics, governance powers, or market truth-voting
- do not broaden onchain state when an append-only, inspectable offchain artifact or read model is
  cleaner

## Definition of done for current changes

Changes are done when they strengthen the current protocol without regressing the founding mission.

That normally means:

1. the change fits the claim-centric architecture and current authority boundaries
2. tests and verification cover the affected behavior
3. local read, write, or workflow surfaces still make sense end to end
4. docs reflect the implemented behavior instead of older roadmap language
5. new functionality composes with existing source, claim, work, artifact, governance, and reward
   surfaces instead of creating avoidable silos

## When blocked

If a requirement is ambiguous:

1. prefer the simpler architecture
2. preserve upgrade and extension points
3. record the assumption in docs
4. do not silently invent tokenomics or governance power
5. prefer implemented runtime behavior over stale roadmap or MVP-era wording
