import type { Pool } from "pg";
import type { ArtifactDraftInput } from "../artifacts/ingestion.js";
import { prepareCoordinatorStore, type ReplicationJobView } from "../coordinator/store.js";
import { extractContractEventId, getContract } from "../shared/contracts.js";
import { getDeploymentPath, loadDeploymentFile } from "../shared/deployment.js";
import { keccakText } from "../shared/hash.js";
import {
  resolveEtherInput,
  resolveIntegerInput,
  resolveNonEmptyStringInput,
} from "../shared/numbers.js";
import { createManagedOperatorSigner } from "../shared/operator.js";
import { ingestSource, type SourceIngestionResult } from "../sources/service.js";

type CoordinatorConnection = Pool | string | undefined;

export type ProductionClaimInput = {
  artifactType?: number;
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

const DEFAULT_AUTHOR_BOND_ETH = "0.005";

export async function createProductionClaim(
  input: ProductionClaimInput,
  authorAddress: string,
  _connection?: CoordinatorConnection,
  options: {
    env?: NodeJS.ProcessEnv;
    onClaimDraftCreated?: (checkpoint: {
      claimId: string;
      createClaimTxHash: string;
    }) => Promise<void>;
    onClaimReady?: (checkpoint: ProductionClaimReadyCheckpoint) => Promise<void>;
  } = {},
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
  const authorBond = resolveEtherInput(input.authorBondEth, DEFAULT_AUTHOR_BOND_ETH);

  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
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

  const createTx = await claimRegistryAsSubmitter.createClaimOnBehalf(
    {
      statementHash: keccakText(statement),
      methodologyHash: keccakText(methodology),
      scopeHash: keccakText(scope),
      metadataHash: keccakText(metadata),
      predictionHooksHash: keccakText(predictionHooks),
      domainId: BigInt(domainId),
      author: authorAddress,
    },
    authorBond,
    "0x0000000000000000000000000000000000000000",
  );
  const createReceipt = await createTx.wait();
  const claimId = extractContractEventId(
    claimRegistryAsSubmitter,
    createReceipt,
    "ClaimCreated",
    "claimId",
  );
  if (!claimId) {
    throw new Error(`claim transaction ${createReceipt.hash} did not emit ClaimCreated`);
  }
  await options.onClaimDraftCreated?.({ claimId, createClaimTxHash: createReceipt.hash });

  const addArtifactTx = await artifactRegistry.addArtifact(
    BigInt(claimId),
    BigInt(artifactType),
    keccakText(`${statement}:${input.artifactUri}`),
    input.artifactUri.trim(),
    keccakText(metadata),
  );
  const addArtifactReceipt = await addArtifactTx.wait();
  const artifactId = extractContractEventId(
    artifactRegistry,
    addArtifactReceipt,
    "ArtifactAdded",
    "artifactId",
  );

  // Replication work cannot open until the author funds the declared bond and
  // explicitly publishes through the second signed action.
  const job: ReplicationJobView | null = null;

  const result = {
    artifactId,
    author: authorAddress,
    claimId,
    job,
    publicationStatus: "awaiting_author_bond" as const,
    submittedBy,
    txHashes: {
      addArtifact: addArtifactReceipt.hash,
      createClaim: createReceipt.hash,
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

export async function publishProductionClaim(
  claimId: string,
  authorAddress: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ claimId: string; publicationStatus: "published"; publishClaimTxHash: string }> {
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
  if (claim.summary.author.toLowerCase() !== authorAddress.toLowerCase()) {
    throw new Error("claim_author_unauthorized");
  }
  if (Number(claim.status) !== 0) throw new Error("claim_not_draft");
  if (!(await bondEscrow.isAuthorBondSatisfied(BigInt(claimId)))) {
    throw new Error("claim_author_bond_unsatisfied");
  }
  const tx = await claimRegistry.setClaimStatus(BigInt(claimId), 1);
  const receipt = await tx.wait();
  return { claimId, publicationStatus: "published", publishClaimTxHash: receipt.hash };
}

export async function createProductionArtifactDraft(
  input: ProductionArtifactDraftInput,
  authorAddress: string,
  connection?: CoordinatorConnection,
): Promise<ProductionArtifactDraftResult> {
  const ownsPool = typeof connection === "string" || connection === undefined;
  const pool =
    typeof connection === "string" || connection === undefined
      ? await prepareCoordinatorStore(connection)
      : connection;
  try {
    return await ingestSource(pool, input, {
      discoveryMode: "user_submitted",
      submittedByActor: authorAddress,
    });
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}
