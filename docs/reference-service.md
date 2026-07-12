# Reference service distribution

The public repository publishes one versioned runtime for the gateway, indexer, migrations, and
reference workers. It is replaceable node infrastructure; contract state and content-addressed
artifacts remain authoritative.

## Service modes

- `SP_SERVICE_MODE=read-only` is the default. The gateway serves GET/HEAD/OPTIONS requests and
  rejects mutation methods plus `/admin/sync` with HTTP 405. Sync and migration CLI commands remain
  available because they update the replaceable read model, not protocol state.
- `SP_SERVICE_MODE=write-enabled` enables signed public/operator routes and workers that can create
  database or chain effects. Run it as a separately credentialed service. Do not put resolver,
  checkpoint, governance, and broad cloud credentials into the public read-only gateway.

The API process defaults `SP_RUN_MIGRATIONS=false`. Apply migrations as an explicit release job
before replacing service instances.

## Commands

After installing `scientific-protocol@0.3.0`:

```bash
scientific-protocol-service help
scientific-protocol-service migrate
scientific-protocol-service sync
scientific-protocol-service gateway
scientific-protocol-service worker sync
SP_SERVICE_MODE=write-enabled scientific-protocol-service worker review
SP_SERVICE_MODE=write-enabled scientific-protocol-service worker replication
SP_SERVICE_MODE=write-enabled scientific-protocol-service worker artifact-maintenance
```

`GET /livez` reports process liveness, service mode, package version, source revision, and build
date without requiring database, RPC, or signer access. `GET /readyz` verifies that the configured
database is reachable and the migration table exists. `/health` remains the richer operational
status endpoint.

## Container build

Build from the release commit:

```bash
docker build \
  --build-arg VERSION=0.3.0 \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  --build-arg CREATED="$(git show -s --format=%cI)" \
  -t scientific-protocol-service:0.3.0 .
docker run --rm scientific-protocol-service:0.3.0 help
```

Tagged releases publish two non-floating GHCR tags:

- `ghcr.io/emgun/scientific-protocol-service:0.3.0`
- `ghcr.io/emgun/scientific-protocol-service:sha-<full-commit-sha>`

Deploy by registry digest, not by a mutable tag:

```bash
docker pull ghcr.io/emgun/scientific-protocol-service:0.3.0
docker inspect --format='{{index .RepoDigests 0}}' \
  ghcr.io/emgun/scientific-protocol-service:0.3.0
```

Record that digest, the deployment manifest hash, migration result, and database backup together.
Rollback restores the previously recorded digest and its matching configuration/database backup;
it never rebuilds an old tag.

## Credential-free smoke checks

The following require no production credentials:

```bash
docker run --rm ghcr.io/emgun/scientific-protocol-service@sha256:<digest> help
docker run --rm ghcr.io/emgun/scientific-protocol-service@sha256:<digest> version
```

Database, RPC, deployment metadata, and signer configuration are required only for the commands
that use them.
