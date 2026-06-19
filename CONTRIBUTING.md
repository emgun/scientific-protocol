# Contributing

Scientific Protocol changes should preserve the claim-centric architecture: claims are the atomic
objects, artifacts are content-addressed, and protocol authority comes from onchain state plus signed
or durable evidence.

## Development Setup

Use Node 22.

```bash
npm install
npm run validate:env
```

Initialize the project-local Node wrapper when needed:

```bash
npm run node:env:init
```

## Pull Request Checklist

- Keep changes scoped to protocol contracts, schemas, SDKs, reference APIs, indexers, workers,
  operator tooling, or documentation.
- Add or update tests for behavior changes.
- Update schemas, generated bindings, and docs when public interfaces change.
- Prefer explicit events, custom errors, and narrow onchain state.
- Avoid broad mutable state, hidden authority, ambiguous payouts, or centralized outcome rewrites.

Run the relevant checks before opening a pull request:

```bash
npm run lint
npm run typecheck
npm test
npm run test:forge
```

For Solidity changes, regenerate checked-in contract bindings and review gas impact:

```bash
npm run build
npm run generate:contracts
npm run gas:snapshot
```

## Security-Sensitive Changes

Do not disclose exploitable details in public issues or pull requests. Follow
[SECURITY.md](./SECURITY.md) for vulnerability reports.
