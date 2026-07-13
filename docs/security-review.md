# Security Review

Date: April 23, 2026 (updated July 12, 2026 after the escrow, resolution, and agent-budget hardening pass)

Use [current-state.md](./current-state.md) for the canonical architecture narrative. This
document is narrower: it captures the current security posture and the still-open security work for
protocol deployments.

## Scope

This review covers the current protocol surface, not just the original MVP contract set.

That includes:

- the core contract stack
- source-centric ingress and claim publication paths
- wallet-signed public writes
- wallet-signed operator lifecycle writes
- artifact persistence and verification
- the offchain operator workflows that index, process, resolve, checkpoint, and repair state

The chain remains the canonical source of truth for claim, replication, checkpoint, governance,
and settlement state. Offchain services improve availability and workflow throughput, but they are
not the authority boundary.

## Checklist

### Reentrancy and value transfer

- `BondEscrow`, `AgentRegistry`, and `ClaimRewardVault` use reentrancy guards on
  value-moving paths.
- Value transfers occur after state updates in those contracts.
- The unified reward layer uses pull-based recipient withdrawals through `ClaimRewardVault`.
- `BondEscrow` still retains older push-style bond and bounty release paths for legacy escrow
  flows. Production hardening should keep narrowing those remaining push-style paths or define a
  stricter recipient-failure policy around them.

### Authorization and write attribution

- Resolver, checkpoint publisher, escrow admin, parameter admin, market settler, and court actions
  are role-gated through `AccessController`.
- Public claim and source lifecycle writes now use signed envelopes rather than relying on demo
  routes.
- Replication submission, resolution submission, and checkpoint publication use signed
  operator-request envelopes with reserved nonces and persisted payload artifacts before chain
  submission.
- Operator routes can still expose a bearer-token compatibility fallback, but public deployments
  should treat that path as disabled-by-default and non-canonical.
- Sandbox admin routes are explicitly separate from production writes and should not be treated as
  part of production correctness.

### Accounting and settlement safety

- Author bond, bounty balance, and reserved bounty balance are tracked separately.
- Reservations are single-use and cannot be released twice.
- Reservation amount cannot exceed currently unreserved bounty balance.
- Bounty reservations are bound to an existing replication under the named claim. The recipient
  is derived from the replication submitter instead of supplied by the escrow administrator.
- Reserved bounty can be released only after the replication has a recorded resolution. An escrow
  administrator can terminally cancel an unreleased reservation without moving value.
- Author bond slash and refund paths cannot exceed the tracked bond balance.
- Reward settlements now have explicit settlement entries and pull-based withdrawal paths in the
  newer unified reward layer.
- Forecast settlement requires the reveal window to be closed for unrevealed forecasts, and
  unrevealed forecasts always forfeit their stake to the reward pool. Refunding them would allow
  committing opposite forecasts and revealing only the winner.
- Revealed forecasts that the settler never settles can be reclaimed (stake only, no bonus) after
  a long settler-inactivity delay.
- Challenge bonds stay committed for a minimum challenge duration, so a challenger cannot rescue a
  bond by withdrawing just ahead of a dismissal.
- Appeal bonds are outcome-dependent: lost appeals (`Rejected`, `Upheld`) forfeit to the protocol
  treasury, won or closed appeals are credited for pull-based withdrawal, so a reverting appellant
  contract cannot block adjudication.
- New claims enforce a governance-set minimum author bond read from `ProtocolParameters`, and the
  complete claim-declared bond must be deposited before the claim can become `Published`.
- Challenges and appeals validate that referenced replication and challenge ids belong to the
  named claim before accepting value.
- Resolution modules can be disabled by the module admin without rewriting claims already bound to
  them.
- Resolution modules may reject by reverting or by returning `false`; either path leaves the
  replication unresolved.
- Resolution-derived claim statuses cannot be written directly. `ClaimRegistry` copies the result,
  confidence, evidence, resolver type, module, replication, and claim linkage into an immutable
  `ResolutionDecision`; later decisions remain recordable even when they cannot validly rewrite a
  stronger or terminal claim state.
- The latest recorded decision is only the append-only evidence tail. A separate effective decision
  pointer advances exclusively when a decision establishes new claim state. A forecast snapshots
  the effective pointer at commitment and can settle only against a strictly newer pointer, so
  known outcomes cannot extract bonuses and later weaker evidence cannot reverse value settlement.
- Operational `BOUNTY_SETTLER_ROLE` authority is limited to replication-bound reserve and release.
  Timelocked `ESCROW_ADMIN_ROLE` controls terminal cancellation and author-bond movement; refunds
  are fixed to the claim author and slashes are fixed to the immutable protocol treasury.
- Delegated claim creation binds each signed request hash to one onchain claim id. Renewable service
  leases fence stale workers before chain writes; the onchain mapping is the final duplicate barrier.
- Outbound HTTP transport pins every redirect hop to the exact DNS addresses that passed validation.
- Repository ingestion passes the validated address to Git/libcurl and persists that pin in the
  partial clone, so later promisor-object reads cannot independently re-resolve the hostname.
- Exact source-submit recovery binds one request hash to one submission row. Accepted replays
  reconstruct that row without consuming quotas or rewriting acceptance; pending and rejected
  replays remain fenced and consume the configured client, actor, and canonical-source limits.
- An agent spend limit is a lifetime ceiling over consumed value plus live reservations. Releasing
  a reservation restores capacity, while consuming it permanently uses capacity. Raising the
  ceiling is an explicit operator action; it cannot be lowered below committed value.

### Lifecycle safety

- `ClaimRegistry` enforces an explicit status transition graph.
- `ClaimRegistry` is bound once to the escrow and replication registry. This circular deployment
  dependency is explicit and must be configured before deployment administration is renounced.
- `ReplicationRegistry` prevents resolving a replication twice and validates module-specific status
  and resolver-type combinations before storing the result.
- `ReputationCheckpointRegistry` validates claim, agent, and module subjects before publishing
  checkpoints.
- Source ingestion and source publication are gated by canonicalization, deduplication, signed
  requests, and explicit policy decisions before a published claim is created.

### Event completeness and auditability

- Core settlement transitions emit events and are projected by the indexer.
- Offchain operator actions have relational audit trails in Postgres:
  - replication job submissions
  - resolution runs
  - checkpoint publications
  - source publication decisions
- Artifact ingestion, extraction, and repair flows persist supporting artifacts that can be
  inspected offchain even when the chain remains the canonical lifecycle record.

### Artifact integrity and offchain trust assumptions

- Artifact integrity is protected by content hashing and verification before downstream workflows
  consume persisted artifacts.
- The repository supports IPFS for canonical artifact storage plus filesystem, HTTP object-store
  style, S3-compatible, and GCS backends for local or mirrored storage.
- Availability remains an operator concern. Production deployment should use redundant IPFS pinning
  and retention controls rather than a single gateway.
- Resolver, checkpoint publisher, indexer, and artifact persistence are still semi-trusted
  operated services. They are replaceable, but they can still fail or disappear.
- Recovery, alerting, backups, and incident response remain deployment responsibilities for
  downstream operators. Those runbooks belong with the operated product or node deployment, not in
  the public protocol package.
- Local runtime state such as `ops/runtime/`, `ops/artifact-store/`, `ops/postgres-data/`, and
  `.conda/` is intentionally ignored in Git. Production release and deployment workflows should
  preserve that boundary and never package local credentials, runtime logs, or local data
  directories into shipped artifacts.

## Findings

### Acceptable for the current launch posture

- role-gated contract authority through `AccessController`
- signed public-write and signed operator-write attribution
- auditable chain writes with stored request and run artifacts
- content-addressed artifact persistence with verification
- unified reward withdrawals through pull-based recipient flows
- explicit sandbox isolation instead of treating demo admin routes as production writes

### Still recommended before public production rollout

- independent contract and property review
- further reduction of legacy `BondEscrow` push-style release reliance, or a stronger
  recipient-failure policy around those paths
- broader invariant and fuzz coverage beyond the current targeted hardening tests
- explicit threat models for resolver compromise, checkpoint compromise, and malicious operator
  inactivity
- explicit threat models for artifact-store compromise across HTTP, S3-compatible, GCS, and IPFS
  mirror backends
- deployment verification that ignored local runtime credentials and logs cannot leak into images,
  bundles, or backup exports by accident

## Security reading order

If you are trying to understand the whole system, use this order:

1. [current-state.md](./current-state.md)
2. this document

This page should not be read as the canonical architecture summary.
