# Run your own gateway

The reference gateway is replaceable infrastructure over canonical contracts and events. A
production operator needs a v0.3 deployment manifest, an Ethereum RPC endpoint, Postgres, and an
immutable service image or the published npm package. Read-only gateways need no protocol private
keys.

## 1. Prepare Postgres and configuration

Create separate databases for the live read model and any future rebuild. Keep the deployment
manifest immutable and record its hash with the service image digest.

```bash
export SP_DATABASE_URL='postgresql://protocol:REDACTED@db.example.org/scientific_protocol'
export SP_RPC_URL='https://base-sepolia.example.org'
export SP_DEPLOYMENT_PATH='/etc/scientific-protocol/base-sepolia.deployment.json'
export SP_SERVICE_MODE='read-only'
export SP_RUN_MIGRATIONS='false'
export SP_INDEXER_CONFIRMATION_DEPTH='12'
```

Do not put resolver, checkpoint-publisher, protocol-admin, author, replicator, agent-operator, AWS,
or other funds-moving credentials in the public gateway. Set `SP_PUBLIC_SERVICE=true` in the
public process; startup fails if privileged credentials or reference-canary mode are present.

## 2. Run migrations once

Using the published container by immutable digest:

```bash
docker run --rm --env-file /etc/scientific-protocol/gateway.env \
  ghcr.io/emgun/scientific-protocol-service@sha256:<digest> migrate
```

Or using npm:

```bash
npm install --global scientific-protocol@0.3.0
scientific-protocol-service migrate
```

Migrations are serialized with a Postgres advisory lock and checksummed. Never edit an applied
migration. Back up Postgres before upgrading.

## 3. Sync, then serve

Perform an initial one-shot sync before admitting traffic:

```bash
scientific-protocol-service sync
scientific-protocol-service gateway
```

Run `scientific-protocol-service worker sync` as a dedicated recurring process, or invoke the
one-shot sync on a scheduler. A 15–60 second cadence is reasonable for a public read gateway;
choose it based on RPC quotas and freshness needs. Only the authenticated `GET /admin/sync` form is
supported if HTTP-triggered sync is unavoidable. Protect it with `CRON_SECRET` and a shared
Postgres rate limiter.

For a remote write-enabled gateway, run a separately credentialed process with
`SP_SERVICE_MODE=write-enabled` and `SP_RATE_LIMIT_BACKEND=postgres`. Keep narrow signer roles in
separate workers where possible. Public writes remain wallet-signed; the gateway does not custody
user wallets or sponsor author bonds.

## 4. Health and smoke checks

```bash
curl --fail http://127.0.0.1:8080/livez
curl --fail http://127.0.0.1:8080/readyz
curl --fail http://127.0.0.1:8080/health
curl --fail 'http://127.0.0.1:8080/claims?limit=1&offset=0'
curl --fail 'http://127.0.0.1:8080/work-items?claimable=true&limit=1&offset=0'
```

`/livez` proves the process is alive without requiring RPC or Postgres. `/readyz` verifies database
and migration readiness. `/health` includes indexed counts, cursor freshness, service provenance,
and sync status. Alert on readiness failures, cursor stagnation, RPC degradation, migration
mismatch, and block-hash/reorg errors.

The credential-free TypeScript and Python examples under
[`examples/external-agent`](../examples/external-agent) run against any gateway selected by
`SP_GATEWAY_URL`.

## 5. Reorg recovery and rollback

The indexer stores the canonical block hash at each committed chunk and holds remote indexing
behind a confirmation window. On a cursor/hash mismatch, stop rather than continuing on a fork.
Rebuild into a fresh database:

```bash
SP_REBUILD_DATABASE_URL='postgresql://protocol:REDACTED@db.example.org/scientific_protocol_rebuild' \
npm run indexer:rebuild:fresh
```

Compare direct chain reads, counts, and cursor/hash evidence before switching read-only traffic.
Do not rewind the mixed operational database in place. Rollback restores the previous image digest,
deployment manifest, and matching database backup together.
