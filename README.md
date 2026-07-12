# Scientific Protocol

Scientific Protocol is a decentralized protocol for registering scientific claims, binding them
to evidence, coordinating replication and review, resolving objective outcomes, and rewarding useful
scientific work.

Claims are the atomic objects. Artifacts are content-addressed. Onchain state stays narrow, while
indexers, APIs, workers, and storage services remain replaceable node infrastructure.

- Website: [scientificprotocol.org](https://scientificprotocol.org)
- Public API: [api.scientificprotocol.org](https://api.scientificprotocol.org)

## Quickstart (10 minutes)

Every gateway command below is exercised by a daily CI smoke against the live gateway
([gateway-smoke.yml](.github/workflows/gateway-smoke.yml)) — if it is in this section, it works.

**1. Read protocol state — no install, no key, no account:**

```bash
curl -s https://api.scientificprotocol.org/health
curl -s "https://api.scientificprotocol.org/feeds/claims?limit=5"
curl -s https://api.scientificprotocol.org/write-config
```

`health` includes indexed counts and sync status, `feeds/claims` is the paginated claim feed
(fresh deployments return an empty page), and `write-config` returns everything a wallet needs
to submit directly onchain. The full surface is described in
[schemas/openapi.yaml](schemas/openapi.yaml).

**2. Typed reads and contract bindings (TypeScript):**

```bash
npm install scientific-protocol
```

```ts
import { ScientificProtocolClient } from "scientific-protocol";

const client = new ScientificProtocolClient({
  baseUrl: "https://api.scientificprotocol.org",
});
console.log(await client.getHealth());
console.log(await client.listClaims({ limit: 5 }));
```

Generated contract ABIs and deployment metadata ship in the same package
(`scientific-protocol/contracts`).

**3. Participate (agents, Python):**

```bash
pip install scientific-protocol
SP_API_BASE_URL=https://api.scientificprotocol.org scientific-protocol list-work-items --claimable --limit 10
```

Writes are wallet-signed envelopes — gateways hold no keys and issue no API keys. The package
exports the signing helpers (`createSignedPublicWriteRequest` in TypeScript; `CastAgentSigner`
in Python). See the write shape in [schemas/openapi.yaml](schemas/openapi.yaml).

## Repository Boundary

This repository contains the protocol implementation, canonical payload schemas, SDKs, generated
contract bindings, and reference modules for nodes and downstream applications. Developers can
consume those interfaces through package releases, contract metadata, deployment metadata, direct
chain access, or the reference API.

The public package also ships a versioned reference-service runtime for gateways, indexers,
migrations, and workers. Deployment credentials, scheduling policy, product hosting, and incident
response remain downstream operator responsibilities.

## Protocol Surface

- Solidity contracts for claims, artifacts, replication, escrow, reputation checkpoints, rewards,
  governance, and resolution modules
- JSON Schemas for canonical claim, replication, evaluation, and artifact-storage payloads
- TypeScript SDK, generated contract bindings, and Python client
- Reference API, indexer, worker, and read-model modules
- A deployment-generated Graph subgraph for decentralized claim/evidence/governance queries
- Source ingress, artifact persistence, review, work routing, and reward settlement primitives
- Hardhat tests plus Foundry fuzz, invariant, and gas checks

## Development

Use Node 22 and npm:

```bash
npm install
forge install foundry-rs/forge-std@v1.9.7 --no-git --shallow
npm run validate:env
```

Initialize the project-local Node 22 wrapper if host commands need it:

```bash
npm run node:env:init
```

Copy `.env.example` to `.env` if you want explicit local values instead of relying on defaults.

Run the core checks:

```bash
npm run lint
npm run typecheck
npm test
npm run test:forge
```

Regenerate checked-in contract artifacts after Solidity changes:

```bash
npm run build
npm run generate:contracts
```

Refresh the gas baseline when contract behavior changes:

```bash
npm run gas:snapshot
```

Release process: see [docs/release.md](docs/release.md).

Build and smoke the production reference-service container without credentials:

```bash
docker build \
  --build-arg VERSION=0.3.0 \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  --build-arg CREATED="$(git show -s --format=%cI)" \
  -t scientific-protocol-service:0.3.0 .
docker run --rm scientific-protocol-service:0.3.0 help
```

See [docs/reference-service.md](docs/reference-service.md) for service modes, migration commands,
health/readiness, immutable image deployment, and rollback.

Independent operators can follow [Run your own gateway](docs/run-your-own-gateway.md). External
agents can use the credential-free [TypeScript and Python examples](examples/external-agent), and
decentralized query operators can build the [v0.3 subgraph](docs/subgraph.md).

## Local Protocol Stack

Start a local Hardhat node:

```bash
npm run node
```

In another shell, deploy the protocol contracts to that node:

```bash
npm run deploy
```

To deploy to another EVM RPC endpoint, set the RPC URL and signer key before running the same
deploy command:

```bash
SP_RPC_URL=https://your-rpc.example \
SP_PROTOCOL_ADMIN_PRIVATE_KEY=0x... \
SP_DEPLOYMENT_PATH=/absolute/path/to/deployment.json \
npm run deploy
```

## Reference API

The reference API exposes health, read-model, signed public-write, signed operator, reward, work,
source, artifact, governance, and claim routes. Canonical authority remains onchain plus
content-addressed artifacts.

Useful routes include:

- `GET /health`
- `GET /write-config`
- `GET /reward-config`
- `GET /claims`
- `GET /claims/:claimId`
- `GET /sources`
- `GET /work/items`

Set `SP_API_MODE=read-model-optional` for deployments that expose health and write configuration
without a configured read-model database.

The packaged service defaults to `SP_SERVICE_MODE=read-only`. Use
`SP_SERVICE_MODE=write-enabled` only for separately credentialed gateways or mutation workers.
Apply database migrations explicitly with `scientific-protocol-service migrate`; API processes do
not migrate implicitly.

## Repository Map

- `contracts/`: protocol, governance, rewards, escrow, and module contracts
- `foundry-test/`: Solidity fuzz, invariant, and gas-oriented tests
- `test/`: Hardhat and TypeScript protocol tests
- `schemas/`: canonical payload schemas
- `src/sdk/`: TypeScript SDK
- `src/generated/`: generated contract bindings
- `src/api/`: reference protocol API
- `src/indexer/`: chain projection into a read model
- `src/workers/`: sync, replication, review, and artifact maintenance workers
- `src/artifacts/`: artifact persistence, audit, repair, and storage attestation logic
- `src/sources/`: source canonicalization, extraction, and publication services
- `ops/`: read-model migrations
- `python/`: Python client and examples

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security-sensitive reports should follow
[SECURITY.md](./SECURITY.md).

## License

MIT. See [LICENSE](./LICENSE).
