# ADR 0001: Preserve the v0.2 default deployment surface pending a versioned core split

- Status: Accepted
- Date: July 12, 2026

## Context

The default deploy script currently deploys `EpistemicMarket` and `AppealsRegistry` together with
the claim, artifact, replication, checkpoint, escrow, reward, access, treasury, and governance
contracts. Both optional systems are also required fields in the deployment manifest and are
consumed by the SDK, indexer, API, and existing testnet tooling.

The protocol-hardening roadmap questions whether markets and appeals belong in the minimum
production core. Removing them from the current deploy script alone would silently break the
published deployment shape without defining optional-address semantics, indexer behavior, or a
migration path. It would also be a governance and product-scope decision rather than a local
security correction.

## Decision

Keep the v0.2 default deployment surface intact for compatibility. The escrow, resolution-module,
and agent-budget corrections in this release require a new non-upgradeable deployment, but they do
not silently remove or redesign markets, appeals, governance, or treasury authority.

Before a vNext ABI freeze, decide explicitly whether `EpistemicMarket` and `AppealsRegistry` are:

1. required core contracts with complete causal links to canonical resolution decisions; or
2. experimental optional modules with nullable deployment-manifest addresses, feature discovery,
   conditional indexer/API wiring, and separate deployment flags.

Until that decision is implemented end to end, deployments must label market and appeal outcomes
as separate protocol records rather than implying that they supersede claim resolution.

## Consequences

- Existing deployment consumers retain a stable manifest shape.
- This hardening slice does not invent governance powers or appeal effects.
- Market and appeal contracts remain deployed by default and therefore remain within external
  audit scope.
- A future optional-module split is intentionally versioned and must update deployment schemas,
  generated clients, indexers, APIs, documentation, and migration guidance together.
