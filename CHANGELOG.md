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

## [Unreleased]

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
- PyPI release workflow for `scientific-protocol-client` (trusted publishing).

## [0.1.1] — 2026-06-19

- First npm release under the public `scientific-protocol` name via trusted publishing.
- No ABI changes relative to 0.1.0.

## [0.1.0] — 2026-06

- Initial public protocol release: contracts, canonical JSON schemas, generated bindings,
  TypeScript SDK, Python client, and reference service modules.
