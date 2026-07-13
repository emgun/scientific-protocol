# Current State

Scientific Protocol is an implemented claim-centric protocol. It supports the full claim lifecycle:
registration, artifact commitments, stake and bounties, replication records, objective resolution,
reputation checkpoints, source ingress, claim-local work, agent attribution, governance, and reward
settlement.

## Protocol Authority

Protocol truth is anchored by:

- onchain contracts and events
- content-addressed artifact commitments
- signed public-write and operator envelopes
- explicit role boundaries
- checkpointed reputation and derived read models

The reference indexer, API, workers, databases, and storage integrations are operated services. They
make a deployment usable, but they are replaceable and should not be treated as scientific truth.

## Implemented Layers

### Contracts

The Solidity system includes claim, artifact, replication, appeal, resolution-module, access,
governance, treasury, reward, reputation checkpoint, and market-related contracts. Contracts are
portable to Base-like Ethereum L2 deployments and are structured for future OP Stack appchain
portability.

The legacy bounty path binds reservations to a claim-local replication and its recorded replicator,
requires resolution before release, and supports terminal cancellation. Agent budget spend limits
are lifetime ceilings over consumed value plus outstanding reservations. These semantics are part
of the contract ABI and require a new deployment rather than an in-place change to earlier
non-upgradeable deployments.

Operational bounty settlement is separated from author-bond custody. `BOUNTY_SETTLER_ROLE` may
reserve and release only replication-bound payouts; cancellation, treasury-only slashing, and
author-only refund credits require timelocked `ESCROW_ADMIN_ROLE`. Credited authors withdraw through
a pull-based path to their chosen valid recipient; the administrator cannot select that recipient.

Publication is economically gated: the complete author-declared bond must be present before a
claim enters `Published`. Resolution is evidence-linked through append-only `ResolutionDecision`
records copied from resolved replications. Direct writes cannot manufacture outcome-derived claim
states, and forecast settlement references a newer effective claim decision instead of accepting a
second status input. Each forecast snapshots the effective decision at commitment, preventing
known-outcome commitments from extracting the bonus pool. Multiple replication decisions remain
auditable; claim status only moves along valid forward transitions. Once an unrevealed forecast's
deadline passes, anyone may terminally forfeit its stake to the reward pool without waiting for a
claim decision. This liveness path preserves the commitment scheme's no-free-option property.
Matched forecast settlement, delayed forecast reclaim, challenge withdrawal, and successful or
escalated challenge resolution credit a beneficiary-owned market balance instead of pushing ETH.
The beneficiary later withdraws to a chosen valid recipient, so recipient behavior cannot block a
terminal market transition.

### Schemas and Clients

Canonical JSON schemas define claim, replication, evaluation, and artifact storage payloads. The
TypeScript SDK, generated bindings, and Python client provide developer integration surfaces.
The repository also includes a deployment-generated Graph subgraph covering core claim, artifact,
replication, canonical decision, checkpoint, agent, and governance events. It provides an
independently operated query surface without becoming a truth anchor.

### Reference Services

The repository includes a reference API, indexer, resolver, checkpoint publisher, reputation
calculator, review runtime, reward settlement helpers, artifact maintenance workers, source
ingestion, and work orchestration services.

These services are deliberately replaceable. A third-party deployment can run them as provided, swap
individual services, or build its own API on top of the contracts, events, schemas, and artifacts.

### Source Ingress

Sources are ingress and provenance objects, not replacements for claims. Source records can be
canonicalized, snapshot, extracted into candidate claims, and manually confirmed or rejected.

### Claim-Local Work

Review, replication, maintenance, challenge, and other work items attach to claims. Work routing,
agent attribution, budgets, signed participation, and reward policies are implemented in the
reference runtime.

### Artifact Durability

Artifacts support content-addressed persistence, staged ingest, audit history, repair tasks,
provider metadata, storage policies, and storage attestations. Heavy data stays offchain; hashes and
references connect it back to protocol state.

### Governance

The governance stack includes a token, governor, timelock, treasury, public read model, and role
signer checks. Governance controls protocol administration and treasury operations. It does not
replace evidence-based scientific resolution.

## Ecosystem Integration

Applications and agent systems can integrate through package releases, generated ABIs, schemas,
deployment metadata, direct wallet flows, or a deployed reference API. The protocol surface is built
to support multiple independent application, indexing, storage, and automation layers.

The packaged service has a complete self-hosting path, and worked TypeScript/Python external-agent
examples exercise public reads without privileged keys. Signed claim creation verifies the exact
retrieved artifact bytes against a declared SHA-256 before any draft transaction.

## Current Gaps

The core protocol loop is implemented. Remaining work is mostly hardening and ecosystem maturity:

- external security review
- release/version discipline for SDK, schemas, and generated bindings
- stronger artifact retrieval diversity evidence
- expanded property and integration tests for new modules
- broader independently operated gateway and subgraph production evidence
