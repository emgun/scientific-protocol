# Artifact Ingestion

Scientific Protocol keeps heavy artifacts offchain but content-addressed. The onchain record stores:

- artifact type
- immutable content digest
- canonical URI
- metadata hash

That means the protocol can already anchor full papers, repository snapshots, notebook bundles, and other large scientific artifacts without inflating onchain state.

## Supported source types

The ingestion path now supports two draft-first source flows:

- manuscript or URL ingest
- repository ingest

Manuscript ingest can snapshot:

- local files
- HTTP or HTTPS URLs
- `ipfs://` URIs
- PDFs
- markdown, HTML, plain text, or JSON sources

Repository ingest can snapshot:

- local Git repositories
- remote Git repositories clonable by `git`

Repository snapshots are stored as commit-pinned `tar.gz` archives, not floating branch URLs.

## Hosting and canonical links

Artifacts are persisted into the configured protocol-controlled storage backend before a claim draft is created. The resulting canonical URI is what gets anchored onchain.

Available backends:

- `ipfs`
- `filesystem`
- `http`
- `s3`
- `gcs`

See [README.md](../README.md) and [.env.example](../.env.example) for the backend env vars.

The important rule is:

- external links may be used as inputs
- protocol claims should point to protocol-controlled snapshots
- the snapshot digest, not the mutable external URL, is the canonical reference

For shared deployments, `ipfs` is the preferred canonical backend. It anchors the artifact as an `ipfs://CID`, keeps the URI portable, and can target a Filecoin-backed pinning provider through a Kubo-compatible API. The repo now supports both a generic `kubo` preset and a hosted `pinata` preset for that backend, plus optional `SP_ARTIFACT_IPFS_REPLICA_TARGETS` so the same snapshot can be replicated across multiple providers and later audited for availability. Centralized object stores remain useful as mirrors or caches, but not as the canonical scientific record.

Replica records now also preserve provider-native metadata when the backend exposes it. For
IPFS/Filecoin-backed providers, that means the persisted artifact surface can show provider object
IDs, pin state, and normalized Filecoin deal state when the provider returns it, instead of only a
bare `ipfs://CID`.

For corpus-scale storage planning, the protocol should store all registered artifacts through
distributed storage commitments, durability classes, audits, and repair work without requiring every
node to store the full corpus.

The read model now has an explicit scaled-storage layer on top of replicas and audits:

- `persisted_artifact_storage_policies` classifies artifacts as durability class `A`, `B`, `C`, or
  `D`, records target replica and independent-retrieval counts, and preserves bundle metadata.
- `persisted_artifact_storage_attestations` records signed, wallet-attributable storage commitments
  for a CID or bundle CID without making Postgres authoritative for the artifact bytes.
- artifact detail responses include `storagePolicy` and `storageAttestations` so independent
  gateways, operators, and repair agents can inspect the same durability state.

These records are operational evidence and coordination state. Protocol truth remains the chain
record plus content-addressed commitments; if a database is rebuilt, operators should replay chain
events and signed storage attestation records.

For corpus scale, operators can prepare provider-neutral bundle manifests before or after storing
the actual CAR, Filecoin dataset, or institutional archive. The manifest records each artifact key,
CID, digest, media type, durability class, and safe member path inside the bundle. The manifest
shape is documented in [artifact-storage-bundle.schema.json](../schemas/artifact-storage-bundle.schema.json).

Storage operators can also produce signed storage attestation records without relying on a hosted
authority. The signed payload includes the chain ID, nonce, scope key, artifact key, CID, storage
class, retention horizon, retrieval endpoint, provider metadata, and attestor wallet address.
Recording that payload into a read model only updates replaceable coordination state; the signed
JSON remains the portable evidence another node can verify and replay. The JSON shape is documented
in [artifact-storage-attestation.schema.json](../schemas/artifact-storage-attestation.schema.json).

The heaviest ingest paths also avoid the old all-bytes-in-memory upload path now:

- repository snapshots persist directly from the staged archive file
- local file ingest persists from the local file path instead of a duplicated buffer
- remote URL ingest stages to a temporary file before persistence
- the public artifact content route streams bytes back out instead of buffering full reads

## Source-first extraction

Ingestion now creates a canonical offchain `source_record` first, not an immediate onchain draft
claim.

The extraction report includes:

- source locator
- source version information such as final URL or commit hash
- normalized extracted text preview
- candidate claim sentences
- chosen draft statement
- default methodology, scope, and metadata

The human-readable extracted text remains offchain in the extraction artifact, and the protocol
opens extraction work against the source record before deciding whether a claim should be published.

This is intentional:

- the protocol stays narrow onchain
- extraction remains reviewable and replaceable
- user-submitted and agent-discovered sources use the same pipeline
- claims are only minted once extraction consensus is strong enough

## API flow

Create a source record from a manuscript or repository snapshot through the canonical production
write route:

- `GET /write-config`
- sign a `claim_draft_from_artifact` public-write envelope
- `POST /sources`

The TypeScript client exposes the source-native surface through
`client.production.createSource(...)`. The legacy
`client.production.createClaimDraftFromArtifact(...)` and `POST /claim-drafts/from-artifact` alias
still exist for compatibility, but they now return the same source-ingestion payload.

The older `POST /demo/claim-drafts/from-artifact` route remains available for sandbox/demo use, but
it is no longer the canonical authoring path.

The response includes:

- the new `source`
- the persisted snapshot artifact
- the persisted extraction artifact
- the extracted preview text and chosen statement
- any later published claim is linked back from the source page once auto-publication clears policy

Once the source exists, the circulation and decision surfaces are:

- `GET /sources/:sourceId`
- `GET /sources/:sourceId/work-graph`
- `GET /sources/:sourceId/publication-decisions`
- `POST /sources/:sourceId/confirm`
- `POST /sources/:sourceId/reject`
- `GET /feeds/sources`
- `GET /feeds/claims`
- `GET /events/sources`
- `GET /events/claims`
- `/sources/:sourceId/view`

That gives the pre-claim lifecycle a real public read surface instead of hiding source discovery,
extraction, and auto-publication behind background workers.

Agents can also discover sources directly through the signed machine route:

- `POST /agent/sources`

Persisted artifacts can then be inspected through:

- `GET /persisted-artifacts/:artifactKey`
- `GET /persisted-artifacts/:artifactKey/content`
- `GET /persisted-artifacts/:artifactKey/audits`
- `GET /persisted-artifacts/:artifactKey/maintenance-tasks`
- `/persisted-artifacts/:artifactKey/view`

Artifact durability can also be turned into agent work through queued `audit` and `repair` tasks.
See [agent-artifact-maintenance.md](./agent-artifact-maintenance.md).

## Source flow

Source ingestion is exposed through signed API and SDK surfaces rather than a bundled public CLI.
Downstream applications can snapshot a manuscript, URL, or repository, create a canonical source
record, and submit signed source publication requests through the same protocol payloads.

## Publication model

The intended lifecycle is:

1. snapshot the source artifact
2. create or update a canonical `source_record`
3. open source-backed `claim_extraction_check` and `claim_extraction_synthesis_check` work
4. let multiple agents submit candidate atomic claims with anchors
5. auto-publish a machine-proposed claim only when extraction consensus clears policy
6. otherwise keep the source circulating for later agent convergence or explicit manual confirm/reject

Every auto-publication attempt now also persists a publication-decision artifact and a structured
decision record. That means the protocol can explain:

- which extraction cluster won
- why it cleared or failed the threshold
- which competing cluster kept it from publishing
- which claim ID was published when the threshold cleared

When a source does not clear auto-acceptance, the same source page now provides the manual fallback:

- confirm one extracted candidate into a published claim through a signed public-write request
- reject the source through a signed public-write request and keep the rejection in the same
  publication-decision history

The source detail surface also includes a bounded `recentSubmissions` slice so operators can see
whether the same canonical source was first created or later reused by additional community
submissions without turning duplicate ingress into new protocol objects.

This keeps artifact intake powerful without letting ingestion services or a single heuristic parser
unilaterally publish scientific outcomes.
