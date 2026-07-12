# Roadmap

## Implemented in v0.3

- hardened escrow, lifetime agent budgets, and module return-value validation
- complete author-bond publication gating and a signed two-step publication saga
- append-only canonical resolution decisions and causally linked forecast settlement
- bounded outbound access, public-service credential containment, ingestion leases, shared rate
  limits, complete internal pagination, migration checksums, and reorg-aware indexing
- packaged self-hosted gateway/indexer/workers with operator guide and external-agent examples
- deployment-generated Graph subgraph for independent decentralized queries

## Next highest-signal work

1. Commission an external contract and operated-runtime security review against the frozen v0.3
   ABI and service image.
2. Run a public testnet soak with at least two independent gateways and two subgraph/indexer
   operators; publish lag, reorg-recovery, artifact-availability, and reconciliation evidence.
3. Decide whether market and appeal modules remain default deployment components or become
   explicitly optional in a later versioned manifest.
4. Expand third-party resolution modules and replication clients only after the v0.3 authority,
   evidence, and deployment boundaries have demonstrated stable operation.

No tokenomics redesign, generalized court, or broader onchain data expansion is implied by this
roadmap.
