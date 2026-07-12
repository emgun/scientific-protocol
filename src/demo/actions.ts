import type { Pool } from "pg";
import type { ArtifactDraftInput } from "../artifacts/ingestion.js";
import { publishDomainCheckpoints } from "../checkpoints/publisher.js";
import {
  createReplicationJob,
  prepareCoordinatorStore,
  type ReplicationJobView,
} from "../coordinator/store.js";
import { type ComputedLeaderboard, computeDomainLeaderboard } from "../reputation/engine.js";
import { resolveReplicationJob } from "../resolver/engine.js";
import { applyAutomaticRewardPolicy, type RewardPolicySettlementView } from "../rewards/policy.js";
import { CLAIM_REWARD_WORK_KIND_CODES } from "../rewards/types.js";
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
import { processReplicationJob } from "../workers/replication-worker.js";
import { resetSandboxDemoEnvironment } from "./reset.js";
import {
  type DemoScenarioView,
  prepareDemoStore,
  readDemoScenarios,
  upsertDemoScenario,
} from "./store.js";
import {
  buildOperationalScenarioClaimInput,
  FULL_CLAIM_OBJECT_SCENARIO_KEY,
  getDemoScenarioTemplate,
  listDemoScenarioTemplates,
  OPERATIONAL_LOOP_SCENARIO_KEY,
} from "./templates.js";

export type DemoClaimInput = {
  artifactType?: number;
  artifactUri: string;
  authorBondEth?: string;
  bountyEth?: string;
  domainId?: number;
  metadata?: string;
  methodology?: string;
  openReplicationJob?: boolean;
  predictionHooks?: string;
  requestedBy?: string;
  scope?: string;
  statement: string;
};

export type DemoClaimResult = {
  artifactId: string | null;
  claimId: string;
  createdBy: string;
  job: ReplicationJobView | null;
  txHashes: {
    addArtifact: string;
    createClaim: string;
    depositAuthorBond: string;
    fundClaimRewardPool: string;
    publishClaim: string;
  };
};

export type DemoDomainRecomputeResult = {
  leaderboard: ComputedLeaderboard;
  publications: Awaited<ReturnType<typeof publishDomainCheckpoints>>;
  rewardSettlements: RewardPolicySettlementView[];
};

export type DemoArtifactDraftInput = ArtifactDraftInput;
export type DemoArtifactDraftResult = SourceIngestionResult;

export type DemoScenarioSeedResult = {
  claim: DemoClaimResult;
  scenario: DemoScenarioView;
};

type CoordinatorConnection = Pool | string | undefined;

const DEFAULT_AUTHOR_BOND_ETH = "0.005";
const DEFAULT_BOUNTY_ETH = "0.01";

export async function createDemoClaim(
  input: DemoClaimInput,
  connection?: CoordinatorConnection,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<DemoClaimResult> {
  const env = options.env ?? process.env;
  if (!input.statement || input.statement.trim() === "") {
    throw new Error("statement is required");
  }
  if (!input.artifactUri || input.artifactUri.trim() === "") {
    throw new Error("artifactUri is required");
  }
  const domainId = resolveIntegerInput(input.domainId, 1, "domainId");
  const artifactType = resolveIntegerInput(input.artifactType, 1, "artifactType", { min: 1 });
  const authorBond = resolveEtherInput(input.authorBondEth, DEFAULT_AUTHOR_BOND_ETH);
  const bounty = resolveEtherInput(input.bountyEth, DEFAULT_BOUNTY_ETH);

  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
  const adminSigner = createManagedOperatorSigner(
    ["SP_PROTOCOL_ADMIN_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
    { env, localAccountIndex: 0 },
  );
  const authorSigner = createManagedOperatorSigner(
    ["SP_CLAIM_AUTHOR_PRIVATE_KEY", "SP_OPERATOR_PRIVATE_KEY"],
    { env, localAccountIndex: 1 },
  );

  const [
    claimRegistryAsAuthor,
    claimRegistryAsAdmin,
    artifactRegistry,
    bondEscrowAsAuthor,
    claimRewardVaultAsAdmin,
  ] = await Promise.all([
    getContract("ClaimRegistry", deployment.addresses.claimRegistry, authorSigner),
    getContract("ClaimRegistry", deployment.addresses.claimRegistry, adminSigner),
    getContract("ArtifactRegistry", deployment.addresses.artifactRegistry, authorSigner),
    getContract("BondEscrow", deployment.addresses.bondEscrow, authorSigner),
    getContract("ClaimRewardVault", deployment.addresses.claimRewardVault, adminSigner),
  ]);

  const authorAddress = await authorSigner.getAddress();
  const statement = resolveNonEmptyStringInput(input.statement, "Untitled claim");
  const methodology = resolveNonEmptyStringInput(input.methodology, "demo-methodology");
  const scope = resolveNonEmptyStringInput(input.scope, "demo-scope");
  const metadata = resolveNonEmptyStringInput(input.metadata, "demo-metadata");
  const predictionHooks = resolveNonEmptyStringInput(input.predictionHooks, "demo-hooks");

  const createTx = await claimRegistryAsAuthor.createClaim(
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
    claimRegistryAsAuthor,
    createReceipt,
    "ClaimCreated",
    "claimId",
  );
  if (!claimId) {
    throw new Error(`claim transaction ${createReceipt.hash} did not emit ClaimCreated`);
  }

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

  const depositTx = await bondEscrowAsAuthor.depositAuthorBond(BigInt(claimId), {
    value: authorBond,
  });
  const depositReceipt = await depositTx.wait();

  const publishTx = await claimRegistryAsAdmin.setClaimStatus(BigInt(claimId), 1);
  const publishReceipt = await publishTx.wait();

  const bountyTx = await claimRewardVaultAsAdmin.fundClaimRewards(
    BigInt(claimId),
    CLAIM_REWARD_WORK_KIND_CODES.replication,
    {
      value: bounty,
    },
  );
  const bountyReceipt = await bountyTx.wait();

  let job: ReplicationJobView | null = null;
  if (input.openReplicationJob) {
    const ownsPool = typeof connection === "string" || connection === undefined;
    const pool = ownsPool ? await prepareCoordinatorStore(connection) : connection;
    try {
      job = await createReplicationJob(pool, {
        claimId,
        requestedBy: resolveNonEmptyStringInput(input.requestedBy, "dashboard"),
        specHash: keccakText(
          JSON.stringify({
            artifactUri: input.artifactUri.trim(),
            claimId,
            domainId,
            statement,
          }),
        ),
      });
    } finally {
      if (ownsPool) {
        await pool.end();
      }
    }
  }

  return {
    artifactId,
    claimId,
    createdBy: authorAddress,
    job,
    txHashes: {
      addArtifact: addArtifactReceipt.hash,
      createClaim: createReceipt.hash,
      depositAuthorBond: depositReceipt.hash,
      fundClaimRewardPool: bountyReceipt.hash,
      publishClaim: publishReceipt.hash,
    },
  };
}

export async function createDemoArtifactDraft(
  input: DemoArtifactDraftInput,
  connection?: CoordinatorConnection,
): Promise<DemoArtifactDraftResult> {
  const ownsPool = typeof connection === "string" || connection === undefined;
  const pool = ownsPool ? await prepareCoordinatorStore(connection) : connection;
  try {
    return await ingestSource(pool, input, {
      discoveryMode: "user_submitted",
    });
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

export async function openDemoReplicationJob(
  input: { claimId: string; requestedBy?: string },
  connection?: CoordinatorConnection,
): Promise<ReplicationJobView> {
  const ownsPool = typeof connection === "string" || connection === undefined;
  const pool = ownsPool ? await prepareCoordinatorStore(connection) : connection;
  try {
    return createReplicationJob(pool, {
      claimId: input.claimId,
      requestedBy: resolveNonEmptyStringInput(input.requestedBy, "dashboard"),
      specHash: keccakText(
        JSON.stringify({
          claimId: input.claimId,
          requestedAt: new Date().toISOString(),
          requestedBy: resolveNonEmptyStringInput(input.requestedBy, "dashboard"),
        }),
      ),
    });
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}

export async function processDemoReplicationJob(
  input: { jobId: string; workerId?: string },
  connectionString?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Awaited<ReturnType<typeof processReplicationJob>>> {
  return processReplicationJob(
    {
      connectionString,
      jobId: input.jobId,
      onceWorkerId: input.workerId,
    },
    env,
  );
}

export async function resolveDemoReplicationJob(
  input: {
    claimStatus?: number | null;
    confidenceBps?: number;
    jobId: string;
    resolutionStatus?: number;
  },
  connectionString?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Awaited<ReturnType<typeof resolveReplicationJob>>> {
  return resolveReplicationJob({
    claimStatus: input.claimStatus,
    confidenceBps: input.confidenceBps,
    connectionString,
    env,
    jobId: input.jobId,
    resolutionStatus: input.resolutionStatus,
  });
}

export async function recomputeDemoDomain(
  input: { domainId: number },
  connectionString?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DemoDomainRecomputeResult> {
  const leaderboard = await computeDomainLeaderboard(connectionString, input.domainId);
  const publications = await publishDomainCheckpoints({
    connectionString,
    domainId: input.domainId,
    env,
  });
  const rewardPolicy = await applyAutomaticRewardPolicy({
    connectionString,
    domainId: input.domainId,
    env,
  });
  return { leaderboard, publications, rewardSettlements: rewardPolicy.settlements };
}

export async function registerFeaturedDemoScenarios(
  input: {
    fullClaimId: string;
    operationalClaimId: string;
  },
  connectionString?: string,
): Promise<DemoScenarioView[]> {
  const pool = await prepareDemoStore(connectionString);
  try {
    const fullTemplate = getDemoScenarioTemplate(FULL_CLAIM_OBJECT_SCENARIO_KEY);
    const operationalTemplate = getDemoScenarioTemplate(OPERATIONAL_LOOP_SCENARIO_KEY);
    if (!fullTemplate || !operationalTemplate) {
      throw new Error("missing_demo_scenario_templates");
    }

    const results = await Promise.all([
      upsertDemoScenario(pool, {
        scenarioKey: fullTemplate.scenarioKey,
        claimId: input.fullClaimId,
        domainId: fullTemplate.domainId,
        eyebrow: fullTemplate.eyebrow,
        title: fullTemplate.title,
        summary: fullTemplate.summary,
        detail: fullTemplate.detail,
        whyItMatters: fullTemplate.whyItMatters,
        proofPoint: fullTemplate.proofPoint,
      }),
      upsertDemoScenario(pool, {
        scenarioKey: operationalTemplate.scenarioKey,
        claimId: input.operationalClaimId,
        domainId: operationalTemplate.domainId,
        eyebrow: operationalTemplate.eyebrow,
        title: operationalTemplate.title,
        summary: operationalTemplate.summary,
        detail: operationalTemplate.detail,
        whyItMatters: operationalTemplate.whyItMatters,
        proofPoint: operationalTemplate.proofPoint,
      }),
    ]);

    return results;
  } finally {
    await pool.end();
  }
}

export async function listFeaturedDemoScenarios(
  connectionString?: string,
): Promise<DemoScenarioView[]> {
  const pool = await prepareDemoStore(connectionString);
  try {
    const scenarios = await readDemoScenarios(pool);
    if (scenarios.length > 0) {
      return scenarios;
    }

    return listDemoScenarioTemplates().map((template) => ({
      scenarioKey: template.scenarioKey,
      claimId: template.scenarioKey === FULL_CLAIM_OBJECT_SCENARIO_KEY ? "1" : "2",
      domainId: template.domainId,
      eyebrow: template.eyebrow,
      title: template.title,
      summary: template.summary,
      detail: template.detail,
      whyItMatters: template.whyItMatters,
      proofPoint: template.proofPoint,
      updatedAt: new Date(0).toISOString(),
    }));
  } finally {
    await pool.end();
  }
}

export async function reseedOperationalDemoScenario(
  connectionString?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DemoScenarioSeedResult> {
  const seedSuffix = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const template = getDemoScenarioTemplate(OPERATIONAL_LOOP_SCENARIO_KEY);
  if (!template) {
    throw new Error("missing_operational_demo_template");
  }

  const claim = await createDemoClaim(
    {
      ...buildOperationalScenarioClaimInput(seedSuffix),
      domainId: template.domainId,
      authorBondEth: DEFAULT_AUTHOR_BOND_ETH,
      bountyEth: DEFAULT_BOUNTY_ETH,
      openReplicationJob: true,
    },
    connectionString,
    { env },
  );

  const pool = await prepareDemoStore(connectionString);
  try {
    const scenario = await upsertDemoScenario(pool, {
      scenarioKey: template.scenarioKey,
      claimId: claim.claimId,
      domainId: template.domainId,
      eyebrow: template.eyebrow,
      title: template.title,
      summary: template.summary,
      detail: template.detail,
      whyItMatters: template.whyItMatters,
      proofPoint: template.proofPoint,
    });

    return { claim, scenario };
  } finally {
    await pool.end();
  }
}

export async function resetSandboxDemo(
  connectionString?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ finishedAt: string; resetAt: string }> {
  return resetSandboxDemoEnvironment(connectionString, env);
}
