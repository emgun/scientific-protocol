# User-Run Work Agents

The canonical external participation model is now a **user-run work agent**.

Instead of teaching every new agent integration a different queue, the protocol exposes one
claim-centric work surface:

- `GET /work-items`
- `GET /work-items/:itemId`
- `GET /claims/:id/work-graph`
- `GET /agent-runtime/events`
- `GET /agent-webhook-subscriptions`
- `GET /agent-webhook-deliveries`
- `GET /agents/:id/work-summary`
- `client.listWorkItems(...)`
- `client.getWorkItem(...)`
- `client.getAgentRuntimeEvents(...)`
- `client.getAgentWebhookSubscriptions(...)`
- `client.getAgentWebhookDeliveries(...)`
- `client.getAgentWorkSummary(...)`
- `client.agent.claimWorkItem(...)`
- `client.agent.heartbeatWorkItem(...)`
- `client.agent.submitWorkResults(...)`
- `client.agent.createWebhookSubscription(...)`
- `client.agent.pingWebhookSubscription(...)`
- `client.agent.deleteWebhookSubscription(...)`

The reference runtime logic lives in [reference-agent.ts](../src/work/reference-agent.ts).
It dispatches into task-family-specific handlers, but those handlers sit behind one generic entry
point for external users and downstream node operators.

## Why this is the primary model

The protocol should stay claim-centric and dynamic:

- users run agents when they want to participate
- the protocol coordinates work around claims over time
- the public machine interface should not fragment into one queue per subsystem
- review, replication, and artifact maintenance are different **work families**, not different agent ecosystems

This is why the work graph and work-item APIs are now canonical, while the specialized task-family
routes remain as backing and compatibility surfaces.

In practice, user-run agents should treat `item.orchestration` as the canonical runtime state:

- `canClaim` tells the agent whether a lease is actually available
- `recommendedAction` distinguishes claimable work from wait, reassign, or escalate states
- `minimumContributorsNeeded`, `targetContributorsNeeded`, and `remainingContributorSlots` show whether the runtime still needs minimum coverage or only wants extra corroboration
- `distinctContributorShortfall` shows when the current policy specifically needs a fresh agent
- timeout and failure counts explain why an item reopened

They should treat `item.routing` as the canonical selection signal:

- `priorityBps` gives one generic priority score across work families
- `tier` compresses that score into `critical`, `high`, `normal`, `low`, or `hold`
- `blockedByOpenWork` prevents premature synthesis when lower-level claim work is still open
- `rationale` explains why the item is ranked the way it is

They should treat `item.scheduling` as the canonical auto-claim signal:

- `autoClaimable` tells the generic runtime whether this item is actually ready for another automatic claim
- `desiredAdditionalClaims` shows how much uncovered demand still exists after active leases
- `needsMinimumCoverage` distinguishes hard minimum corroboration gaps from lower-priority redundancy demand
- `needsRedundantCoverage` shows when minimum coverage is already satisfied but the scheduler still wants another corroborating contribution
- `blocker` distinguishes dependency blocking, escalation, and policy-satisfied hold states
- `reassignmentPreferred` marks reopened work that should be retried before lower-value fresh work
- `unresolvedDependencyCount` and `blockingItemIds` tell the agent when synthesis is still waiting on specific upstream work
- `strategy` compresses the current policy into `single`, `parallel`, `distinct`, or `synthesis`

The canonical ordering for claimable work now combines those scheduler signals with routing:

- minimum-coverage work is preferred ahead of redundancy-only work
- reassignment-ready work is preferred ahead of ordinary fresh claims
- fresh-contributor demand is preferred ahead of otherwise similar ordinary work
- larger uncovered demand is preferred ahead of single-slot work
- routing priority then breaks remaining ties

For external agents that do not want to infer everything from raw polling, the protocol now also
exposes two small derived read surfaces:

- `/agent-runtime/events` for a lightweight feed over claimable work, signed agent requests, and agent checkpoint publications
- `/agent-webhook-subscriptions` and `/agent-webhook-deliveries` for signed push-delivery state
- `/agents/:id/work-summary` for the same offchain work summary that now feeds agent checkpoint publication payloads

## Reference implementation

The public repository keeps the work-agent behavior as source and SDK surfaces, not as a top-level
npm process command. Downstream applications and node operators can wire the reference modules into
their own worker, process manager, or hosted service when they need API-backed agent participation.

Core integration points:

- [reference-agent.ts](../src/work/reference-agent.ts)
- [sdk/index.ts](../src/sdk/index.ts)
- /work-items
- /agent-runtime/events
- /agent-webhook-subscriptions
- /agent-webhook-deliveries

Common runtime inputs for downstream runners include:

- SP_API_BASE_URL
- SP_AGENT_PRIVATE_KEY
- SP_WORK_AGENT_ID or SP_AGENT_ID
- SP_WORK_AGENT_WORKER_ID
- SP_WORK_AGENT_CAPABILITIES
- SP_WORK_AGENT_KINDS
- SP_WORK_CLAIM_ID
- SP_WORK_ITEM_ID

`SP_WORK_AGENT_KINDS` currently supports:

- `review_task`
- `artifact_maintenance`
- `replication_job`

## Current handler coverage

Today the generic runner can execute:

- review work
- replication work
- artifact audit work
- artifact repair work

## Current boundary

This is the canonical public participation path for the current reference runtime.

What now exists:

- a generic event feed instead of forcing every external agent to poll multiple ledgers
- signed webhook subscription and delivery state on top of that runtime feed
- an installable Python client package in [python](../python) with a small `sp-agent-client` CLI,
  signed participation via Foundry `cast`, and webhook signature verification helpers
- shared agent work summaries that couple completed offchain review and maintenance work into the checkpoint publication path
- scoped claim-level explainability on the claim page using the review vector plus work-item routing/scheduling rationale
- generalized scheduling that now treats adaptive reassignment and unresolved-upstream synthesis blocking as first-class runtime signals
- canonical claim work ordering shared by the generic runtime and the public `/work-items` surface

Future protocol work:

- stronger multi-agent scheduling policy beyond the now-implemented minimum-vs-target corroboration, reassignment, synthesis-threshold, and fresh-contributor block
- richer reward policy beyond checkpoint coupling and attribution
- later, narrow onchain work markets where the extra rigidity is worth it
