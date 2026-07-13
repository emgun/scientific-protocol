import type { Pool } from "pg";
import type { ArtifactDraftInput } from "../artifacts/ingestion.js";
import {
  prepareCoordinatorStore,
  type ReplicationJobView,
  readPersistedArtifact,
} from "../coordinator/store.js";
import { extractContractEventId, getContract } from "../shared/contracts.js";
import { getDeploymentPath, loadDeploymentFile } from "../shared/deployment.js";
import { keccakText } from "../shared/hash.js";
import { isIpfsUrl, parseIpfsUrl } from "../shared/ipfs.js";
import {
  resolveEtherInput,
  resolveIntegerInput,
  resolveNonEmptyStringInput,
} from "../shared/numbers.js";
import { createManagedOperatorSigner } from "../shared/operator.js";
import { fetchBoundedOutbound, type OutboundRequestPolicy } from "../shared/outbound-request.js";
import { sha256Hex } from "../shared/sha256.js";
import { ingestSource, type SourceIngestionResult } from "../sources/service.js";

type CoordinatorConnection = Pool | string | undefined;

type ProductionClaimOptions = {
  env?: NodeJS.ProcessEnv;
  requestHash?: string;
  faultInjection?: "before-create" | "after-create-before-checkpoint" | "after-artifact";
  onClaimDraftCreated?: (checkpoint: {
    claimId: string;
    createClaimTxHash: string;
  }) => Promise<void>;
  onClaimReady?: (checkpoint: ProductionClaimReadyCheckpoint) => Promise<void>;
  assertExecutionLease?: () => Promise<void>;
};

export type ProductionClaimInput = {
  artifactType?: number;
  artifactSha256?: string;
  artifactUri: string;
  authorBondEth?: string;
  domainId?: number;
  metadata?: string;
  methodology?: string;
  openReplicationJob?: boolean;
  predictionHooks?: string;
  requestedBy?: string;
  scope?: string;
  statement: string;
};

export type ProductionClaimResult = {
  artifactId: string | null;
  author: string;
  claimId: string;
  job: ReplicationJobView | null;
  submittedBy: string;
  publicationStatus: "awaiting_author_bond";
  txHashes: {
    addArtifact: string;
    createClaim: string;
    publishClaim?: string;
  };
};

export type ProductionClaimReadyCheckpoint = Pick<
  ProductionClaimResult,
  "artifactId" | "claimId"
> & { txHashes: Record<string, string> };

export type ProductionArtifactDraftInput = ArtifactDraftInput;
export type ProductionArtifactDraftResult = SourceIngestionResult;

export function resolveProductionClaimPublicationAction(input: {
  actualAuthor: string;
  bondSatisfied?: boolean;
  requestedAuthor: string;
  status: number;
}): "publish" | "reconciled" {
  if (input.actualAuthor.toLowerCase() !== input.requestedAuthor.toLowerCase()) {
    throw new Error("claim_author_unauthorized");
  }
  if (input.status >= 1 && input.status <= 6) return "reconciled";
  if (input.status !== 0) throw new Error("claim_not_draft");
  if (input.bondSatisfied !== true) throw new Error("claim_author_bond_unsatisfied");
  return "publish";
}

const DEFAULT_CLAIM_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

function normalizeSha256(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, "")
    .replace(/^0x/u, "");
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error("artifactSha256 must be a 32-byte hexadecimal SHA-256 digest");
  }
  return normalized;
}

function retrievableArtifactUrl(uri: string, env: NodeJS.ProcessEnv): string {
  let locator: { cid: string; path?: string };
  if (isIpfsUrl(uri)) {
    locator = parseIpfsUrl(uri);
  } else {
    const parsed = new URL(uri);
    if (parsed.protocol === "ar:") {
      const transactionId = parsed.host || parsed.pathname.replace(/^\/+/, "");
      if (!transactionId) throw new Error("invalid ar artifact locator");
      return `${(env.SP_ARTIFACT_ARWEAVE_GATEWAY_URL ?? "https://arweave.net").replace(/\/+$/u, "")}/${transactionId}`;
    }
    if (parsed.protocol !== "filecoin:") {
      throw new Error("claim artifactUri must use ipfs://, ar://, or filecoin://");
    }
    const cid = parsed.host || parsed.pathname.replace(/^\/+/, "");
    if (!cid) throw new Error("invalid filecoin artifact locator");
    locator = { cid };
  }
  const base = (env.SP_ARTIFACT_IPFS_GATEWAY_URL ?? "https://w3s.link/ipfs")
    .trim()
    .replace(/\/+$/u, "");
  const normalizedBase = base.endsWith("/ipfs") ? base : `${base}/ipfs`;
  return `${normalizedBase}/${locator.cid}${locator.path ? `/${locator.path}` : ""}`;
}

export async function runClaimCreationSaga(input: {
  attachArtifact: (claimId: string) => Promise<{ artifactId: string; txHash: string }>;
  checkpoint: (claimId: string, txHash: string) => Promise<void>;
  createClaim: () => Promise<{ claimId: string; txHash: string }>;
  faultInjection?: ProductionClaimOptions["faultInjection"];
  findArtifact: (claimId: string) => Promise<{ artifactId: string; txHash: string } | null>;
  findClaim: () => Promise<{ claimId: string; txHash: string } | null>;
}): Promise<{ artifactId: string; artifactTxHash: string; claimId: string; claimTxHash: string }> {
  if (input.faultInjection === "before-create") throw new Error("fault_injected_before_create");
  const existingClaim = await input.findClaim();
  const claim = existingClaim ?? (await input.createClaim());
  if (!existingClaim && input.faultInjection === "after-create-before-checkpoint") {
    throw new Error("fault_injected_after_create_before_checkpoint");
  }
  await input.checkpoint(claim.claimId, claim.txHash);
  const existingArtifact = await input.findArtifact(claim.claimId);
  const artifact = existingArtifact ?? (await input.attachArtifact(claim.claimId));
  if (!existingArtifact && input.faultInjection === "after-artifact") {
    throw new Error("fault_injected_after_artifact");
  }
  return {
    artifactId: artifact.artifactId,
    artifactTxHash: artifact.txHash,
    claimId: claim.claimId,
    claimTxHash: claim.txHash,
  };
}

export async function verifyProductionClaimArtifact(
  input: Pick<ProductionClaimInput, "artifactSha256" | "artifactUri">,
  options: OutboundRequestPolicy & { env?: NodeJS.ProcessEnv } = {},
): Promise<{ contentDigest: string; sizeBytes: number }> {
  const uri = input.artifactUri.trim();
  if (!uri) throw new Error("artifactUri is required");
  const expected = normalizeSha256(input.artifactSha256 ?? "");
  const response = await fetchBoundedOutbound(
    retrievableArtifactUrl(uri, options.env ?? process.env),
    {},
    {
      ...options,
      maxBytes: options.maxBytes ?? DEFAULT_CLAIM_ARTIFACT_MAX_BYTES,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`claim artifact retrieval failed with status ${response.status}`);
  }
  const observed = sha256Hex(response.body);
  if (observed !== expected) {
    throw new Error(`claim artifact SHA-256 mismatch: expected ${expected}, observed ${observed}`);
  }
  return { contentDigest: `0x${observed}`, sizeBytes: response.body.byteLength };
}

async function createProductionClaimLocked(
  input: ProductionClaimInput,
  authorAddress: string,
  verifiedArtifact: { contentDigest: string; sizeBytes: number },
  options: ProductionClaimOptions,
): Promise<ProductionClaimResult> {
  const env = options.env ?? process.env;
  if (!input.statement || input.statement.trim() === "") {
    throw new Error("statement is required");
  }
  if (!input.artifactUri || input.artifactUri.trim() === "") {
    throw new Error("artifactUri is required");
  }
  const domainId = resolveIntegerInput(input.domainId, 1, "domainId");
  const artifactType = resolveIntegerInput(input.artifactType, 1, "artifactType", {
    min: 1,
  });
  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
  const authorBond =
    input.authorBondEth === undefined
      ? BigInt(deployment.parameters.minimumAuthorBondWei)
      : resolveEtherInput(input.authorBondEth, "0");
  const submitterSigner = createManagedOperatorSigner(
    ["SP_CLAIM_SUBMITTER_PRIVATE_KEY", "SP_PROTOCOL_ADMIN_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
    { env, localAccountIndex: 0 },
  );
  const submittedBy = await submitterSigner.getAddress();
  const [claimRegistryAsSubmitter, artifactRegistry] = await Promise.all([
    getContract("ClaimRegistry", deployment.addresses.claimRegistry, submitterSigner),
    getContract("ArtifactRegistry", deployment.addresses.artifactRegistry, submitterSigner),
  ]);

  const statement = resolveNonEmptyStringInput(input.statement, "Untitled claim");
  const methodology = resolveNonEmptyStringInput(input.methodology, "production-methodology");
  const scope = resolveNonEmptyStringInput(input.scope, "production-scope");
  const metadata = resolveNonEmptyStringInput(input.metadata, "production-metadata");
  const predictionHooks = resolveNonEmptyStringInput(input.predictionHooks, "production-hooks");

  const requestCommitment = options.requestHash?.toLowerCase();
  const existingRequestClaimId = requestCommitment
    ? await claimRegistryAsSubmitter.getDelegatedClaimIdByRequestHash(requestCommitment)
    : 0n;

  const saga = await runClaimCreationSaga({
    faultInjection: options.faultInjection,
    findClaim: async () =>
      existingRequestClaimId !== 0n
        ? {
            claimId: existingRequestClaimId.toString(),
            txHash: "0x",
          }
        : null,
    createClaim: async () => {
      await options.assertExecutionLease?.();
      const createTx = requestCommitment
        ? await claimRegistryAsSubmitter.createClaimOnBehalfWithRequestHash(
            {
              statementHash: keccakText(statement),
              methodologyHash: keccakText(methodology),
              scopeHash: keccakText(scope),
              metadataHash: requestCommitment,
              predictionHooksHash: keccakText(predictionHooks),
              domainId: BigInt(domainId),
              author: authorAddress,
            },
            authorBond,
            "0x0000000000000000000000000000000000000000",
            requestCommitment,
          )
        : await claimRegistryAsSubmitter.createClaimOnBehalf(
            {
              statementHash: keccakText(statement),
              methodologyHash: keccakText(methodology),
              scopeHash: keccakText(scope),
              metadataHash: requestCommitment ?? keccakText(metadata),
              predictionHooksHash: keccakText(predictionHooks),
              domainId: BigInt(domainId),
              author: authorAddress,
            },
            authorBond,
            "0x0000000000000000000000000000000000000000",
          );
      const receipt = await createTx.wait();
      const emittedClaimId = extractContractEventId(
        claimRegistryAsSubmitter,
        receipt,
        "ClaimCreated",
        "claimId",
      );
      const claimId =
        emittedClaimId ??
        (requestCommitment
          ? (
              await claimRegistryAsSubmitter.getDelegatedClaimIdByRequestHash(requestCommitment)
            ).toString()
          : null);
      if (!claimId || claimId === "0") {
        throw new Error(`claim transaction ${receipt.hash} did not establish a delegated claim`);
      }
      return { claimId, txHash: receipt.hash };
    },
    checkpoint: async (claimId, txHash) => {
      await options.onClaimDraftCreated?.({ claimId, createClaimTxHash: txHash });
    },
    findArtifact: async (claimId) => {
      const artifactIds = await artifactRegistry.getClaimArtifactIds(BigInt(claimId));
      for (const id of artifactIds) {
        const artifact = await artifactRegistry.getArtifact(id);
        if (
          artifact.contentDigest.toLowerCase() === verifiedArtifact.contentDigest.toLowerCase() &&
          artifact.uri === input.artifactUri.trim()
        ) {
          return { artifactId: id.toString(), txHash: "0x" };
        }
      }
      return null;
    },
    attachArtifact: async (claimId) => {
      await options.assertExecutionLease?.();
      const tx = await artifactRegistry.addArtifact(
        BigInt(claimId),
        BigInt(artifactType),
        verifiedArtifact.contentDigest,
        input.artifactUri.trim(),
        keccakText(metadata),
      );
      const receipt = await tx.wait();
      const artifactId = extractContractEventId(
        artifactRegistry,
        receipt,
        "ArtifactAdded",
        "artifactId",
      );
      if (!artifactId)
        throw new Error(`artifact transaction ${receipt.hash} did not emit ArtifactAdded`);
      return { artifactId, txHash: receipt.hash };
    },
  });

  // Replication work cannot open until the author funds the declared bond and
  // explicitly publishes through the second signed action.
  const job: ReplicationJobView | null = null;

  const result = {
    artifactId: saga.artifactId,
    author: authorAddress,
    claimId: saga.claimId,
    job,
    publicationStatus: "awaiting_author_bond" as const,
    submittedBy,
    txHashes: {
      addArtifact: saga.artifactTxHash,
      createClaim: saga.claimTxHash,
    },
  };
  await options.onClaimReady?.({
    artifactId: result.artifactId,
    claimId: result.claimId,
    txHashes: Object.fromEntries(
      Object.entries(result.txHashes).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    ),
  });
  return result;
}

export async function createProductionClaim(
  input: ProductionClaimInput,
  authorAddress: string,
  connection?: CoordinatorConnection,
  options: ProductionClaimOptions = {},
): Promise<ProductionClaimResult> {
  const env = options.env ?? process.env;
  // Fetch and verify before loading deployment state, acquiring DB locks, or sending any chain tx.
  let verifiedArtifact: { contentDigest: string; sizeBytes: number };
  const persistedArtifactKey = input.artifactUri.match(/^persisted-artifact:\/\/(.+)$/u)?.[1];
  if (persistedArtifactKey && connection && typeof connection !== "string") {
    const persisted = await readPersistedArtifact(connection, persistedArtifactKey);
    if (!persisted) throw new Error("claim persisted artifact was not found");
    verifiedArtifact = { contentDigest: persisted.sha256, sizeBytes: persisted.byteLength };
  } else {
    verifiedArtifact = await verifyProductionClaimArtifact(input, { env });
  }
  return createProductionClaimLocked(input, authorAddress, verifiedArtifact, options);
}

export async function publishProductionClaim(
  claimId: string,
  authorAddress: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { assertExecutionLease?: () => Promise<void> } = {},
): Promise<{
  claimId: string;
  publicationStatus: "published";
  publishClaimTxHash: string | null;
  reconciled: boolean;
}> {
  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
  const resolverSigner = createManagedOperatorSigner(
    ["SP_RESOLVER_PRIVATE_KEY", "SP_PROTOCOL_ADMIN_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
    { env, localAccountIndex: 4 },
  );
  const [claimRegistry, bondEscrow] = await Promise.all([
    getContract("ClaimRegistry", deployment.addresses.claimRegistry, resolverSigner),
    getContract("BondEscrow", deployment.addresses.bondEscrow, resolverSigner),
  ]);
  const claim = await claimRegistry.getClaim(BigInt(claimId));
  const status = Number(claim.status);
  const bondSatisfied =
    status === 0 ? await bondEscrow.isAuthorBondSatisfied(BigInt(claimId)) : undefined;
  const action = resolveProductionClaimPublicationAction({
    actualAuthor: claim.summary.author,
    bondSatisfied,
    requestedAuthor: authorAddress,
    status,
  });
  if (action === "reconciled") {
    return {
      claimId,
      publicationStatus: "published",
      publishClaimTxHash: null,
      reconciled: true,
    };
  }
  await options.assertExecutionLease?.();
  const tx = await claimRegistry.setClaimStatus(BigInt(claimId), 1);
  const receipt = await tx.wait();
  return {
    claimId,
    publicationStatus: "published",
    publishClaimTxHash: receipt.hash,
    reconciled: false,
  };
}

export async function createProductionArtifactDraft(
  input: ProductionArtifactDraftInput,
  authorAddress: string,
  connection?: CoordinatorConnection,
  options: { requestHash?: string | null } = {},
): Promise<ProductionArtifactDraftResult> {
  const ownsPool = typeof connection === "string" || connection === undefined;
  const pool =
    typeof connection === "string" || connection === undefined
      ? await prepareCoordinatorStore(connection)
      : connection;
  try {
    return await ingestSource(pool, input, {
      discoveryMode: "user_submitted",
      requestHash: options.requestHash,
      submittedByActor: authorAddress,
    });
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}
