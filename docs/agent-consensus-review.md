# Agent-Consensus Review

## Purpose

This document defines how Scientific Protocol should replace traditional peer review with an agent-native review and certification system.

The core thesis is:

- the claim remains the atomic unit
- review should live inside a broader claim work graph rather than a siloed review queue
- review should be continuous, typed, and evidence-backed
- the primary epistemic state is an ever-evolving vector, not a single verdict
- consensus should be used only for narrow operational decisions and certification thresholds
- most review work should be performed by decentralized AI agents, with humans reserved for governance, disputes, and high-judgment edge cases

This fits the protocol constraints in [AGENTS.md](../AGENTS.md):

- claims, not papers, are the atomic unit
- objective faults should be machine-resolvable where possible
- heavy artifacts stay offchain
- onchain state should stay narrow
- replication, negative results, and error discovery must be first-class

## Why not traditional peer review

Traditional peer review compresses many different jobs into one opaque process:

- scope screening
- methodology review
- artifact and reproducibility review
- statistical review
- contradiction and prior-work review
- editorial prioritization
- certification and prestige transfer

That model breaks down when claims and artifacts grow faster than humans can read them.

Scientific should separate those functions into typed protocol tasks and evidence artifacts. This makes review:

- continuous instead of one-shot
- decomposable instead of holistic
- inspectable instead of opaque
- scalable through agents instead of bottlenecked on unpaid reviewers

Those typed tasks should not become their own isolated workflow universe. They should sit inside the
broader [claim work graph](./claim-work-graph.md), where review, replication, and maintenance work
all remain claim-centric and composable.

## Review Model

The protocol should not ask a single question like "is this claim true?"

Instead, it should track a live review state vector for each claim.

### Primary state: claim review vector

The review vector is the canonical epistemic state for a claim. It should update as new artifacts, reviews, replications, challenges, and forecasts arrive.

Representative dimensions:

- `artifactCompleteness`
- `artifactIntegrity`
- `methodConsistency`
- `statisticalSanity`
- `reproducibilityReadiness`
- `replicationSupport`
- `challengePressure`
- `contradictionPressure`
- `forecastSupport`
- `reviewCoverage`
- `reviewDiversity`
- `reviewFreshness`
- `certificationReadiness`

Each dimension should be:

- explicit
- typed
- bounded
- domain-extensible
- derivable from evidence-bearing submissions

The vector is not "truth." It is a structured summary of how well the claim currently survives scrutiny.

### Secondary state: narrow consensus

Consensus still has a role, but only for narrow questions such as:

- did the artifact completeness task pass
- did three independent agents rerun the benchmark within tolerance
- is the repair task completed correctly
- has the claim crossed the threshold for a provisional certification label

Consensus should never be the primary representation of a claim's epistemic status.

Use:

- vector for epistemic state
- consensus for task completion, payout eligibility, certification gating, and escalation triggers

## Where this fits in the current architecture

Review should not be implemented as a fifth isolated protocol silo.

It should be a cross-layer system spanning the four layers in [layer-status.md](./layer-status.md).

### Core protocol

The core protocol should remain narrow.

Core protocol owns:

- claim identity
- claim domain and status
- claim-artifact bindings
- replication records
- challenge records
- compact certification and checkpoint outputs

The core protocol should not store:

- full review reports
- long reasoning traces
- detailed issue lists
- large evaluation payloads

At most, the core protocol should eventually anchor compact review-derived commitments and certification checkpoints.

### Agent layer

The agent layer is where most review work should happen.

Agents should be able to:

- discover review tasks
- claim work
- run typed evaluations
- submit structured outputs
- attach evidence artifacts
- receive attribution, rewards, and later reputation adjustments

This builds naturally on:

- [AgentRegistry.sol](../contracts/AgentRegistry.sol)
- signed machine APIs in [server.ts](../src/api/server.ts)
- the current task-run patterns in [store.ts](../src/coordinator/store.ts)
- the generalized claim work graph in [graph.ts](../src/work/graph.ts)

### Governance layer

Governance should define policy, not scientific truth.

Governance should control:

- allowed review task types
- schema versions
- quorum and diversity requirements
- certification thresholds
- escalation rules
- reward and bond parameters
- trusted or specialized certifier roles where needed

This fits the timelocked governance stack in [protocol-governance.md](./protocol-governance.md).

### Artifact layer

The artifact layer should hold the full review record:

- review reports
- extracted evidence
- issue lists
- rebuttals
- benchmark logs
- rerun traces
- statistical outputs
- contradiction analyses
- structured review payloads

These should remain content-addressed and portable through the decentralized artifact system described in [artifact-ingestion.md](./artifact-ingestion.md).

## Core Objects

The review system should revolve around these objects.

### `ReviewTask`

A bounded unit of evaluation work.

Examples:

- artifact completeness check
- method/spec consistency check
- benchmark rerun check
- statistical sanity check
- contradiction scan
- replication readiness check
- certification synthesis check

Suggested fields:

- `taskId`
- `claimId`
- `taskType`
- `schemaVersion`
- `openedAt`
- `openedBy`
- `deadline`
- `requiredCapabilities`
- `rewardPolicy`
- `consensusPolicyId`
- `inputArtifactKeys`
- `status`

In the current implementation, these review tasks are exposed as one class of work item inside the
claim work graph rather than as the only task abstraction the protocol understands.

### `ReviewSubmission`

A typed result from an agent or human reviewer.

Suggested fields:

- `submissionId`
- `taskId`
- `claimId`
- `reviewerActor`
- `reviewerAgentId`
- `reviewType`
- `verdict`
- `confidenceBps`
- `evidenceArtifactKey`
- `resultArtifactKey`
- `schemaVersion`
- `submittedAt`

### `ReviewIssue`

A structured problem statement attached to a submission.

Suggested fields:

- `issueId`
- `submissionId`
- `severity`
- `category`
- `summary`
- `artifactAnchor`
- `status`

### `AuthorResponse`

A structured response to one or more review issues.

Suggested fields:

- `responseId`
- `claimId`
- `respondsToIssueIds`
- `responseArtifactKey`
- `submittedAt`

### `CertificationCheckpoint`

A compact claim-level summary emitted when a claim crosses defined thresholds.

Examples:

- `artifact_complete`
- `repro_ready`
- `method_checked`
- `independently_replicated`
- `contested`
- `provisionally_certified`
- `domain_certified`

These should eventually fit naturally beside the existing checkpoint system rather than replacing it.

### `ConsensusPolicy`

A governance-controlled rule for how a task or certification threshold is evaluated.

Suggested inputs:

- minimum number of submissions
- diversity requirements
- minimum confidence requirements
- task timeout rules
- conflict escalation rules
- payout rules

## Task Taxonomy

The system should not use one generic "review" task. It should use typed tasks.

Useful first classes:

- `artifact_integrity_check`
- `artifact_completeness_check`
- `method_consistency_check`
- `stats_sanity_check`
- `replication_readiness_check`
- `contradiction_scan`
- `benchmark_rerun_check`
- `environment_repro_check`
- `challenge_synthesis_check`
- `certification_synthesis_check`

Later, for less objective domains:

- `wetlab_protocol_check`
- `literature_context_review`
- `clinical_endpoint_consistency_check`

This decomposition is critical. It is what makes AI-agent review practical.

## Consensus Model

### Vector first

Every review submission should update one or more vector dimensions for the claim.

The vector should be:

- append-only in evidence
- recomputable from indexed history
- checkpointable into compact summaries
- robust to disagreement

### Consensus second

Consensus should be derived only when required by policy.

Examples:

- certification requires at least three independent successful artifact-completeness submissions
- a rerun task requires two matching independent outputs within tolerance
- a repair payout requires one successful execution plus one verification task

### Diversity requirements

Consensus policies should not allow naive majority voting by many similar agents.

Policies should be able to require:

- distinct operators
- distinct models or implementations
- distinct artifact sources
- distinct execution environments
- minimum historical calibration score

The protocol should optimize for independent corroboration, not volume of votes.

## Onchain vs offchain split

This system should stay hybrid.

### Keep offchain

- full task payloads
- detailed reports
- reasoning traces
- long issue lists
- execution logs
- model outputs
- benchmark and audit artifacts
- rebuttal text

### Put onchain only when useful

- task opening and bounty commitments, later if needed
- compact certification commitments
- checkpoint publications
- minimal reward and attribution state
- limited claim-level certification labels

The protocol should avoid putting subjective or bulky review material onchain.

## Human role

Humans should still matter, but they should not be the throughput bottleneck.

Humans should focus on:

- governance and policy
- exception handling
- high-value disputed claims
- review schema design
- certification policy updates
- adversarial oversight of agent behavior

The system should assume most routine review work is machine-executed.

## Incentives

For this to become a self-sustaining ecosystem, review work must become economically legible.

The long-run model should support:

- task bounties
- agent reputation updates
- calibrated reward allocation
- optional reviewer or claimer bonds
- slashing or reputation loss for low-quality or dishonest work

The protocol should reward agents for useful, durable review signals, not just activity volume.

## UI and API implications

Public clients should not show raw "review votes."

It should show:

- claim review vector
- current certification labels
- active review tasks
- unresolved issues
- supporting and conflicting evidence
- freshness and coverage of the current review state

The claim page should answer:

- what has been checked
- what remains unverified
- where agents agree
- where agents disagree
- whether the claim is escalated or certified

The machine interfaces should expose:

- task discovery
- task claiming
- submission schemas
- review vector state
- certification checkpoints
- escalation state

## What already exists in this repo

Useful building blocks already implemented:

- claim, artifact, replication, challenge, and checkpoint core in [layer-status.md](./layer-status.md)
- decentralized artifact persistence and provenance in [artifact-ingestion.md](./artifact-ingestion.md)
- agent identity, budgets, attribution, and signed machine APIs in [agent-artifact-maintenance.md](./agent-artifact-maintenance.md)
- governance for policy and parameter control in [protocol-governance.md](./protocol-governance.md)

This means the review system does not need to start from zero.

## What remains to build

The main missing pieces are:

1. review task schemas and indexed review objects
2. review-vector computation and claim-level aggregation rules
3. certification checkpoint types and publication rules
4. agent-facing review task APIs and workers beyond maintenance tasks
5. reward and reputation loops for review agents
6. later, optional onchain bounty/claim/timeout settlement for objective review work

## Recommended implementation sequence

### Phase 1: offchain review system

- add typed review tasks and review submissions to the indexed store
- add review artifacts and issue/rebuttal support
- compute and expose claim review vectors through the API
- render vector and certification state on the claim page

### Phase 2: agent-native execution

- add review-task discovery and submission APIs for outside agents
- ship a reference review worker
- add diversity and calibration tracking
- add reward attribution for useful review work

### Phase 3: protocol settlement

- add checkpointed certification outputs
- add claim-level certification policies per domain
- optionally move objective task bounty mechanics onchain

## Bottom line

Scientific should not reproduce journal peer review as a binary gate.

It should become a decentralized, agent-native evaluation system in which:

- claims are the atomic object
- evidence stays inspectable
- epistemic state is represented as a live vector
- consensus is used only where narrow coordination requires it
- humans govern policy and resolve edge cases
- decentralized agents do the majority of routine review work
