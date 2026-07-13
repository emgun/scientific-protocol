import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const { ethers } = await network.connect();

const ROLE = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));

const CLAIM_STATUS = {
  Draft: 0,
  Published: 1,
  UnderReplication: 2,
  ProvisionallySupported: 3,
  Qualified: 4,
  Refuted: 5,
  Fraudulent: 6,
  Deprecated: 7,
} as const;

const RESOLUTION_STATUS = {
  Pending: 0,
  Supported: 1,
  Qualified: 2,
  Inconclusive: 3,
  Refuted: 4,
  FraudSignal: 5,
  Escalated: 6,
} as const;

const RESOLVER_TYPE = {
  HumanResolver: 1,
  AgentWorker: 2,
  ComputationOracle: 3,
  BenchmarkOracle: 4,
  WetLabCouncil: 5,
  AppealCourt: 6,
} as const;

const SUBJECT_TYPE = {
  Actor: 0,
  Claim: 1,
  ActorClaimPair: 2,
  Agent: 3,
  Module: 4,
} as const;

const FORECAST_DIRECTION = {
  Supports: 0,
  Questions: 1,
  Refutes: 2,
} as const;

const CHALLENGE_STATUS = {
  Open: 0,
  Sustained: 1,
  Dismissed: 2,
  Escalated: 3,
  Withdrawn: 4,
} as const;

const APPEAL_REASON = {
  DisputedClassification: 0,
  FraudAllegation: 1,
  ResolverMisconduct: 2,
  ModuleBoundary: 3,
} as const;

const APPEAL_STATUS = {
  Filed: 0,
  Accepted: 1,
  Rejected: 2,
  Upheld: 3,
  Overturned: 4,
  Closed: 5,
} as const;

async function deployProtocol() {
  const [admin, author, replicator, checkpointPublisher, agentOperator, other] =
    await ethers.getSigners();

  const AccessController = await ethers.getContractFactory(
    "contracts/AccessController.sol:AccessController",
  );
  const accessController = await AccessController.deploy(admin.address);
  await accessController.waitForDeployment();

  for (const role of [
    "CLAIM_SUBMITTER_ROLE",
    "PARAMETER_ADMIN_ROLE",
    "RESOLVER_ROLE",
    "CHECKPOINT_PUBLISHER_ROLE",
    "MODULE_ADMIN_ROLE",
    "ESCROW_ADMIN_ROLE",
    "AGENT_BUDGET_MANAGER_ROLE",
    "MARKET_SETTLER_ROLE",
    "REWARD_SETTLER_ROLE",
    "COURT_ROLE",
  ]) {
    await (await accessController.grantRole(ROLE(role), admin.address)).wait();
  }

  await (
    await accessController.grantRole(ROLE("CHECKPOINT_PUBLISHER_ROLE"), checkpointPublisher.address)
  ).wait();

  const ModuleRegistry = await ethers.getContractFactory(
    "contracts/ResolutionModuleRegistry.sol:ResolutionModuleRegistry",
  );
  const moduleRegistry = await ModuleRegistry.deploy(await accessController.getAddress());
  await moduleRegistry.waitForDeployment();

  const ComputationalModule = await ethers.getContractFactory(
    "contracts/modules/ComputationalResolutionModule.sol:ComputationalResolutionModule",
  );
  const computationalModule = await ComputationalModule.deploy();
  await computationalModule.waitForDeployment();

  const BenchmarkModule = await ethers.getContractFactory(
    "contracts/modules/BenchmarkResolutionModule.sol:BenchmarkResolutionModule",
  );
  const benchmarkModule = await BenchmarkModule.deploy();
  await benchmarkModule.waitForDeployment();

  const WetLabModule = await ethers.getContractFactory(
    "contracts/modules/WetLabResolutionModule.sol:WetLabResolutionModule",
  );
  const wetLabModule = await WetLabModule.deploy();
  await wetLabModule.waitForDeployment();

  for (const module of [computationalModule, benchmarkModule, wetLabModule]) {
    await (
      await moduleRegistry.registerModule(await module.getAddress(), "ipfs://module-metadata")
    ).wait();
  }

  await (await moduleRegistry.setDomainModule(1, await computationalModule.getAddress())).wait();
  await (await moduleRegistry.setDomainModule(2, await wetLabModule.getAddress())).wait();
  await (await moduleRegistry.setDomainModule(3, await benchmarkModule.getAddress())).wait();

  const ProtocolParameters = await ethers.getContractFactory(
    "contracts/ProtocolParameters.sol:ProtocolParameters",
  );
  const protocolParameters = await ProtocolParameters.deploy(await accessController.getAddress());
  await protocolParameters.waitForDeployment();

  const ClaimRegistry = await ethers.getContractFactory(
    "contracts/ClaimRegistry.sol:ClaimRegistry",
  );
  const claimRegistry = await ClaimRegistry.deploy(
    await accessController.getAddress(),
    await moduleRegistry.getAddress(),
    await protocolParameters.getAddress(),
  );
  await claimRegistry.waitForDeployment();

  const ArtifactRegistry = await ethers.getContractFactory(
    "contracts/ArtifactRegistry.sol:ArtifactRegistry",
  );
  const artifactRegistry = await ArtifactRegistry.deploy(await claimRegistry.getAddress());
  await artifactRegistry.waitForDeployment();

  const AgentRegistry = await ethers.getContractFactory(
    "contracts/AgentRegistry.sol:AgentRegistry",
  );
  const agentRegistry = await AgentRegistry.deploy(await accessController.getAddress());
  await agentRegistry.waitForDeployment();

  const ClaimRewardVault = await ethers.getContractFactory(
    "contracts/ClaimRewardVault.sol:ClaimRewardVault",
  );
  const claimRewardVault = await ClaimRewardVault.deploy(
    await accessController.getAddress(),
    await claimRegistry.getAddress(),
    await agentRegistry.getAddress(),
  );
  await claimRewardVault.waitForDeployment();

  const ReplicationRegistry = await ethers.getContractFactory(
    "contracts/ReplicationRegistry.sol:ReplicationRegistry",
  );
  const replicationRegistry = await ReplicationRegistry.deploy(
    await accessController.getAddress(),
    await claimRegistry.getAddress(),
    await agentRegistry.getAddress(),
  );
  await replicationRegistry.waitForDeployment();

  const BondEscrow = await ethers.getContractFactory("contracts/BondEscrow.sol:BondEscrow");
  const bondEscrow = await BondEscrow.deploy(
    await accessController.getAddress(),
    await claimRegistry.getAddress(),
    await replicationRegistry.getAddress(),
  );
  await bondEscrow.waitForDeployment();
  await (
    await claimRegistry
      .connect(admin)
      .configureProtocolDependencies(
        await bondEscrow.getAddress(),
        await replicationRegistry.getAddress(),
      )
  ).wait();

  const CheckpointRegistry = await ethers.getContractFactory(
    "contracts/ReputationCheckpointRegistry.sol:ReputationCheckpointRegistry",
  );
  const checkpointRegistry = await CheckpointRegistry.deploy(
    await accessController.getAddress(),
    await claimRegistry.getAddress(),
    await agentRegistry.getAddress(),
    await moduleRegistry.getAddress(),
  );
  await checkpointRegistry.waitForDeployment();

  const EpistemicMarket = await ethers.getContractFactory(
    "contracts/EpistemicMarket.sol:EpistemicMarket",
  );
  const epistemicMarket = await EpistemicMarket.deploy(
    await accessController.getAddress(),
    await claimRegistry.getAddress(),
    await agentRegistry.getAddress(),
    await replicationRegistry.getAddress(),
  );
  await epistemicMarket.waitForDeployment();

  const ProtocolTreasury = await ethers.getContractFactory(
    "contracts/ProtocolTreasury.sol:ProtocolTreasury",
  );
  const protocolTreasury = await ProtocolTreasury.deploy(admin.address);
  await protocolTreasury.waitForDeployment();

  const AppealsRegistry = await ethers.getContractFactory(
    "contracts/AppealsRegistry.sol:AppealsRegistry",
  );
  const appealsRegistry = await AppealsRegistry.deploy(
    await accessController.getAddress(),
    await claimRegistry.getAddress(),
    await replicationRegistry.getAddress(),
    await epistemicMarket.getAddress(),
    await protocolTreasury.getAddress(),
  );
  await appealsRegistry.waitForDeployment();

  return {
    admin,
    author,
    replicator,
    checkpointPublisher,
    agentOperator,
    other,
    accessController,
    moduleRegistry,
    protocolParameters,
    protocolTreasury,
    computationalModule,
    benchmarkModule,
    wetLabModule,
    claimRegistry,
    artifactRegistry,
    bondEscrow,
    claimRewardVault,
    agentRegistry,
    replicationRegistry,
    checkpointRegistry,
    epistemicMarket,
    appealsRegistry,
  };
}

async function resolveReplication(
  protocol: Awaited<ReturnType<typeof deployProtocol>>,
  replicationId: number,
) {
  await (
    await protocol.replicationRegistry
      .connect(protocol.admin)
      .resolveReplicationOutcome(replicationId, {
        status: RESOLUTION_STATUS.Supported,
        confidenceBps: 9_000,
        resolutionHash: ethers.keccak256(
          ethers.toUtf8Bytes(`resolution-${replicationId.toString()}`),
        ),
        resolverType: RESOLVER_TYPE.ComputationOracle,
        evidenceHash: ethers.keccak256(
          ethers.toUtf8Bytes(`resolution-evidence-${replicationId.toString()}`),
        ),
        evidenceURI: `ipfs://resolution/${replicationId.toString()}`,
      })
  ).wait();
}

async function satisfyBondAndPublishClaim(
  protocol: Awaited<ReturnType<typeof deployProtocol>>,
  claimId: number,
) {
  const requiredBond = await protocol.claimRegistry.getRequiredAuthorBond(claimId);
  const currentBond = await protocol.bondEscrow.authorBondBalances(claimId);
  if (currentBond < requiredBond) {
    await (
      await protocol.bondEscrow
        .connect(protocol.author)
        .depositAuthorBond(claimId, { value: requiredBond - currentBond })
    ).wait();
  }
  await (
    await protocol.claimRegistry
      .connect(protocol.admin)
      .setClaimStatus(claimId, CLAIM_STATUS.Published)
  ).wait();
}

async function createCanonicalResolutionDecision(
  protocol: Awaited<ReturnType<typeof deployProtocol>>,
  claimId: number,
  status: (typeof RESOLUTION_STATUS)[keyof typeof RESOLUTION_STATUS],
) {
  const claim = await protocol.claimRegistry.getClaim(claimId);
  const resolverType =
    claim.summary.domainId === 2n
      ? RESOLVER_TYPE.WetLabCouncil
      : claim.summary.domainId === 3n
        ? RESOLVER_TYPE.BenchmarkOracle
        : RESOLVER_TYPE.ComputationOracle;
  if (claim.status === BigInt(CLAIM_STATUS.Draft)) {
    await satisfyBondAndPublishClaim(protocol, claimId);
  }
  if ((await protocol.claimRegistry.getClaim(claimId)).status === BigInt(CLAIM_STATUS.Published)) {
    await (
      await protocol.claimRegistry
        .connect(protocol.admin)
        .setClaimStatus(claimId, CLAIM_STATUS.UnderReplication)
    ).wait();
  }
  const replicationId = Number(await protocol.replicationRegistry.nextReplicationId());
  await (
    await protocol.replicationRegistry
      .connect(protocol.replicator)
      .submitReplication(
        claimId,
        ethers.keccak256(ethers.toUtf8Bytes(`decision-env-${replicationId}`)),
        ethers.keccak256(ethers.toUtf8Bytes(`decision-result-${replicationId}`)),
        ethers.keccak256(ethers.toUtf8Bytes(`decision-evidence-${replicationId}`)),
        0,
      )
  ).wait();
  await (
    await protocol.replicationRegistry
      .connect(protocol.admin)
      .resolveReplicationOutcome(replicationId, {
        status,
        confidenceBps: 9_000,
        resolutionHash: ethers.keccak256(
          ethers.toUtf8Bytes(`decision-resolution-${replicationId}`),
        ),
        resolverType,
        evidenceHash: ethers.keccak256(
          ethers.toUtf8Bytes(`decision-resolution-evidence-${replicationId}`),
        ),
        evidenceURI: `ipfs://decision/${replicationId}`,
      })
  ).wait();
  await (
    await protocol.claimRegistry
      .connect(protocol.admin)
      .finalizeClaimResolution(claimId, replicationId)
  ).wait();
  return await protocol.claimRegistry.getLatestResolutionDecisionId(claimId);
}

describe("ClaimRegistry delegated submission", () => {
  it("allows authorized submitters to create a claim on behalf of the author", async () => {
    const protocol = await deployProtocol();
    const requiredBond = ethers.parseEther("0.25");

    const tx = await protocol.claimRegistry
      .connect(protocol.admin)
      .createClaimOnBehalf(
        makeClaimSummary(protocol.author.address, 1n),
        requiredBond,
        ethers.ZeroAddress,
      );
    const receipt = await tx.wait();
    const createdLog = receipt?.logs.find((log) => {
      try {
        return protocol.claimRegistry.interface.parseLog(log)?.name === "ClaimCreated";
      } catch {
        return false;
      }
    });
    const parsed = createdLog ? protocol.claimRegistry.interface.parseLog(createdLog) : null;
    const claimId = parsed?.args.claimId;

    assert.ok(claimId);
    const claim = await protocol.claimRegistry.getClaim(claimId);
    assert.equal(claim.summary.author, protocol.author.address);
    assert.equal(await protocol.claimRegistry.getRequiredAuthorBond(claimId), requiredBond);
  });

  it("rejects unauthorized delegated claim submission", async () => {
    const protocol = await deployProtocol();
    let reverted = false;
    try {
      await protocol.claimRegistry
        .connect(protocol.other)
        .createClaimOnBehalf(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.1"),
          ethers.ZeroAddress,
        );
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true);
  });

  it("rejects delegated claim submission without an author", async () => {
    const protocol = await deployProtocol();

    await assert.rejects(
      protocol.claimRegistry
        .connect(protocol.admin)
        .createClaimOnBehalf(
          makeClaimSummary(ethers.ZeroAddress, 1n),
          ethers.parseEther("0.1"),
          ethers.ZeroAddress,
        ),
    );
  });

  it("makes request-bound delegated creation idempotent onchain", async () => {
    const protocol = await deployProtocol();
    const requestHash = ethers.keccak256(ethers.toUtf8Bytes("signed-request-1"));
    const summary = makeClaimSummary(protocol.author.address, 1n);
    const requiredBond = ethers.parseEther("0.25");

    assert.equal(await protocol.claimRegistry.getDelegatedClaimIdByRequestHash(requestHash), 0n);
    const firstReceipt = await (
      await protocol.claimRegistry
        .connect(protocol.admin)
        .createClaimOnBehalfWithRequestHash(summary, requiredBond, ethers.ZeroAddress, requestHash)
    ).wait();
    assert.equal(
      firstReceipt?.logs.some((log) => {
        try {
          return (
            protocol.claimRegistry.interface.parseLog(log)?.name === "DelegatedClaimRequestRecorded"
          );
        } catch {
          return false;
        }
      }),
      true,
    );
    assert.equal(await protocol.claimRegistry.getDelegatedClaimIdByRequestHash(requestHash), 1n);

    const replayReceipt = await (
      await protocol.claimRegistry
        .connect(protocol.admin)
        .createClaimOnBehalfWithRequestHash(summary, requiredBond, ethers.ZeroAddress, requestHash)
    ).wait();
    assert.equal(
      replayReceipt?.logs.some((log) => {
        try {
          return protocol.claimRegistry.interface.parseLog(log)?.name === "ClaimCreated";
        } catch {
          return false;
        }
      }),
      false,
    );
    assert.equal(await protocol.claimRegistry.nextClaimId(), 2n);
    assert.equal(await protocol.claimRegistry.getDelegatedClaimIdByRequestHash(requestHash), 1n);
    await assert.rejects(
      protocol.claimRegistry
        .connect(protocol.admin)
        .createClaimOnBehalfWithRequestHash(
          summary,
          requiredBond,
          ethers.ZeroAddress,
          ethers.ZeroHash,
        ),
      /ClaimRegistryInvalidRequestHash/,
    );
    await assert.rejects(
      protocol.claimRegistry
        .connect(protocol.other)
        .createClaimOnBehalfWithRequestHash(
          summary,
          requiredBond,
          ethers.ZeroAddress,
          ethers.keccak256(ethers.toUtf8Bytes("unauthorized-request")),
        ),
      /AccessManagedMissingRole/,
    );
  });
});

function makeClaimSummary(authorAddress: string, domainId: bigint) {
  return {
    statementHash: ethers.keccak256(ethers.toUtf8Bytes(`statement-${domainId.toString()}`)),
    methodologyHash: ethers.keccak256(ethers.toUtf8Bytes(`methodology-${domainId.toString()}`)),
    scopeHash: ethers.keccak256(ethers.toUtf8Bytes(`scope-${domainId.toString()}`)),
    metadataHash: ethers.keccak256(ethers.toUtf8Bytes(`metadata-${domainId.toString()}`)),
    predictionHooksHash: ethers.keccak256(ethers.toUtf8Bytes(`hooks-${domainId.toString()}`)),
    domainId,
    author: authorAddress,
  };
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("ScientificProtocol", () => {
  it("supports the core claim, escrow, replication, and checkpoint lifecycle", async () => {
    const protocol = await deployProtocol();
    const bondAmount = ethers.parseEther("1");
    const bountyAmount = ethers.parseEther("2");

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(makeClaimSummary(protocol.author.address, 1n), bondAmount, ethers.ZeroAddress)
    ).wait();

    await satisfyBondAndPublishClaim(protocol, 1);

    await (
      await protocol.artifactRegistry
        .connect(protocol.author)
        .addArtifact(
          1,
          0,
          ethers.keccak256(ethers.toUtf8Bytes("artifact")),
          "ipfs://artifact",
          ethers.keccak256(ethers.toUtf8Bytes("artifact-meta")),
        )
    ).wait();

    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .fundReplicationBounty(1, { value: bountyAmount })
    ).wait();

    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("env")),
          ethers.keccak256(ethers.toUtf8Bytes("result")),
          ethers.keccak256(ethers.toUtf8Bytes("evidence")),
          0,
        )
    ).wait();

    await (
      await protocol.claimRegistry
        .connect(protocol.admin)
        .setClaimStatus(1, CLAIM_STATUS.UnderReplication)
    ).wait();

    await (
      await protocol.replicationRegistry.connect(protocol.admin).resolveReplicationOutcome(1, {
        status: RESOLUTION_STATUS.Supported,
        confidenceBps: 9_200,
        resolutionHash: ethers.keccak256(ethers.toUtf8Bytes("resolution")),
        resolverType: RESOLVER_TYPE.ComputationOracle,
        evidenceHash: ethers.keccak256(ethers.toUtf8Bytes("resolution-evidence")),
        evidenceURI: "ipfs://resolution",
      })
    ).wait();

    await (
      await protocol.claimRegistry.connect(protocol.admin).finalizeClaimResolution(1, 1)
    ).wait();
    await (
      await protocol.bondEscrow.connect(protocol.admin).reserveBountyPayout(1, 1, bountyAmount)
    ).wait();
    await (await protocol.bondEscrow.connect(protocol.admin).releaseReservedPayout(1, 1)).wait();

    await (
      await protocol.checkpointRegistry
        .connect(protocol.checkpointPublisher)
        .publishCheckpoint(
          1,
          SUBJECT_TYPE.Claim,
          ethers.ZeroAddress,
          1,
          0,
          ethers.ZeroAddress,
          ethers.keccak256(ethers.toUtf8Bytes("score-vector")),
          ethers.keccak256(ethers.toUtf8Bytes("payload")),
          "ipfs://checkpoint",
        )
    ).wait();

    const claim = await protocol.claimRegistry.getClaim(1);
    const replication = await protocol.replicationRegistry.getReplication(1);
    const checkpoint = await protocol.checkpointRegistry.getCheckpoint(1);

    assert.equal(claim.status, 3n);
    assert.equal(replication.outcome, 1n);
    assert.equal(checkpoint.subjectClaimId, 1n);
    assert.equal(await protocol.bondEscrow.authorBondBalances(1), bondAmount);
  });

  it("allows wet-lab claims to resolve inconclusively and rejects module mismatches", async () => {
    const protocol = await deployProtocol();

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 2n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();
    await satisfyBondAndPublishClaim(protocol, 1);

    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("wet-env")),
          ethers.keccak256(ethers.toUtf8Bytes("wet-result")),
          ethers.keccak256(ethers.toUtf8Bytes("wet-evidence")),
          0,
        )
    ).wait();

    await (
      await protocol.replicationRegistry.connect(protocol.admin).resolveReplicationOutcome(1, {
        status: RESOLUTION_STATUS.Inconclusive,
        confidenceBps: 6_000,
        resolutionHash: ethers.keccak256(ethers.toUtf8Bytes("wet-resolution")),
        resolverType: RESOLVER_TYPE.WetLabCouncil,
        evidenceHash: ethers.keccak256(ethers.toUtf8Bytes("wetlab-audit")),
        evidenceURI: "ipfs://wet-lab",
      })
    ).wait();

    const replication = await protocol.replicationRegistry.getReplication(1);
    assert.equal(replication.outcome, 3n);
    assert.equal(replication.resolutionStatus, 3n);

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();
    await satisfyBondAndPublishClaim(protocol, 2);
    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          2,
          ethers.keccak256(ethers.toUtf8Bytes("bad-env")),
          ethers.keccak256(ethers.toUtf8Bytes("bad-result")),
          ethers.keccak256(ethers.toUtf8Bytes("bad-evidence")),
          0,
        )
    ).wait();

    let reverted = false;
    try {
      await (
        await protocol.replicationRegistry.connect(protocol.admin).resolveReplicationOutcome(2, {
          status: RESOLUTION_STATUS.Supported,
          confidenceBps: 8_000,
          resolutionHash: ethers.keccak256(ethers.toUtf8Bytes("bad")),
          resolverType: RESOLVER_TYPE.WetLabCouncil,
          evidenceHash: ethers.keccak256(ethers.toUtf8Bytes("bad-evidence")),
          evidenceURI: "ipfs://bad",
        })
      ).wait();
    } catch {
      reverted = true;
    }
    assert.equal(reverted, true);
  });

  it("supports sovereign agents with spend limits and onchain attribution", async () => {
    const protocol = await deployProtocol();

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();

    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .registerAgent(
          ethers.keccak256(ethers.toUtf8Bytes("agent-meta")),
          "ipfs://agent",
          ethers.parseEther("1"),
          { value: ethers.parseEther("2") },
        )
    ).wait();

    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .authorizeController(1, protocol.replicator.address, true)
    ).wait();
    await (
      await protocol.agentRegistry
        .connect(protocol.admin)
        .reserveBudget(1, ethers.parseEther("0.5"))
    ).wait();
    await (
      await protocol.agentRegistry
        .connect(protocol.admin)
        .consumeBudget(1, ethers.parseEther("0.25"), protocol.other.address)
    ).wait();

    const agentRecord = await protocol.agentRegistry.getAgent(1);
    assert.equal(agentRecord.budgetBalance, ethers.parseEther("1.75"));
    assert.equal(agentRecord.reservedBudget, ethers.parseEther("0.25"));
    assert.equal(agentRecord.spentBudget, ethers.parseEther("0.25"));

    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("agent-env")),
          ethers.keccak256(ethers.toUtf8Bytes("agent-result")),
          ethers.keccak256(ethers.toUtf8Bytes("agent-evidence")),
          1,
        )
    ).wait();

    const replication = await protocol.replicationRegistry.getReplication(1);
    assert.equal(replication.agentId, 1n);
  });

  it("enforces an agent spend limit across repeated reserve-and-consume cycles", async () => {
    const protocol = await deployProtocol();
    const spendLimit = ethers.parseEther("1");

    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .registerAgent(
          ethers.keccak256(ethers.toUtf8Bytes("lifetime-cap-agent")),
          "ipfs://agents/lifetime-cap",
          spendLimit,
          { value: ethers.parseEther("2") },
        )
    ).wait();

    for (let index = 0; index < 2; index += 1) {
      await (
        await protocol.agentRegistry
          .connect(protocol.admin)
          .reserveBudget(1, ethers.parseEther("0.5"))
      ).wait();
      await (
        await protocol.agentRegistry
          .connect(protocol.admin)
          .consumeBudget(1, ethers.parseEther("0.5"), protocol.other.address)
      ).wait();
    }

    const agent = await protocol.agentRegistry.getAgent(1);
    assert.equal(agent.spentBudget, spendLimit);
    assert.equal(agent.reservedBudget, 0n);

    await assert.rejects(
      protocol.agentRegistry.connect(protocol.admin).reserveBudget(1, 1n),
      /AgentRegistrySpendLimitExceeded/,
    );
    await assert.rejects(
      protocol.agentRegistry.connect(protocol.agentOperator).setSpendLimit(1, spendLimit - 1n),
      /AgentRegistrySpendLimitBelowCommitted/,
    );
  });

  it("rejects a resolution module that returns false without mutating the replication", async () => {
    const protocol = await deployProtocol();
    const RejectingModule = await ethers.getContractFactory(
      "contracts/mocks/RejectingResolutionModule.sol:RejectingResolutionModule",
    );
    const rejectingModule = await RejectingModule.deploy();
    await rejectingModule.waitForDeployment();
    await (
      await protocol.moduleRegistry
        .connect(protocol.admin)
        .registerModule(await rejectingModule.getAddress(), "ipfs://modules/rejecting")
    ).wait();

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          await rejectingModule.getAddress(),
        )
    ).wait();
    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("reject-env")),
          ethers.keccak256(ethers.toUtf8Bytes("reject-result")),
          ethers.keccak256(ethers.toUtf8Bytes("reject-evidence")),
          0,
        )
    ).wait();

    await assert.rejects(
      protocol.replicationRegistry.connect(protocol.admin).resolveReplicationOutcome(1, {
        status: RESOLUTION_STATUS.Supported,
        confidenceBps: 9_000,
        resolutionHash: ethers.keccak256(ethers.toUtf8Bytes("rejected-resolution")),
        resolverType: RESOLVER_TYPE.ComputationOracle,
        evidenceHash: ethers.keccak256(ethers.toUtf8Bytes("rejected-resolution-evidence")),
        evidenceURI: "ipfs://resolution/rejected",
      }),
      /ReplicationRegistryModuleRejected/,
    );

    const replication = await protocol.replicationRegistry.getReplication(1);
    assert.equal(replication.resolvedAt, 0n);
    assert.equal(replication.resolver, ethers.ZeroAddress);
  });

  it("does not authorize inactive agents for controller or budget execution", async () => {
    const protocol = await deployProtocol();

    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .registerAgent(
          ethers.keccak256(ethers.toUtf8Bytes("inactive-agent")),
          "ipfs://agents/inactive",
          ethers.parseEther("1"),
          { value: ethers.parseEther("2") },
        )
    ).wait();
    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .authorizeController(1, protocol.replicator.address, true)
    ).wait();
    await (
      await protocol.agentRegistry
        .connect(protocol.admin)
        .reserveBudget(1, ethers.parseEther("0.25"))
    ).wait();

    assert.equal(
      await protocol.agentRegistry.isAuthorizedController(1, protocol.replicator.address),
      true,
    );

    await (
      await protocol.agentRegistry.connect(protocol.agentOperator).setAgentActive(1, false)
    ).wait();

    assert.equal(
      await protocol.agentRegistry.isAuthorizedController(1, protocol.replicator.address),
      false,
    );
    await assert.rejects(
      protocol.agentRegistry.connect(protocol.admin).reserveBudget(1, ethers.parseEther("0.1")),
    );
    await assert.rejects(
      protocol.agentRegistry
        .connect(protocol.admin)
        .consumeBudget(1, ethers.parseEther("0.1"), protocol.other.address),
    );
  });

  it("accrues claim work rewards continuously and can stream value into agent budgets", async () => {
    const protocol = await deployProtocol();
    const agentSpendLimit = ethers.parseEther("5");

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();

    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .registerAgent(
          ethers.keccak256(ethers.toUtf8Bytes("reward-agent")),
          "ipfs://agents/reward",
          agentSpendLimit,
          { value: ethers.parseEther("0.25") },
        )
    ).wait();

    await (
      await protocol.claimRewardVault
        .connect(protocol.other)
        .fundClaimRewards(1, 0, { value: ethers.parseEther("1.2") })
    ).wait();
    await (
      await protocol.claimRewardVault
        .connect(protocol.other)
        .fundClaimRewards(1, 1, { value: ethers.parseEther("2.4") })
    ).wait();

    const reviewSettlementId = ethers.keccak256(ethers.toUtf8Bytes("review-submission:1"));
    await (
      await protocol.claimRewardVault
        .connect(protocol.admin)
        .accrueWorkReward(
          1,
          0,
          reviewSettlementId,
          protocol.other.address,
          1,
          ethers.parseEther("0.6"),
          5_000,
        )
    ).wait();

    assert.equal(await protocol.claimRewardVault.claimRewardPools(1, 0), ethers.parseEther("0.6"));
    assert.equal(
      await protocol.claimRewardVault.accruedRewardBalances(protocol.other.address),
      ethers.parseEther("0.3"),
    );

    const agentAfterReview = await protocol.agentRegistry.getAgent(1);
    assert.equal(agentAfterReview.budgetBalance, ethers.parseEther("0.55"));

    const followUpSettlementId = ethers.keccak256(ethers.toUtf8Bytes("review-follow-up:1"));
    await (
      await protocol.claimRewardVault
        .connect(protocol.admin)
        .accrueWorkReward(
          1,
          0,
          followUpSettlementId,
          protocol.other.address,
          1,
          ethers.parseEther("0.2"),
          10_000,
        )
    ).wait();

    assert.equal(await protocol.claimRewardVault.claimRewardPools(1, 0), ethers.parseEther("0.4"));
    const agentAfterFollowUp = await protocol.agentRegistry.getAgent(1);
    assert.equal(agentAfterFollowUp.budgetBalance, ethers.parseEther("0.75"));

    const withdrawAmount = ethers.parseEther("0.3");
    const beforeBalance = await ethers.provider.getBalance(protocol.other.address);
    const withdrawTx = await protocol.claimRewardVault
      .connect(protocol.other)
      .withdrawAccruedRewards(withdrawAmount, protocol.other.address);
    const withdrawReceipt = await withdrawTx.wait();
    assert.ok(withdrawReceipt);
    const gasPaid = withdrawReceipt.gasUsed * withdrawReceipt.gasPrice;
    const afterBalance = await ethers.provider.getBalance(protocol.other.address);

    assert.equal(await protocol.claimRewardVault.accruedRewardBalances(protocol.other.address), 0n);
    assert.equal(afterBalance - beforeBalance + gasPaid, withdrawAmount);
  });

  it("rejects duplicate or unauthorized claim reward settlements", async () => {
    const protocol = await deployProtocol();

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();

    await (
      await protocol.claimRewardVault
        .connect(protocol.other)
        .fundClaimRewards(1, 1, { value: ethers.parseEther("1") })
    ).wait();

    const settlementId = ethers.keccak256(ethers.toUtf8Bytes("replication:1"));
    await (
      await protocol.claimRewardVault
        .connect(protocol.admin)
        .accrueWorkReward(
          1,
          1,
          settlementId,
          protocol.replicator.address,
          0,
          ethers.parseEther("0.25"),
          0,
        )
    ).wait();

    await assert.rejects(
      protocol.claimRewardVault
        .connect(protocol.other)
        .accrueWorkReward(
          1,
          1,
          ethers.keccak256(ethers.toUtf8Bytes("replication:2")),
          protocol.replicator.address,
          0,
          ethers.parseEther("0.1"),
          0,
        ),
    );

    await assert.rejects(
      protocol.claimRewardVault
        .connect(protocol.admin)
        .accrueWorkReward(
          1,
          1,
          settlementId,
          protocol.replicator.address,
          0,
          ethers.parseEther("0.1"),
          0,
        ),
    );
  });

  it("supports forecast commitments, challenge bonds, and append-only appeals", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    await (
      await protocol.epistemicMarket
        .connect(protocol.admin)
        .fundRewardPool({ value: ethers.parseEther("3") })
    ).wait();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"));
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "uint16", "bytes32"],
      [FORECAST_DIRECTION.Supports, 8_500, salt],
    );
    const commitmentHash = ethers.keccak256(encoded);

    const forecastStake = ethers.parseEther("1");
    const latestBlock = await ethers.provider.getBlock("latest");
    assert.ok(latestBlock);
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .commitForecast(1, commitmentHash, BigInt(latestBlock.timestamp + 3600), 0, {
          value: forecastStake,
        })
    ).wait();
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .revealForecast(1, FORECAST_DIRECTION.Supports, 8_500, salt)
    ).wait();
    const resolutionDecisionId = await createCanonicalResolutionDecision(
      protocol,
      1,
      RESOLUTION_STATUS.Supported,
    );
    await (
      await protocol.epistemicMarket.connect(protocol.admin).settleForecast(1, resolutionDecisionId)
    ).wait();

    const challengeBond = ethers.parseEther("0.5");
    await (
      await protocol.epistemicMarket
        .connect(protocol.replicator)
        .openChallenge(
          1,
          0,
          ethers.keccak256(ethers.toUtf8Bytes("challenge-evidence")),
          "ipfs://challenge",
          0,
          { value: challengeBond },
        )
    ).wait();
    await (
      await protocol.epistemicMarket
        .connect(protocol.admin)
        .resolveChallenge(
          1,
          CHALLENGE_STATUS.Sustained,
          ethers.keccak256(ethers.toUtf8Bytes("challenge-resolution")),
        )
    ).wait();

    await (
      await protocol.appealsRegistry
        .connect(protocol.replicator)
        .fileAppeal(
          1,
          0,
          1,
          APPEAL_REASON.ModuleBoundary,
          ethers.keccak256(ethers.toUtf8Bytes("appeal-filing")),
          "ipfs://appeal",
          { value: ethers.parseEther("0.1") },
        )
    ).wait();
    await (
      await protocol.appealsRegistry
        .connect(protocol.admin)
        .adjudicateAppeal(
          1,
          APPEAL_STATUS.Upheld,
          ethers.keccak256(ethers.toUtf8Bytes("appeal-ruling")),
          "ipfs://appeal-ruling",
        )
    ).wait();

    const forecast = await protocol.epistemicMarket.getForecast(1);
    const challenge = await protocol.epistemicMarket.getChallenge(1);
    const appeal = await protocol.appealsRegistry.getAppeal(1);

    assert.equal(forecast.settled, true);
    assert.equal(challenge.status, 1n);
    assert.equal(appeal.status, 3n);
  });

  it("refuses to settle an unrevealed forecast before the reveal deadline and forfeits it after", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("never-revealed"));
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "uint16", "bytes32"],
      [FORECAST_DIRECTION.Questions, 5_000, salt],
    );
    const latestBlock = await ethers.provider.getBlock("latest");
    assert.ok(latestBlock);
    const forecastStake = ethers.parseEther("1");
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .commitForecast(1, ethers.keccak256(encoded), BigInt(latestBlock.timestamp + 3600), 0, {
          value: forecastStake,
        })
    ).wait();

    await assert.rejects(
      protocol.epistemicMarket
        .connect(protocol.admin)
        .settleForecast(1, RESOLUTION_STATUS.Inconclusive),
      /EpistemicMarketRevealWindowOpen/,
    );

    await ethers.provider.send("evm_increaseTime", [3700]);
    await ethers.provider.send("evm_mine", []);

    const resolutionDecisionId = await createCanonicalResolutionDecision(
      protocol,
      1,
      RESOLUTION_STATUS.Inconclusive,
    );

    const poolBefore = await protocol.epistemicMarket.rewardPoolBalance();
    const settleTx = await protocol.epistemicMarket
      .connect(protocol.admin)
      .settleForecast(1, resolutionDecisionId);
    const settleReceipt = await settleTx.wait();
    const settledLog = settleReceipt?.logs
      .map((log) => {
        try {
          return protocol.epistemicMarket.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "ForecastSettled");
    assert.ok(settledLog);
    assert.equal(settledLog.args.matched, false);
    assert.equal(settledLog.args.payoutAmount, 0n);
    assert.equal(await protocol.epistemicMarket.rewardPoolBalance(), poolBefore + forecastStake);
  });

  it("lets a revealed forecaster reclaim their stake only after the settler-inactivity delay", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("reclaim-salt"));
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "uint16", "bytes32"],
      [FORECAST_DIRECTION.Supports, 9_000, salt],
    );
    const latestBlock = await ethers.provider.getBlock("latest");
    assert.ok(latestBlock);
    const forecastStake = ethers.parseEther("1");
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .commitForecast(1, ethers.keccak256(encoded), BigInt(latestBlock.timestamp + 3600), 0, {
          value: forecastStake,
        })
    ).wait();
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .revealForecast(1, FORECAST_DIRECTION.Supports, 9_000, salt)
    ).wait();

    await assert.rejects(
      protocol.epistemicMarket.connect(protocol.author).reclaimForecast(1),
      /EpistemicMarketForecastNotReclaimable/,
    );

    const reclaimDelay = await protocol.epistemicMarket.FORECAST_RECLAIM_DELAY();
    await ethers.provider.send("evm_increaseTime", [Number(reclaimDelay) + 3700]);
    await ethers.provider.send("evm_mine", []);

    await assert.rejects(
      protocol.epistemicMarket.connect(protocol.other).reclaimForecast(1),
      /EpistemicMarketUnauthorizedAgent/,
    );

    const balanceBefore = await ethers.provider.getBalance(protocol.author.address);
    await (await protocol.epistemicMarket.connect(protocol.author).reclaimForecast(1)).wait();
    const balanceAfter = await ethers.provider.getBalance(protocol.author.address);
    assert.ok(balanceAfter > balanceBefore);

    const forecast = await protocol.epistemicMarket.getForecast(1);
    assert.equal(forecast.settled, true);
    await assert.rejects(
      protocol.epistemicMarket.connect(protocol.admin).settleForecast(1, 0),
      /EpistemicMarketAlreadySettled/,
    );
  });

  it("keeps challenge bonds committed for the minimum challenge duration", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    await (
      await protocol.epistemicMarket
        .connect(protocol.replicator)
        .openChallenge(
          1,
          0,
          ethers.keccak256(ethers.toUtf8Bytes("withdraw-evidence")),
          "ipfs://withdraw-challenge",
          0,
          { value: ethers.parseEther("0.5") },
        )
    ).wait();

    await assert.rejects(
      protocol.epistemicMarket.connect(protocol.replicator).withdrawChallenge(1),
      /EpistemicMarketChallengeWithdrawLocked/,
    );

    const minDuration = await protocol.epistemicMarket.MIN_CHALLENGE_DURATION();
    await ethers.provider.send("evm_increaseTime", [Number(minDuration) + 1]);
    await ethers.provider.send("evm_mine", []);

    await (await protocol.epistemicMarket.connect(protocol.replicator).withdrawChallenge(1)).wait();
    const challenge = await protocol.epistemicMarket.getChallenge(1);
    assert.equal(challenge.status, BigInt(CHALLENGE_STATUS.Withdrawn));
  });

  it("rejects challenges referencing replications that do not belong to the claim", async () => {
    const protocol = await deployProtocol();
    for (const author of [protocol.author, protocol.author]) {
      await (
        await protocol.claimRegistry
          .connect(author)
          .createClaim(
            makeClaimSummary(author.address, 1n),
            ethers.parseEther("0.5"),
            ethers.ZeroAddress,
          )
      ).wait();
    }
    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          2,
          ethers.keccak256(ethers.toUtf8Bytes("env")),
          ethers.keccak256(ethers.toUtf8Bytes("result")),
          ethers.keccak256(ethers.toUtf8Bytes("evidence")),
          0,
        )
    ).wait();

    await assert.rejects(
      protocol.epistemicMarket
        .connect(protocol.replicator)
        .openChallenge(
          1,
          1,
          ethers.keccak256(ethers.toUtf8Bytes("cross-claim")),
          "ipfs://cross-claim",
          0,
          { value: ethers.parseEther("0.1") },
        ),
      /EpistemicMarketUnknownReplication/,
    );
  });

  it("forfeits lost appeal bonds to the treasury and refunds won appeals pull-based", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    const bond = ethers.parseEther("0.2");
    const fileAppeal = () =>
      protocol.appealsRegistry
        .connect(protocol.replicator)
        .fileAppeal(
          1,
          0,
          0,
          APPEAL_REASON.DisputedClassification,
          ethers.keccak256(ethers.toUtf8Bytes("appeal")),
          "ipfs://appeal",
          { value: bond },
        );

    await (await fileAppeal()).wait();
    await assert.rejects(
      protocol.appealsRegistry
        .connect(protocol.admin)
        .adjudicateAppeal(1, APPEAL_STATUS.Filed, ethers.ZeroHash, ""),
      /AppealsRegistryInvalidStatus/,
    );

    const treasuryAddress = await protocol.protocolTreasury.getAddress();
    const treasuryBefore = await ethers.provider.getBalance(treasuryAddress);
    await (
      await protocol.appealsRegistry
        .connect(protocol.admin)
        .adjudicateAppeal(
          1,
          APPEAL_STATUS.Rejected,
          ethers.keccak256(ethers.toUtf8Bytes("rejection")),
          "ipfs://rejection",
        )
    ).wait();
    assert.equal(await ethers.provider.getBalance(treasuryAddress), treasuryBefore + bond);

    await (await fileAppeal()).wait();
    await (
      await protocol.appealsRegistry
        .connect(protocol.admin)
        .adjudicateAppeal(
          2,
          APPEAL_STATUS.Overturned,
          ethers.keccak256(ethers.toUtf8Bytes("overturned")),
          "ipfs://overturned",
        )
    ).wait();
    assert.equal(
      await protocol.appealsRegistry.refundableBondBalances(protocol.replicator.address),
      bond,
    );

    const recipientBefore = await ethers.provider.getBalance(protocol.other.address);
    await (
      await protocol.appealsRegistry
        .connect(protocol.replicator)
        .withdrawRefundedBond(bond, protocol.other.address)
    ).wait();
    assert.equal(await ethers.provider.getBalance(protocol.other.address), recipientBefore + bond);
    assert.equal(
      await protocol.appealsRegistry.refundableBondBalances(protocol.replicator.address),
      0n,
    );
  });

  it("rejects appeals referencing replications or challenges outside the claim", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    await assert.rejects(
      protocol.appealsRegistry
        .connect(protocol.replicator)
        .fileAppeal(
          1,
          99,
          0,
          APPEAL_REASON.DisputedClassification,
          ethers.keccak256(ethers.toUtf8Bytes("bad-replication")),
          "ipfs://bad-replication",
          { value: ethers.parseEther("0.1") },
        ),
      /AppealsRegistryUnknownReplication/,
    );

    await assert.rejects(
      protocol.appealsRegistry
        .connect(protocol.replicator)
        .fileAppeal(
          1,
          0,
          99,
          APPEAL_REASON.DisputedClassification,
          ethers.keccak256(ethers.toUtf8Bytes("bad-challenge")),
          "ipfs://bad-challenge",
          { value: ethers.parseEther("0.1") },
        ),
      /AppealsRegistryUnknownChallenge/,
    );
  });

  it("enforces the governance-set minimum author bond on new claims", async () => {
    const protocol = await deployProtocol();
    const minBondKey = await protocol.claimRegistry.MIN_AUTHOR_BOND_PARAMETER_KEY();
    await (
      await protocol.protocolParameters
        .connect(protocol.admin)
        .setUintParameter(minBondKey, ethers.parseEther("0.5"))
    ).wait();

    await assert.rejects(
      protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.4"),
          ethers.ZeroAddress,
        ),
      /ClaimRegistryAuthorBondBelowMinimum/,
    );

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();
    assert.equal(await protocol.claimRegistry.claimExists(1), true);
  });

  it("requires the complete configured author bond before publication", async () => {
    const protocol = await deployProtocol();
    const requiredBond = ethers.parseEther("0.5");
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          requiredBond,
          ethers.ZeroAddress,
        )
    ).wait();

    await assert.rejects(
      protocol.claimRegistry.connect(protocol.admin).setClaimStatus(1, CLAIM_STATUS.Published),
      /ClaimRegistryAuthorBondUnsatisfied/,
    );
    await (
      await protocol.bondEscrow
        .connect(protocol.author)
        .depositAuthorBond(1, { value: ethers.parseEther("0.4") })
    ).wait();
    await assert.rejects(
      protocol.claimRegistry.connect(protocol.admin).setClaimStatus(1, CLAIM_STATUS.Published),
      /ClaimRegistryAuthorBondUnsatisfied/,
    );
    await (
      await protocol.bondEscrow
        .connect(protocol.author)
        .depositAuthorBond(1, { value: ethers.parseEther("0.1") })
    ).wait();

    const receipt = await (
      await protocol.claimRegistry.connect(protocol.admin).setClaimStatus(1, CLAIM_STATUS.Published)
    ).wait();
    assert.ok(
      receipt?.logs.some((log) => {
        try {
          return protocol.claimRegistry.interface.parseLog(log)?.name === "ClaimStatusUpdated";
        } catch {
          return false;
        }
      }),
    );
    assert.equal((await protocol.claimRegistry.getClaim(1)).status, BigInt(CLAIM_STATUS.Published));

    await assert.rejects(
      protocol.claimRegistry
        .connect(protocol.admin)
        .configureProtocolDependencies(
          await protocol.bondEscrow.getAddress(),
          await protocol.replicationRegistry.getAddress(),
        ),
      /ClaimRegistryProtocolDependenciesAlreadyConfigured/,
    );
    await assert.rejects(
      protocol.claimRegistry
        .connect(protocol.other)
        .configureProtocolDependencies(
          await protocol.bondEscrow.getAddress(),
          await protocol.replicationRegistry.getAddress(),
        ),
      /AccessManagedMissingRole/,
    );
  });

  it("derives append-only canonical claim decisions from resolved replications", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();
    await satisfyBondAndPublishClaim(protocol, 1);
    await (
      await protocol.claimRegistry
        .connect(protocol.admin)
        .setClaimStatus(1, CLAIM_STATUS.UnderReplication)
    ).wait();

    for (const suffix of ["supported", "refuted"]) {
      await (
        await protocol.replicationRegistry
          .connect(protocol.replicator)
          .submitReplication(
            1,
            ethers.keccak256(ethers.toUtf8Bytes(`${suffix}-env`)),
            ethers.keccak256(ethers.toUtf8Bytes(`${suffix}-result`)),
            ethers.keccak256(ethers.toUtf8Bytes(`${suffix}-evidence`)),
            0,
          )
      ).wait();
    }

    await assert.rejects(
      protocol.claimRegistry.connect(protocol.admin).setClaimStatus(1, CLAIM_STATUS.Qualified),
      /ClaimRegistryResolutionDecisionRequired/,
    );
    await assert.rejects(
      protocol.claimRegistry.connect(protocol.admin).setClaimStatus(1, CLAIM_STATUS.Fraudulent),
      /ClaimRegistryResolutionDecisionRequired/,
    );
    await assert.rejects(
      protocol.claimRegistry.connect(protocol.admin).finalizeClaimResolution(1, 1),
      /ClaimRegistryUnresolvedReplication/,
    );
    await assert.rejects(
      protocol.claimRegistry.connect(protocol.other).finalizeClaimResolution(1, 1),
      /AccessManagedMissingRole/,
    );

    await (
      await protocol.replicationRegistry.connect(protocol.admin).resolveReplicationOutcome(1, {
        status: RESOLUTION_STATUS.Supported,
        confidenceBps: 9_200,
        resolutionHash: ethers.keccak256(ethers.toUtf8Bytes("supported-resolution")),
        resolverType: RESOLVER_TYPE.ComputationOracle,
        evidenceHash: ethers.keccak256(ethers.toUtf8Bytes("supported-resolution-evidence")),
        evidenceURI: "ipfs://resolution/supported",
      })
    ).wait();
    const firstReceipt = await (
      await protocol.claimRegistry.connect(protocol.admin).finalizeClaimResolution(1, 1)
    ).wait();
    assert.ok(
      firstReceipt?.logs.some((log) => {
        try {
          return (
            protocol.claimRegistry.interface.parseLog(log)?.name === "ResolutionDecisionRecorded"
          );
        } catch {
          return false;
        }
      }),
    );
    assert.ok(
      firstReceipt?.logs.some((log) => {
        try {
          return (
            protocol.claimRegistry.interface.parseLog(log)?.name ===
            "EffectiveResolutionDecisionUpdated"
          );
        } catch {
          return false;
        }
      }),
    );
    const firstDecision = await protocol.claimRegistry.getResolutionDecision(1);
    assert.equal(firstDecision.claimId, 1n);
    assert.equal(firstDecision.replicationId, 1n);
    assert.equal(firstDecision.status, BigInt(RESOLUTION_STATUS.Supported));
    assert.equal(firstDecision.claimStatus, BigInt(CLAIM_STATUS.ProvisionallySupported));
    assert.equal(firstDecision.confidenceBps, 9_200n);
    assert.equal(
      (await protocol.claimRegistry.getClaim(1)).status,
      BigInt(CLAIM_STATUS.ProvisionallySupported),
    );
    await assert.rejects(
      protocol.claimRegistry.connect(protocol.admin).finalizeClaimResolution(1, 1),
      /ClaimRegistryReplicationDecisionExists/,
    );

    await (
      await protocol.replicationRegistry.connect(protocol.admin).resolveReplicationOutcome(2, {
        status: RESOLUTION_STATUS.Refuted,
        confidenceBps: 8_700,
        resolutionHash: ethers.keccak256(ethers.toUtf8Bytes("refuted-resolution")),
        resolverType: RESOLVER_TYPE.ComputationOracle,
        evidenceHash: ethers.keccak256(ethers.toUtf8Bytes("refuted-resolution-evidence")),
        evidenceURI: "ipfs://resolution/refuted",
      })
    ).wait();
    await (
      await protocol.claimRegistry.connect(protocol.admin).finalizeClaimResolution(1, 2)
    ).wait();

    assert.equal(await protocol.claimRegistry.getLatestResolutionDecisionId(1), 2n);
    assert.equal(await protocol.claimRegistry.getEffectiveResolutionDecisionId(1), 2n);
    assert.deepEqual(Array.from(await protocol.claimRegistry.getClaimResolutionDecisionIds(1)), [
      1n,
      2n,
    ]);
    const secondDecision = await protocol.claimRegistry.getResolutionDecision(2);
    assert.equal(secondDecision.status, BigInt(RESOLUTION_STATUS.Refuted));
    assert.equal(secondDecision.claimStatus, BigInt(CLAIM_STATUS.Refuted));
    assert.equal((await protocol.claimRegistry.getClaim(1)).status, BigInt(CLAIM_STATUS.Refuted));

    const thirdDecisionId = await createCanonicalResolutionDecision(
      protocol,
      1,
      RESOLUTION_STATUS.Supported,
    );
    const thirdDecision = await protocol.claimRegistry.getResolutionDecision(thirdDecisionId);
    assert.equal(thirdDecision.claimStatus, BigInt(CLAIM_STATUS.ProvisionallySupported));
    assert.equal(await protocol.claimRegistry.getLatestResolutionDecisionId(1), thirdDecisionId);
    assert.equal(await protocol.claimRegistry.getEffectiveResolutionDecisionId(1), 2n);
    assert.equal((await protocol.claimRegistry.getClaim(1)).status, BigInt(CLAIM_STATUS.Refuted));
  });

  it("settles markets only against the decision that established current claim state", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();
    await satisfyBondAndPublishClaim(protocol, 1);
    await (
      await protocol.claimRegistry
        .connect(protocol.admin)
        .setClaimStatus(1, CLAIM_STATUS.UnderReplication)
    ).wait();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("effective-decision-only"));
    const commitmentHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8", "uint16", "bytes32"],
        [FORECAST_DIRECTION.Refutes, 9_000, salt],
      ),
    );
    const latestBlock = await ethers.provider.getBlock("latest");
    assert.ok(latestBlock);
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .commitForecast(1, commitmentHash, BigInt(latestBlock.timestamp + 3600), 0, {
          value: ethers.parseEther("0.1"),
        })
    ).wait();
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .revealForecast(1, FORECAST_DIRECTION.Refutes, 9_000, salt)
    ).wait();

    await createCanonicalResolutionDecision(protocol, 1, RESOLUTION_STATUS.Supported);
    const refutedDecisionId = await createCanonicalResolutionDecision(
      protocol,
      1,
      RESOLUTION_STATUS.Refuted,
    );
    const laterWeakerDecisionId = await createCanonicalResolutionDecision(
      protocol,
      1,
      RESOLUTION_STATUS.Supported,
    );
    assert.equal(
      await protocol.claimRegistry.getLatestResolutionDecisionId(1),
      laterWeakerDecisionId,
    );
    assert.equal(
      await protocol.claimRegistry.getEffectiveResolutionDecisionId(1),
      refutedDecisionId,
    );

    await assert.rejects(
      protocol.epistemicMarket.connect(protocol.admin).settleForecast(1, laterWeakerDecisionId),
      /EpistemicMarketStaleResolutionDecision/,
    );
    await (
      await protocol.epistemicMarket.connect(protocol.admin).settleForecast(1, refutedDecisionId)
    ).wait();
    const forecast = await protocol.epistemicMarket.getForecast(1);
    assert.equal(forecast.settled, true);
    assert.equal(forecast.resolutionDecisionId, refutedDecisionId);
  });

  it("maps every resolvable replication status to one canonical claim-status recommendation", async () => {
    const protocol = await deployProtocol();
    const mappings = [
      [RESOLUTION_STATUS.Supported, CLAIM_STATUS.ProvisionallySupported],
      [RESOLUTION_STATUS.Qualified, CLAIM_STATUS.Qualified],
      [RESOLUTION_STATUS.Inconclusive, CLAIM_STATUS.UnderReplication],
      [RESOLUTION_STATUS.Refuted, CLAIM_STATUS.Refuted],
      [RESOLUTION_STATUS.FraudSignal, CLAIM_STATUS.Fraudulent],
      [RESOLUTION_STATUS.Escalated, CLAIM_STATUS.UnderReplication],
    ] as const;

    await assert.rejects(
      protocol.claimRegistry.getClaimStatusForResolution(RESOLUTION_STATUS.Pending),
      /ClaimRegistryInvalidResolutionStatus/,
    );

    for (const [index, [resolutionStatus, expectedClaimStatus]] of mappings.entries()) {
      assert.equal(
        await protocol.claimRegistry.getClaimStatusForResolution(resolutionStatus),
        BigInt(expectedClaimStatus),
      );
      const claimId = index + 1;
      const domainId = resolutionStatus === RESOLUTION_STATUS.Escalated ? 2n : 1n;
      await (
        await protocol.claimRegistry
          .connect(protocol.author)
          .createClaim(makeClaimSummary(protocol.author.address, domainId), 0, ethers.ZeroAddress)
      ).wait();
      const decisionId = await createCanonicalResolutionDecision(
        protocol,
        claimId,
        resolutionStatus,
      );
      const decision = await protocol.claimRegistry.getResolutionDecision(decisionId);
      assert.equal(decision.claimStatus, BigInt(expectedClaimStatus));
    }
  });

  it("rejects same-status claim transitions", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();
    await satisfyBondAndPublishClaim(protocol, 1);

    await assert.rejects(
      protocol.claimRegistry.connect(protocol.admin).setClaimStatus(1, CLAIM_STATUS.Published),
      /ClaimRegistryInvalidStatusTransition/,
    );
  });

  it("blocks new claims on disabled resolution modules until re-enabled", async () => {
    const protocol = await deployProtocol();
    const moduleAddress = await protocol.computationalModule.getAddress();

    await (
      await protocol.moduleRegistry.connect(protocol.admin).setModuleEnabled(moduleAddress, false)
    ).wait();
    await assert.rejects(
      protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          moduleAddress,
        ),
      /ClaimRegistryUnregisteredResolutionModule/,
    );

    await (
      await protocol.moduleRegistry.connect(protocol.admin).setModuleEnabled(moduleAddress, true)
    ).wait();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          moduleAddress,
        )
    ).wait();
    assert.equal(await protocol.claimRegistry.claimExists(1), true);
  });

  it("lets accounts renounce their own roles", async () => {
    const protocol = await deployProtocol();
    const role = ROLE("RESOLVER_ROLE");
    await (
      await protocol.accessController
        .connect(protocol.admin)
        .grantRole(role, protocol.other.address)
    ).wait();
    assert.equal(await protocol.accessController.hasRole(role, protocol.other.address), true);

    await (
      await protocol.accessController
        .connect(protocol.other)
        .renounceRole(role, protocol.other.address)
    ).wait();
    assert.equal(await protocol.accessController.hasRole(role, protocol.other.address), false);
  });

  it("halts value inflows behind the guardian deposit pause while exits stay open", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    await (
      await protocol.bondEscrow
        .connect(protocol.author)
        .depositAuthorBond(1, { value: ethers.parseEther("0.1") })
    ).wait();

    await assert.rejects(
      protocol.bondEscrow.connect(protocol.author).setDepositsPaused(true),
      /AccessManagedMissingRole/,
    );

    await (
      await protocol.accessController
        .connect(protocol.admin)
        .grantRole(ROLE("PAUSER_ROLE"), protocol.other.address)
    ).wait();
    await (await protocol.bondEscrow.connect(protocol.other).setDepositsPaused(true)).wait();
    await (await protocol.epistemicMarket.connect(protocol.other).setDepositsPaused(true)).wait();

    await assert.rejects(
      protocol.bondEscrow
        .connect(protocol.author)
        .depositAuthorBond(1, { value: ethers.parseEther("0.1") }),
      /DepositsPausedError/,
    );
    await assert.rejects(
      protocol.bondEscrow
        .connect(protocol.admin)
        .fundReplicationBounty(1, { value: ethers.parseEther("0.1") }),
      /DepositsPausedError/,
    );
    await assert.rejects(
      protocol.epistemicMarket
        .connect(protocol.other)
        .fundRewardPool({ value: ethers.parseEther("0.1") }),
      /DepositsPausedError/,
    );

    // Exits stay live during a deposit pause: the author bond refund path is not gated.
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .refundAuthorBond(1, ethers.parseEther("0.05"), protocol.author.address)
    ).wait();

    await (await protocol.bondEscrow.connect(protocol.other).setDepositsPaused(false)).wait();
    await (
      await protocol.bondEscrow
        .connect(protocol.author)
        .depositAuthorBond(1, { value: ethers.parseEther("0.1") })
    ).wait();
  });

  it("refuses budget top-ups for inactive agents during reward accrual", async () => {
    const protocol = await deployProtocol();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();
    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .registerAgent(
          ethers.keccak256(ethers.toUtf8Bytes("inactive-agent")),
          "ipfs://agent/inactive",
          ethers.parseEther("1"),
        )
    ).wait();
    await (
      await protocol.agentRegistry.connect(protocol.agentOperator).setAgentActive(1, false)
    ).wait();
    await (
      await protocol.claimRewardVault
        .connect(protocol.admin)
        .fundClaimRewards(1, 0, { value: ethers.parseEther("1") })
    ).wait();

    await assert.rejects(
      protocol.claimRewardVault
        .connect(protocol.admin)
        .accrueWorkReward(
          1,
          0,
          ethers.keccak256(ethers.toUtf8Bytes("inactive-settlement")),
          protocol.replicator.address,
          1,
          ethers.parseEther("0.1"),
          5_000,
        ),
      /ClaimRewardVaultInactiveAgent/,
    );
  });

  it("rejects forecast reveals with invalid confidence basis points", async () => {
    const protocol = await deployProtocol();

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();

    const salt = ethers.keccak256(ethers.toUtf8Bytes("invalid-confidence-salt"));
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "uint16", "bytes32"],
      [FORECAST_DIRECTION.Supports, 10_001, salt],
    );
    const commitmentHash = ethers.keccak256(encoded);
    const latestBlock = await ethers.provider.getBlock("latest");
    assert.ok(latestBlock);
    await (
      await protocol.epistemicMarket
        .connect(protocol.author)
        .commitForecast(1, commitmentHash, BigInt(latestBlock.timestamp + 3600), 0, {
          value: ethers.parseEther("1"),
        })
    ).wait();

    await assert.rejects(
      protocol.epistemicMarket
        .connect(protocol.author)
        .revealForecast(1, FORECAST_DIRECTION.Supports, 10_001, salt),
    );
  });

  it("rejects ambiguous reputation checkpoint subject fields", async () => {
    const protocol = await deployProtocol();

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();
    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .registerAgent(
          ethers.keccak256(ethers.toUtf8Bytes("checkpoint-agent")),
          "ipfs://agent/checkpoint",
          ethers.parseEther("1"),
        )
    ).wait();

    const scoreVectorHash = ethers.keccak256(ethers.toUtf8Bytes("score-vector"));
    const payloadHash = ethers.keccak256(ethers.toUtf8Bytes("payload"));

    await assert.rejects(
      protocol.checkpointRegistry
        .connect(protocol.checkpointPublisher)
        .publishCheckpoint(
          1,
          SUBJECT_TYPE.Claim,
          protocol.author.address,
          1,
          0,
          ethers.ZeroAddress,
          scoreVectorHash,
          payloadHash,
          "ipfs://checkpoint-claim",
        ),
    );
    await assert.rejects(
      protocol.checkpointRegistry
        .connect(protocol.checkpointPublisher)
        .publishCheckpoint(
          1,
          SUBJECT_TYPE.ActorClaimPair,
          protocol.author.address,
          1,
          1,
          ethers.ZeroAddress,
          scoreVectorHash,
          payloadHash,
          "ipfs://checkpoint-pair",
        ),
    );
    await assert.rejects(
      protocol.checkpointRegistry
        .connect(protocol.checkpointPublisher)
        .publishCheckpoint(
          1,
          SUBJECT_TYPE.Agent,
          ethers.ZeroAddress,
          1,
          1,
          ethers.ZeroAddress,
          scoreVectorHash,
          payloadHash,
          "ipfs://checkpoint-agent",
        ),
    );
    await assert.rejects(
      protocol.checkpointRegistry
        .connect(protocol.checkpointPublisher)
        .publishCheckpoint(
          1,
          SUBJECT_TYPE.Module,
          protocol.author.address,
          0,
          0,
          await protocol.computationalModule.getAddress(),
          scoreVectorHash,
          payloadHash,
          "ipfs://checkpoint-module",
        ),
    );
  });

  it("rejects unauthorized resolver, checkpoint, and escrow actions", async () => {
    const protocol = await deployProtocol();

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();
    await satisfyBondAndPublishClaim(protocol, 1);

    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("env")),
          ethers.keccak256(ethers.toUtf8Bytes("result")),
          ethers.keccak256(ethers.toUtf8Bytes("evidence")),
          0,
        )
    ).wait();

    let unauthorizedResolve = false;
    try {
      await (
        await protocol.replicationRegistry
          .connect(protocol.replicator)
          .resolveReplicationOutcome(1, {
            status: RESOLUTION_STATUS.Supported,
            confidenceBps: 9000,
            resolutionHash: ethers.keccak256(ethers.toUtf8Bytes("unauthorized-resolution")),
            resolverType: RESOLVER_TYPE.ComputationOracle,
            evidenceHash: ethers.keccak256(ethers.toUtf8Bytes("unauthorized-evidence")),
            evidenceURI: "ipfs://unauthorized-resolution",
          })
      ).wait();
    } catch {
      unauthorizedResolve = true;
    }
    assert.equal(unauthorizedResolve, true);

    let unauthorizedCheckpoint = false;
    try {
      await (
        await protocol.checkpointRegistry
          .connect(protocol.author)
          .publishCheckpoint(
            1,
            SUBJECT_TYPE.Claim,
            ethers.ZeroAddress,
            1,
            0,
            ethers.ZeroAddress,
            ethers.keccak256(ethers.toUtf8Bytes("unauthorized-score-vector")),
            ethers.keccak256(ethers.toUtf8Bytes("unauthorized-payload")),
            "ipfs://unauthorized-checkpoint",
          )
      ).wait();
    } catch {
      unauthorizedCheckpoint = true;
    }
    assert.equal(unauthorizedCheckpoint, true);

    let unauthorizedEscrow = false;
    try {
      await (
        await protocol.bondEscrow
          .connect(protocol.author)
          .reserveBountyPayout(1, 1, ethers.parseEther("0.1"))
      ).wait();
    } catch {
      unauthorizedEscrow = true;
    }
    assert.equal(unauthorizedEscrow, true);
  });

  it("enforces payout accounting and monotonic identifier invariants", async () => {
    const protocol = await deployProtocol();
    const bondAmount = ethers.parseEther("1");
    const bountyAmount = ethers.parseEther("2");

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(makeClaimSummary(protocol.author.address, 1n), bondAmount, ethers.ZeroAddress)
    ).wait();
    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 2n),
          ethers.parseEther("0.25"),
          ethers.ZeroAddress,
        )
    ).wait();
    assert.equal(await protocol.claimRegistry.nextClaimId(), 3n);

    await satisfyBondAndPublishClaim(protocol, 1);
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .fundReplicationBounty(1, { value: bountyAmount })
    ).wait();
    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("env-a")),
          ethers.keccak256(ethers.toUtf8Bytes("result-a")),
          ethers.keccak256(ethers.toUtf8Bytes("evidence-a")),
          0,
        )
    ).wait();
    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("env-b")),
          ethers.keccak256(ethers.toUtf8Bytes("result-b")),
          ethers.keccak256(ethers.toUtf8Bytes("evidence-b")),
          0,
        )
    ).wait();
    assert.equal(await protocol.replicationRegistry.nextReplicationId(), 3n);

    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .reserveBountyPayout(1, 1, ethers.parseEther("1"))
    ).wait();

    await resolveReplication(protocol, 1);

    let oversubscribedReservation = false;
    try {
      await (
        await protocol.bondEscrow
          .connect(protocol.admin)
          .reserveBountyPayout(1, 2, ethers.parseEther("1.5"))
      ).wait();
    } catch {
      oversubscribedReservation = true;
    }
    assert.equal(oversubscribedReservation, true);

    await (await protocol.bondEscrow.connect(protocol.admin).releaseReservedPayout(1, 1)).wait();

    let doubleRelease = false;
    try {
      await (await protocol.bondEscrow.connect(protocol.admin).releaseReservedPayout(1, 1)).wait();
    } catch {
      doubleRelease = true;
    }
    assert.equal(doubleRelease, true);

    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .slashAuthorBond(1, ethers.parseEther("0.25"), protocol.other.address)
    ).wait();
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .refundAuthorBond(1, ethers.parseEther("0.25"), protocol.author.address)
    ).wait();

    let overRefund = false;
    try {
      await (
        await protocol.bondEscrow
          .connect(protocol.admin)
          .refundAuthorBond(1, ethers.parseEther("1"), protocol.author.address)
      ).wait();
    } catch {
      overRefund = true;
    }
    assert.equal(overRefund, true);
    assert.equal(await protocol.bondEscrow.authorBondBalances(1), ethers.parseEther("0.5"));
    assert.equal(await protocol.bondEscrow.bountyBalances(1), ethers.parseEther("1"));
    assert.equal(await protocol.bondEscrow.reservedBountyBalances(1), 0n);
  });

  it("binds bounty payouts to resolved replications and supports terminal cancellation", async () => {
    const protocol = await deployProtocol();
    const bountyAmount = ethers.parseEther("2");

    for (const domainId of [1n, 2n]) {
      await (
        await protocol.claimRegistry
          .connect(protocol.author)
          .createClaim(
            makeClaimSummary(protocol.author.address, domainId),
            ethers.parseEther("0.25"),
            ethers.ZeroAddress,
          )
      ).wait();
    }
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .fundReplicationBounty(1, { value: bountyAmount })
    ).wait();

    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          2,
          ethers.keccak256(ethers.toUtf8Bytes("other-claim-env")),
          ethers.keccak256(ethers.toUtf8Bytes("other-claim-result")),
          ethers.keccak256(ethers.toUtf8Bytes("other-claim-evidence")),
          0,
        )
    ).wait();
    await assert.rejects(
      protocol.bondEscrow
        .connect(protocol.admin)
        .reserveBountyPayout(1, 1, ethers.parseEther("0.5")),
      /BondEscrowReplicationClaimMismatch/,
    );

    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("claim-env")),
          ethers.keccak256(ethers.toUtf8Bytes("claim-result")),
          ethers.keccak256(ethers.toUtf8Bytes("claim-evidence")),
          0,
        )
    ).wait();
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .reserveBountyPayout(1, 2, ethers.parseEther("0.75"))
    ).wait();

    const reservation = await protocol.bondEscrow.getReservation(1, 2);
    assert.equal(reservation.recipient, protocol.replicator.address);
    await assert.rejects(
      protocol.bondEscrow.connect(protocol.admin).releaseReservedPayout(1, 2),
      /BondEscrowUnresolvedReplication/,
    );
    await assert.rejects(protocol.bondEscrow.connect(protocol.author).cancelReservedPayout(1, 2));

    const cancellation = await (
      await protocol.bondEscrow.connect(protocol.admin).cancelReservedPayout(1, 2)
    ).wait();
    const cancelledLog = cancellation?.logs.find((log) => {
      try {
        return protocol.bondEscrow.interface.parseLog(log)?.name === "BountyPayoutCancelled";
      } catch {
        return false;
      }
    });
    assert.ok(cancelledLog);
    const cancelledReservation = await protocol.bondEscrow.getReservation(1, 2);
    assert.equal(cancelledReservation.cancelled, true);
    assert.equal(await protocol.bondEscrow.reservedBountyBalances(1), 0n);
    assert.equal(await protocol.bondEscrow.bountyBalances(1), bountyAmount);
    await assert.rejects(
      protocol.bondEscrow.connect(protocol.admin).cancelReservedPayout(1, 2),
      /BondEscrowAlreadyCancelled/,
    );
    await assert.rejects(
      protocol.bondEscrow.connect(protocol.admin).releaseReservedPayout(1, 2),
      /BondEscrowAlreadyCancelled/,
    );

    await (
      await protocol.replicationRegistry
        .connect(protocol.replicator)
        .submitReplication(
          1,
          ethers.keccak256(ethers.toUtf8Bytes("released-env")),
          ethers.keccak256(ethers.toUtf8Bytes("released-result")),
          ethers.keccak256(ethers.toUtf8Bytes("released-evidence")),
          0,
        )
    ).wait();
    await resolveReplication(protocol, 3);
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .reserveBountyPayout(1, 3, ethers.parseEther("0.5"))
    ).wait();
    const before = await ethers.provider.getBalance(protocol.replicator.address);
    const release = await (
      await protocol.bondEscrow.connect(protocol.admin).releaseReservedPayout(1, 3)
    ).wait();
    const releasedLog = release?.logs.find((log) => {
      try {
        return protocol.bondEscrow.interface.parseLog(log)?.name === "BountyPayoutReleased";
      } catch {
        return false;
      }
    });
    assert.ok(releasedLog);
    assert.equal(
      await ethers.provider.getBalance(protocol.replicator.address),
      before + ethers.parseEther("0.5"),
    );
  });

  it("rejects zero-address escrow and agent budget recipients", async () => {
    const protocol = await deployProtocol();
    const bondAmount = ethers.parseEther("1");
    const bountyAmount = ethers.parseEther("2");

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(makeClaimSummary(protocol.author.address, 1n), bondAmount, ethers.ZeroAddress)
    ).wait();
    await (
      await protocol.bondEscrow.connect(protocol.author).depositAuthorBond(1, { value: bondAmount })
    ).wait();
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .fundReplicationBounty(1, { value: bountyAmount })
    ).wait();

    await assert.rejects(
      protocol.bondEscrow
        .connect(protocol.admin)
        .reserveBountyPayout(1, 99, ethers.parseEther("0.5")),
    );
    await assert.rejects(
      protocol.bondEscrow
        .connect(protocol.admin)
        .slashAuthorBond(1, ethers.parseEther("0.1"), ethers.ZeroAddress),
    );
    await assert.rejects(
      protocol.bondEscrow
        .connect(protocol.admin)
        .refundAuthorBond(1, ethers.parseEther("0.1"), ethers.ZeroAddress),
    );

    await (
      await protocol.agentRegistry
        .connect(protocol.agentOperator)
        .registerAgent(
          ethers.keccak256(ethers.toUtf8Bytes("recipient-agent")),
          "ipfs://agents/recipient",
          ethers.parseEther("1"),
          { value: ethers.parseEther("2") },
        )
    ).wait();
    await (
      await protocol.agentRegistry
        .connect(protocol.admin)
        .reserveBudget(1, ethers.parseEther("0.5"))
    ).wait();

    await assert.rejects(
      protocol.agentRegistry
        .connect(protocol.admin)
        .consumeBudget(1, ethers.parseEther("0.25"), ethers.ZeroAddress),
    );
    await assert.rejects(
      protocol.agentRegistry
        .connect(protocol.agentOperator)
        .withdrawBudget(1, ethers.parseEther("0.25"), ethers.ZeroAddress),
    );
  });

  it("rejects unknown artifact and checkpoint reads", async () => {
    const protocol = await deployProtocol();

    await assert.rejects(protocol.artifactRegistry.getArtifact(99));
    await assert.rejects(protocol.checkpointRegistry.getCheckpoint(99));
  });

  it("maintains bounty accounting across randomized reservation and release sequences", async () => {
    const protocol = await deployProtocol();
    const rng = createDeterministicRng(42);
    const fundedBounty = ethers.parseEther("5");

    await (
      await protocol.claimRegistry
        .connect(protocol.author)
        .createClaim(
          makeClaimSummary(protocol.author.address, 1n),
          ethers.parseEther("0.5"),
          ethers.ZeroAddress,
        )
    ).wait();
    await satisfyBondAndPublishClaim(protocol, 1);
    await (
      await protocol.bondEscrow
        .connect(protocol.admin)
        .fundReplicationBounty(1, { value: fundedBounty })
    ).wait();

    const releasedByReplication = new Map<number, bigint>();
    let totalReleased = 0n;

    for (let replicationId = 1; replicationId <= 8; replicationId += 1) {
      await (
        await protocol.replicationRegistry
          .connect(protocol.replicator)
          .submitReplication(
            1,
            ethers.keccak256(ethers.toUtf8Bytes(`env-${replicationId}`)),
            ethers.keccak256(ethers.toUtf8Bytes(`result-${replicationId}`)),
            ethers.keccak256(ethers.toUtf8Bytes(`evidence-${replicationId}`)),
            0,
          )
      ).wait();

      const bountyBalance = BigInt(await protocol.bondEscrow.bountyBalances(1));
      const reservedBountyBalance = BigInt(await protocol.bondEscrow.reservedBountyBalances(1));
      const available = bountyBalance - reservedBountyBalance;

      const step = ethers.parseEther("0.25");
      const maxUnits = Number(available / step);
      if (maxUnits === 0) {
        continue;
      }

      const amount = step * BigInt(1 + Math.floor(rng() * maxUnits));
      await (
        await protocol.bondEscrow
          .connect(protocol.admin)
          .reserveBountyPayout(1, replicationId, amount)
      ).wait();

      const reservedAfterReservation = BigInt(await protocol.bondEscrow.reservedBountyBalances(1));
      const bountyAfterReservation = BigInt(await protocol.bondEscrow.bountyBalances(1));
      assert.equal(reservedAfterReservation <= bountyAfterReservation, true);

      if (rng() > 0.35) {
        await resolveReplication(protocol, replicationId);
        await (
          await protocol.bondEscrow.connect(protocol.admin).releaseReservedPayout(1, replicationId)
        ).wait();
        releasedByReplication.set(replicationId, amount);
        totalReleased += amount;
      }

      const currentReserved = BigInt(await protocol.bondEscrow.reservedBountyBalances(1));
      const currentBounty = BigInt(await protocol.bondEscrow.bountyBalances(1));
      assert.equal(currentReserved <= currentBounty, true);
      assert.equal(currentBounty + totalReleased, fundedBounty);
    }

    for (const [replicationId, amount] of releasedByReplication.entries()) {
      const reservation = await protocol.bondEscrow.getReservation(1, replicationId);
      assert.equal(reservation.released, true);
      assert.equal(reservation.amount, amount);
    }
  });

  it("accepts randomized administrative claim paths and rejects outcome bypasses", async () => {
    const protocol = await deployProtocol();
    const rng = createDeterministicRng(7);
    const allowedTransitions = new Map<number, number[]>([
      [CLAIM_STATUS.Draft, [CLAIM_STATUS.Published, CLAIM_STATUS.Deprecated]],
      [CLAIM_STATUS.Published, [CLAIM_STATUS.UnderReplication, CLAIM_STATUS.Deprecated]],
      [CLAIM_STATUS.UnderReplication, [CLAIM_STATUS.Deprecated]],
    ]);

    for (let claimIndex = 0; claimIndex < 6; claimIndex += 1) {
      await (
        await protocol.claimRegistry
          .connect(protocol.author)
          .createClaim(
            makeClaimSummary(protocol.author.address, BigInt((claimIndex % 3) + 1)),
            ethers.parseEther("0.1"),
            ethers.ZeroAddress,
          )
      ).wait();
      const claimId = claimIndex + 1;
      let currentStatus = CLAIM_STATUS.Draft;

      while (allowedTransitions.has(currentStatus)) {
        const allowed = allowedTransitions.get(currentStatus);
        assert.ok(allowed);
        const nextStatus = allowed[Math.floor(rng() * allowed.length)];
        if (nextStatus === CLAIM_STATUS.Published) {
          await satisfyBondAndPublishClaim(protocol, claimId);
        } else {
          await (
            await protocol.claimRegistry.connect(protocol.admin).setClaimStatus(claimId, nextStatus)
          ).wait();
        }
        const claim = await protocol.claimRegistry.getClaim(claimId);
        assert.equal(Number(claim.status), nextStatus);

        const invalidStatus = CLAIM_STATUS.Draft;
        if (!allowed.includes(invalidStatus) && invalidStatus !== nextStatus) {
          let reverted = false;
          try {
            await (
              await protocol.claimRegistry
                .connect(protocol.admin)
                .setClaimStatus(claimId, invalidStatus)
            ).wait();
          } catch {
            reverted = true;
          }
          assert.equal(reverted, true);
        }

        currentStatus = nextStatus;
        if (currentStatus === CLAIM_STATUS.Deprecated) {
          break;
        }
      }
    }
  });
});
