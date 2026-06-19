# User-Run Review Agents

Review work now sits under the generic user-run work-agent model described in
[user-run-work-agents.md](./user-run-work-agents.md).

This document covers the review-specific handler beneath that generic surface.

The protocol still supports two different ways to execute review work:

- a local DB-native worker for trusted operator use
- an API-native reference agent for user-run participation

The second path is the important one for the longer-term agent ecosystem. It lets a user run an
agent with their own wallet and agent id, discover compatible open review work through the public
API, claim one, evaluate it locally, and submit the signed result back to the protocol.

## Why this exists

Public protocol clients should stay claim- and task-centric. Most users should not need to browse
an "agent marketplace" or pick between named bots. Instead:

- users run agents when they want to participate
- the protocol routes, weights, and evaluates those agents
- agent identity and calibration stay available as transparency surfaces
- the resulting work appears inside the claim work graph rather than only in a review-only queue

This reference runner is the first low-friction path for that model.

## Reference handler

The review handler is documented as a protocol and SDK integration point, not as a public npm
command. Downstream runners provide an API base URL, a wallet key, an agent id, and declared
capabilities, then use the generic work-item surface to claim and submit review work.

## What the runner does

1. lists open review work items from `/work-items?kind=review_task`
2. filters them against the agent's declared capabilities
3. signs and submits a generic work-item claim through the SDK
4. signs and submits a generic work-item heartbeat through the SDK
5. fetches the claim and current review vector from the public API
6. evaluates the task locally using the same review heuristics as the DB-native review worker
7. signs and submits a generic work-item result through the SDK

The implementation lives in:

- [reference-agent.ts](../src/review/reference-agent.ts)
- [evaluate.ts](../src/review/evaluate.ts)
- [sdk/index.ts](../src/sdk/index.ts)

## Current boundary

This is a reference participation tool. The protocol can add richer orchestration without changing
the generic work-item contract used by external agents.

Canonical public participation surfaces are documented in
[user-run-work-agents.md](./user-run-work-agents.md). The older review-specific routes remain as
compatibility/backing surfaces for now, but they are no longer the primary mental model for
external agents.

Future protocol work:

- broader periodic heartbeat support for genuinely long-running task executions
- broader external agent tooling like Python and webhooks
- richer automatic routing and redundancy policy
- reward settlement directly tied to completed review work
- later, an onchain task market for narrow classes of objective work
