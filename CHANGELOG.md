# Changelog

All notable changes to the `scientific-protocol` package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## Compatibility policy

- **Contract ABIs are the compatibility contract.** Within a minor line (0.x.y), published ABIs
  and deployment metadata for a given network are stable; anything that changes an ABI, an event
  signature, a role constant, or canonical schema semantics bumps the minor version and is called
  out under **ABI changes** below.
- Pre-1.0, minor bumps may break; patch bumps never do. Each release lists what integrators must
  do, or states "no action".
- JSON Schemas in `schemas/` are versioned with the package. Additive, optional fields are patch
  changes; anything else is minor.

## [0.3.0] — Unreleased

### ABI changes

- `BondEscrow` now takes the replication registry as its third constructor argument.
- `reserveBountyPayout` derives the recipient from the named replication and removes the caller-
  supplied recipient argument. Reservations require a matching claim/replication pair, release
  requires a resolved replication, and `cancelReservedPayout` provides terminal cancellation.
- `AgentRegistry.AgentRecord` adds `spentBudget`. Spend limits now cap lifetime consumed value plus
  outstanding reservations and cannot be reduced below that committed amount.
- `ReplicationRegistry` rejects modules that return `false` and exposes replication submitter and
  resolution-state reads through `IReplicationRegistry`.
- `ClaimRegistry` must be bound once to `BondEscrow` and `ReplicationRegistry` with
  `configureProtocolDependencies`. A claim cannot enter `Published` until its complete declared
  author bond is deposited.
- Resolved replications now produce append-only `ResolutionDecision` records through
  `finalizeClaimResolution`. Direct writes to resolution-derived claim statuses are rejected.
- `EpistemicMarket.settleForecast` now accepts the latest claim `resolutionDecisionId`, not a
  caller-supplied resolution status. `ForecastCommitment` and `ForecastSettled` expose that causal
  decision id.

These contracts are non-upgradeable. Existing deployments remain readable history but cannot be
relabelled as 0.3.0. Operators must deploy the complete 0.3.0 contract set and update deployment
metadata. See [docs/migrations/0.3.0.md](docs/migrations/0.3.0.md).

### Added

- A production multi-stage reference-service container with non-root execution, OCI provenance,
  SBOM/attestation release automation, immutable version and commit tags, and a read-only default.
- `scientific-protocol-service` CLI entrypoints for the gateway, migrations, one-shot sync,
  recurring sync, review, replication, and artifact-maintenance workers.
- Explicit `read-only` and `write-enabled` gateway modes, `/livez`, `/readyz`, release provenance,
  and migration-aware readiness.
- Executable JSON Schema compilation and OpenAPI/public-route conformance tests.
- A public canonical resolution-status mapping. `Supported` recommends
  `ProvisionallySupported`, `Qualified` recommends `Qualified`, `Inconclusive` and `Escalated`
  recommend `UnderReplication`, and `Refuted`/`FraudSignal` recommend their matching terminal
  outcome. `Pending` is not finalizable.

### Changed

- The published npm package now includes the compiled reference-service runtime and read-model
  migrations. Service runtime libraries are production dependencies.
- OpenAPI is versioned at 0.3.0 and correctly models GET and POST as operations on `/sources`.
- API processes no longer run migrations implicitly; operators run the explicit migration command
  as a release step.
- Claim publication flows deposit the declared author bond before requesting `Published`. The
  operated submission path fails before creating a claim when a nonzero bond is required but no
  configured signer controls the declared author address.

## [0.2.2] — 2026-07-10

### Added

- User-run review agents can attach bounded, content-addressed JSON result artifacts to signed
  submissions. Gateways retrieve and verify the declared bytes, hash, and size before indexing.
- Inline JSON data artifacts support small self-contained results without giving a gateway storage
  credentials; HTTPS and IPFS references remain available for externally persisted evidence.

### Changed

- Reference review agents now create and sign their own result artifact descriptors. Operator-hosted
  nodes retain server-side persistence as a compatibility fallback.
- No ABI or canonical schema changes. Existing integrators require no action.

## [0.2.1] — 2026-07-10

### Added

- Durable source-publication attempts prevent retries from creating a second onchain claim after
  indexer or database failures.
- The claim feed supports `claimId` filtering and an aggregate `view=record` response for paginated
  claim, artifact, replication, and source reads.

### Changed

- Unsupported binary manuscripts now fail closed instead of producing decoded metadata garbage.
- Public API examples and smoke checks use `api.scientificprotocol.org`.
- No ABI or canonical schema changes. Existing integrators require no action.

## [0.2.0] — 2026-07-06

Protocol source code for the changes below landed in this repository on 2026-07-06; this
repository is now the protocol source of truth (product/operator code lives in the private
`scientific-product` repository).

### ABI changes (integrator action required on next deployment)

- Access control is now OpenZeppelin `AccessControl`: `renounceRole` takes
  `(role, callerConfirmation)`, role errors are `AccessControlUnauthorizedAccount`, and the
  timelock admin role is `DEFAULT_ADMIN_ROLE` (the OZ 4.x `TIMELOCK_ADMIN_ROLE` is gone).
- New `PAUSER_ROLE` guardian can pause deposit-style entry points on `EpistemicMarket`,
  `BondEscrow`, `ClaimRewardVault`, `AgentRegistry`, and `AppealsRegistry`
  (`setDepositsPaused(bool)` / `DepositsPauseSet` event). Withdrawals, settlements, and
  resolutions are never pausable.
- OZ revert strings replaced by OZ 5 custom errors throughout the governance stack
  (`OwnableUnauthorizedAccount`, `GovernorInsufficientProposerVotes`,
  `TimelockUnexpectedOperationState`).

### Added

- `schemas/openapi.yaml`: v0 OpenAPI description of the public gateway read surface and the
  signed public-write envelope.
- Quickstart section in the README (curl → npm → pip in ten minutes).
- PyPI release workflow for `scientific-protocol` (trusted publishing).

## [0.1.1] — 2026-06-19

- First npm release under the public `scientific-protocol` name via trusted publishing.
- Python package v0.1.1 adds canonical `scientific_protocol` import and `scientific-protocol`
  CLI aliases while preserving `scientific_protocol_client` and `sp-agent-client`.
- No ABI changes relative to 0.1.0.

## [0.1.0] — 2026-06

- Initial public protocol release: contracts, canonical JSON schemas, generated bindings,
  TypeScript SDK, Python client, and reference service modules.
