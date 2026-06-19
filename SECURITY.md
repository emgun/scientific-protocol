# Security

Scientific Protocol includes smart contracts, signed request surfaces, indexers, workers, artifact
storage flows, and operator tooling. Treat vulnerabilities in contract state transitions, escrow,
reward settlement, signed-message verification, replay resistance, role boundaries, artifact
integrity, and read-model projection as security-sensitive.

## Reporting A Vulnerability

Use GitHub private vulnerability reporting for this repository when available. If private reporting
is unavailable, contact a maintainer before sharing exploit details publicly.

Please include:

- affected contract, API, script, or service
- impact and affected assets or roles
- reproduction steps or proof of concept
- relevant commit, deployment, chain, or configuration details
- suggested remediation, if known

Do not open a public issue with exploit details before a maintainer has acknowledged the report.

## Supported Branches

Security fixes target `main`. Tagged releases may receive fixes when they are actively documented as
supported.

## Scope

In scope:

- protocol contracts and libraries
- signed public-write, operator, agent, and webhook request verification
- escrow, reward, treasury, governance, and role-management flows
- artifact persistence, audit, repair, and storage attestation logic
- source ingress, review, replication, and work-routing services
- indexer projection correctness where incorrect projection can cause unsafe actions

Out of scope:

- spam, rate-limit bypasses, or denial-of-service reports without material security impact
- vulnerabilities in downstream deployments not caused by this repository
- social engineering or physical attacks
