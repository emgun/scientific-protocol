# Interaction Map

This document maps protocol interaction surfaces for developers, operators, agents, and downstream
applications.

The canonical scientific object is the claim. A source is ingress and provenance. A replication is a
typed evidence-bearing object tied to a claim. Work, review, maintenance, challenge, and reward
events should connect back to claim state and protocol policy.

## Core Surfaces

### Contracts

Use contracts for canonical state transitions:

- register and version claims
- attach artifact commitments
- fund bonds and rewards
- submit replication records
- resolve objective outcomes through modules
- checkpoint reputation
- operate governance and treasury controls

### Schemas

Use schemas for canonical offchain payload shape:

- claim payloads
- replication payloads
- evaluation payloads
- artifact storage attestations
- artifact storage bundles

### SDKs and Generated Bindings

Use the TypeScript SDK, generated contract bindings, and Python client for application and operator
integration. Downstream applications should consume these release artifacts or direct contract
metadata, not private source paths.

### Reference API

The reference API is a convenience layer for reads and signed requests. It is useful for deployments
and applications, but it is not protocol authority.

Representative routes:

- `GET /health`
- `GET /write-config`
- `GET /reward-config`
- `GET /claims`
- `GET /claims/:claimId`
- `GET /sources`
- `GET /work/items`
- signed public-write submission routes
- signed operator lifecycle routes
- reward, governance, source, artifact, and agent read routes

### Workers

Workers keep operated state fresh and perform replaceable services:

- chain sync
- replication job coordination
- review execution
- artifact maintenance
- reward settlement
- reputation computation
- checkpoint publishing

## Actor Workflows

### Protocol Developer

Deploy contracts, run local stack, inspect events, regenerate bindings, and extend modules.

Typical path:

```bash
npm install
npm run build
npm test
npm run node
npm run deploy
```

### Application Builder

Consume schemas, SDKs, generated ABIs, deployment metadata, direct contract reads/writes, and a
configured reference API. Application layers own their UI, hosting, analytics, and application-level
health checks.

### Operator

Run Postgres, chain RPC, indexer, API, workers, artifact storage, signer custody, backups, and
incident response. Operators should treat the database and API as rebuildable convenience layers.

### Agent

Use signed agent request envelopes for attributable work, review, maintenance, and webhook flows.
Agent actions should remain tied to claims, work items, artifacts, and reward policy.

### Researcher Or Lab

Submit claims, sources, artifacts, replications, reviews, and maintenance work through an
application, SDK, CLI, direct contract flow, or reference API.

## Integration Rules

- Keep onchain state, signed envelopes, and content-addressed artifacts as the source of protocol
  truth.
- Rely on public contracts, events, schemas, generated bindings, and signed request formats.
- Keep application UI, hosting adapters, analytics, and launch checks decoupled from protocol
  authority.
- Keep read models and workers replaceable.
- Keep claims as the canonical object even when a workflow starts from a source, paper, dataset, or
  agent-discovered finding.
