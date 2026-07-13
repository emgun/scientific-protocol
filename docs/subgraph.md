# Decentralized query subgraph

`subgraph/` is a Graph-compatible, independently deployable index of the v0.3 core
claim/evidence/governance event surface. It tracks claims, artifacts, replications, canonical
resolution decisions, reputation checkpoints, agents, and governance proposals. It is a query
convenience, not protocol authority.

The v0.3 subgraph intentionally does not index the derivative `EpistemicMarket` forecast lifecycle.
Forecast commitments, reveals, and settlements remain available through contract events and the
reference Postgres read model/API. This keeps the independently operated subgraph focused on the
claim-centric evidence and governance history; adding market entities later requires an explicit
schema and compatibility decision rather than silently broadening this package's query contract.

## Deterministic generation and build

The manifest and ABIs are generated from a v0.3 deployment file and the compiled contract
artifacts. No address is hand-maintained.

```bash
SP_DEPLOYMENT_PATH=/absolute/path/to/deployment.json \
SP_SUBGRAPH_NETWORK=base-sepolia \
npm run subgraph:test
```

This compiles contracts, writes `subgraph/abis/*.json` and `subgraph/subgraph.yaml`, runs Graph
code generation, compiles every AssemblyScript mapping to WASM, and validates the manifest against
the deployment addresses/start block and required entity/event coverage.

## Deploy

Create the subgraph in your Graph Studio or graph-node environment, then deploy with credentials
provided only to the deployment command:

```bash
cd subgraph
graph auth --studio "$GRAPH_DEPLOY_KEY"
graph deploy --studio scientific-protocol-v0-3 subgraph.yaml
```

For a self-hosted graph-node, use its `graph create`/`graph deploy` endpoint instead. Record the
deployment manifest hash, package commit, network, start block, and resulting query URL. This
repository intentionally does not deploy or store Graph credentials.

## Example query

```graphql
query ClaimEvidence($id: ID!) {
  claim(id: $id) {
    id
    author
    domainId
    status
    metadataHash
    resolutionModule
    effectiveResolutionDecision {
      id
    }
  }
  resolutionDecisions(where: { claim: $id }, orderBy: createdAtBlock) {
    id
    status
    claimStatus
    confidenceBps
    evidenceHash
    resolutionHash
    resolverType
    replication {
      id
      replicator
      resultHash
      resolutionStatus
      evidenceURI
    }
  }
}
```

Consumers should verify high-value results against contract reads and content-addressed artifacts.
Subgraphs can lag, fork, or disappear; they do not supersede the chain.
