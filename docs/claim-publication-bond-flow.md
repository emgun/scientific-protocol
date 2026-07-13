# Claim publication bond flow

Service-assisted claim creation is deliberately two-step:

1. the signed `claim_create` request binds an immutable artifact URI and exact SHA-256, creates an
   onchain `Draft`, and attaches the verified artifact;
2. the author wallet deposits the declared bond directly into `BondEscrow.depositAuthorBond`;
3. the author signs a `claim_publish` request scoped to `claim:<id>`;
4. the operated resolver verifies `BondEscrow.isAuthorBondSatisfied(id)` onchain and only then moves
   the claim from `Draft` to `Published`.

The minimum/default amount has one deployment source of truth. Deployment records the configured
onchain `osp.claim.minAuthorBond` value as `parameters.minimumAuthorBondWei`; `/write-config`
publishes that same value as both `authorBondWei` and `minimumAuthorBondWei`.

The API never sponsors or deposits a bond on behalf of an author. This preserves bond provenance
and prevents a service key from manufacturing economically backed publication.

The original `claim_create` request remains durable while chain effects run. As soon as
`ClaimCreated` confirms, its request row records the claim ID and transaction hash. If artifact
attachment fails, that checkpoint is retained with `reconciliation_required` detail rather than
losing the onchain draft. A successful create returns `publicationStatus: awaiting_author_bond` and
does not open replication work.

The claim metadata commitment binds the signed request hash. Exact signed-request replays resume
the same request row under a renewable execution lease. Workers renew and re-check ownership before
each chain write, and a stale worker cannot reject a row now owned by its replacement. The delegated
request hash is also registered onchain: `createClaimOnBehalfWithRequestHash` idempotently returns the
original claim id, so a lease race or arbitrarily old replay cannot create a second claim. Artifact
attachment is reconciled against that claim before writing. A different payload using the same nonce
remains rejected.

`claim_publish` uses the same renewable request lease and permits only exact recorded replay. If the
chain write succeeded before request acceptance was persisted, the retry verifies the author and
canonical claim status, returns `reconciled: true` with a null transaction hash, and marks the
original request accepted. Pending or rejected late workers cannot downgrade an accepted row.

Source auto-publication follows the same rule. Consensus may prepare a draft, but the source remains
`ready_for_publication` and its publication attempt remains `claim_ready` until the source author
funds the bond and submits a signed manual confirmation/publish action. Reference agents cannot
turn an unfunded draft into an authoritative publication.
