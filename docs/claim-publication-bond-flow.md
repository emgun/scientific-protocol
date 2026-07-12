# Claim publication bond flow

Service-assisted claim creation is deliberately two-step:

1. the signed `claim_create` request creates an onchain `Draft` and attaches its artifact;
2. the author wallet deposits the declared bond directly into `BondEscrow.depositAuthorBond`;
3. the author signs a `claim_publish` request scoped to `claim:<id>`;
4. the operated resolver verifies `BondEscrow.isAuthorBondSatisfied(id)` onchain and only then moves
   the claim from `Draft` to `Published`.

The API never sponsors or deposits a bond on behalf of an author. This preserves bond provenance
and prevents a service key from manufacturing economically backed publication.

The original `claim_create` request remains durable while chain effects run. As soon as
`ClaimCreated` confirms, its request row records the claim ID and transaction hash. If artifact
attachment fails, that checkpoint is retained with `reconciliation_required` detail rather than
losing the onchain draft. A successful create returns `publicationStatus: awaiting_author_bond` and
does not open replication work.

Source auto-publication follows the same rule. Consensus may prepare a draft, but the source remains
`ready_for_publication` and its publication attempt remains `claim_ready` until the source author
funds the bond and submits a signed manual confirmation/publish action. Reference agents cannot
turn an unfunded draft into an authoritative publication.
