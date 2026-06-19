# Claim Work Graph

## Purpose

The protocol should not treat review, replication, and artifact maintenance as unrelated queues.

The more general model is a **claim work graph**:

- the claim is the root object
- agents contribute work around that claim over time
- specialized workflows still exist underneath
- the public architecture exposes one evolving graph of work, runs, results, and artifacts

This keeps the protocol aligned with [AGENTS.md](../AGENTS.md):

- claims stay atomic
- heavy execution and artifacts stay offchain
- onchain state stays narrow
- the ecosystem remains dynamic and agent-native rather than editorial and one-shot

## Why this model

If every workflow gets its own isolated task system, the protocol becomes fragmented:

- review tasks live in one world
- replication jobs live in another
- artifact durability work lives in a third

That makes it harder to:

- explain what is happening around a claim
- route general-purpose agents through the system
- evolve toward a self-sustaining ecosystem
- add new kinds of work without adding another silo

The work graph solves this by separating:

- a **general execution framework**
- from **specific task schemas**

## Core Objects

### `Work subject`

What the work is about.

Current subjects:

- claim
- claim artifact
- persisted artifact
- source record

### `Work item`

A bounded unit of protocol work.

Current work item kinds:

- review task
- replication job
- artifact maintenance task

Source-backed extraction currently reuses `review_task` with `source_record` subject metadata until a
broader dedicated source item kinds become worth their own public surface.

Each work item should have:

- a subject
- a lane
- a status
- a derived orchestration view
- a derived routing view
- a derived scheduling view
- agent action metadata
- optional policy
- optional required capabilities
- related artifact keys
- zero or more runs
- an optional derived result

### `Work run`

A leased execution attempt by an agent or worker.

Current runs already support:

- claim
- heartbeat
- completion
- failure
- stale-run reopening

At the generalized work layer, runs now also normalize:

- failure reason
- attempt history
- timeout counts
- reassignability

### `Work result`

A typed outcome that can feed the claim state.

Current result families:

- review submission
- replication result
- artifact audit or repair report

## Lanes

The graph should stay general, but not vague.

Current lanes:

- `evaluation`
- `execution`
- `maintenance`
- `synthesis`

These are not hard-coded reviewer roles. They are broad classes of claim work that general agents can participate in over time.

## Current Implementation

The repo now exposes a derived claim work graph through:

- [graph.ts](../src/work/graph.ts)
- [types.ts](../src/work/types.ts)
- [server.ts](../src/api/server.ts)
- [client.ts](../src/sdk/client.ts)

Public surfaces:

- `GET /claims/:id/work-graph`
- `GET /sources/:id/work-graph`
- `GET /work-items`
- `GET /work-items/:itemId`
- full claim detail at `GET /claims/:id` now includes `workGraph`
- full source detail at `GET /sources/:id` now includes `workGraph`
- the claim page renders the unified work graph alongside the review vector
- the source page renders extraction work as the same routed work model instead of a raw task list
- `GET /work-items?sourceId=...` and `GET /work-items/:itemId?sourceId=...` expose source-scoped extraction work through the same generic item surfaces
- the claim page now uses the work graph plus review payload references to show which concrete
  work-items, submissions, and recent changes are driving support, uncertainty, and remaining
  blockers
- the SDK exposes `listWorkItems`, `getWorkItem`, and generic work-item claim/heartbeat/submit helpers
- work items now carry agent action metadata so user-run agents can tell which items are externally claimable
- work items now carry an `orchestration` block with retry, timeout, slot, and recommended-action state
- work items now also carry a `routing` block with derived priority, tier, and claim-level blocking context
- work items now also carry a `scheduling` block with scheduler-ready claimability, minimum-vs-target corroboration state, reassignment preference, unresolved-upstream synthesis blocking, and desired additional claim count
- work graph summaries now also carry aggregate scheduler state such as auto-claimable item count, minimum-coverage gaps, redundancy-target demand, reassignment-ready item count, fresh-contributor demand, dependency-blocked item count, and uncovered contribution demand

The orchestration view is intentionally derived and generic. It answers questions like:

- can a user-run agent claim this item right now
- is the item waiting on an active lease
- does it need reassignment after a failed run
- has it hit an escalation threshold
- how many contributions still matter for the current policy
- whether the current policy still needs additional distinct contributors rather than more of the same agent work

The routing view answers a different question:

- if many claimable items are available, which one should a general agent take next
- is this item blocked behind lower-level open work
- is this item ordinary, urgent, or effectively on hold
- is this item valuable specifically because it still needs a distinct contributor to satisfy its policy

The scheduling view answers a third question:

- should the generic runtime actually auto-claim this item right now
- is the item blocked behind dependencies even if it is structurally open
- is the item still below minimum corroboration or only seeking extra redundancy
- how many additional claims would still be useful right now
- whether the next useful action is a fresh claim or an adaptive reassignment
- which unresolved upstream items are still blocking synthesis

The graph summary now answers a fourth question:

- how much scheduler-ready work exists for this claim overall
- whether the claim is mostly blocked, mostly below minimum corroboration, mostly seeking extra corroboration, or mostly waiting on fresh contributors
- how much uncovered contribution demand still exists across all open work

Important boundary:

This is a **generalized read and coordination model**, not yet a full storage refactor.

The underlying specialized systems still exist:

- review tasks in [store.ts](../src/review/store.ts)
- replication jobs in [store.ts](../src/coordinator/store.ts)
- artifact maintenance tasks in [store.ts](../src/coordinator/store.ts)

That is intentional. It keeps the implementation stable while moving the architecture toward a more
protocol-native model. The generalized work-item surfaces are canonical; the specialized queues are
implementation backends and compatibility routes until a deeper storage unification becomes worth
the migration risk.

Source-backed extraction follows the same pattern: the public surface is now a first-class source
work graph plus source-scoped generic work-item views, while the underlying records still reuse the
review-task store.

Persisted-artifact subjects in the graph now resolve to the public artifact record page instead of
only the raw JSON endpoint, so provenance, replica health, and audit history stay attached to the
same claim-centric navigation model.

## Relationship To Review

Review should be understood as one family of work inside the claim work graph, not the whole system.

That means:

- narrow typed review tasks remain useful
- broad synthesis work can sit above them
- replication and artifact durability work remain part of the same evolving ecosystem
- the claim’s review vector stays the epistemic summary
- the work graph stays the operational and explainability layer
- the review explanation layer can now point back into concrete work-items and submissions instead
  of only emitting abstract dimension summaries

## Why this is better for general agents

General agents do not need to be pre-classified into rigid protocol roles.

Instead:

- agents participate in open work
- the protocol evaluates how their outputs affect claim state
- capability tags become routing hints, not the core ontology
- calibration, diversity, and consensus policies can evolve over time

This is closer to a decentralized scientific ecosystem than a static reviewer assignment model.

## What remains

The current work graph is a derived abstraction. The next steps are:

- broaden it to more task families
- deepen orchestration policy into stronger multi-agent routing, diversity, and escalation decisions
- keep strengthening the scheduling layer so more cross-item policy can live there instead of in siloed workers, but without letting it collapse into a separate orchestration subsystem
- deepen the current claim-level explainability further for harder adversarial cases and additional
  work families beyond the now-implemented work-item and submission attribution
- later decide whether some narrow objective work should move into an onchain bounty market
