# Agent Artifact Maintenance

Artifact maintenance now sits under the generic user-run work-agent model described in
[user-run-work-agents.md](./user-run-work-agents.md).

This document covers the maintenance-specific handler and durability semantics beneath that generic
surface.

The artifact durability layer now has a task model so users can run agents that keep protocol artifacts healthy instead of relying on one centralized audit daemon.

## Task model

Two task types exist:

- `audit`
- `repair`

An audit task:

1. verifies every known replica against the canonical artifact hash
2. records audit rows on each replica
3. persists a result artifact summarizing the run
4. opens follow-on `repair` tasks for failed non-primary replica targets that are configured locally

A repair task:

1. finds a healthy source replica
2. re-pins the artifact bytes to the requested target provider
3. updates the replica locator
4. re-verifies the repaired replica
5. persists a result artifact summarizing the repair

The current implementation lives in:

- [maintenance.ts](../src/artifacts/maintenance.ts)
- [artifact-maintenance-worker.ts](../src/workers/artifact-maintenance-worker.ts)
- [store.ts](../src/coordinator/store.ts)
- [010_artifact_maintenance_tasks.sql](../ops/migrations/010_artifact_maintenance_tasks.sql)
- [011_agent_requests.sql](../ops/migrations/011_agent_requests.sql)

## Why this matters

This is the current bridge from protocol-owned maintenance to a user-run ecosystem:

- tasks are explicit and claimable
- task runs are attributable to agent ids
- results are persisted as artifacts
- failed audits generate new work instead of just logging errors

It is still an MVP market, not a full onchain maintenance economy. The work queue is offchain and the incentive surface is currently attribution plus future integration points for rewards and checkpoints.

## Reference implementation

Artifact maintenance is exposed through task state, signed agent envelopes, and reference source
modules. Public protocol consumers should treat maintenance as a work family they can implement or
operate around, not as a bundled npm command surface.

Core inputs for downstream maintenance runners include:

- SP_ARTIFACT_MAINTENANCE_AGENT_ID
- SP_ARTIFACT_MAINTENANCE_WORKER_ID
- SP_ARTIFACT_MAINTENANCE_TASK_ID
- SP_ARTIFACT_MAINTENANCE_TASK_TYPE
- SP_ARTIFACT_IPFS_REPLICA_TARGETS

## APIs

Third-party agents no longer need direct database access to participate. The API now exposes both read routes and signed mutation routes.

Canonical read and coordination surfaces are documented in
[user-run-work-agents.md](./user-run-work-agents.md).

Signed mutation routes:

- `POST /agent/artifact-maintenance-tasks/:id/claim`
- `POST /agent/artifact-maintenance-tasks/:id/heartbeat`
- `POST /agent/artifact-maintenance-tasks/:id/audit-results`
- `POST /agent/artifact-maintenance-tasks/:id/repair-results`

Read routes:

- `GET /artifact-maintenance-tasks`
- `GET /artifact-maintenance-tasks/:id`
- `GET /persisted-artifacts/:artifactKey/maintenance-tasks`
- `GET /agent-requests`
- `GET /agent-requests/:id`

Those artifact-maintenance-specific routes still back the current implementation, but the generic
work-item surfaces are the canonical entry points for new external tooling.

The signed mutation payload is:

```json
{
  "envelope": {
    "actionType": "artifact_task_claim",
    "actorAddress": "0x...",
    "agentId": "1",
    "issuedAt": "2026-04-02T12:00:00.000Z",
    "requestNonce": "nonce-1",
    "scopeKey": "artifact-maintenance-task:2",
    "payload": {
      "workerId": "artifact-worker-a"
    }
  },
  "signature": "0x..."
}
```

Heartbeat payloads use the same signed envelope shape, with `actionType` set to
`artifact_task_heartbeat` and a payload containing the claimed `runId` plus optional `workerId`.

## Reaping stale runs

Assigned work is lease-like. Running task rows record lastHeartbeatAt, and downstream operators can
fail and reopen stale runs when agents stop heartbeating. The stale-run policy inputs are:

- SP_AGENT_TASK_STALE_AFTER_MS
- SP_AGENT_TASK_REAPER_LIMIT
- SP_AGENT_TASK_REAPER_INCLUDE_ARTIFACTS
- SP_AGENT_TASK_REAPER_INCLUDE_REVIEWS
- SP_AGENT_TASK_REAPER_INCLUDE_REPLICATIONS

The request hash/signature helpers are exported from:

- [agent-request-envelope.ts](../src/shared/agent-request-envelope.ts)
- [sdk/index.ts](../src/sdk/index.ts)

## Current boundary

This supports agent maintenance in local and hosted operator stacks. Future work can add
decentralized market mechanics where that extra rigidity is worth it.

Not yet implemented:

- onchain maintenance bounties and automated payouts
- provider-native Filecoin deal status tracking
- scheduled repair escalation and alerts

Those are the next steps if artifact maintenance becomes a first-class open agent economy.
