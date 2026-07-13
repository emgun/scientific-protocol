import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import { getBytes, HDNodeWallet, keccak256, toUtf8Bytes, Wallet } from "ethers";
import type { Pool } from "pg";
import type {
  AgentWebhookDeliveryView,
  AgentWebhookSubscriptionSecretView,
} from "../src/agents/webhooks.js";
import {
  type ApiDependencies,
  type ApiServerInstance,
  createApiServer,
  type PartialApiRateLimitConfig,
} from "../src/api/server.js";
import type { CheckpointPublicationView } from "../src/checkpoints/store.js";
import type {
  ArtifactMaintenanceTaskRunView,
  ArtifactMaintenanceTaskView,
  PersistedArtifactAuditView,
  PersistedArtifactProvenanceView,
  PersistedArtifactReplicaView,
  PersistedArtifactStorageAttestationView,
  PersistedArtifactStoragePolicyView,
  PersistedArtifactView,
  ReplicationJobRunView,
  ReplicationJobView,
} from "../src/coordinator/store.js";
import { SandboxDemoResetInProgressError } from "../src/demo/reset.js";
import type { DemoScenarioView } from "../src/demo/store.js";
import type {
  GovernanceEventView,
  GovernanceOverviewView,
  GovernanceProposalDetailView,
  GovernanceProposalSummaryView,
  GovernanceTreasuryView,
} from "../src/governance/read.js";
import { ReadModelSyncInProgressError } from "../src/indexer/store.js";
import type { LeaderboardEntryView, ReputationPayloadView } from "../src/reputation/store.js";
import type { ResolutionRunView } from "../src/resolver/store.js";
import type {
  ReviewAuthorResponseView,
  ReviewIssueView,
  ReviewSubmissionView,
  ReviewTaskRunView,
  ReviewTaskView,
} from "../src/review/types.js";
import {
  type AgentRequestEnvelope,
  type AgentRequestView,
  hashAgentRequestEnvelope,
} from "../src/shared/agent-requests.js";
import type { OperatorRequestView } from "../src/shared/operator-requests.js";
import { createInlineJsonArtifact, sha256Hex } from "../src/shared/persisted-artifacts.js";
import type { PublicWriteRequestView } from "../src/shared/public-write-requests.js";
import { hashPublicWriteEnvelope } from "../src/shared/public-write-requests.js";
import type { ReadModel } from "../src/shared/read-model.js";
import type {
  SourceExtractionCandidate,
  SourcePublicationDecisionView,
  SourceRecordView,
} from "../src/sources/types.js";

const TEST_DEPLOYMENT_PATH = path.resolve(
  process.cwd(),
  "test",
  "fixtures",
  "local-deployment.json",
);
const TEST_ROLE_HASH = {
  CHECKPOINT_PUBLISHER_ROLE: keccak256(toUtf8Bytes("CHECKPOINT_PUBLISHER_ROLE")),
  RESOLVER_ROLE: keccak256(toUtf8Bytes("RESOLVER_ROLE")),
} as const;

function createDependencyOverrides(
  overrides: Partial<ApiDependencies> = {},
): Partial<ApiDependencies> {
  const publicWriteRequests = new Map<string, PublicWriteRequestView>();
  const replicationJobs: ReplicationJobView[] = [
    {
      jobId: "1",
      claimId: "1",
      requestedBy: "local-coordinator",
      status: "completed",
      onchainReplicationId: "1",
      specHash: "0x9001",
      specURI: "ipfs://replication-spec-1",
      requestId: "1",
      submissionActor: "0x0000000000000000000000000000000000000007",
      submissionTxHash: "0xbeef",
      submittedAt: "2026-03-11T00:04:30.000Z",
      assignedWorker: "worker-a",
      assignedAgentId: "1",
      assignedAt: "2026-03-11T00:04:00.000Z",
      resultArtifactKey: "replication-result-abc123",
      resultHash: "0x9002",
      evidenceHash: "0x9003",
      evidenceURI: "/tmp/replication-result.json",
      failureReason: null,
      createdAt: "2026-03-11T00:03:00.000Z",
      updatedAt: "2026-03-11T00:05:00.000Z",
      completedAt: "2026-03-11T00:05:00.000Z",
    },
  ];
  const replicationJobRuns: ReplicationJobRunView[] = [
    {
      runId: "1",
      jobId: "1",
      workerId: "worker-a",
      agentId: "1",
      requestId: "1",
      status: "completed",
      submissionTxHash: "0xbeef",
      executionManifestHash: "0x9004",
      resultArtifactKey: "replication-result-abc123",
      resultHash: "0x9002",
      evidenceHash: "0x9003",
      evidenceURI: "/tmp/replication-result.json",
      failureReason: null,
      lastHeartbeatAt: "2026-03-11T00:04:30.000Z",
      startedAt: "2026-03-11T00:04:00.000Z",
      finishedAt: "2026-03-11T00:05:00.000Z",
    },
  ];
  const artifactMaintenanceTasks: ArtifactMaintenanceTaskView[] = [
    {
      taskId: "1",
      artifactKey: "replication-result-abc123",
      taskType: "audit",
      status: "completed",
      requestedBy: "artifact-maintenance-scheduler",
      targetReplicaKey: null,
      targetProvider: null,
      assignedWorker: "artifact-worker-a",
      assignedAgentId: "1",
      assignedAt: "2026-03-11T00:11:00.000Z",
      resultArtifactKey: "artifact-maintenance-audit-result-1111",
      failureReason: null,
      repairSourceReplicaKey: null,
      repairLocator: null,
      createdAt: "2026-03-11T00:10:50.000Z",
      updatedAt: "2026-03-11T00:11:15.000Z",
      completedAt: "2026-03-11T00:11:15.000Z",
    },
    {
      taskId: "2",
      artifactKey: "replication-result-abc123",
      taskType: "repair",
      status: "open",
      requestedBy: "artifact-audit:1",
      targetReplicaKey: "pinata-public",
      targetProvider: "ipfs:pinata",
      assignedWorker: null,
      assignedAgentId: null,
      assignedAt: null,
      resultArtifactKey: null,
      failureReason: null,
      repairSourceReplicaKey: null,
      repairLocator: null,
      createdAt: "2026-03-11T00:11:16.000Z",
      updatedAt: "2026-03-11T00:11:16.000Z",
      completedAt: null,
    },
  ];
  const artifactMaintenanceTaskRuns: ArtifactMaintenanceTaskRunView[] = [
    {
      runId: "1",
      taskId: "1",
      workerId: "artifact-worker-a",
      agentId: "1",
      status: "completed",
      summaryArtifactKey: "artifact-maintenance-audit-result-1111",
      failureReason: null,
      lastHeartbeatAt: "2026-03-11T00:11:10.000Z",
      startedAt: "2026-03-11T00:11:00.000Z",
      finishedAt: "2026-03-11T00:11:15.000Z",
    },
  ];
  const persistedArtifacts: PersistedArtifactView[] = [
    {
      artifactKey: "replication-result-abc123",
      byteLength: 123,
      contentType: "application/json",
      createdAt: "2026-03-11T00:05:00.000Z",
      kind: "replication-result",
      sha256: "0x9002",
      storagePath: "/tmp/replication-result.json",
    },
    {
      artifactKey: "artifact-maintenance-audit-result-1111",
      byteLength: 321,
      contentType: "application/json",
      createdAt: "2026-03-11T00:11:15.000Z",
      kind: "artifact-maintenance-audit-result",
      sha256: "0x9010",
      storagePath: "/tmp/artifact-maintenance-audit-result.json",
    },
  ];
  const persistedArtifactReplicas: PersistedArtifactReplicaView[] = [
    {
      replicaKey: "primary",
      provider: "filesystem",
      locator: "/tmp/replication-result.json",
      isPrimary: true,
      providerMetadata: null,
      createdAt: "2026-03-11T00:05:00.000Z",
      updatedAt: "2026-03-11T00:10:00.000Z",
      lastCheckedAt: "2026-03-11T00:10:00.000Z",
      lastCheckStatus: "verified",
      lastCheckError: null,
    },
    {
      replicaKey: "pinata-public",
      provider: "ipfs:pinata",
      locator: "ipfs://bafyreplicationresult",
      isPrimary: false,
      providerMetadata: {
        capturedAt: "2026-03-11T00:05:05.000Z",
        filecoin: {
          dealCount: 1,
          deals: [
            {
              dealId: "deal-1001",
              miner: "f01234",
              pieceCid: "baga6ea4seaq",
              status: "active",
            },
          ],
          network: "public",
          status: "active",
        },
        network: "public",
        objectId: "pinata-file-1",
        provider: "ipfs:pinata",
        raw: {
          id: "pinata-file-1",
          status: "pinned",
        },
        status: "pinned",
      },
      createdAt: "2026-03-11T00:05:05.000Z",
      updatedAt: "2026-03-11T00:10:00.000Z",
      lastCheckedAt: "2026-03-11T00:10:00.000Z",
      lastCheckStatus: "verified",
      lastCheckError: null,
    },
  ];
  const persistedArtifactAudits: PersistedArtifactAuditView[] = [
    {
      auditId: "1",
      artifactKey: "replication-result-abc123",
      replicaKey: "primary",
      provider: "filesystem",
      locator: "/tmp/replication-result.json",
      checkKind: "verify",
      status: "verified",
      detail: null,
      observedSha256: "0x9002",
      checkedAt: "2026-03-11T00:10:00.000Z",
    },
    {
      auditId: "2",
      artifactKey: "replication-result-abc123",
      replicaKey: "pinata-public",
      provider: "ipfs:pinata",
      locator: "ipfs://bafyreplicationresult",
      checkKind: "verify",
      status: "verified",
      detail: null,
      observedSha256: "0x9002",
      checkedAt: "2026-03-11T00:10:01.000Z",
    },
  ];
  const persistedArtifactProvenance: PersistedArtifactProvenanceView = {
    artifactKey: "replication-result-abc123",
    sourceType: "repository",
    sourceLocator: "https://github.com/example/repro-benchmark",
    ref: "main",
    commitHash: "abc123def456",
    cid: null,
    finalUrl: null,
    derivedFromArtifactKey: null,
    metadata: {
      repositoryName: "repro-benchmark",
    },
    createdAt: "2026-03-11T00:05:00.000Z",
    updatedAt: "2026-03-11T00:05:00.000Z",
  };
  const persistedArtifactStoragePolicy: PersistedArtifactStoragePolicyView = {
    artifactKey: "replication-result-abc123",
    bundleCid: "bafyreplicationbundle",
    bundleMemberPath: "replications/abc123/result.json",
    createdAt: "2026-03-11T00:05:10.000Z",
    durabilityClass: "A",
    metadata: { launchCritical: true },
    repairPriority: 100,
    requiredIndependentRetrievalPaths: 2,
    requiredReplicaCount: 2,
    requiresFilecoinOrEquivalent: true,
    retentionUntil: null,
    updatedAt: "2026-03-11T00:05:10.000Z",
  };
  const persistedArtifactStorageAttestations: PersistedArtifactStorageAttestationView[] = [
    {
      artifactKey: "replication-result-abc123",
      attestationId: "1",
      attestorAddress: "0x0000000000000000000000000000000000000007",
      cid: "bafyreplicationresult",
      commitmentKind: "filecoin",
      createdAt: "2026-03-11T00:05:20.000Z",
      evidenceRef: "ipfs://bafyevidence",
      nodeId: "pinata-public",
      provider: "ipfs:pinata",
      providerMetadata: { dealId: "deal-1001" },
      retentionUntil: "2027-03-11T00:05:20.000Z",
      retrievalUrl: "https://gateway.pinata.cloud/ipfs/bafyreplicationresult",
      signature: "0xsigned",
      signedPayloadHash: "0xstorageattestation",
      storageClass: "A",
      storageStartedAt: "2026-03-11T00:05:20.000Z",
      updatedAt: "2026-03-11T00:05:20.000Z",
    },
  ];
  const rewardSettlements = [
    {
      accruedTotalWei: "15000000000000000",
      agentId: "1",
      amountWei: "15000000000000000",
      budgetTopUpBps: 5000,
      claimId: "1",
      createdAt: "2026-03-11T00:08:00.000Z",
      itemId: "review-task:1",
      marketPressureBps: 12000,
      policyVersion: "auto-v1",
      qualityBps: 10000,
      recipient: "0x0000000000000000000000000000000000000003",
      settlementId: "0xsettlement1",
      settlementLabel: "auto-v1:step-1",
      targetTotalWei: "15000000000000000",
      txHash: "0xreward1",
      workKind: "review" as const,
    },
    {
      accruedTotalWei: "40000000000000000",
      agentId: "1",
      amountWei: "25000000000000000",
      budgetTopUpBps: 5000,
      claimId: "1",
      createdAt: "2026-03-11T00:12:00.000Z",
      itemId: "replication-job:1",
      marketPressureBps: 14500,
      policyVersion: "auto-v1",
      qualityBps: 11000,
      recipient: "0x0000000000000000000000000000000000000003",
      settlementId: "0xsettlement2",
      settlementLabel: "auto-v1:step-2",
      targetTotalWei: "40000000000000000",
      txHash: "0xreward2",
      workKind: "replication" as const,
    },
  ];
  const reputationPayloads: ReputationPayloadView[] = [
    {
      payloadId: "1",
      domainId: 1,
      cutoffBlock: 42,
      cursorBlock: 41,
      payloadHash: "0xa001",
      policyVersion: "reputation-v2-direction-neutral-work",
      artifactKey: "reputation-payload-a001",
      entryCount: 1,
      createdAt: "2026-03-11T00:06:00.000Z",
    },
  ];
  const leaderboardEntries: LeaderboardEntryView[] = [
    {
      payloadId: "1",
      domainId: 1,
      rank: 1,
      subjectActor: "0x0000000000000000000000000000000000000001",
      score: "52",
      claimCount: 1,
      supportedClaimCount: 1,
      refutedClaimCount: 0,
      fraudulentClaimCount: 0,
      replicationCount: 0,
      checkpointCount: 1,
    },
  ];
  const resolutionRuns: ResolutionRunView[] = [
    {
      runId: "1",
      jobId: "1",
      claimId: "1",
      replicationId: "1",
      resolver: "0x0000000000000000000000000000000000000007",
      status: "submitted",
      resolutionStatus: 1,
      claimStatus: 4,
      resolverType: 3,
      confidenceBps: 9200,
      resolutionHash: "0xa100",
      evidenceHash: "0x9003",
      evidenceURI: "/tmp/replication-result.json",
      rationaleArtifactKey: "replication-result-abc123",
      requestId: "2",
      payoutAmount: "2000000000000000000",
      txHashes: ["0xaaa", "0xbbb", "0xccc"],
      failureReason: null,
      createdAt: "2026-03-11T00:07:00.000Z",
      submittedAt: "2026-03-11T00:07:10.000Z",
      updatedAt: "2026-03-11T00:07:10.000Z",
    },
  ];
  const checkpointPublications: CheckpointPublicationView[] = [
    {
      publicationId: "1",
      payloadId: "1",
      domainId: 1,
      publisher: "0x0000000000000000000000000000000000000007",
      requestId: "3",
      subjectType: 0,
      subjectActor: "0x0000000000000000000000000000000000000001",
      subjectClaimId: "0",
      subjectAgentId: "0",
      subjectModule: "0x0000000000000000000000000000000000000000",
      scoreVectorHash: "0xa200",
      payloadHash: "0xa001",
      uri: "/tmp/checkpoint-score-vector.json",
      status: "submitted",
      checkpointId: "2",
      txHash: "0xddd",
      failureReason: null,
      createdAt: "2026-03-11T00:08:00.000Z",
      publishedAt: "2026-03-11T00:08:10.000Z",
      updatedAt: "2026-03-11T00:08:10.000Z",
    },
  ];
  const governanceOverview: GovernanceOverviewView = {
    chainId: 31337,
    claimRewardVaultAddress: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    deploymentBlock: 56,
    governanceTokenAddress: "0x851356ae760d987E095750cCeb3bC6014560891C",
    governanceTokenName: "Scientific Protocol Votes",
    governanceTokenSymbol: "OSPVOTE",
    governanceTokenTotalSupply: "1100000000000000000000",
    governorAddress: "0x95401dc811bb5740090279Ba06cfA8fcF6113778",
    governorName: "Scientific Protocol Governor",
    latestBlock: 412,
    proposalThreshold: "100000000000000000000",
    quorumNumerator: 4,
    timelockAddress: "0xf5059a5D33d5853360D16C683c16e67980206f36",
    timelockDelaySeconds: 60,
    treasuryAddress: "0x998abeb3E57409262aE5b751f60747921B33613E",
    treasuryBalanceWei: "1500000000000000000",
    votingDelayBlocks: 1,
    votingPeriodBlocks: 20,
  };
  const governanceTreasury: GovernanceTreasuryView = {
    accruedRewardLiabilityWei: "1250000000000000000",
    claimRewardVaultAddress: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    claimRewardVaultBalanceWei: "5750000000000000000",
    recentRewardSettlements: {
      items: [
        {
          accruedTotalWei: "500000000000000000",
          agentId: "1",
          amountWei: "500000000000000000",
          budgetTopUpBps: 2500,
          claimId: "1",
          createdAt: "2026-04-14T18:16:00.000Z",
          itemId: "review-task:12",
          marketPressureBps: 11800,
          policyVersion: "reward-policy-v2",
          qualityBps: 9400,
          recipient: "0x0000000000000000000000000000000000000011",
          settlementId: "0xsettlement01",
          settlementLabel: "initial-accrual",
          targetTotalWei: "900000000000000000",
          txHash: "0xreward1",
          workKind: "review",
        },
      ],
      limit: 10,
      offset: 0,
      total: 1,
    },
    recentTreasuryEvents: {
      items: [
        {
          actor: "0x0000000000000000000000000000000000000001",
          amountWei: "3000000000000000000",
          blockNumber: 88,
          createdAt: "2026-04-14T18:12:00.000Z",
          eventType: "deposit",
          recipient: null,
          txHash: "0xtreasury1",
        },
        {
          actor: "0x95401dc811bb5740090279Ba06cfA8fcF6113778",
          amountWei: "1000000000000000000",
          blockNumber: 97,
          createdAt: "2026-04-14T18:18:00.000Z",
          eventType: "ether_release",
          recipient: "0x0000000000000000000000000000000000000011",
          txHash: "0xtreasury2",
        },
      ],
      limit: 10,
      offset: 0,
      total: 2,
    },
    rewardBudgetByWorkKind: [
      {
        accruedWei: "700000000000000000",
        fundedWei: "1200000000000000000",
        outstandingPoolWei: "500000000000000000",
        settlementCount: 2,
        workKind: "review",
      },
      {
        accruedWei: "600000000000000000",
        fundedWei: "2000000000000000000",
        outstandingPoolWei: "1400000000000000000",
        settlementCount: 1,
        workKind: "replication",
      },
    ],
    rewardPoolOutstandingTotalWei: "4500000000000000000",
    settledRewards: {
      byWorkKind: [
        {
          amountWei: "700000000000000000",
          settlementCount: 2,
          workKind: "review",
        },
        {
          amountWei: "600000000000000000",
          settlementCount: 1,
          workKind: "replication",
        },
      ],
      settlementCount: 3,
      totalAmountWei: "1300000000000000000",
    },
    totalManagedCapitalWei: "7250000000000000000",
    treasuryAddress: "0x998abeb3E57409262aE5b751f60747921B33613E",
    treasuryBalanceWei: "1500000000000000000",
  };
  const governanceEvents: GovernanceEventView[] = [
    {
      actor: "0x0000000000000000000000000000000000000001",
      blockNumber: 80,
      createdAt: "2026-04-14T18:10:00.000Z",
      eventType: "proposal_created",
      proposalId: "101",
      proposalTitle: "Increase review pool target",
      summary: "Proposal created by 0x0000000000000000000000000000000000000001",
      txHash: "0xgov1",
    },
    {
      actor: "0x0000000000000000000000000000000000000001",
      blockNumber: 83,
      createdAt: "2026-04-14T18:12:00.000Z",
      eventType: "vote_cast",
      proposalId: "101",
      proposalTitle: "Increase review pool target",
      summary: "Vote cast for with 450000000000000000000 weight",
      txHash: "0xgov2",
    },
    {
      actor: null,
      blockNumber: 89,
      createdAt: "2026-04-14T18:18:00.000Z",
      eventType: "proposal_queued",
      proposalId: "101",
      proposalTitle: "Increase review pool target",
      summary: "Proposal queued with eta 2026-04-14T18:20:00.000Z",
      txHash: "0xgov3",
    },
  ];
  const governanceProposalSummaries: GovernanceProposalSummaryView[] = [
    {
      createdAt: "2026-04-14T18:10:00.000Z",
      createdBlock: 80,
      description:
        "# Increase review pool target\n\nRaise the default review funding target for domain 1.",
      eta: "2026-04-14T18:20:00.000Z",
      operationCount: 2,
      proposalId: "101",
      proposer: "0x0000000000000000000000000000000000000001",
      quorumVotes: "44000000000000000000",
      snapshotBlock: "81",
      state: "Queued",
      title: "Increase review pool target",
      voteDeadlineBlock: "101",
      votes: {
        abstain: "0",
        against: "0",
        for: "650000000000000000000",
      },
    },
  ];
  const governanceProposalDetails = new Map<string, GovernanceProposalDetailView>(
    governanceProposalSummaries.map((proposal) => [
      proposal.proposalId,
      {
        ...proposal,
        actions: [
          {
            calldata: "0x1234",
            signature: "setParameter(bytes32,uint256)",
            summary: "setParameter(bytes32,uint256) on 0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1",
            target: "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1",
            valueWei: "0",
          },
          {
            calldata: "0x5678",
            signature: "releaseEther(address,uint256)",
            summary:
              "releaseEther(address,uint256) on 0x998abeb3E57409262aE5b751f60747921B33613E with 250000000000000000 wei",
            target: "0x998abeb3E57409262aE5b751f60747921B33613E",
            valueWei: "250000000000000000",
          },
        ],
        votesCast: {
          items: [
            {
              blockNumber: 84,
              createdAt: "2026-04-14T18:13:00.000Z",
              reason: "Funds more review depth for contested claims.",
              support: "for",
              txHash: "0xvote1",
              voter: "0x0000000000000000000000000000000000000001",
              weight: "450000000000000000000",
            },
            {
              blockNumber: 85,
              createdAt: "2026-04-14T18:14:00.000Z",
              reason: "Matches current demand pressure.",
              support: "for",
              txHash: "0xvote2",
              voter: "0x0000000000000000000000000000000000000002",
              weight: "200000000000000000000",
            },
          ],
          limit: 20,
          offset: 0,
          total: 2,
        },
      },
    ]),
  );
  const operatorRequests: OperatorRequestView[] = [
    {
      requestId: "1",
      actionType: "replication_submission",
      operatorAddress: "0x0000000000000000000000000000000000000007",
      requestNonce: "0",
      chainId: 31337,
      scopeKey: "replication-job:1",
      requestHash: "0xf001",
      signature: "0xsigned1",
      payloadArtifactKey: "replication-result-abc123",
      status: "submitted",
      submissionReference: "0xbeef",
      failureReason: null,
      createdAt: "2026-03-11T00:04:10.000Z",
      submittedAt: "2026-03-11T00:04:30.000Z",
      updatedAt: "2026-03-11T00:04:30.000Z",
    },
    {
      requestId: "2",
      actionType: "resolution_submission",
      operatorAddress: "0x0000000000000000000000000000000000000007",
      requestNonce: "0",
      chainId: 31337,
      scopeKey: "replication:1",
      requestHash: "0xf002",
      signature: "0xsigned2",
      payloadArtifactKey: "replication-result-abc123",
      status: "submitted",
      submissionReference: "0xaaa,0xbbb,0xccc",
      failureReason: null,
      createdAt: "2026-03-11T00:07:00.000Z",
      submittedAt: "2026-03-11T00:07:10.000Z",
      updatedAt: "2026-03-11T00:07:10.000Z",
    },
    {
      requestId: "3",
      actionType: "checkpoint_publication",
      operatorAddress: "0x0000000000000000000000000000000000000007",
      requestNonce: "0",
      chainId: 31337,
      scopeKey:
        "checkpoint:1:0:0x0000000000000000000000000000000000000001:0:0x0000000000000000000000000000000000000000",
      requestHash: "0xf003",
      signature: "0xsigned3",
      payloadArtifactKey: "replication-result-abc123",
      status: "submitted",
      submissionReference: "0xddd",
      failureReason: null,
      createdAt: "2026-03-11T00:08:00.000Z",
      submittedAt: "2026-03-11T00:08:10.000Z",
      updatedAt: "2026-03-11T00:08:10.000Z",
    },
  ];
  const agentRequests: AgentRequestView[] = [
    {
      requestId: "1",
      actionType: "artifact_task_claim",
      agentId: "1",
      actorAddress: "0x0000000000000000000000000000000000000003",
      requestNonce: "nonce-1",
      scopeKey: "artifact-maintenance-task:1",
      requestHash: "0xa001",
      signature: "0xsigned-agent-1",
      payload: {
        workerId: "artifact-worker-a",
      },
      status: "accepted",
      outcomeDetail: "claimed task 1",
      createdAt: "2026-03-11T00:11:00.000Z",
      updatedAt: "2026-03-11T00:11:00.000Z",
    },
  ];
  const agentWebhookSubscriptions: AgentWebhookSubscriptionSecretView[] = [
    {
      subscriptionId: "1",
      agentId: "1",
      actorAddress: "0x0000000000000000000000000000000000000003",
      label: "Primary webhook",
      targetUrl: "https://hooks.example.org/osp",
      eventTypes: ["agent_request.accepted", "work_item.claimable"],
      signingSecret: "ospwhsec_test_1234",
      signingSecretPreview: "ospwhsec_tes...1234",
      status: "active",
      cursorOccurredAt: "2026-03-11T00:11:00.000Z",
      cursorEventId: "agent-request:1:accepted",
      lastEnqueuedAt: "2026-03-11T00:11:05.000Z",
      lastDeliveryAt: "2026-03-11T00:11:10.000Z",
      failureReason: null,
      createdAt: "2026-03-11T00:10:55.000Z",
      updatedAt: "2026-03-11T00:11:10.000Z",
    },
  ];
  const agentWebhookDeliveries: AgentWebhookDeliveryView[] = [
    {
      deliveryId: "1",
      subscriptionId: "1",
      agentId: "1",
      eventId: "agent-request:1:accepted",
      eventType: "agent_request.accepted",
      occurredAt: "2026-03-11T00:11:00.000Z",
      payload: {
        payload: {
          workerId: "artifact-worker-a",
        },
      },
      status: "delivered",
      attempts: 1,
      nextAttemptAt: "2026-03-11T00:11:00.000Z",
      lastAttemptedAt: "2026-03-11T00:11:09.000Z",
      deliveredAt: "2026-03-11T00:11:10.000Z",
      responseStatus: 200,
      responseBody: "ok",
      signature: "v1=deadbeef",
      createdAt: "2026-03-11T00:11:00.000Z",
      updatedAt: "2026-03-11T00:11:10.000Z",
    },
  ];
  const reviewTasks: ReviewTaskView[] = [
    {
      taskId: "1",
      claimId: "1",
      taskType: "artifact_completeness_check",
      scopeKey: "artifact_completeness_check",
      schemaVersion: "review-task.v1",
      status: "completed",
      requestedBy: "demo-review-bootstrap",
      requiredCapabilities: ["artifact-access", "content-integrity"],
      inputArtifactKeys: [],
      consensusPolicy: {
        minSubmissions: 2,
        maxSubmissions: 2,
        requireDistinctAgents: true,
      },
      resultArtifactKey: "review-submission-result-1",
      failureReason: null,
      createdAt: "2026-03-11T00:09:00.000Z",
      updatedAt: "2026-03-11T00:09:20.000Z",
      completedAt: "2026-03-11T00:09:20.000Z",
    },
    {
      taskId: "2",
      claimId: "1",
      taskType: "contradiction_scan",
      scopeKey: "contradiction_scan",
      schemaVersion: "review-task.v1",
      status: "open",
      requestedBy: "demo-review-bootstrap",
      requiredCapabilities: ["literature-scan", "claim-comparison"],
      inputArtifactKeys: [],
      consensusPolicy: {
        minSubmissions: 2,
        maxSubmissions: 2,
        requireDistinctAgents: true,
      },
      resultArtifactKey: null,
      failureReason: null,
      createdAt: "2026-03-11T00:09:30.000Z",
      updatedAt: "2026-03-11T00:09:30.000Z",
      completedAt: null,
    },
  ];
  const reviewTaskRuns: ReviewTaskRunView[] = [
    {
      runId: "1",
      taskId: "1",
      workerId: "review-worker-a",
      agentId: "1",
      status: "completed",
      failureReason: null,
      lastHeartbeatAt: "2026-03-11T00:09:08.000Z",
      startedAt: "2026-03-11T00:09:05.000Z",
      finishedAt: "2026-03-11T00:09:10.000Z",
    },
    {
      runId: "2",
      taskId: "1",
      workerId: "review-worker-b",
      agentId: "2",
      status: "completed",
      failureReason: null,
      lastHeartbeatAt: "2026-03-11T00:09:18.000Z",
      startedAt: "2026-03-11T00:09:12.000Z",
      finishedAt: "2026-03-11T00:09:20.000Z",
    },
  ];
  const reviewSubmissions: ReviewSubmissionView[] = [
    {
      submissionId: "1",
      taskId: "1",
      runId: "1",
      claimId: "1",
      reviewerActor: "0x0000000000000000000000000000000000000003",
      reviewerAgentId: "1",
      reviewType: "artifact_completeness_check",
      verdict: "pass",
      confidenceBps: 8600,
      evidenceArtifactKey: null,
      resultArtifactKey: "review-submission-result-1",
      schemaVersion: "review-task.v1",
      dimensions: {
        artifactCompleteness: 8600,
        artifactIntegrity: 8200,
      },
      payload: {
        summary: "Artifacts are present and sufficiently complete for review.",
      },
      createdAt: "2026-03-11T00:09:10.000Z",
    },
    {
      submissionId: "2",
      taskId: "1",
      runId: "2",
      claimId: "1",
      reviewerActor: "0x0000000000000000000000000000000000000004",
      reviewerAgentId: "2",
      reviewType: "artifact_completeness_check",
      verdict: "pass",
      confidenceBps: 8400,
      evidenceArtifactKey: null,
      resultArtifactKey: "review-submission-result-2",
      schemaVersion: "review-task.v1",
      dimensions: {
        artifactCompleteness: 8400,
        artifactIntegrity: 8100,
        reviewCoverage: 6000,
        reviewDiversity: 7000,
      },
      payload: {
        summary: "A second independent agent corroborated artifact completeness.",
      },
      createdAt: "2026-03-11T00:09:20.000Z",
    },
  ];
  const reviewIssues: ReviewIssueView[] = [
    {
      issueId: "1",
      submissionId: "2",
      severity: "medium",
      category: "execution_readiness",
      summary: "Container digest is not attached to the current claim bundle.",
      artifactAnchor: {
        artifactType: 1,
      },
      status: "open",
      createdAt: "2026-03-11T00:09:21.000Z",
      updatedAt: "2026-03-11T00:09:21.000Z",
    },
  ];
  const reviewResponses: ReviewAuthorResponseView[] = [
    {
      responseId: "1",
      claimId: "1",
      issueIds: ["1"],
      responderActor: "0x0000000000000000000000000000000000000001",
      responseArtifactKey: "review-response-artifact-1",
      summary: "Author notes that a container digest will be attached in the next revision.",
      createdAt: "2026-03-11T00:09:40.000Z",
    },
  ];
  const demoScenarios: DemoScenarioView[] = [
    {
      scenarioKey: "full-claim-object",
      claimId: "1",
      domainId: 1,
      eyebrow: "Benchmark dispute",
      title: "Published model ranking survives a fresh rerun",
      summary:
        "Source evidence, an independent rerun, and an open challenge are tied to the same public claim.",
      detail:
        "The underlying claim is that the published benchmark bundle preserves the reported model ordering when rerun under the declared environment. This case shows how disagreement accumulates around one bounded scientific assertion.",
      whyItMatters:
        "Scientific review stays attached to the claim itself instead of splintering into disconnected papers, comments, and dashboards.",
      proofPoint:
        "Evidence, rerun results, challenges, and review work stay attached to one bounded claim.",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
    {
      scenarioKey: "operational-loop",
      claimId: "2",
      domainId: 1,
      eyebrow: "Computational rerun",
      title: "Independent benchmark rerun updates the claim record",
      summary: "A rerun result is attached to the claim and reflected in the public field record.",
      detail:
        "The underlying claim is that a published benchmark bundle can be rerun in the declared container and scored objectively against the reported output manifest.",
      whyItMatters:
        "The claim only changes scientific status when a typed replication result and settlement are appended to the record.",
      proofPoint:
        "The same claim moves from evidence to rerun result to public checkpoint without changing the atomic object.",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
  ];
  const readModel: ReadModel = {
    metadata: {
      chainId: 31337,
      indexedAt: "2026-03-11T00:03:00.000Z",
      deploymentBlock: 1,
      latestBlock: 45,
    },
    claims: [
      {
        claimId: "1",
        author: "0x0000000000000000000000000000000000000001",
        domainId: 1,
        metadataHash: "0x01",
        resolutionModule: "0x0000000000000000000000000000000000000010",
        status: 1,
        revisionOfClaimId: null,
        createdAtBlock: 2,
      },
    ],
    artifacts: [],
    replications: [
      {
        replicationId: "1",
        claimId: "1",
        replicator: "0x0000000000000000000000000000000000000002",
        agentId: "0",
        resultHash: "0x02",
        outcome: 1,
        resolutionStatus: 1,
        confidenceBps: 9000,
        resolverType: 1,
        resolutionHash: "0x03",
        evidenceHash: "0x04",
        evidenceURI: "ipfs://evidence",
      },
    ],
    checkpoints: [
      {
        checkpointId: "1",
        domainId: 1,
        subjectType: 1,
        subjectActor: "0x0000000000000000000000000000000000000001",
        subjectClaimId: "1",
        subjectAgentId: "0",
        subjectModule: "0x0000000000000000000000000000000000000010",
        scoreVectorHash: "0x05",
        payloadHash: "0x06",
        uri: "ipfs://checkpoint",
      },
    ],
    agents: [
      {
        agentId: "1",
        operator: "0x0000000000000000000000000000000000000003",
        metadataHash: "0x07",
        uri: "ipfs://agent",
        budgetBalance: "100",
        reservedBudget: "0",
        spendLimit: "50",
        active: true,
      },
    ],
    agentControllers: [],
    forecasts: [
      {
        forecastId: "1",
        claimId: "1",
        forecaster: "0x0000000000000000000000000000000000000004",
        agentId: "0",
        commitmentHash: "0x08",
        stakeAmount: "10",
        committedAt: 3,
        revealDeadline: 4,
        revealed: true,
        settled: true,
        direction: 1,
        confidenceBps: 8000,
        effectiveDecisionIdAtCommit: "6",
        resolutionDecisionId: "7",
        finalStatus: 1,
        matched: true,
        payoutAmount: "12",
      },
    ],
    challenges: [
      {
        challengeId: "1",
        claimId: "1",
        replicationId: "1",
        challenger: "0x0000000000000000000000000000000000000005",
        agentId: "0",
        evidenceHash: "0x09",
        evidenceURI: "ipfs://challenge",
        bondAmount: "5",
        status: 1,
        resolutionHash: "0x10",
        createdAt: 5,
        resolvedAt: 6,
        payoutAmount: "2",
        refundedAmount: "0",
      },
    ],
    appeals: [
      {
        appealId: "1",
        claimId: "1",
        replicationId: "1",
        challengeId: "1",
        appellant: "0x0000000000000000000000000000000000000006",
        reason: 1,
        filingHash: "0x11",
        uri: "ipfs://appeal",
        status: 1,
        adjudicationHash: "0x12",
        adjudicationURI: "ipfs://adjudication",
        bondAmount: "5",
        createdAt: 7,
        adjudicatedAt: 8,
        refundedAmount: "0",
      },
    ],
  };
  return {
    getChainHeadBlock: async () => 45,
    listFeaturedDemoScenarios: async () => demoScenarios,
    enqueueArtifactAuditTasks: async () => ({
      createdTaskIds: ["2"],
      requestedAt: "2026-03-11T00:11:16.000Z",
      totalCreated: 1,
    }),
    createDemoArtifactDraft: async (input) => ({
      artifactType: input.artifactType ?? (input.sourceType === "repository" ? 1 : 5),
      artifactIds: {
        extractionArtifactId: "12",
        snapshotArtifactId: "11",
      },
      claimId: "4",
      createdBy: "0x0000000000000000000000000000000000000001",
      extractionArtifact: {
        artifactKey: "claim-draft-extraction-abc123",
        byteLength: 512,
        contentType: "application/json",
        kind: "claim-draft-extraction",
        sha256: "0xaaa111",
        storagePath: "/tmp/claim-draft-extraction.json",
      },
      preview: {
        candidateStatements: [
          "The paper demonstrates that the published benchmark bundle preserves the reported model ordering when rerun in the declared container image.",
        ],
        extractedTextPreview:
          "The paper demonstrates that the published benchmark bundle preserves the reported model ordering when rerun in the declared container image.",
        metadata: '{"sourceType":"url"}',
        methodology: "Automatically extracted from the manuscript snapshot.",
        predictionHooks:
          "auto-ingested artifact draft; requires explicit review before publication",
        scope: "Limited to the assertion and evidence visible in the ingested manuscript snapshot.",
        sourceDescriptor: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
        statement:
          "The paper demonstrates that the published benchmark bundle preserves the reported model ordering when rerun in the declared container image.",
        summary:
          "The ingested artifact reports an objective rerun target that can be checked against a released manifest.",
        title: input.sourceType === "repository" ? "demo-repo" : "Imported manuscript snapshot",
      },
      snapshotArtifact: {
        artifactKey: "artifact-source-snapshot-abc123",
        byteLength: 1024,
        contentType: input.sourceType === "repository" ? "application/gzip" : "application/pdf",
        kind:
          input.sourceType === "repository"
            ? "artifact-repository-snapshot"
            : "artifact-source-snapshot",
        sha256: "0xbbb222",
        storagePath:
          input.sourceType === "repository"
            ? "/tmp/repository-snapshot.tar.gz"
            : "/tmp/manuscript.pdf",
      },
      sourceLocator: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
      sourceType: input.sourceType,
      sourceVersion: {
        commitHash:
          input.sourceType === "repository" ? "1234567890abcdef1234567890abcdef12345678" : null,
        contentType: input.sourceType === "repository" ? "application/gzip" : "application/pdf",
        extension: input.sourceType === "repository" ? "tar.gz" : "pdf",
        finalUrl: input.sourceType === "url" ? input.sourceUrl : null,
        ref: input.sourceType === "repository" ? (input.ref ?? null) : null,
      },
      txHashes: {
        addExtractionArtifact: "0xextract",
        addSnapshotArtifact: "0xsnapshot",
        createClaim: "0xcreate",
      },
    }),
    createDemoClaim: async () => ({
      artifactId: "9",
      claimId: "3",
      createdBy: "0x0000000000000000000000000000000000000001",
      job: null,
      txHashes: {
        addArtifact: "0xartifact",
        createClaim: "0xcreate",
        depositAuthorBond: "0xbond",
        fundClaimRewardPool: "0xbounty",
        publishClaim: "0xpublish",
      },
    }),
    createProductionClaim: async (input, authorAddress) => ({
      artifactId: "29",
      author: authorAddress,
      claimId: "23",
      job: input.openReplicationJob
        ? {
            jobId: "33",
            claimId: "23",
            requestedBy: input.requestedBy ?? "production-submit",
            status: "open",
            onchainReplicationId: null,
            specHash: "0xscope",
            specURI: null,
            requestId: null,
            submissionActor: null,
            submissionTxHash: null,
            submittedAt: null,
            assignedWorker: null,
            assignedAgentId: null,
            assignedAt: null,
            resultArtifactKey: null,
            resultHash: null,
            evidenceHash: null,
            evidenceURI: null,
            failureReason: null,
            createdAt: "2026-03-11T00:05:00.000Z",
            updatedAt: "2026-03-11T00:05:00.000Z",
            completedAt: null,
          }
        : null,
      submittedBy: "0x00000000000000000000000000000000000000aa",
      txHashes: {
        addArtifact: "0xartifact",
        createClaim: "0xcreate",
        publishClaim: "0xpublish",
      },
    }),
    createProductionArtifactDraft: async (input, authorAddress) => ({
      artifactIds: {
        extractionArtifactId: "12",
        snapshotArtifactId: "11",
      },
      claimId: "24",
      createdBy: authorAddress,
      extractionArtifact: {
        artifactKey: "claim-draft-extraction-abc123",
        byteLength: 512,
        contentType: "application/json",
        kind: "claim-draft-extraction",
        sha256: "0xaaa111",
        storagePath: "/tmp/claim-draft-extraction.json",
      },
      preview: {
        candidateStatements: ["Imported draft claim"],
        extractedTextPreview: "Imported draft claim",
        metadata: '{"sourceType":"url"}',
        methodology: "Automatically extracted from the manuscript snapshot.",
        predictionHooks: "production draft import",
        scope: "Limited to the ingested manuscript snapshot.",
        sourceDescriptor: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
        statement: "Imported draft claim",
        summary: "Imported manuscript snapshot",
        title: input.sourceType === "repository" ? "demo-repo" : "Imported manuscript snapshot",
      },
      snapshotArtifact: {
        artifactKey: "artifact-source-snapshot-abc123",
        byteLength: 1024,
        contentType: input.sourceType === "repository" ? "application/gzip" : "application/pdf",
        kind:
          input.sourceType === "repository"
            ? "artifact-repository-snapshot"
            : "artifact-source-snapshot",
        sha256: "0xbbb222",
        storagePath:
          input.sourceType === "repository"
            ? "/tmp/repository-snapshot.tar.gz"
            : "/tmp/manuscript.pdf",
      },
      sourceLocator: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
      sourceType: input.sourceType,
      sourceVersion: {
        commitHash:
          input.sourceType === "repository" ? "1234567890abcdef1234567890abcdef12345678" : null,
        contentType: input.sourceType === "repository" ? "application/gzip" : "application/pdf",
        extension: input.sourceType === "repository" ? "tar.gz" : "pdf",
        finalUrl: input.sourceType === "url" ? input.sourceUrl : null,
        ref: input.sourceType === "repository" ? (input.ref ?? null) : null,
      },
      txHashes: {
        addExtractionArtifact: "0xextract",
        addSnapshotArtifact: "0xsnapshot",
        createClaim: "0xcreate",
      },
    }),
    createArtifactMaintenanceTask: async (_pool, input) => {
      const taskId = String(artifactMaintenanceTasks.length + 1);
      const now = "2026-03-11T00:11:16.000Z";
      const task: ArtifactMaintenanceTaskView = {
        taskId,
        artifactKey: input.artifactKey,
        taskType: input.taskType,
        status: "open",
        requestedBy: input.requestedBy,
        targetReplicaKey: input.targetReplicaKey ?? null,
        targetProvider: input.targetProvider ?? null,
        assignedWorker: null,
        assignedAgentId: null,
        assignedAt: null,
        resultArtifactKey: null,
        failureReason: null,
        repairSourceReplicaKey: null,
        repairLocator: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      artifactMaintenanceTasks.push(task);
      return task;
    },
    claimArtifactMaintenanceTaskById: async (_pool, input) => {
      const task = artifactMaintenanceTasks.find((entry) => entry.taskId === input.taskId);
      if (!task || task.status !== "open") {
        return undefined;
      }
      const assignedAt = "2026-03-11T00:11:20.000Z";
      task.status = "assigned";
      task.assignedAgentId = input.agentId;
      task.assignedWorker = input.workerId;
      task.assignedAt = assignedAt;
      task.updatedAt = assignedAt;
      const run: ArtifactMaintenanceTaskRunView = {
        runId: String(artifactMaintenanceTaskRuns.length + 1),
        taskId: task.taskId,
        workerId: input.workerId,
        agentId: input.agentId,
        status: "running",
        summaryArtifactKey: null,
        failureReason: null,
        lastHeartbeatAt: assignedAt,
        startedAt: assignedAt,
        finishedAt: null,
      };
      artifactMaintenanceTaskRuns.push(run);
      return { run, task };
    },
    claimReplicationJobById: async (_pool, input) => {
      const job = replicationJobs.find((entry) => entry.jobId === input.jobId);
      if (!job || job.status !== "open") {
        return undefined;
      }
      const assignedAt = "2026-03-11T00:04:10.000Z";
      job.status = "assigned";
      job.assignedAgentId = input.agentId ?? null;
      job.assignedWorker = input.workerId;
      job.assignedAt = assignedAt;
      job.updatedAt = assignedAt;
      const run: ReplicationJobRunView = {
        runId: String(replicationJobRuns.length + 1),
        jobId: job.jobId,
        workerId: input.workerId,
        agentId: input.agentId ?? null,
        requestId: null,
        status: "running",
        submissionTxHash: null,
        executionManifestHash: null,
        resultArtifactKey: null,
        resultHash: null,
        evidenceHash: null,
        evidenceURI: null,
        failureReason: null,
        lastHeartbeatAt: assignedAt,
        startedAt: assignedAt,
        finishedAt: null,
      };
      replicationJobRuns.push(run);
      return { job, run };
    },
    heartbeatArtifactMaintenanceTaskRun: async (_pool, input) => {
      const run = artifactMaintenanceTaskRuns.find(
        (entry) => entry.runId === input.runId && entry.taskId === input.taskId,
      );
      if (!run || run.status !== "running") {
        return undefined;
      }
      if (input.agentId && run.agentId !== input.agentId) {
        return undefined;
      }
      if (input.workerId && run.workerId !== input.workerId) {
        return undefined;
      }
      run.lastHeartbeatAt = "2026-03-11T00:11:25.000Z";
      const task = artifactMaintenanceTasks.find((entry) => entry.taskId === input.taskId);
      if (task) {
        task.updatedAt = run.lastHeartbeatAt;
      }
      return run;
    },
    heartbeatReplicationJobRun: async (_pool, input) => {
      const run = replicationJobRuns.find(
        (entry) => entry.runId === input.runId && entry.jobId === input.jobId,
      );
      if (!run || run.status !== "running") {
        return undefined;
      }
      if (input.agentId && run.agentId !== input.agentId) {
        return undefined;
      }
      if (input.workerId && run.workerId !== input.workerId) {
        return undefined;
      }
      run.lastHeartbeatAt = "2026-03-11T00:04:20.000Z";
      const job = replicationJobs.find((entry) => entry.jobId === input.jobId);
      if (job) {
        job.updatedAt = run.lastHeartbeatAt;
      }
      return run;
    },
    completeArtifactMaintenanceTask: async (_pool, input) => {
      const task = artifactMaintenanceTasks.find((entry) => entry.taskId === input.taskId);
      if (!task) {
        throw new Error(`missing maintenance task ${input.taskId}`);
      }
      const completedAt = "2026-03-11T00:11:30.000Z";
      task.status = "completed";
      task.resultArtifactKey = input.resultArtifactKey ?? task.resultArtifactKey;
      task.repairLocator = input.repairLocator ?? task.repairLocator;
      task.repairSourceReplicaKey = input.repairSourceReplicaKey ?? task.repairSourceReplicaKey;
      task.completedAt = completedAt;
      task.updatedAt = completedAt;
      const run = artifactMaintenanceTaskRuns.find((entry) => entry.runId === input.runId);
      if (run) {
        run.status = "completed";
        run.summaryArtifactKey = input.resultArtifactKey ?? run.summaryArtifactKey;
        run.finishedAt = completedAt;
      }
      return task;
    },
    completeReplicationJob: async (_pool, input) => {
      const job = replicationJobs.find((entry) => entry.jobId === input.jobId);
      if (!job) {
        throw new Error(`missing replication job ${input.jobId}`);
      }
      const completedAt = "2026-03-11T00:04:30.000Z";
      job.status = "completed";
      job.requestId = input.requestId ?? job.requestId;
      job.resultArtifactKey = input.resultArtifactKey;
      job.resultHash = input.resultHash;
      job.evidenceHash = input.evidenceHash;
      job.evidenceURI = input.evidenceURI;
      job.onchainReplicationId = input.onchainReplicationId ?? job.onchainReplicationId;
      job.submissionTxHash = input.submissionTxHash ?? job.submissionTxHash;
      job.submissionActor = input.submissionActor ?? job.submissionActor;
      job.submittedAt = completedAt;
      job.completedAt = completedAt;
      job.updatedAt = completedAt;
      const run = replicationJobRuns.find((entry) => entry.runId === input.runId);
      if (run) {
        run.status = "completed";
        run.requestId = input.requestId ?? run.requestId;
        run.executionManifestHash = input.executionManifestHash;
        run.resultArtifactKey = input.resultArtifactKey;
        run.resultHash = input.resultHash;
        run.evidenceHash = input.evidenceHash;
        run.evidenceURI = input.evidenceURI;
        run.submissionTxHash = input.submissionTxHash ?? run.submissionTxHash;
        run.finishedAt = completedAt;
      }
      return job;
    },
    claimReviewTaskById: async (_pool, input) => {
      const task = reviewTasks.find((entry) => entry.taskId === input.taskId);
      if (!task || task.status !== "open") {
        return undefined;
      }
      const completedSubmissions = reviewSubmissions.filter(
        (submission) => submission.taskId === task.taskId,
      ).length;
      const runningRuns = reviewTaskRuns.filter(
        (run) => run.taskId === task.taskId && run.status === "running",
      ).length;
      if (completedSubmissions + runningRuns >= task.consensusPolicy.maxSubmissions) {
        return undefined;
      }
      if (
        input.agentId &&
        task.consensusPolicy.requireDistinctAgents &&
        reviewSubmissions.some(
          (submission) =>
            submission.taskId === task.taskId && submission.reviewerAgentId === input.agentId,
        )
      ) {
        return undefined;
      }
      const startedAt = "2026-03-11T00:11:20.000Z";
      const run: ReviewTaskRunView = {
        runId: String(reviewTaskRuns.length + 1),
        taskId: task.taskId,
        workerId: input.workerId,
        agentId: input.agentId ?? null,
        status: "running",
        failureReason: null,
        lastHeartbeatAt: startedAt,
        startedAt,
        finishedAt: null,
      };
      reviewTaskRuns.push(run);
      task.updatedAt = startedAt;
      return { run, task };
    },
    heartbeatReviewTaskRun: async (_pool, input) => {
      const run = reviewTaskRuns.find(
        (entry) => entry.runId === input.runId && entry.taskId === input.taskId,
      );
      if (!run || run.status !== "running") {
        return undefined;
      }
      if (input.agentId && run.agentId !== input.agentId) {
        return undefined;
      }
      if (input.workerId && run.workerId !== input.workerId) {
        return undefined;
      }
      run.lastHeartbeatAt = "2026-03-11T00:11:25.000Z";
      const task = reviewTasks.find((entry) => entry.taskId === input.taskId);
      if (task) {
        task.updatedAt = run.lastHeartbeatAt;
      }
      return run;
    },
    createReviewAuthorResponse: async (_pool, input) => {
      const response: ReviewAuthorResponseView = {
        responseId: String(reviewResponses.length + 1),
        claimId: input.claimId,
        issueIds: input.issueIds,
        responderActor: input.responderActor.toLowerCase(),
        responseArtifactKey: input.responseArtifactKey,
        summary: input.summary,
        createdAt: "2026-03-11T00:11:50.000Z",
      };
      reviewResponses.unshift(response);
      return response;
    },
    createReviewTask: async (_pool, input) => {
      const existing = reviewTasks.find(
        (task) =>
          task.claimId === input.claimId &&
          task.taskType === input.taskType &&
          task.scopeKey === (input.scopeKey ?? input.taskType) &&
          task.status === "open",
      );
      if (existing) {
        return existing;
      }
      const task: ReviewTaskView = {
        taskId: String(reviewTasks.length + 1),
        claimId: input.claimId,
        taskType: input.taskType,
        scopeKey: input.scopeKey ?? input.taskType,
        schemaVersion: input.schemaVersion ?? "review-task.v1",
        status: "open",
        requestedBy: input.requestedBy,
        requiredCapabilities: input.requiredCapabilities ?? [],
        inputArtifactKeys: input.inputArtifactKeys ?? [],
        consensusPolicy: {
          minSubmissions: input.consensusPolicy?.minSubmissions ?? 1,
          maxSubmissions: input.consensusPolicy?.maxSubmissions ?? 1,
          requireDistinctAgents: input.consensusPolicy?.requireDistinctAgents ?? false,
        },
        resultArtifactKey: null,
        failureReason: null,
        createdAt: "2026-03-11T00:11:45.000Z",
        updatedAt: "2026-03-11T00:11:45.000Z",
        completedAt: null,
      };
      reviewTasks.unshift(task);
      return task;
    },
    failReplicationJob: async (_pool, input) => {
      const job = replicationJobs.find((entry) => entry.jobId === input.jobId);
      if (!job) {
        throw new Error(`missing replication job ${input.jobId}`);
      }
      const failedAt = "2026-03-11T00:04:30.000Z";
      job.status = "failed";
      job.requestId = input.requestId ?? job.requestId;
      job.failureReason = input.failureReason;
      job.updatedAt = failedAt;
      const run = replicationJobRuns.find((entry) => entry.runId === input.runId);
      if (run) {
        run.status = "failed";
        run.requestId = input.requestId ?? run.requestId;
        run.failureReason = input.failureReason;
        run.finishedAt = failedAt;
      }
      return job;
    },
    insertAgentRequest: async (_pool, input) => {
      const request: AgentRequestView = {
        requestId: String(agentRequests.length + 1),
        actionType: input.actionType,
        agentId: input.agentId,
        actorAddress: input.actorAddress.toLowerCase(),
        requestNonce: input.requestNonce,
        scopeKey: input.scopeKey,
        requestHash: input.requestHash,
        signature: input.signature,
        payload: input.payload,
        status: input.status,
        outcomeDetail: input.outcomeDetail ?? null,
        createdAt: "2026-03-11T00:11:40.000Z",
        updatedAt: "2026-03-11T00:11:40.000Z",
      };
      agentRequests.push(request);
      return request;
    },
    insertPublicWriteRequest: async (_pool, input) => {
      const request: PublicWriteRequestView = {
        requestId: "91",
        actionType: input.actionType,
        actorAddress: input.actorAddress.toLowerCase(),
        chainId: input.chainId,
        requestNonce: input.requestNonce,
        scopeKey: input.scopeKey,
        requestHash: input.requestHash,
        signature: input.signature,
        payload: input.payload,
        status: input.status,
        outcomeDetail: input.outcomeDetail ?? null,
        createdAt: "2026-03-11T00:11:40.000Z",
        updatedAt: "2026-03-11T00:11:40.000Z",
      };
      publicWriteRequests.set(request.requestHash, request);
      return request;
    },
    readPublicWriteRequestByHash: async (_pool, requestHash) =>
      publicWriteRequests.get(requestHash),
    reservePublicWriteRequestExecution: async () => true,
    renewPublicWriteRequestExecution: async () => true,
    assertPublicWriteRequestExecution: async () => {},
    releasePublicWriteRequestExecution: async () => {},
    markPublicWriteRequestAccepted: async (_pool, requestId, outcomeDetail) => {
      const existing = [...publicWriteRequests.values()].find(
        (request) => request.requestId === requestId,
      );
      const updated: PublicWriteRequestView = {
        ...(existing ?? {
          requestId,
          actionType: "claim_create",
          actorAddress: "0x0000000000000000000000000000000000000001",
          chainId: 31337,
          requestNonce: "nonce-1",
          scopeKey: "claim:1",
          requestHash: "0xwritehash",
          signature: "0xsigned",
          payload: {},
          createdAt: "2026-03-11T00:11:40.000Z",
        }),
        status: "accepted",
        outcomeDetail: outcomeDetail ?? null,
        updatedAt: "2026-03-11T00:11:41.000Z",
      };
      publicWriteRequests.set(updated.requestHash, updated);
      return updated;
    },
    markPublicWriteRequestPending: async (_pool, requestId, outcomeDetail) => {
      const existing = [...publicWriteRequests.values()].find(
        (request) => request.requestId === requestId,
      );
      if (!existing) throw new Error("public_write_request_not_found_after_pending_update");
      if (existing.status === "accepted") return existing;
      const updated = { ...existing, status: "pending" as const, outcomeDetail };
      publicWriteRequests.set(updated.requestHash, updated);
      return updated;
    },
    markPublicWriteRequestRejected: async (_pool, requestId, outcomeDetail) => {
      const existing = [...publicWriteRequests.values()].find(
        (request) => request.requestId === requestId,
      );
      if (!existing) throw new Error("public_write_request_not_found_after_reject");
      if (existing.status === "accepted") return existing;
      const updated = { ...existing, status: "rejected" as const, outcomeDetail };
      publicWriteRequests.set(updated.requestHash, updated);
      return updated;
    },
    createAgentWebhookSubscription: async (_pool, input) => {
      const subscription: AgentWebhookSubscriptionSecretView = {
        subscriptionId: String(agentWebhookSubscriptions.length + 1),
        agentId: input.agentId,
        actorAddress: input.actorAddress.toLowerCase(),
        label: input.label ?? null,
        targetUrl: input.targetUrl,
        eventTypes: input.eventTypes ?? ["agent_request.accepted", "work_item.claimable"],
        signingSecret: input.signingSecret ?? "ospwhsec_generated",
        signingSecretPreview: "ospwhsec_gen...ated",
        status: "active",
        cursorOccurredAt: null,
        cursorEventId: null,
        lastEnqueuedAt: null,
        lastDeliveryAt: null,
        failureReason: null,
        createdAt: "2026-04-08T12:00:00.000Z",
        updatedAt: "2026-04-08T12:00:00.000Z",
      };
      agentWebhookSubscriptions.unshift(subscription);
      return subscription;
    },
    deactivateAgentWebhookSubscription: async (_pool, subscriptionId) => {
      const subscription = agentWebhookSubscriptions.find(
        (entry) => entry.subscriptionId === subscriptionId,
      );
      if (!subscription) {
        return undefined;
      }
      subscription.status = "inactive";
      subscription.updatedAt = "2026-04-08T12:05:00.000Z";
      const { signingSecret: _signingSecret, ...view } = subscription;
      return view;
    },
    enqueueAgentWebhookPingDelivery: async (_pool, subscription) => {
      const delivery: AgentWebhookDeliveryView = {
        deliveryId: String(agentWebhookDeliveries.length + 1),
        subscriptionId: subscription.subscriptionId,
        agentId: subscription.agentId,
        eventId: `webhook-ping:${subscription.subscriptionId}`,
        eventType: "webhook.ping",
        occurredAt: "2026-04-08T12:06:00.000Z",
        payload: {
          message: "Webhook ping requested.",
          subscriptionId: subscription.subscriptionId,
        },
        status: "pending",
        attempts: 0,
        nextAttemptAt: "2026-04-08T12:06:00.000Z",
        lastAttemptedAt: null,
        deliveredAt: null,
        responseStatus: null,
        responseBody: null,
        signature: null,
        createdAt: "2026-04-08T12:06:00.000Z",
        updatedAt: "2026-04-08T12:06:00.000Z",
      };
      agentWebhookDeliveries.unshift(delivery);
      return delivery;
    },
    submitPersistedReplicationResult: async (_input) => ({
      onchainReplicationId: "2",
      operatorRequestArtifactKey: "operator-request-artifact-2",
      operatorRequestId: "4",
      submissionActor: "0x0000000000000000000000000000000000000007",
      submissionTxHash: "0xfeed",
    }),
    recordPersistedArtifactAudit: async (_pool, artifactKey, audit) => {
      persistedArtifactAudits.unshift({
        auditId: String(persistedArtifactAudits.length + 1),
        artifactKey,
        replicaKey: audit.replicaKey,
        provider: audit.provider,
        locator: audit.locator,
        checkKind: audit.checkKind,
        status: audit.status,
        detail: audit.detail ?? null,
        observedSha256: audit.observedSha256 ?? null,
        checkedAt: audit.checkedAt ?? "2026-03-11T00:11:41.000Z",
      });
    },
    upsertPersistedArtifact: async (_pool, artifact) => {
      const index = persistedArtifacts.findIndex(
        (entry) => entry.artifactKey === artifact.artifactKey,
      );
      if (index >= 0) {
        persistedArtifacts[index] = artifact;
        return;
      }
      persistedArtifacts.push(artifact);
    },
    upsertPersistedArtifactReplica: async (_pool, artifactKey, replica) => {
      if (artifactKey !== "replication-result-abc123") {
        return;
      }
      const nextReplica: PersistedArtifactReplicaView = {
        replicaKey: replica.replicaKey,
        provider: replica.provider,
        locator: replica.locator,
        isPrimary: replica.isPrimary,
        providerMetadata: replica.providerMetadata ?? null,
        createdAt: "2026-03-11T00:11:42.000Z",
        updatedAt: "2026-03-11T00:11:42.000Z",
        lastCheckedAt: null,
        lastCheckStatus: null,
        lastCheckError: null,
      };
      const index = persistedArtifactReplicas.findIndex(
        (entry) => entry.replicaKey === replica.replicaKey,
      );
      if (index >= 0) {
        const existingReplica = persistedArtifactReplicas[index];
        if (!existingReplica) {
          throw new Error("missing persisted artifact replica");
        }
        persistedArtifactReplicas[index] = {
          ...existingReplica,
          ...nextReplica,
          createdAt: existingReplica.createdAt,
        };
        return;
      }
      persistedArtifactReplicas.push(nextReplica);
    },
    openDefaultReviewTasksForClaim: async (_pool, input) => {
      const created = [
        "artifact_integrity_check",
        "artifact_completeness_check",
        "replication_readiness_check",
      ].map((taskType, index) => ({
        taskId: String(reviewTasks.length + index + 1),
        claimId: input.claimId,
        taskType: taskType as ReviewTaskView["taskType"],
        scopeKey: taskType,
        schemaVersion: "review-task.v1",
        status: "open" as const,
        requestedBy: input.requestedBy,
        requiredCapabilities: [],
        inputArtifactKeys: [],
        consensusPolicy: {
          minSubmissions: 2,
          maxSubmissions: 2,
          requireDistinctAgents: true,
        },
        resultArtifactKey: null,
        failureReason: null,
        createdAt: "2026-03-11T00:12:00.000Z",
        updatedAt: "2026-03-11T00:12:00.000Z",
        completedAt: null,
      }));
      reviewTasks.unshift(...created);
      return created;
    },
    readClaims: async () => readModel.claims,
    readArtifactMaintenanceTask: async (_pool, taskId) =>
      artifactMaintenanceTasks.find((task) => task.taskId === taskId),
    readArtifactMaintenanceTaskRuns: async (_pool, taskId) =>
      artifactMaintenanceTaskRuns.filter((run) => run.taskId === taskId),
    readArtifactMaintenanceTasksPage: async (_pool, options) => {
      const filtered = artifactMaintenanceTasks.filter(
        (task) =>
          (options.artifactKey === undefined ? true : task.artifactKey === options.artifactKey) &&
          (options.assignedAgentId === undefined
            ? true
            : task.assignedAgentId === options.assignedAgentId) &&
          (options.status === undefined ? true : task.status === options.status) &&
          (options.targetReplicaKey === undefined
            ? true
            : task.targetReplicaKey === options.targetReplicaKey) &&
          (options.taskType === undefined ? true : task.taskType === options.taskType),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readClaim: async (_pool, claimId) =>
      readModel.claims.find((claim) => claim.claimId === claimId),
    readClaimRewardPools: async (claimId) =>
      claimId === "1"
        ? [
            { balanceWei: "50000000000000000", workKind: "review" as const },
            { balanceWei: "120000000000000000", workKind: "replication" as const },
            { balanceWei: "6000000000000000", workKind: "maintenance" as const },
            { balanceWei: "0", workKind: "challenge" as const },
            { balanceWei: "4000000000000000", workKind: "synthesis" as const },
            { balanceWei: "3000000000000000", workKind: "forecast" as const },
          ]
        : [],
    readClaimReplicationJobsPage: async (_pool, claimId, options) => ({
      items: replicationJobs.filter((job) => job.claimId === claimId),
      total: replicationJobs.filter((job) => job.claimId === claimId).length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readClaimsPage: async (_pool, options) => ({
      items: readModel.claims.slice(
        options.offset ?? 0,
        (options.offset ?? 0) + (options.limit ?? 20),
      ),
      total: readModel.claims.length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readDomainLeaderboard: async (_pool, domainId, options) => ({
      items: leaderboardEntries.filter((entry) => entry.domainId === domainId),
      total: leaderboardEntries.filter((entry) => entry.domainId === domainId).length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readAgents: async () => readModel.agents,
    readAgentsPage: async (_pool, options) => ({
      items: readModel.agents.filter((agent) =>
        options.active === undefined ? true : agent.active === options.active,
      ),
      total:
        options.active === undefined
          ? readModel.agents.length
          : readModel.agents.filter((agent) => agent.active === options.active).length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readAgent: async (_pool, agentId) =>
      readModel.agents.find((agent) => agent.agentId === agentId),
    readAgentRequest: async (_pool, requestId) =>
      agentRequests.find((request) => request.requestId === requestId),
    readAgentRequestsPage: async (_pool, options) => {
      const filtered = agentRequests.filter(
        (request) =>
          (options.actionType === undefined ? true : request.actionType === options.actionType) &&
          (options.agentId === undefined ? true : request.agentId === options.agentId) &&
          (options.scopeKey === undefined ? true : request.scopeKey === options.scopeKey) &&
          (options.status === undefined ? true : request.status === options.status),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readAgentWebhookSubscription: async (_pool, subscriptionId) => {
      const subscription = agentWebhookSubscriptions.find(
        (entry) => entry.subscriptionId === subscriptionId,
      );
      if (!subscription) {
        return undefined;
      }
      const { signingSecret: _signingSecret, ...view } = subscription;
      return view;
    },
    readAgentWebhookSubscriptionSecret: async (_pool, subscriptionId) =>
      agentWebhookSubscriptions.find((entry) => entry.subscriptionId === subscriptionId),
    readAgentWebhookSubscriptionsPage: async (_pool, options) => {
      const filtered = agentWebhookSubscriptions.filter(
        (subscription) =>
          (options.agentId === undefined ? true : subscription.agentId === options.agentId) &&
          (options.status === undefined ? true : subscription.status === options.status),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit).map((subscription) => {
          const { signingSecret: _signingSecret, ...view } = subscription;
          return view;
        }),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readAgentWebhookDelivery: async (_pool, deliveryId) =>
      agentWebhookDeliveries.find((delivery) => delivery.deliveryId === deliveryId),
    readAgentWebhookDeliveriesPage: async (_pool, options) => {
      const filtered = agentWebhookDeliveries.filter(
        (delivery) =>
          (options.agentId === undefined ? true : delivery.agentId === options.agentId) &&
          (options.status === undefined ? true : delivery.status === options.status) &&
          (options.subscriptionId === undefined
            ? true
            : delivery.subscriptionId === options.subscriptionId),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readAgentControllersPage: async (_pool, options) => ({
      items: readModel.agentControllers.filter((controller) =>
        options.agentId === undefined ? true : controller.agentId === options.agentId,
      ),
      total: readModel.agentControllers.length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readAgentControllers: async (_pool, agentId) =>
      readModel.agentControllers.filter((controller) => controller.agentId === agentId),
    readArtifactsPage: async (_pool, options) => {
      const filtered = readModel.artifacts.filter((artifact) =>
        options.claimId !== undefined
          ? artifact.claimId === options.claimId
          : options.claimIds
            ? options.claimIds.includes(artifact.claimId)
            : true,
      );
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readArtifactsByClaim: async (_pool, claimId) =>
      readModel.artifacts.filter((artifact) => artifact.claimId === claimId),
    readMetadata: async () => ({
      chainId: 31337,
      indexedAt: "2026-03-11T00:00:00.000Z",
      deploymentBlock: 1,
      latestBlock: 42,
    }),
    readOperatorRequest: async (_pool, requestId) =>
      operatorRequests.find((request) => request.requestId === requestId),
    readOperatorRequestsPage: async (_pool, options) => {
      const filtered = operatorRequests.filter(
        (request) =>
          (options.actionType === undefined ? true : request.actionType === options.actionType) &&
          (options.operatorAddress === undefined
            ? true
            : request.operatorAddress.toLowerCase() === options.operatorAddress.toLowerCase()) &&
          (options.scopeKey === undefined ? true : request.scopeKey === options.scopeKey) &&
          (options.status === undefined ? true : request.status === options.status),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readReadModelCounts: async () => ({
      claims: 1,
      artifacts: 0,
      replications: 1,
      checkpoints: 1,
      agents: 1,
      agentControllers: 0,
      forecasts: 1,
      challenges: 1,
      appeals: 1,
    }),
    readReviewAuthorResponsesPage: async (_pool, options) => {
      const filtered = reviewResponses.filter((response) =>
        options.claimId === undefined ? true : response.claimId === options.claimId,
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readReviewIssuesPage: async (_pool, options) => {
      const filtered = reviewIssues.filter((issue) => {
        const submission = reviewSubmissions.find(
          (entry) => entry.submissionId === issue.submissionId,
        );
        return (
          (options.claimId === undefined ? true : submission?.claimId === options.claimId) &&
          (options.taskId === undefined ? true : submission?.taskId === options.taskId) &&
          (options.severity === undefined ? true : issue.severity === options.severity) &&
          (options.status === undefined ? true : issue.status === options.status)
        );
      });
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readReviewSubmission: async (_pool, submissionId) =>
      reviewSubmissions.find((submission) => submission.submissionId === submissionId),
    readReviewSubmissionsPage: async (_pool, options) => {
      const filtered = reviewSubmissions.filter(
        (submission) =>
          (options.claimId === undefined ? true : submission.claimId === options.claimId) &&
          (options.sourceId === undefined ? true : submission.sourceId === options.sourceId) &&
          (options.taskId === undefined ? true : submission.taskId === options.taskId) &&
          (options.reviewerAgentId === undefined
            ? true
            : submission.reviewerAgentId === options.reviewerAgentId) &&
          (options.verdict === undefined ? true : submission.verdict === options.verdict),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readReviewTask: async (_pool, taskId) => reviewTasks.find((task) => task.taskId === taskId),
    readReviewTaskRuns: async (_pool, taskId) =>
      reviewTaskRuns.filter((run) => run.taskId === taskId),
    readReviewTasksPage: async (_pool, options) => {
      const filtered = reviewTasks.filter(
        (task) =>
          (options.claimId === undefined ? true : task.claimId === options.claimId) &&
          (options.sourceId === undefined ? true : task.sourceId === options.sourceId) &&
          (options.status === undefined ? true : task.status === options.status) &&
          (options.taskType === undefined ? true : task.taskType === options.taskType),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readSyncCursor: async () => 41,
    readWorkRewardSettlementsPage: async (_pool, options) => {
      const filtered = rewardSettlements.filter(
        (settlement) =>
          (options.agentId === undefined ? true : settlement.agentId === options.agentId) &&
          (options.claimId === undefined ? true : settlement.claimId === options.claimId) &&
          (options.itemId === undefined ? true : settlement.itemId === options.itemId) &&
          (options.policyVersion === undefined
            ? true
            : settlement.policyVersion === options.policyVersion) &&
          (options.recipient === undefined ? true : settlement.recipient === options.recipient) &&
          (options.workKind === undefined ? true : settlement.workKind === options.workKind),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readWorkRewardSettlementTotals: async (_pool, options) => {
      const filtered = rewardSettlements.filter(
        (settlement) =>
          (options.agentId === undefined ? true : settlement.agentId === options.agentId) &&
          (options.claimId === undefined ? true : settlement.claimId === options.claimId) &&
          (options.itemId === undefined ? true : settlement.itemId === options.itemId) &&
          (options.policyVersion === undefined
            ? true
            : settlement.policyVersion === options.policyVersion) &&
          (options.recipient === undefined ? true : settlement.recipient === options.recipient) &&
          (options.workKind === undefined ? true : settlement.workKind === options.workKind),
      );
      const grouped = new Map<
        string,
        {
          amountWei: bigint;
          settlementCount: number;
          workKind: string;
        }
      >();
      for (const settlement of filtered) {
        const current = grouped.get(settlement.workKind) ?? {
          amountWei: 0n,
          settlementCount: 0,
          workKind: settlement.workKind,
        };
        current.amountWei += BigInt(settlement.amountWei);
        current.settlementCount += 1;
        grouped.set(settlement.workKind, current);
      }
      return {
        byWorkKind: Array.from(grouped.values()).map((entry) => ({
          amountWei: entry.amountWei.toString(),
          settlementCount: entry.settlementCount,
          workKind: entry.workKind as
            | "challenge"
            | "forecast"
            | "maintenance"
            | "replication"
            | "review"
            | "synthesis",
        })),
        settlementCount: filtered.length,
        totalAmountWei: filtered
          .reduce((sum, settlement) => sum + BigInt(settlement.amountWei), 0n)
          .toString(),
      };
    },
    readPersistedArtifact: async (_pool, artifactKey) =>
      persistedArtifacts.find((artifact) => artifact.artifactKey === artifactKey),
    readPersistedArtifactAuditsPage: async (_pool, input) => ({
      items: persistedArtifactAudits.filter((audit) => audit.artifactKey === input.artifactKey),
      total: persistedArtifactAudits.filter((audit) => audit.artifactKey === input.artifactKey)
        .length,
      limit: input.limit ?? 20,
      offset: input.offset ?? 0,
    }),
    readPersistedArtifactMaintenanceTasksPage: async (_pool, artifactKey, options) => {
      const filtered = artifactMaintenanceTasks.filter(
        (task) =>
          task.artifactKey === artifactKey &&
          (options.assignedAgentId === undefined
            ? true
            : task.assignedAgentId === options.assignedAgentId) &&
          (options.status === undefined ? true : task.status === options.status) &&
          (options.targetReplicaKey === undefined
            ? true
            : task.targetReplicaKey === options.targetReplicaKey) &&
          (options.taskType === undefined ? true : task.taskType === options.taskType),
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readPersistedArtifactProvenance: async (_pool, artifactKey) =>
      artifactKey === persistedArtifactProvenance.artifactKey
        ? persistedArtifactProvenance
        : undefined,
    readPersistedArtifactReplicas: async (_pool, artifactKey) =>
      artifactKey === "replication-result-abc123" ? persistedArtifactReplicas : [],
    readPersistedArtifactStorageAttestations: async (_pool, artifactKey) =>
      artifactKey === "replication-result-abc123" ? persistedArtifactStorageAttestations : [],
    readPersistedArtifactStoragePolicy: async (_pool, artifactKey) =>
      artifactKey === persistedArtifactStoragePolicy.artifactKey
        ? persistedArtifactStoragePolicy
        : undefined,
    readRecipientAccruedRewardBalance: async (recipient) =>
      recipient.toLowerCase() === "0x0000000000000000000000000000000000000003"
        ? "20000000000000000"
        : "0",
    readReplicationJob: async (_pool, jobId) => replicationJobs.find((job) => job.jobId === jobId),
    readReplicationJobsPage: async (_pool, options) => ({
      items: replicationJobs.filter((job) =>
        options.claimId === undefined ? true : job.claimId === options.claimId,
      ),
      total: replicationJobs.filter((job) =>
        options.claimId === undefined ? true : job.claimId === options.claimId,
      ).length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readReplicationJobRuns: async (_pool, jobId) =>
      replicationJobRuns.filter((run) => run.jobId === jobId),
    recordReviewSubmission: async (_pool, input) => {
      const submission: ReviewSubmissionView = {
        submissionId: String(reviewSubmissions.length + 1),
        taskId: input.taskId,
        runId: input.runId ?? null,
        claimId: input.claimId ?? "1",
        reviewerActor: input.reviewerActor.toLowerCase(),
        reviewerAgentId: input.reviewerAgentId ?? null,
        reviewType: input.reviewType ?? "artifact_completeness_check",
        verdict: input.verdict,
        confidenceBps: input.confidenceBps,
        evidenceArtifactKey: input.evidenceArtifactKey ?? null,
        resultArtifactKey: input.resultArtifactKey ?? null,
        schemaVersion: input.schemaVersion ?? "review-task.v1",
        dimensions: input.dimensions,
        payload: input.payload ?? {},
        createdAt: "2026-03-11T00:11:55.000Z",
      };
      reviewSubmissions.unshift(submission);
      for (const issue of input.issues ?? []) {
        reviewIssues.unshift({
          issueId: String(reviewIssues.length + 1),
          submissionId: submission.submissionId,
          severity: issue.severity,
          category: issue.category,
          summary: issue.summary,
          artifactAnchor: issue.artifactAnchor ?? {},
          status: issue.status ?? "open",
          createdAt: "2026-03-11T00:11:55.000Z",
          updatedAt: "2026-03-11T00:11:55.000Z",
        });
      }
      const task = reviewTasks.find((entry) => entry.taskId === input.taskId);
      if (!task) {
        throw new Error("review_task_not_found");
      }
      if (
        reviewSubmissions.filter((entry) => entry.taskId === task.taskId).length >=
        task.consensusPolicy.minSubmissions
      ) {
        task.status = "completed";
        task.resultArtifactKey = input.resultArtifactKey ?? task.resultArtifactKey;
        task.completedAt = "2026-03-11T00:11:56.000Z";
        task.updatedAt = "2026-03-11T00:11:56.000Z";
      }
      const run = reviewTaskRuns.find((entry) => entry.runId === input.runId);
      if (run) {
        run.status = "completed";
        run.finishedAt = "2026-03-11T00:11:56.000Z";
      }
      return { submission, task };
    },
    readResolutionRun: async (_pool, runId) => resolutionRuns.find((run) => run.runId === runId),
    readResolutionRunsPage: async (_pool, options) => ({
      items: resolutionRuns.filter(
        (run) =>
          (options.jobId === undefined ? true : run.jobId === options.jobId) &&
          (options.claimId === undefined ? true : run.claimId === options.claimId) &&
          (options.replicationId === undefined
            ? true
            : run.replicationId === options.replicationId) &&
          (options.resolver === undefined
            ? true
            : run.resolver.toLowerCase() === options.resolver.toLowerCase()) &&
          (options.status === undefined ? true : run.status === options.status),
      ),
      total: resolutionRuns.length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readCheckpointPublication: async (_pool, publicationId) =>
      checkpointPublications.find((publication) => publication.publicationId === publicationId),
    readCheckpointPublicationsPage: async (_pool, options) => ({
      items: checkpointPublications.filter(
        (publication) =>
          (options.domainId === undefined ? true : publication.domainId === options.domainId) &&
          (options.payloadId === undefined ? true : publication.payloadId === options.payloadId) &&
          (options.status === undefined ? true : publication.status === options.status) &&
          (options.subjectType === undefined
            ? true
            : publication.subjectType === options.subjectType) &&
          (options.subjectActor === undefined
            ? true
            : publication.subjectActor.toLowerCase() === options.subjectActor.toLowerCase()) &&
          (options.subjectAgentId === undefined
            ? true
            : publication.subjectAgentId === options.subjectAgentId),
      ),
      total: checkpointPublications.length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readIndexerRuntimeStatus: async () => ({
      name: "read_model",
      status: "idle",
      lastStartedAt: "2026-03-11T00:01:00.000Z",
      lastFinishedAt: "2026-03-11T00:02:00.000Z",
      lastSuccessAt: "2026-03-11T00:02:00.000Z",
      lastErrorAt: null,
      lastErrorMessage: null,
      updatedAt: "2026-03-11T00:02:00.000Z",
    }),
    readLatestReputationPayload: async (_pool, domainId) =>
      reputationPayloads.find((payload) => payload.domainId === domainId),
    readGovernanceOverview: async () => governanceOverview,
    readGovernanceEvents: async (options) => {
      const filtered = governanceEvents.filter((event) =>
        options?.proposalId ? event.proposalId === options.proposalId : true,
      );
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        limit,
        offset,
        total: filtered.length,
      };
    },
    readGovernanceTreasury: async () => governanceTreasury,
    readGovernanceProposalDetail: async (proposalId, options) => {
      const detail = governanceProposalDetails.get(proposalId);
      if (!detail) {
        return null;
      }
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? detail.votesCast.limit;
      return {
        ...detail,
        votesCast: {
          ...detail.votesCast,
          items: detail.votesCast.items.slice(offset, offset + limit),
          limit,
          offset,
        },
      };
    },
    readGovernanceProposals: async (options) => {
      const filtered = governanceProposalSummaries.filter((proposal) =>
        options?.state ? proposal.state === options.state : true,
      );
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 20;
      return {
        items: filtered.slice(offset, offset + limit),
        limit,
        offset,
        total: filtered.length,
      };
    },
    readForecastsPage: async (_pool, options) => ({
      items: readModel.forecasts.filter(
        (forecast) =>
          (options.claimId === undefined ? true : forecast.claimId === options.claimId) &&
          (options.settled === undefined ? true : forecast.settled === options.settled),
      ),
      total: readModel.forecasts.filter((forecast) =>
        options.claimId === undefined ? true : forecast.claimId === options.claimId,
      ).length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readForecastsByClaim: async (_pool, claimId) =>
      readModel.forecasts.filter((forecast) => forecast.claimId === claimId),
    readChallengesPage: async (_pool, options) => ({
      items: readModel.challenges.filter(
        (challenge) =>
          (options.claimId === undefined ? true : challenge.claimId === options.claimId) &&
          (options.status === undefined ? true : challenge.status === options.status),
      ),
      total: readModel.challenges.filter((challenge) =>
        options.claimId === undefined ? true : challenge.claimId === options.claimId,
      ).length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readChallengesByClaim: async (_pool, claimId) =>
      readModel.challenges.filter((challenge) => challenge.claimId === claimId),
    readAppealsPage: async (_pool, options) => ({
      items: readModel.appeals.filter(
        (appeal) =>
          (options.claimId === undefined ? true : appeal.claimId === options.claimId) &&
          (options.status === undefined ? true : appeal.status === options.status),
      ),
      total: readModel.appeals.filter((appeal) =>
        options.claimId === undefined ? true : appeal.claimId === options.claimId,
      ).length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readAppealsByClaim: async (_pool, claimId) =>
      readModel.appeals.filter((appeal) => appeal.claimId === claimId),
    readReplicationsPage: async (_pool, options) => {
      const filtered = readModel.replications.filter((replication) =>
        options.claimId !== undefined
          ? replication.claimId === options.claimId
          : options.claimIds
            ? options.claimIds.includes(replication.claimId)
            : true,
      );
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      return {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      };
    },
    readReplicationsByClaim: async (_pool, claimId) =>
      readModel.replications.filter((replication) => replication.claimId === claimId),
    readCheckpointsPage: async (_pool, options) => ({
      items: readModel.checkpoints.filter((checkpoint) =>
        options.claimId === undefined ? true : checkpoint.subjectClaimId === options.claimId,
      ),
      total: readModel.checkpoints.length,
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    }),
    readCheckpointsByClaim: async (_pool, claimId) =>
      readModel.checkpoints.filter((checkpoint) => checkpoint.subjectClaimId === claimId),
    reseedOperationalDemoScenario: async () => ({
      claim: {
        artifactId: "99",
        claimId: "3",
        createdBy: "0x0000000000000000000000000000000000000001",
        job: null,
        txHashes: {
          addArtifact: "0xartifact",
          createClaim: "0xcreate",
          depositAuthorBond: "0xbond",
          fundClaimRewardPool: "0xbounty",
          publishClaim: "0xpublish",
        },
      },
      scenario: {
        scenarioKey: "operational-loop",
        claimId: "3",
        domainId: 1,
        eyebrow: "Computational rerun",
        title: "Independent benchmark rerun updates the claim record",
        summary:
          "A rerun result is attached to the claim and reflected in the public field record.",
        detail:
          "The underlying claim is that a published benchmark bundle can be rerun in the declared container and scored objectively against the reported output manifest.",
        whyItMatters:
          "The claim only changes scientific status when a typed replication result and settlement are appended to the record.",
        proofPoint:
          "The same claim moves from evidence to rerun result to public checkpoint without changing the atomic object.",
        updatedAt: "2026-03-12T00:03:00.000Z",
      },
    }),
    resetSandboxDemo: async () => ({
      resetAt: "2026-03-12T00:04:00.000Z",
      finishedAt: "2026-03-12T00:04:30.000Z",
    }),
    syncReadModel: async () => ({
      metadata: readModel.metadata,
      counts: {
        claims: readModel.claims.length,
        artifacts: readModel.artifacts.length,
        replications: readModel.replications.length,
        checkpoints: readModel.checkpoints.length,
        agents: readModel.agents.length,
        agentControllers: readModel.agentControllers.length,
        forecasts: readModel.forecasts.length,
        challenges: readModel.challenges.length,
        appeals: readModel.appeals.length,
      },
    }),
    ...overrides,
  };
}

async function startServer(
  dependencies: Partial<ApiDependencies> = {},
  options: {
    deploymentPath?: string;
    env?: NodeJS.ProcessEnv;
    pool?: Pool | null;
    rateLimitConfig?: PartialApiRateLimitConfig;
    useDefaultDependencies?: boolean;
  } = {},
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  server: Server;
}> {
  const instance: ApiServerInstance = await createApiServer({
    pool: options.pool === null ? undefined : (options.pool ?? ({} as Pool)),
    runMigrations: false,
    dependencies: options.useDefaultDependencies
      ? undefined
      : createDependencyOverrides(dependencies),
    databaseUrl: "postgresql://test@127.0.0.1:5432/scientific_protocol_test",
    deploymentPath: options.deploymentPath ?? TEST_DEPLOYMENT_PATH,
    env:
      options.env === undefined
        ? { ...process.env, SP_SERVICE_MODE: "write-enabled" }
        : { SP_SERVICE_MODE: "write-enabled", ...options.env },
    rateLimitConfig: options.rateLimitConfig,
  });

  await new Promise<void>((resolve, reject) => {
    instance.server.listen(0, "127.0.0.1", () => resolve());
    instance.server.once("error", reject);
  });

  const address = instance.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: instance.close,
    server: instance.server,
  };
}

async function buildSignedAgentRequestBody(
  wallet: Wallet,
  envelope: AgentRequestEnvelope,
): Promise<{
  envelope: AgentRequestEnvelope;
  signature: string;
}> {
  const requestHash = hashAgentRequestEnvelope(envelope);
  const signature = await wallet.signMessage(getBytes(requestHash));
  return { envelope, signature };
}

async function buildSignedPublicWriteBody(
  wallet: Wallet,
  envelope: PublicWriteEnvelope,
): Promise<{
  envelope: PublicWriteEnvelope;
  signature: string;
}> {
  const requestHash = hashPublicWriteEnvelope(envelope);
  const signature = await wallet.signMessage(getBytes(requestHash));
  return { envelope, signature };
}

function localOperatorWallet(accountIndex: number): Wallet {
  return HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
    undefined,
    `m/44'/60'/0'/0/${accountIndex}`,
  );
}

describe("ApiServer", () => {
  it("exposes liveness provenance without database, RPC, or signer access", async () => {
    const server = await startServer(
      {},
      {
        env: {
          SP_SERVICE_BUILD_DATE: "2026-07-12T00:00:00Z",
          SP_SERVICE_MODE: "read-only",
          SP_SERVICE_REVISION: "abc123",
          SP_SERVICE_VERSION: "0.3.0",
        },
      },
    );
    try {
      const response = await fetch(`${server.baseUrl}/livez`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        service: {
          mode: "read-only",
          provenance: {
            buildDate: "2026-07-12T00:00:00Z",
            imageRevision: "abc123",
            version: "0.3.0",
          },
          writesEnabled: false,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("reports migration-aware readiness without disclosing database errors", async () => {
    const readyPool = {
      query: async () => ({ rows: [{ schema_migrations: "schema_migrations" }] }),
    } as unknown as Pool;
    const ready = await startServer({}, { pool: readyPool });
    try {
      const response = await fetch(`${ready.baseUrl}/readyz`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        readModel: "available",
        serviceMode: "write-enabled",
      });
    } finally {
      await ready.close();
    }

    const unavailablePool = {
      query: async () => {
        throw new Error("private database hostname");
      },
    } as unknown as Pool;
    const unavailable = await startServer({}, { pool: unavailablePool });
    try {
      const response = await fetch(`${unavailable.baseUrl}/readyz`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "read_model_unavailable",
        ok: false,
      });
    } finally {
      await unavailable.close();
    }
  });

  it("fails safe to a read-only gateway mode", async () => {
    const server = await startServer({}, { env: { SP_SERVICE_MODE: "read-only" } });
    try {
      const response = await fetch(`${server.baseUrl}/sources`, { method: "POST" });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
      assert.deepEqual(await response.json(), {
        error: "service_read_only",
        serviceMode: "read-only",
      });

      const syncResponse = await fetch(`${server.baseUrl}/admin/sync`);
      assert.equal(syncResponse.status, 405);
    } finally {
      await server.close();
    }
  });

  it("rejects unknown service modes during server creation", async () => {
    await assert.rejects(
      createApiServer({
        env: { SP_SERVICE_MODE: "unsafe" },
        pool: {} as Pool,
        runMigrations: false,
      }),
      /SP_SERVICE_MODE must be one of: read-only, write-enabled/,
    );
  });

  it("rejects invalid rate-limit boolean env values during server creation", async () => {
    await assert.rejects(
      startServer({}, { env: { SP_TRUST_PROXY: "sometimes" } }),
      /SP_TRUST_PROXY must be true or false/,
    );
  });

  it("rejects invalid numeric rate-limit env values during server creation", async () => {
    await assert.rejects(
      startServer({}, { env: { SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS: "-1" } }),
      /SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS must be an integer greater than or equal to 0/,
    );
  });

  it("sets explicit HTTP server timeouts", async () => {
    const { close, server } = await startServer();

    try {
      expect(server.requestTimeout).to.equal(30_000);
      expect(server.headersTimeout).to.equal(10_000);
      expect(server.keepAliveTimeout).to.equal(5_000);
    } finally {
      await close();
    }
  });

  it("returns JSON 404 for product page routes outside the protocol API", async () => {
    const { baseUrl, close } = await startServer();

    try {
      for (const route of [
        "/",
        "/dashboard",
        "/explore",
        "/submit",
        "/protocol",
        "/static/app.css",
        "/claims/1/view",
      ]) {
        const response = await fetch(`${baseUrl}${route}`);
        expect(response.status).to.equal(404);
        expect(response.headers.get("content-type")).to.contain("application/json");
        expect(await response.json()).to.deep.equal({ error: "not_found" });
      }
    } finally {
      await close();
    }
  });

  it("returns runtime sync state from /health and /admin/status", async () => {
    const runtimeStatus = {
      name: "read_model",
      status: "failed",
      lastStartedAt: "2026-03-11T00:01:00.000Z",
      lastFinishedAt: "2026-03-11T00:02:00.000Z",
      lastSuccessAt: "2026-03-11T00:00:30.000Z",
      lastErrorAt: "2026-03-11T00:02:00.000Z",
      lastErrorMessage: "chainId mismatch",
      updatedAt: "2026-03-11T00:02:00.000Z",
    };
    const { baseUrl, close } = await startServer({
      readIndexerRuntimeStatus: async () => runtimeStatus,
    });

    try {
      const [healthResponse, statusResponse] = await Promise.all([
        fetch(`${baseUrl}/health`),
        fetch(`${baseUrl}/admin/status`),
      ]);

      expect(healthResponse.status).to.equal(200);
      expect(statusResponse.status).to.equal(200);

      const healthPayload = await healthResponse.json();
      const statusPayload = await statusResponse.json();
      const expectedCounts = {
        claims: 1,
        artifacts: 0,
        replications: 1,
        checkpoints: 1,
        agents: 1,
        agentControllers: 0,
        forecasts: 1,
        challenges: 1,
        appeals: 1,
      };
      const expectedSync = {
        blocksRemaining: 4,
        chainHeadBlock: 45,
        cursorBlock: 41,
        indexer: runtimeStatus,
        lagBlocks: 3,
        rpcError: null,
        rpcReachable: true,
        syncedToHead: false,
      };

      expect(healthPayload.ok).to.equal(true);
      expect(healthPayload.counts).to.deep.equal(expectedCounts);
      expect(healthPayload.sync).to.deep.equal(expectedSync);
      expect(healthPayload.chainId).to.equal(31337);
      expect(healthPayload.databaseUrl).to.equal(undefined);
      expect(statusPayload.counts).to.deep.equal(expectedCounts);
      expect(statusPayload.sync).to.deep.equal(expectedSync);
      expect(statusPayload.metadata.latestBlock).to.equal(42);
    } finally {
      await close();
    }
  });

  it("reports RPC degradation in sync status without failing health endpoints", async () => {
    const { baseUrl, close } = await startServer({
      getChainHeadBlock: async () => {
        throw new Error("rpc unavailable");
      },
    });

    try {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.sync.blocksRemaining).to.equal(null);
      expect(payload.sync.chainHeadBlock).to.equal(null);
      expect(payload.sync.cursorBlock).to.equal(41);
      expect(payload.sync.lagBlocks).to.equal(null);
      expect(payload.sync.rpcReachable).to.equal(false);
      expect(payload.sync.rpcError).to.equal("rpc unavailable");
      expect(payload.sync.syncedToHead).to.equal(null);
    } finally {
      await close();
    }
  });

  it("serves read-model-optional protocol API health without a read-model database", async () => {
    let readMetadataCalled = false;
    const { baseUrl, close } = await startServer(
      {
        readMetadata: async () => {
          readMetadataCalled = true;
          throw new Error("read-model should not be used");
        },
      },
      {
        env: {
          ...process.env,
          SP_API_MODE: "read-model-optional",
        },
        pool: null,
      },
    );

    try {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.api).to.deep.equal({
        mode: "read-model-optional",
        readModel: "disabled",
      });
      expect(payload.readModel).to.deep.equal({
        configured: false,
        status: "unavailable",
      });
      expect(payload.chainId).to.equal(31337);
      expect(payload.deploymentBlock).to.equal(56);
      expect(payload.latestBlock).to.equal(45);
      expect(payload.sync).to.deep.equal({
        blocksRemaining: null,
        chainHeadBlock: 45,
        cursorBlock: null,
        lagBlocks: null,
        rpcError: null,
        rpcReachable: true,
        syncedToHead: null,
      });
      expect(readMetadataCalled).to.equal(false);
    } finally {
      await close();
    }
  });

  it("returns explicit 503s for read-model APIs in read-model-optional API mode", async () => {
    const { baseUrl, close } = await startServer(
      {},
      {
        env: {
          ...process.env,
          SP_API_MODE: "read-model-optional",
        },
        pool: null,
        useDefaultDependencies: true,
      },
    );

    try {
      const response = await fetch(`${baseUrl}/claims`);
      expect(response.status).to.equal(503);

      const payload = await response.json();
      expect(payload).to.deep.equal({
        error: "read_model_unavailable",
        message: "This protocol API is running without a configured read-model database.",
      });
    } finally {
      await close();
    }
  });

  it("rejects unauthenticated POST /admin/sync", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/admin/sync`, { method: "POST" });
      expect(response.status).to.equal(405);
      expect(response.headers.get("allow")).to.equal("GET");
      expect(await response.json()).to.deep.equal({ error: "method_not_allowed" });
    } finally {
      await close();
    }
  });

  it("returns governance overview, activity, treasury state, proposal list, and proposal detail", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const [
        overviewResponse,
        eventsResponse,
        treasuryResponse,
        proposalsResponse,
        detailResponse,
      ] = await Promise.all([
        fetch(`${baseUrl}/governance`),
        fetch(`${baseUrl}/governance/events?proposalId=101&limit=2`),
        fetch(`${baseUrl}/governance/treasury?limit=2`),
        fetch(`${baseUrl}/governance/proposals?state=Queued&limit=10`),
        fetch(`${baseUrl}/governance/proposals/101?limit=1`),
      ]);

      expect(overviewResponse.status).to.equal(200);
      expect(eventsResponse.status).to.equal(200);
      expect(treasuryResponse.status).to.equal(200);
      expect(proposalsResponse.status).to.equal(200);
      expect(detailResponse.status).to.equal(200);

      const overviewPayload = await overviewResponse.json();
      expect(overviewPayload).to.include.keys(
        "governorAddress",
        "governorName",
        "proposalThreshold",
        "quorumNumerator",
        "treasuryBalanceWei",
      );

      const eventsPayload = await eventsResponse.json();
      expect(eventsPayload.items).to.have.length(2);
      expect(eventsPayload.items[0]).to.include.keys(
        "eventType",
        "proposalId",
        "proposalTitle",
        "summary",
      );
      expect(eventsPayload.total).to.equal(3);

      const treasuryPayload = await treasuryResponse.json();
      expect(treasuryPayload).to.include.keys(
        "claimRewardVaultAddress",
        "claimRewardVaultBalanceWei",
        "rewardBudgetByWorkKind",
        "recentTreasuryEvents",
        "recentRewardSettlements",
      );
      expect(treasuryPayload.rewardBudgetByWorkKind).to.have.length(2);
      expect(treasuryPayload.recentTreasuryEvents.items).to.have.length(2);
      expect(treasuryPayload.recentRewardSettlements.items).to.have.length(1);

      const proposalsPayload = await proposalsResponse.json();
      expect(proposalsPayload.items).to.have.length(1);
      expect(proposalsPayload.items[0]).to.include.keys(
        "proposalId",
        "title",
        "state",
        "votes",
        "quorumVotes",
      );

      const detailPayload = await detailResponse.json();
      expect(detailPayload.proposalId).to.equal("101");
      expect(detailPayload.actions).to.have.length(2);
      expect(detailPayload.votesCast.items).to.have.length(1);
      expect(detailPayload.votesCast.total).to.equal(2);
    } finally {
      await close();
    }
  });

  it("returns the featured demo scenarios for reference deployments", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/demo/scenarios`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.items).to.have.length(2);
      expect(payload.items[0].scenarioKey).to.equal("full-claim-object");
      expect(payload.items[0].claim.claimId).to.equal("1");
      expect(payload.items[1].scenarioKey).to.equal("operational-loop");
    } finally {
      await close();
    }
  });

  it("disables sandbox admin routes when the sandbox flag is off", async () => {
    const { baseUrl, close } = await startServer({}, { env: {} });

    try {
      const statusResponse = await fetch(`${baseUrl}/demo/admin/status`);
      expect(statusResponse.status).to.equal(404);
      expect(await statusResponse.json()).to.deep.equal({
        error: "sandbox_admin_routes_disabled",
      });

      const reseedResponse = await fetch(`${baseUrl}/demo/admin/reseed-operational`, {
        method: "POST",
      });
      expect(reseedResponse.status).to.equal(404);
      expect(await reseedResponse.json()).to.deep.equal({
        error: "sandbox_admin_routes_disabled",
      });

      const resetResponse = await fetch(`${baseUrl}/demo/admin/reset-demo`, {
        method: "POST",
      });
      expect(resetResponse.status).to.equal(404);
      expect(await resetResponse.json()).to.deep.equal({
        error: "sandbox_admin_routes_disabled",
      });
    } finally {
      await close();
    }
  });

  it("guards the demo admin status route behind the configured admin token", async () => {
    const { baseUrl, close } = await startServer(
      {},
      {
        env: {
          SP_DEMO_ADMIN_TOKEN: "demo-secret",
          SP_ENABLE_SANDBOX_ADMIN_ROUTES: "true",
        },
      },
    );

    try {
      const unauthorized = await fetch(`${baseUrl}/demo/admin/status`);
      expect(unauthorized.status).to.equal(401);
      expect(await unauthorized.json()).to.deep.equal({ error: "demo_admin_unauthorized" });

      const authorized = await fetch(`${baseUrl}/demo/admin/status`, {
        headers: { "x-sp-demo-admin-token": "demo-secret" },
      });
      expect(authorized.status).to.equal(200);

      const payload = await authorized.json();
      expect(payload.ok).to.equal(true);
      expect(payload.tokenConfigured).to.equal(true);
      expect(payload.scenarios).to.have.length(2);
    } finally {
      await close();
    }
  });

  it("reseeds the operational scenario through the demo admin route", async () => {
    const reseededScenario = {
      scenarioKey: "operational-loop",
      claimId: "3",
      domainId: 1,
      eyebrow: "Computational rerun",
      title: "Independent benchmark rerun updates the claim record",
      summary: "A rerun result is attached to the claim and reflected in the public field record.",
      detail:
        "The underlying claim is that a published benchmark bundle can be rerun in the declared container and scored objectively against the reported output manifest.",
      whyItMatters:
        "The claim only changes scientific status when a typed replication result and settlement are appended to the record.",
      proofPoint:
        "The same claim moves from evidence to rerun result to public checkpoint without changing the atomic object.",
      updatedAt: "2026-03-12T00:03:00.000Z",
    };

    const { baseUrl, close } = await startServer(
      {
        listFeaturedDemoScenarios: async () => [
          {
            scenarioKey: "full-claim-object",
            claimId: "1",
            domainId: 1,
            eyebrow: "Benchmark dispute",
            title: "Published model ranking survives a fresh rerun",
            summary:
              "Source evidence, an independent rerun, and an open challenge are tied to the same public claim.",
            detail:
              "The underlying claim is that the published benchmark bundle preserves the reported model ordering when rerun under the declared environment. This case shows how disagreement accumulates around one bounded scientific assertion.",
            whyItMatters:
              "Scientific review stays attached to the claim itself instead of splintering into disconnected papers, comments, and dashboards.",
            proofPoint:
              "Evidence, rerun results, challenges, and review work stay attached to one bounded claim.",
            updatedAt: "2026-03-12T00:00:00.000Z",
          },
          reseededScenario,
        ],
        reseedOperationalDemoScenario: async () => ({
          claim: {
            artifactId: "99",
            claimId: "3",
            createdBy: "0x0000000000000000000000000000000000000001",
            job: null,
            txHashes: {
              addArtifact: "0xartifact",
              createClaim: "0xcreate",
              depositAuthorBond: "0xbond",
              fundClaimRewardPool: "0xbounty",
              publishClaim: "0xpublish",
            },
          },
          scenario: reseededScenario,
        }),
      },
      {
        env: {
          SP_DEMO_ADMIN_TOKEN: "demo-secret",
          SP_ENABLE_SANDBOX_ADMIN_ROUTES: "true",
        },
      },
    );

    try {
      const response = await fetch(`${baseUrl}/demo/admin/reseed-operational`, {
        method: "POST",
        headers: { "x-sp-demo-admin-token": "demo-secret" },
      });
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.scenario.claimId).to.equal("3");
      expect(payload.synced.latestBlock).to.equal(45);
    } finally {
      await close();
    }
  });

  it("resets the sandbox demo through the demo admin route", async () => {
    const { baseUrl, close } = await startServer(
      {
        resetSandboxDemo: async () => ({
          resetAt: "2026-03-12T00:04:00.000Z",
          finishedAt: "2026-03-12T00:04:30.000Z",
        }),
      },
      {
        env: {
          SP_DEMO_ADMIN_TOKEN: "demo-secret",
          SP_ENABLE_SANDBOX_ADMIN_ROUTES: "true",
        },
      },
    );

    try {
      const response = await fetch(`${baseUrl}/demo/admin/reset-demo`, {
        method: "POST",
        headers: { "x-sp-demo-admin-token": "demo-secret" },
      });
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.resetAt).to.equal("2026-03-12T00:04:00.000Z");
      expect(payload.result.finishedAt).to.equal("2026-03-12T00:04:30.000Z");
      expect(payload.scenarios).to.have.length(2);
      expect(payload.synced.latestBlock).to.equal(45);
    } finally {
      await close();
    }
  });

  it("maps sync lock contention to HTTP 409", async () => {
    const { baseUrl, close } = await startServer(
      {
        syncReadModel: async () => {
          throw new ReadModelSyncInProgressError();
        },
      },
      { env: { CRON_SECRET: "cron-test-secret" } },
    );

    try {
      const response = await fetch(`${baseUrl}/admin/sync`, {
        headers: { authorization: "Bearer cron-test-secret" },
      });
      expect(response.status).to.equal(409);
      expect(await response.json()).to.deep.equal({ error: "sync_in_progress" });
    } finally {
      await close();
    }
  });

  it("gates cron GET /admin/sync behind CRON_SECRET", async () => {
    const { baseUrl, close } = await startServer({}, { env: { CRON_SECRET: "cron-test-secret" } });

    try {
      const missing = await fetch(`${baseUrl}/admin/sync`);
      expect(missing.status).to.equal(401);

      const wrong = await fetch(`${baseUrl}/admin/sync`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(wrong.status).to.equal(401);

      const authorized = await fetch(`${baseUrl}/admin/sync`, {
        headers: { authorization: "Bearer cron-test-secret" },
      });
      expect(authorized.status).to.equal(200);
      const body = (await authorized.json()) as { ok: boolean };
      expect(body.ok).to.equal(true);
    } finally {
      await close();
    }
  });

  it("rejects cron GET /admin/sync when no CRON_SECRET is configured", async () => {
    const { baseUrl, close } = await startServer({}, { env: {} });

    try {
      const response = await fetch(`${baseUrl}/admin/sync`, {
        headers: { authorization: "Bearer anything" },
      });
      expect(response.status).to.equal(401);
    } finally {
      await close();
    }
  });

  it("maps sandbox reset contention to HTTP 409", async () => {
    const { baseUrl, close } = await startServer(
      {
        resetSandboxDemo: async () => {
          throw new SandboxDemoResetInProgressError();
        },
      },
      {
        env: {
          SP_DEMO_ADMIN_TOKEN: "demo-secret",
          SP_ENABLE_SANDBOX_ADMIN_ROUTES: "true",
        },
      },
    );

    try {
      const response = await fetch(`${baseUrl}/demo/admin/reset-demo`, {
        method: "POST",
        headers: { "x-sp-demo-admin-token": "demo-secret" },
      });
      expect(response.status).to.equal(409);
      expect(await response.json()).to.deep.equal({
        error: "sandbox_demo_reset_in_progress",
      });
    } finally {
      await close();
    }
  });

  it("creates demo claims and syncs the read model", async () => {
    let receivedInput: Record<string, unknown> | null = null;
    const { baseUrl, close } = await startServer({
      createDemoClaim: async (input) => {
        receivedInput = input as unknown as Record<string, unknown>;
        return {
          artifactId: "9",
          claimId: "3",
          createdBy: "0x0000000000000000000000000000000000000001",
          job: null,
          txHashes: {
            addArtifact: "0xartifact",
            createClaim: "0xcreate",
            depositAuthorBond: "0xbond",
            fundClaimRewardPool: "0xbounty",
            publishClaim: "0xpublish",
          },
        };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/demo/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statement: "A new claim",
          artifactUri: "ipfs://artifact",
          domainId: 4,
          openReplicationJob: true,
          requestedBy: "dashboard-user",
        }),
      });
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(receivedInput).to.include({
        statement: "A new claim",
        artifactUri: "ipfs://artifact",
        domainId: 4,
        openReplicationJob: true,
        requestedBy: "dashboard-user",
      });
      expect(payload.ok).to.equal(true);
      expect(payload.result.claimId).to.equal("3");
      expect(payload.synced.latestBlock).to.equal(45);
    } finally {
      await close();
    }
  });

  it("creates source records from ingested artifacts through the demo route", async () => {
    let receivedInput: Record<string, unknown> | null = null;
    const { baseUrl, close } = await startServer({
      createDemoArtifactDraft: async (input) => {
        receivedInput = input as unknown as Record<string, unknown>;
        return {
          artifactType: 5,
          extractionArtifact: {
            artifactKey: "claim-draft-extraction-abc123",
            byteLength: 512,
            contentType: "application/json",
            kind: "claim-draft-extraction",
            sha256: "0xaaa111",
            storagePath: "/tmp/claim-draft-extraction.json",
          },
          preview: {
            candidateStatements: ["The paper demonstrates a rerun claim."],
            extractedTextPreview: "The paper demonstrates a rerun claim.",
            metadata: '{"sourceType":"url"}',
            methodology: "Automatically extracted from the manuscript snapshot.",
            predictionHooks:
              "auto-ingested artifact draft; requires explicit review before publication",
            scope:
              "Limited to the assertion and evidence visible in the ingested manuscript snapshot.",
            sourceDescriptor: "https://example.com/paper.pdf",
            statement: "The paper demonstrates a rerun claim.",
            summary: "Imported manuscript snapshot.",
            title: "Imported manuscript snapshot",
          },
          snapshotArtifact: {
            artifactKey: "artifact-source-snapshot-abc123",
            byteLength: 1024,
            contentType: "application/pdf",
            kind: "artifact-source-snapshot",
            sha256: "0xbbb222",
            storagePath: "/tmp/manuscript.pdf",
          },
          sourceLocator: "https://example.com/paper.pdf",
          source: {
            canonicalSourceKey: "url:https://example.com/paper.pdf",
            createdAt: "2026-04-16T12:00:00.000Z",
            discoveryMode: "user_submitted",
            extractionArtifactKey: "claim-draft-extraction-abc123",
            publishedClaimId: null,
            snapshotArtifactKey: "artifact-source-snapshot-abc123",
            sourceId: "4",
            sourceMetadata: {
              locator: "https://example.com/paper.pdf",
              title: "Imported manuscript snapshot",
            },
            sourceType: "url",
            status: "extracting",
            submittedByActor: null,
            submittedByAgentId: null,
            updatedAt: "2026-04-16T12:00:00.000Z",
          },
          sourceType: "url",
          sourceVersion: {
            commitHash: null,
            contentType: "application/pdf",
            extension: "pdf",
            finalUrl: "https://example.com/paper.pdf",
            ref: null,
          },
        };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/demo/claim-drafts/from-artifact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: "url",
          sourceUrl: "https://example.com/paper.pdf",
          domainId: 4,
        }),
      });
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(receivedInput).to.deep.include({
        sourceType: "url",
        sourceUrl: "https://example.com/paper.pdf",
        domainId: 4,
      });
      expect(payload.ok).to.equal(true);
      expect(payload.result.source.sourceId).to.equal("4");
      expect(payload.result.preview.statement).to.equal("The paper demonstrates a rerun claim.");
    } finally {
      await close();
    }
  });

  it("returns write protocol config for production wallet and API flows", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/write-config`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.chainId).to.equal(31337);
      expect(payload.accessControllerAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(payload.artifactRegistryAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(payload.claimRegistryAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(payload.bondEscrowAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(payload.authorBondWei).to.equal("5000000000000000");
      expect(payload.minimumAuthorBondWei).to.equal(payload.authorBondWei);
      expect(payload.claimRewardVaultAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(payload.operatorLifecycleAuth.canonicalMode).to.equal("wallet_signature");
      expect(payload.operatorLifecycleAuth.resolverRole).to.equal("RESOLVER_ROLE");
      expect(payload.operatorLifecycleAuth.checkpointPublisherRole).to.equal(
        "CHECKPOINT_PUBLISHER_ROLE",
      );
      expect(payload.operatorLifecycleAuth.bearerTokenFallbackEnabled).to.equal(false);
      expect(payload.operatorLifecycleAuth.replicationSubmitterAuthorizedAddresses).to.be.an(
        "array",
      );
    } finally {
      await close();
    }
  });

  it("serves non-local write protocol configs without requiring operator secrets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sp-api-deployment-"));
    const deploymentPath = path.join(directory, "base-sepolia.deployment.json");
    try {
      const deployment = JSON.parse(await readFile(TEST_DEPLOYMENT_PATH, "utf8")) as {
        chainId: number;
        network: string;
      };
      deployment.chainId = 84532;
      deployment.network = "base-sepolia";
      await writeFile(deploymentPath, JSON.stringify(deployment), "utf8");

      const localRpcServer = await startServer(
        {},
        {
          deploymentPath,
          env: {
            SP_RPC_URL: "http://127.0.0.1:8545",
          },
        },
      );
      try {
        const response = await fetch(`${localRpcServer.baseUrl}/write-config`);
        expect(response.status).to.equal(200);
        const payload = await response.json();
        expect(payload.chainId).to.equal(84532);
        expect(payload.network).to.equal("base-sepolia");
        expect(payload.rpcUrl).to.equal(undefined);
      } finally {
        await localRpcServer.close();
      }

      const { baseUrl, close } = await startServer(
        {},
        {
          deploymentPath,
          env: {
            SP_PUBLIC_RPC_URL: "https://base-sepolia.example.invalid",
            SP_RPC_URL: "https://base-sepolia.example.invalid",
          },
        },
      );
      try {
        const response = await fetch(`${baseUrl}/write-config`);
        expect(response.status).to.equal(200);
        const payload = await response.json();
        expect(payload.chainId).to.equal(84532);
        expect(payload.network).to.equal("base-sepolia");
        expect(payload.rpcUrl).to.equal("https://base-sepolia.example.invalid");
        expect(payload.operatorLifecycleAuth.replicationSubmitterAuthorizedAddresses).to.deep.equal(
          [],
        );
      } finally {
        await close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("allows configured public preview origins to read write-config", async () => {
    const { baseUrl, close } = await startServer(
      {},
      {
        env: {
          SP_PUBLIC_CORS_ORIGINS: "https://protocol-preview.example.org",
        },
      },
    );

    try {
      const response = await fetch(`${baseUrl}/write-config`, {
        headers: {
          origin: "https://protocol-preview.example.org",
        },
      });
      expect(response.status).to.equal(200);
      expect(response.headers.get("access-control-allow-origin")).to.equal(
        "https://protocol-preview.example.org",
      );
      expect(response.headers.get("vary")).to.include("Origin");

      const preflight = await fetch(`${baseUrl}/write-config`, {
        headers: {
          "access-control-request-method": "GET",
          origin: "https://protocol-preview.example.org",
        },
        method: "OPTIONS",
      });
      expect(preflight.status).to.equal(204);
      expect(preflight.headers.get("access-control-allow-origin")).to.equal(
        "https://protocol-preview.example.org",
      );
      expect(preflight.headers.get("access-control-allow-methods")).to.include("GET");
    } finally {
      await close();
    }
  });

  it("does not expose public CORS headers to unconfigured origins", async () => {
    const { baseUrl, close } = await startServer(
      {},
      {
        env: {
          SP_PUBLIC_CORS_ORIGINS: "https://protocol-preview.example.org",
        },
      },
    );

    try {
      const response = await fetch(`${baseUrl}/write-config`, {
        headers: {
          origin: "https://attacker.example",
        },
      });
      expect(response.status).to.equal(200);
      expect(response.headers.get("access-control-allow-origin")).to.equal(null);
    } finally {
      await close();
    }
  });

  it("serves open CORS on the public read surface", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const read = await fetch(`${baseUrl}/feeds/claims?limit=1`, {
        headers: { origin: "https://any-reader.example" },
      });
      expect(read.headers.get("access-control-allow-origin")).to.equal("*");

      const preflight = await fetch(`${baseUrl}/feeds/claims`, {
        method: "OPTIONS",
        headers: {
          origin: "https://any-reader.example",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.status).to.equal(204);
      expect(preflight.headers.get("access-control-allow-origin")).to.equal("*");
    } finally {
      await close();
    }
  });

  it("keeps admin and agent surfaces out of open CORS", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const admin = await fetch(`${baseUrl}/admin/status`, {
        headers: { origin: "https://any-reader.example" },
      });
      expect(admin.headers.get("access-control-allow-origin")).to.equal(null);
    } finally {
      await close();
    }
  });

  it("creates production claims through signed public write requests", async () => {
    let receivedInput: Record<string, unknown> | null = null;
    let receivedAuthor = "";
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      createProductionClaim: async (input, authorAddress) => {
        receivedInput = input as unknown as Record<string, unknown>;
        receivedAuthor = authorAddress;
        return {
          artifactId: "29",
          author: authorAddress,
          claimId: "23",
          job: null,
          publicationStatus: "awaiting_author_bond" as const,
          submittedBy: "0x00000000000000000000000000000000000000aa",
          txHashes: {
            addArtifact: "0xartifact",
            createClaim: "0xcreate",
          },
        };
      },
    });

    try {
      const writeConfig = await fetch(`${baseUrl}/write-config`).then((response) =>
        response.json(),
      );
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "claim_create",
        actorAddress: wallet.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: {
          statement: "A production claim",
          artifactUri: "ipfs://artifact",
          domainId: 4,
          openReplicationJob: true,
          requestedBy: "submit-page",
        },
        requestNonce: "claim-create-1",
        scopeKey: `submit:${wallet.address.toLowerCase()}`,
      });

      const response = await fetch(`${baseUrl}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(receivedAuthor).to.equal(wallet.address);
      expect(receivedInput).to.deep.include({
        statement: "A production claim",
        artifactUri: "ipfs://artifact",
        domainId: 4,
        openReplicationJob: true,
        requestedBy: "submit-page",
      });
      expect(payload.ok).to.equal(true);
      expect(payload.requestId).to.equal("91");
      expect(payload.result.claimId).to.equal("23");
    } finally {
      await close();
    }
  });

  it("publishes a bonded draft through a second signed author request", async () => {
    const wallet = Wallet.createRandom();
    let received: { authorAddress: string; claimId: string } | null = null;
    const { baseUrl, close } = await startServer({
      publishProductionClaim: async (claimId, authorAddress) => {
        received = { authorAddress, claimId };
        return {
          claimId,
          publicationStatus: "published",
          publishClaimTxHash: "0xpublish",
          reconciled: false,
        };
      },
    });
    try {
      const writeConfig = await fetch(`${baseUrl}/write-config`).then((response) =>
        response.json(),
      );
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "claim_publish",
        actorAddress: wallet.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: {},
        requestNonce: "claim-publish-23",
        scopeKey: "claim:23",
      });
      const response = await fetch(`${baseUrl}/claims/23/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });
      expect(response.status).to.equal(200);
      expect(received).to.deep.equal({ authorAddress: wallet.address, claimId: "23" });
      expect((await response.json()).result.publicationStatus).to.equal("published");
    } finally {
      await close();
    }
  });

  it("reconciles an exact publication replay after the chain write outlives request acceptance", async () => {
    const wallet = Wallet.createRandom();
    let publishCalls = 0;
    let acceptanceCalls = 0;
    const { baseUrl, close } = await startServer({
      publishProductionClaim: async (claimId) => {
        publishCalls += 1;
        return {
          claimId,
          publicationStatus: "published",
          publishClaimTxHash: publishCalls === 1 ? "0xpublish" : null,
          reconciled: publishCalls > 1,
        };
      },
      markPublicWriteRequestAccepted: async (_pool, requestId, outcomeDetail) => {
        acceptanceCalls += 1;
        if (acceptanceCalls === 1) throw new Error("fault_after_chain_publish");
        return {
          requestId,
          actionType: "claim_publish",
          actorAddress: wallet.address.toLowerCase(),
          chainId: 31337,
          requestNonce: "claim-publish-replay",
          scopeKey: "claim:23",
          requestHash: "0xrequest",
          signature: "0xsigned",
          payload: {},
          status: "accepted",
          outcomeDetail: outcomeDetail ?? null,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:01.000Z",
        };
      },
    });
    try {
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "claim_publish",
        actorAddress: wallet.address,
        chainId: 31337,
        issuedAt: new Date().toISOString(),
        payload: {},
        requestNonce: "claim-publish-replay",
        scopeKey: "claim:23",
      });
      const publish = () =>
        fetch(`${baseUrl}/claims/23/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        });
      expect((await publish()).status).to.equal(500);
      const replay = await publish();
      expect(replay.status).to.equal(200);
      const payload = await replay.json();
      expect(payload.result).to.include({ publicationStatus: "published", reconciled: true });
      expect(payload.result.publishClaimTxHash).to.equal(null);
      expect(publishCalls).to.equal(2);
      expect(acceptanceCalls).to.equal(2);
    } finally {
      await close();
    }
  });

  it("serializes concurrent exact publication replays under one execution lease", async () => {
    const wallet = Wallet.createRandom();
    let leaseHeld = false;
    let publishCalls = 0;
    let acceptedStatus: string | null = null;
    let releasePublish: (() => void) | null = null;
    const publishStarted = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let unblockPublish: (() => void) | null = null;
    const publishBlocked = new Promise<void>((resolve) => {
      unblockPublish = resolve;
    });
    const { baseUrl, close } = await startServer({
      reservePublicWriteRequestExecution: async () => {
        if (leaseHeld) return false;
        leaseHeld = true;
        return true;
      },
      renewPublicWriteRequestExecution: async () => leaseHeld,
      assertPublicWriteRequestExecution: async () => {
        if (!leaseHeld) throw new Error("public_write_request_execution_lease_lost");
      },
      releasePublicWriteRequestExecution: async () => {
        leaseHeld = false;
      },
      publishProductionClaim: async (claimId) => {
        publishCalls += 1;
        releasePublish?.();
        await publishBlocked;
        return {
          claimId,
          publicationStatus: "published",
          publishClaimTxHash: "0xpublish",
          reconciled: false,
        };
      },
      markPublicWriteRequestAccepted: async (_pool, requestId, outcomeDetail) => {
        acceptedStatus = "accepted";
        return {
          requestId,
          actionType: "claim_publish",
          actorAddress: wallet.address.toLowerCase(),
          chainId: 31337,
          requestNonce: "claim-publish-concurrent",
          scopeKey: "claim:23",
          requestHash: "0xrequest",
          signature: "0xsigned",
          payload: {},
          status: "accepted",
          outcomeDetail: outcomeDetail ?? null,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:01.000Z",
        };
      },
    });
    try {
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "claim_publish",
        actorAddress: wallet.address,
        chainId: 31337,
        issuedAt: new Date().toISOString(),
        payload: {},
        requestNonce: "claim-publish-concurrent",
        scopeKey: "claim:23",
      });
      const publish = () =>
        fetch(`${baseUrl}/claims/23/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        });
      const winnerPromise = publish();
      await publishStarted;
      const concurrent = await publish();
      expect(concurrent.status).to.equal(409);
      expect(await concurrent.json()).to.deep.equal({ error: "public_write_request_in_progress" });
      unblockPublish?.();
      expect((await winnerPromise).status).to.equal(200);
      expect(publishCalls).to.equal(1);
      expect(acceptedStatus).to.equal("accepted");
    } finally {
      unblockPublish?.();
      await close();
    }
  });

  it("creates production source records through signed public write requests", async () => {
    let receivedInput: Record<string, unknown> | null = null;
    let receivedAuthor = "";
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      createProductionArtifactDraft: async (input, authorAddress) => {
        receivedInput = input as unknown as Record<string, unknown>;
        receivedAuthor = authorAddress;
        return {
          artifactType: 5,
          extractionArtifact: {
            artifactKey: "claim-draft-extraction-abc123",
            byteLength: 512,
            contentType: "application/json",
            kind: "claim-draft-extraction",
            sha256: "0xaaa111",
            storagePath: "/tmp/claim-draft-extraction.json",
          },
          preview: {
            candidateStatements: ["Imported draft claim"],
            extractedTextPreview: "Imported draft claim",
            metadata: '{"sourceType":"url"}',
            methodology: "Automatically extracted from the manuscript snapshot.",
            predictionHooks: "production draft import",
            scope: "Limited to the ingested manuscript snapshot.",
            sourceDescriptor: "https://example.com/paper.pdf",
            statement: "Imported draft claim",
            summary: "Imported manuscript snapshot",
            title: "Imported manuscript snapshot",
          },
          snapshotArtifact: {
            artifactKey: "artifact-source-snapshot-abc123",
            byteLength: 1024,
            contentType: "application/pdf",
            kind: "artifact-source-snapshot",
            sha256: "0xbbb222",
            storagePath: "/tmp/manuscript.pdf",
          },
          sourceLocator: "https://example.com/paper.pdf",
          source: {
            canonicalSourceKey: "url:https://example.com/paper.pdf",
            createdAt: "2026-04-16T12:00:00.000Z",
            discoveryMode: "user_submitted",
            extractionArtifactKey: "claim-draft-extraction-abc123",
            publishedClaimId: null,
            snapshotArtifactKey: "artifact-source-snapshot-abc123",
            sourceId: "24",
            sourceMetadata: {
              locator: "https://example.com/paper.pdf",
              title: "Imported manuscript snapshot",
            },
            sourceType: "url",
            status: "extracting",
            submittedByActor: authorAddress,
            submittedByAgentId: null,
            updatedAt: "2026-04-16T12:00:00.000Z",
          },
          sourceType: "url",
          sourceVersion: {
            commitHash: null,
            contentType: "application/pdf",
            extension: "pdf",
            finalUrl: "https://example.com/paper.pdf",
            ref: null,
          },
        };
      },
    });

    try {
      const writeConfig = await fetch(`${baseUrl}/write-config`).then((response) =>
        response.json(),
      );
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_submit",
        actorAddress: wallet.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: {
          sourceType: "url",
          sourceUrl: "https://example.com/paper.pdf",
          domainId: 4,
        },
        requestNonce: "source-submit-1",
        scopeKey: `source:${wallet.address.toLowerCase()}`,
      });

      const response = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(receivedAuthor).to.equal(wallet.address);
      expect(receivedInput).to.deep.include({
        sourceType: "url",
        sourceUrl: "https://example.com/paper.pdf",
        domainId: 4,
      });
      expect(payload.result.source.sourceId).to.equal("24");
    } finally {
      await close();
    }
  });

  it("confirms and rejects source publication through signed public write requests", async () => {
    const wallet = Wallet.createRandom();
    let confirmedInput: { actorAddress: string; candidateId: string; sourceId: string } | null =
      null;
    let rejectedInput: { actorAddress: string; reason: string; sourceId: string } | null = null;
    const { baseUrl, close } = await startServer({
      readSourceRecord: async (_pool, sourceId) => ({
        canonicalSourceKey: sourceId === "24" ? "arxiv:2405.15793v1" : "github:openai/rae@main",
        createdAt: "2026-04-17T00:00:00.000Z",
        discoveryMode: "user_submitted",
        extractionArtifactKey: `source-extraction-preview-${sourceId}`,
        publishedClaimId: null,
        snapshotArtifactKey: `source-snapshot-${sourceId}`,
        sourceId,
        sourceMetadata: {
          title: sourceId === "24" ? "SWE-agent" : "RAE repository",
        },
        sourceType: sourceId === "24" ? "url" : "repository",
        status: "extracting",
        submittedByActor: wallet.address,
        submittedByAgentId: null,
        updatedAt: "2026-04-17T00:10:00.000Z",
      }),
      confirmSourcePublication: async (_pool, input) => {
        confirmedInput = input;
        return {
          decision: {
            competingStrengthRatio: null,
            createdAt: "2026-04-17T00:12:00.000Z",
            decisionArtifactKey: "source-publication-decision-24",
            decisionId: "24",
            publishedClaimId: "29",
            reason: "Confirmed manually from source review.",
            shouldPublish: true,
            sourceId: input.sourceId,
            winningCluster: null,
          },
          publishedClaimId: "29",
          source: {
            canonicalSourceKey: "arxiv:2405.15793v1",
            createdAt: "2026-04-17T00:00:00.000Z",
            discoveryMode: "user_submitted",
            extractionArtifactKey: "source-extraction-preview-24",
            publishedClaimId: "29",
            snapshotArtifactKey: "source-snapshot-24",
            sourceId: input.sourceId,
            sourceMetadata: {
              title: "SWE-agent",
            },
            sourceType: "url",
            status: "published",
            submittedByActor: wallet.address,
            submittedByAgentId: null,
            updatedAt: "2026-04-17T00:12:00.000Z",
          },
        };
      },
      rejectSourcePublication: async (_pool, input) => {
        rejectedInput = input;
        return {
          decision: {
            competingStrengthRatio: null,
            createdAt: "2026-04-17T00:15:00.000Z",
            decisionArtifactKey: "source-publication-decision-25",
            decisionId: "25",
            publishedClaimId: null,
            reason: input.reason,
            shouldPublish: false,
            sourceId: input.sourceId,
            winningCluster: null,
          },
          source: {
            canonicalSourceKey: "github:openai/rae@main",
            createdAt: "2026-04-17T00:00:00.000Z",
            discoveryMode: "user_submitted",
            extractionArtifactKey: "source-extraction-preview-25",
            publishedClaimId: null,
            snapshotArtifactKey: "source-snapshot-25",
            sourceId: input.sourceId,
            sourceMetadata: {
              title: "RAE repository",
            },
            sourceType: "repository",
            status: "rejected",
            submittedByActor: wallet.address,
            submittedByAgentId: null,
            updatedAt: "2026-04-17T00:15:00.000Z",
          },
        };
      },
    });

    try {
      const writeConfig = await fetch(`${baseUrl}/write-config`).then((response) =>
        response.json(),
      );
      const confirmSigned = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_publication_confirm",
        actorAddress: wallet.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: {
          candidateId: "candidate-24-1",
          requestedBy: "source-view",
          sourceId: "24",
        },
        requestNonce: "source-confirm-1",
        scopeKey: "source:24:confirm",
      });

      const confirmResponse = await fetch(`${baseUrl}/sources/24/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirmSigned),
      });
      expect(confirmResponse.status).to.equal(200);
      const confirmPayload = await confirmResponse.json();
      expect(confirmPayload.ok).to.equal(true);
      expect(confirmPayload.result.publishedClaimId).to.equal("29");
      expect(confirmedInput).to.deep.equal({
        actorAddress: wallet.address,
        candidateId: "candidate-24-1",
        sourceId: "24",
      });

      const rejectSigned = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_publication_reject",
        actorAddress: wallet.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: {
          reason: "low-signal extraction cluster",
          requestedBy: "source-view",
          sourceId: "25",
        },
        requestNonce: "source-reject-1",
        scopeKey: "source:25:reject",
      });

      const rejectResponse = await fetch(`${baseUrl}/sources/25/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rejectSigned),
      });
      expect(rejectResponse.status).to.equal(200);
      const rejectPayload = await rejectResponse.json();
      expect(rejectPayload.ok).to.equal(true);
      expect(rejectPayload.result.source.status).to.equal("rejected");
      expect(rejectedInput).to.deep.equal({
        actorAddress: wallet.address,
        reason: "low-signal extraction cluster",
        sourceId: "25",
      });
    } finally {
      await close();
    }
  });

  it("opens production replication jobs for the signed claim author", async () => {
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      readClaim: async (_pool, claimId) => ({
        claimId,
        author: wallet.address,
        domainId: 1,
        metadataHash: "0xabc",
        resolutionModule: "0x0000000000000000000000000000000000000010",
        status: 1,
        revisionOfClaimId: null,
        createdAtBlock: 12,
      }),
      openDemoReplicationJob: async (input) => ({
        jobId: "44",
        claimId: input.claimId,
        requestedBy: input.requestedBy ?? "claim-view",
        status: "open",
        onchainReplicationId: null,
        specHash: "0xdead",
        specURI: null,
        requestId: null,
        submissionActor: null,
        submissionTxHash: null,
        submittedAt: null,
        assignedWorker: null,
        assignedAgentId: null,
        assignedAt: null,
        resultArtifactKey: null,
        resultHash: null,
        evidenceHash: null,
        evidenceURI: null,
        failureReason: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
        completedAt: null,
      }),
    });

    try {
      const writeConfig = await fetch(`${baseUrl}/write-config`).then((response) =>
        response.json(),
      );
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "replication_job_open",
        actorAddress: wallet.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: {
          requestedBy: "claim-view",
        },
        requestNonce: "replication-open-1",
        scopeKey: "claim:7",
      });

      const response = await fetch(`${baseUrl}/claims/7/replication-jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.result.jobId).to.equal("44");
    } finally {
      await close();
    }
  });

  it("requires operator auth for production lifecycle mutation routes", async () => {
    const previousToken = process.env.SP_OPERATOR_API_TOKEN;
    process.env.SP_OPERATOR_API_TOKEN = "operator-secret";
    const { baseUrl, close } = await startServer();

    try {
      const unauthorized = await fetch(`${baseUrl}/replication-jobs/8/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "operator-worker" }),
      });
      expect(unauthorized.status).to.equal(401);
      expect(await unauthorized.json()).to.deep.equal({ error: "operator_unauthorized" });
    } finally {
      if (previousToken === undefined) {
        delete process.env.SP_OPERATOR_API_TOKEN;
      } else {
        process.env.SP_OPERATOR_API_TOKEN = previousToken;
      }
      await close();
    }
  });

  it("accepts wallet-signed operator lifecycle requests from authorized operator wallets", async () => {
    const replicationSubmitter = localOperatorWallet(3);
    const resolver = localOperatorWallet(4);
    const checkpointPublisher = localOperatorWallet(5);
    const observed: Array<{ route: string; payload: Record<string, unknown> }> = [];
    const { baseUrl, close } = await startServer({
      accessControllerHasRole: async (_deploymentPath, roleHash, account) => {
        const normalizedAccount = account.toLowerCase();
        if (roleHash === TEST_ROLE_HASH.RESOLVER_ROLE) {
          return normalizedAccount === resolver.address.toLowerCase();
        }
        if (roleHash === TEST_ROLE_HASH.CHECKPOINT_PUBLISHER_ROLE) {
          return normalizedAccount === checkpointPublisher.address.toLowerCase();
        }
        return false;
      },
      processDemoReplicationJob: async (input) => {
        observed.push({
          payload: { workerId: input.workerId ?? null },
          route: `process:${input.jobId}`,
        });
        return {
          completed: true,
          jobId: input.jobId,
          onchainReplicationId: "11",
          operatorRequestId: "14",
          resultArtifactKey: "replication-result-14",
          submissionTxHash: "0xprocess",
          workerId: input.workerId ?? "wallet-worker",
        };
      },
      resolveDemoReplicationJob: async (input) => {
        observed.push({
          payload: {
            claimStatus: input.claimStatus ?? null,
            confidenceBps: input.confidenceBps ?? null,
            resolutionStatus: input.resolutionStatus ?? null,
          },
          route: `resolve:${input.jobId}`,
        });
        return {
          completedAt: "2026-04-20T01:00:00.000Z",
          confidenceBps: input.confidenceBps ?? 9100,
          createdAt: "2026-04-20T00:59:00.000Z",
          failureReason: null,
          jobId: input.jobId,
          rationaleArtifactKey: "resolution-rationale-14",
          replicationId: "11",
          requestId: "15",
          resolutionStatus: input.resolutionStatus ?? 1,
          resolvedAt: 42,
          resolver: resolver.address,
          resolverType: 3,
          runId: "15",
          status: "submitted",
          txHashes: ["0xresolve"],
          updatedAt: "2026-04-20T01:00:00.000Z",
        };
      },
      recomputeDemoDomain: async ({ domainId }) => {
        observed.push({
          payload: {},
          route: `recompute:${domainId}`,
        });
        return {
          leaderboard: {
            computedAt: "2026-04-20T01:02:00.000Z",
            domainId,
            entries: [],
            payloadHash: "0xpayload",
            payloadId: "payload-1",
            uri: "ipfs://payload-1",
          },
          publications: [],
          rewardSettlements: [],
        };
      },
    });

    try {
      const writeConfig = await fetch(`${baseUrl}/write-config`).then((response) =>
        response.json(),
      );

      const processSigned = await buildSignedPublicWriteBody(replicationSubmitter, {
        actionType: "replication_job_process",
        actorAddress: replicationSubmitter.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: { workerId: "wallet-worker" },
        requestNonce: "process-1",
        scopeKey: "replication-job:8:process",
      });
      const processResponse = await fetch(`${baseUrl}/replication-jobs/8/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(processSigned),
      });
      expect(processResponse.status).to.equal(200);
      const processPayload = await processResponse.json();
      expect(processPayload.requestId).to.equal("91");
      expect(processPayload.result.workerId).to.equal("wallet-worker");

      const resolveSigned = await buildSignedPublicWriteBody(resolver, {
        actionType: "replication_job_resolve",
        actorAddress: resolver.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: { claimStatus: 4, confidenceBps: 9300, resolutionStatus: 1 },
        requestNonce: "resolve-1",
        scopeKey: "replication-job:8:resolve",
      });
      const resolveResponse = await fetch(`${baseUrl}/replication-jobs/8/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(resolveSigned),
      });
      expect(resolveResponse.status).to.equal(200);
      const resolvePayload = await resolveResponse.json();
      expect(resolvePayload.requestId).to.equal("91");
      expect(resolvePayload.result.runId).to.equal("15");

      const recomputeSigned = await buildSignedPublicWriteBody(checkpointPublisher, {
        actionType: "domain_recompute",
        actorAddress: checkpointPublisher.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: {},
        requestNonce: "recompute-1",
        scopeKey: "domain:1:recompute",
      });
      const recomputeResponse = await fetch(`${baseUrl}/domains/1/recompute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recomputeSigned),
      });
      expect(recomputeResponse.status).to.equal(200);
      const recomputePayload = await recomputeResponse.json();
      expect(recomputePayload.requestId).to.equal("91");
      expect(recomputePayload.result.leaderboard.domainId).to.equal(1);

      expect(observed).to.deep.equal([
        {
          payload: { workerId: "wallet-worker" },
          route: "process:8",
        },
        {
          payload: { claimStatus: 4, confidenceBps: 9300, resolutionStatus: 1 },
          route: "resolve:8",
        },
        {
          payload: {},
          route: "recompute:1",
        },
      ]);
    } finally {
      await close();
    }
  });

  it("rejects wallet-signed operator lifecycle requests from unauthorized wallets", async () => {
    const unauthorizedWallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      accessControllerHasRole: async () => false,
    });

    try {
      const writeConfig = await fetch(`${baseUrl}/write-config`).then((response) =>
        response.json(),
      );
      const signed = await buildSignedPublicWriteBody(unauthorizedWallet, {
        actionType: "replication_job_resolve",
        actorAddress: unauthorizedWallet.address,
        chainId: writeConfig.chainId,
        issuedAt: new Date().toISOString(),
        payload: { claimStatus: 4, confidenceBps: 9200, resolutionStatus: 1 },
        requestNonce: "resolve-unauthorized-1",
        scopeKey: "replication-job:8:resolve",
      });

      const response = await fetch(`${baseUrl}/replication-jobs/8/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });
      expect(response.status).to.equal(403);
      expect(await response.json()).to.deep.equal({ error: "operator_forbidden" });
    } finally {
      await close();
    }
  });

  it("rejects bearer-token operator auth unless the compatibility fallback is explicit", async () => {
    const previousToken = process.env.SP_OPERATOR_API_TOKEN;
    const previousFallback = process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK;
    process.env.SP_OPERATOR_API_TOKEN = "operator-secret";
    delete process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK;
    const { baseUrl, close } = await startServer({
      processDemoReplicationJob: async (input) => ({
        completed: true,
        jobId: input.jobId,
        onchainReplicationId: "11",
        operatorRequestId: "14",
        resultArtifactKey: "replication-result-14",
        submissionTxHash: "0xprocess",
        workerId: input.workerId ?? "token-worker",
      }),
    });

    try {
      const response = await fetch(`${baseUrl}/replication-jobs/8/process`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sp-operator-token": "operator-secret",
        },
        body: JSON.stringify({ workerId: "token-worker" }),
      });
      expect(response.status).to.equal(401);
      expect(await response.json()).to.deep.equal({ error: "operator_unauthorized" });
    } finally {
      if (previousToken === undefined) {
        delete process.env.SP_OPERATOR_API_TOKEN;
      } else {
        process.env.SP_OPERATOR_API_TOKEN = previousToken;
      }
      if (previousFallback === undefined) {
        delete process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK;
      } else {
        process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK = previousFallback;
      }
      await close();
    }
  });

  it("does not reuse demo admin tokens for operator lifecycle fallback", async () => {
    const previousOperatorToken = process.env.SP_OPERATOR_API_TOKEN;
    const previousDemoToken = process.env.SP_DEMO_ADMIN_TOKEN;
    const previousFallback = process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK;
    const previousRpcUrl = process.env.SP_RPC_URL;
    const previousReplicationSubmitters = process.env.SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES;
    delete process.env.SP_OPERATOR_API_TOKEN;
    process.env.SP_DEMO_ADMIN_TOKEN = "demo-secret";
    process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK = "true";
    process.env.SP_RPC_URL = "https://base.example.org";
    process.env.SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES =
      "0x0000000000000000000000000000000000000003";
    const { baseUrl, close } = await startServer({
      processDemoReplicationJob: async (input) => ({
        completed: true,
        jobId: input.jobId,
        onchainReplicationId: "11",
        operatorRequestId: "14",
        resultArtifactKey: "replication-result-14",
        submissionTxHash: "0xprocess",
        workerId: input.workerId ?? "token-worker",
      }),
    });

    try {
      const response = await fetch(`${baseUrl}/replication-jobs/8/process`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sp-operator-token": "demo-secret",
        },
        body: JSON.stringify({ workerId: "token-worker" }),
      });
      expect(response.status).to.equal(401);
      expect(await response.json()).to.deep.equal({ error: "operator_unauthorized" });
    } finally {
      if (previousOperatorToken === undefined) {
        delete process.env.SP_OPERATOR_API_TOKEN;
      } else {
        process.env.SP_OPERATOR_API_TOKEN = previousOperatorToken;
      }
      if (previousDemoToken === undefined) {
        delete process.env.SP_DEMO_ADMIN_TOKEN;
      } else {
        process.env.SP_DEMO_ADMIN_TOKEN = previousDemoToken;
      }
      if (previousFallback === undefined) {
        delete process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK;
      } else {
        process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK = previousFallback;
      }
      if (previousRpcUrl === undefined) {
        delete process.env.SP_RPC_URL;
      } else {
        process.env.SP_RPC_URL = previousRpcUrl;
      }
      if (previousReplicationSubmitters === undefined) {
        delete process.env.SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES;
      } else {
        process.env.SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES = previousReplicationSubmitters;
      }
      await close();
    }
  });

  it("keeps bearer-token operator auth as a compatibility fallback", async () => {
    const previousToken = process.env.SP_OPERATOR_API_TOKEN;
    const previousFallback = process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK;
    process.env.SP_OPERATOR_API_TOKEN = "operator-secret";
    process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK = "true";
    const { baseUrl, close } = await startServer({
      processDemoReplicationJob: async (input) => ({
        completed: true,
        jobId: input.jobId,
        onchainReplicationId: "11",
        operatorRequestId: "14",
        resultArtifactKey: "replication-result-14",
        submissionTxHash: "0xprocess",
        workerId: input.workerId ?? "token-worker",
      }),
    });

    try {
      const response = await fetch(`${baseUrl}/replication-jobs/8/process`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sp-operator-token": "operator-secret",
        },
        body: JSON.stringify({ workerId: "token-worker" }),
      });
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.requestId).to.equal(undefined);
      expect(payload.result.workerId).to.equal("token-worker");
    } finally {
      if (previousToken === undefined) {
        delete process.env.SP_OPERATOR_API_TOKEN;
      } else {
        process.env.SP_OPERATOR_API_TOKEN = previousToken;
      }
      if (previousFallback === undefined) {
        delete process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK;
      } else {
        process.env.SP_ENABLE_OPERATOR_TOKEN_FALLBACK = previousFallback;
      }
      await close();
    }
  });

  it("opens, processes, resolves, and recomputes demo state through action endpoints", async () => {
    const { baseUrl, close } = await startServer({
      openDemoReplicationJob: async (input) => ({
        jobId: "8",
        claimId: input.claimId,
        requestedBy: input.requestedBy ?? "dashboard",
        status: "open",
        onchainReplicationId: null,
        specHash: "0xdead",
        specURI: null,
        requestId: null,
        submissionActor: null,
        submissionTxHash: null,
        submittedAt: null,
        assignedWorker: null,
        assignedAgentId: null,
        assignedAt: null,
        resultArtifactKey: null,
        resultHash: null,
        evidenceHash: null,
        evidenceURI: null,
        failureReason: null,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
        completedAt: null,
      }),
      processDemoReplicationJob: async ({ jobId, workerId }) => ({
        completed: true,
        jobId,
        onchainReplicationId: "12",
        operatorRequestId: "14",
        resultArtifactKey: "replication-result-12",
        submissionTxHash: "0xprocess",
        workerId: workerId ?? "worker-z",
      }),
      resolveDemoReplicationJob: async ({
        jobId,
        claimStatus,
        confidenceBps,
        resolutionStatus,
      }) => ({
        runId: "11",
        jobId,
        claimId: "2",
        replicationId: "12",
        resolver: "0x0000000000000000000000000000000000000007",
        status: "submitted",
        resolutionStatus: resolutionStatus ?? 1,
        claimStatus: claimStatus ?? 4,
        resolverType: 3,
        confidenceBps: confidenceBps ?? 9100,
        resolutionHash: "0xresolution",
        evidenceHash: "0xevidence",
        evidenceURI: "ipfs://evidence",
        rationaleArtifactKey: "resolution-rationale-11",
        requestId: "15",
        payoutAmount: "1500000000000000000",
        txHashes: ["0xresolve"],
        failureReason: null,
        createdAt: "2026-03-12T00:01:00.000Z",
        submittedAt: "2026-03-12T00:01:10.000Z",
        updatedAt: "2026-03-12T00:01:10.000Z",
      }),
      recomputeDemoDomain: async ({ domainId }) => ({
        leaderboard: {
          entries: [
            {
              payloadId: "22",
              domainId,
              rank: 1,
              subjectActor: "0x0000000000000000000000000000000000000001",
              score: "10",
              claimCount: 1,
              supportedClaimCount: 1,
              refutedClaimCount: 0,
              fraudulentClaimCount: 0,
              replicationCount: 1,
              checkpointCount: 1,
            },
          ],
          payload: {
            payloadId: "22",
            domainId,
            cutoffBlock: 45,
            cursorBlock: 45,
            payloadHash: "0xpayload",
            artifactKey: "reputation-payload-45",
            entryCount: 1,
            createdAt: "2026-03-12T00:02:00.000Z",
          },
        },
        publications: [],
      }),
    });

    try {
      const openResponse = await fetch(`${baseUrl}/demo/replication-jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claimId: "2", requestedBy: "dashboard-user" }),
      });
      expect(openResponse.status).to.equal(200);
      expect((await openResponse.json()).result.jobId).to.equal("8");

      const processResponse = await fetch(`${baseUrl}/demo/replication-jobs/8/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "worker-z" }),
      });
      expect(processResponse.status).to.equal(200);
      const processPayload = await processResponse.json();
      expect(processPayload.result.completed).to.equal(true);
      expect(processPayload.result.workerId).to.equal("worker-z");
      expect(processPayload.synced.latestBlock).to.equal(45);

      const resolveResponse = await fetch(`${baseUrl}/demo/replication-jobs/8/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claimStatus: 4, confidenceBps: 9500, resolutionStatus: 1 }),
      });
      expect(resolveResponse.status).to.equal(200);
      const resolvePayload = await resolveResponse.json();
      expect(resolvePayload.result.runId).to.equal("11");
      expect(resolvePayload.result.confidenceBps).to.equal(9500);

      const recomputeResponse = await fetch(`${baseUrl}/demo/domains/1/recompute`, {
        method: "POST",
      });
      expect(recomputeResponse.status).to.equal(200);
      const recomputePayload = await recomputeResponse.json();
      expect(recomputePayload.result.leaderboard.payload.domainId).to.equal(1);
      expect(recomputePayload.synced.latestBlock).to.equal(45);
    } finally {
      await close();
    }
  });

  it("opens and enqueues artifact maintenance tasks through demo endpoints", async () => {
    let createdTaskInput: Record<string, unknown> | null = null;
    let enqueueInput: Record<string, unknown> | null = null;
    const { baseUrl, close } = await startServer({
      createArtifactMaintenanceTask: async (_pool, input) => {
        createdTaskInput = input as unknown as Record<string, unknown>;
        return {
          taskId: "5",
          artifactKey: input.artifactKey,
          taskType: input.taskType,
          status: "open",
          requestedBy: input.requestedBy,
          targetReplicaKey: input.targetReplicaKey ?? null,
          targetProvider: input.targetProvider ?? null,
          assignedWorker: null,
          assignedAgentId: null,
          assignedAt: null,
          resultArtifactKey: null,
          failureReason: null,
          repairSourceReplicaKey: null,
          repairLocator: null,
          createdAt: "2026-03-12T00:02:30.000Z",
          updatedAt: "2026-03-12T00:02:30.000Z",
          completedAt: null,
        };
      },
      enqueueArtifactAuditTasks: async (_pool, input) => {
        enqueueInput = input as unknown as Record<string, unknown>;
        return {
          createdTaskIds: ["5", "6"],
          requestedAt: "2026-03-12T00:02:31.000Z",
          totalCreated: 2,
        };
      },
    });

    try {
      const openResponse = await fetch(`${baseUrl}/demo/artifact-maintenance-tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactKey: "replication-result-abc123",
          requestedBy: "dashboard-agent",
          targetReplicaKey: "pinata-public",
          targetProvider: "ipfs:pinata",
          taskType: "repair",
        }),
      });
      expect(openResponse.status).to.equal(200);
      const openPayload = await openResponse.json();
      expect(createdTaskInput).to.deep.include({
        artifactKey: "replication-result-abc123",
        requestedBy: "dashboard-agent",
        targetReplicaKey: "pinata-public",
        targetProvider: "ipfs:pinata",
        taskType: "repair",
      });
      expect(openPayload.result.taskId).to.equal("5");

      const enqueueResponse = await fetch(
        `${baseUrl}/demo/artifact-maintenance-tasks/enqueue-audits`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestedBy: "scheduler-agent",
            staleAfterMinutes: 30,
          }),
        },
      );
      expect(enqueueResponse.status).to.equal(200);
      const enqueuePayload = await enqueueResponse.json();
      expect(enqueueInput).to.deep.equal({
        requestedBy: "scheduler-agent",
        staleAfterMs: 30 * 60 * 1000,
      });
      expect(enqueuePayload.result.totalCreated).to.equal(2);
    } finally {
      await close();
    }
  });

  it("claims artifact maintenance tasks through signed agent requests and records the request", async () => {
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const signed = await buildSignedAgentRequestBody(wallet, {
        actionType: "artifact_task_claim",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          workerId: "artifact-worker-b",
        },
        requestNonce: "nonce-claim-2",
        scopeKey: "artifact-maintenance-task:2",
      });

      const response = await fetch(`${baseUrl}/agent/artifact-maintenance-tasks/2/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });

      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.task.taskId).to.equal("2");
      expect(payload.result.task.status).to.equal("assigned");
      expect(payload.result.task.assignedAgentId).to.equal("1");
      expect(payload.result.task.assignedWorker).to.equal("artifact-worker-b");

      const requestsResponse = await fetch(
        `${baseUrl}/agent-requests?scopeKey=artifact-maintenance-task:2`,
      );
      expect(requestsResponse.status).to.equal(200);
      const requestsPayload = await requestsResponse.json();
      expect(
        requestsPayload.items.some(
          (item: AgentRequestView) =>
            item.requestHash === hashAgentRequestEnvelope(signed.envelope),
        ),
      ).to.equal(true);
    } finally {
      await close();
    }
  });

  it("claims review tasks through signed agent requests and records the request", async () => {
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const signed = await buildSignedAgentRequestBody(wallet, {
        actionType: "review_task_claim",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          workerId: "review-worker-c",
        },
        requestNonce: "nonce-review-claim-2",
        scopeKey: "review-task:2",
      });

      const response = await fetch(`${baseUrl}/agent/review-tasks/2/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });

      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.task.taskId).to.equal("2");
      expect(payload.result.run.workerId).to.equal("review-worker-c");

      const requestsResponse = await fetch(`${baseUrl}/agent-requests?scopeKey=review-task:2`);
      expect(requestsResponse.status).to.equal(200);
      const requestsPayload = await requestsResponse.json();
      expect(
        requestsPayload.items.some(
          (item: AgentRequestView) =>
            item.requestHash === hashAgentRequestEnvelope(signed.envelope),
        ),
      ).to.equal(true);
    } finally {
      await close();
    }
  });

  it("ingests agent-discovered sources through signed machine requests", async () => {
    const wallet = Wallet.createRandom();
    let ingestedByAgent: string | null = null;
    const { baseUrl, close } = await startServer({
      ingestSource: async (_pool, input, options) => {
        ingestedByAgent = options?.submittedByAgentId ?? null;
        return {
          extractionArtifact: {
            artifactKey: "source-extraction-preview-1",
            byteLength: 256,
            contentType: "application/json",
            kind: "claim-draft-extraction",
            sha256: "0xextract",
            storagePath: "/tmp/source-extraction-preview-1.json",
          },
          preview: {
            candidateStatements: ["Example extracted claim"],
            extractedTextPreview: "Example extracted claim",
            metadata: "{}",
            methodology: "Automatically extracted from the source snapshot.",
            predictionHooks: "source discovery",
            scope: "Limited to the submitted source snapshot.",
            sourceDescriptor:
              input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
            statement: "Example extracted claim",
            summary: "Example extracted source summary",
            title: "Example source",
          },
          snapshotArtifact: {
            artifactKey: "source-snapshot-1",
            byteLength: 1024,
            contentType: "application/pdf",
            kind: "artifact-source-snapshot",
            sha256: "0xsnapshot",
            storagePath: "/tmp/source-snapshot-1.pdf",
          },
          source: {
            canonicalSourceKey: "arxiv:2405.15793",
            createdAt: "2026-04-16T00:00:00.000Z",
            discoveryMode: "agent_discovered",
            extractionArtifactKey: "source-extraction-preview-1",
            publishedClaimId: null,
            snapshotArtifactKey: "source-snapshot-1",
            sourceId: "7",
            sourceMetadata: {
              locator: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
            },
            sourceType: input.sourceType,
            status: "extracting",
            submittedByActor: options?.submittedByActor ?? null,
            submittedByAgentId: options?.submittedByAgentId ?? null,
            updatedAt: "2026-04-16T00:00:00.000Z",
          },
          sourceLocator: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
          sourceType: input.sourceType,
          sourceVersion: {
            contentType: "application/pdf",
            extension: "pdf",
            finalUrl: input.sourceType === "url" ? input.sourceUrl : null,
            ref: input.sourceType === "repository" ? (input.ref ?? null) : null,
          },
        };
      },
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const signed = await buildSignedAgentRequestBody(wallet, {
        actionType: "source_discovery_submission",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          sourceType: "url",
          sourceUrl: "https://arxiv.org/abs/2405.15793",
        },
        requestNonce: "nonce-source-discovery-1",
        scopeKey: "source-discovery:arxiv:2405.15793",
      });

      const response = await fetch(`${baseUrl}/agent/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });

      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.source.sourceId).to.equal("7");
      expect(ingestedByAgent).to.equal("1");

      const requestsResponse = await fetch(
        `${baseUrl}/agent-requests?scopeKey=source-discovery:arxiv:2405.15793`,
      );
      expect(requestsResponse.status).to.equal(200);
      const requestsPayload = await requestsResponse.json();
      expect(
        requestsPayload.items.some(
          (item: AgentRequestView) =>
            item.requestHash === hashAgentRequestEnvelope(signed.envelope),
        ),
      ).to.equal(true);
    } finally {
      await close();
    }
  });

  it("resumes an exact rejected source-submit replay while reapplying global throttles", async () => {
    const wallet = Wallet.createRandom();
    let attempts = 0;
    const { baseUrl, close } = await startServer(
      {
        createProductionArtifactDraft: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("fault_after_request_insert");
          return {
            source: { sourceId: "7" },
            submissionOutcome: "created",
          } as never;
        },
      },
      {
        rateLimitConfig: {
          sourceSubmission: { maxRequests: 2, windowMs: 60_000 },
        } as PartialApiRateLimitConfig,
      },
    );
    try {
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_submit",
        actorAddress: wallet.address,
        chainId: 31337,
        issuedAt: new Date().toISOString(),
        payload: { sourceType: "url", sourceUrl: "https://example.com/resumable.pdf" },
        requestNonce: "source-resume-after-insert",
        scopeKey: `submit:${wallet.address.toLowerCase()}`,
      });
      const submit = () =>
        fetch(`${baseUrl}/sources`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        });
      expect((await submit()).status).to.equal(500);
      const replay = await submit();
      expect(replay.status).to.equal(200);
      expect((await replay.json()).result.source.sourceId).to.equal("7");
      expect(attempts).to.equal(2);
      const differentRequest = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_submit",
        actorAddress: wallet.address,
        chainId: 31337,
        issuedAt: new Date().toISOString(),
        payload: { sourceType: "url", sourceUrl: "https://example.com/after-replay.pdf" },
        requestNonce: "source-after-rejected-replay",
        scopeKey: `submit:${wallet.address.toLowerCase()}`,
      });
      const limited = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(differentRequest),
      });
      expect(limited.status).to.equal(429);
    } finally {
      await close();
    }
  });

  it("serializes concurrent exact source-submit replays under one execution lease", async () => {
    const wallet = Wallet.createRandom();
    let leaseHeld = false;
    let createCalls = 0;
    let signalStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let unblock: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const { baseUrl, close } = await startServer({
      reservePublicWriteRequestExecution: async () => {
        if (leaseHeld) return false;
        leaseHeld = true;
        return true;
      },
      renewPublicWriteRequestExecution: async () => leaseHeld,
      assertPublicWriteRequestExecution: async () => {
        if (!leaseHeld) throw new Error("public_write_request_execution_lease_lost");
      },
      releasePublicWriteRequestExecution: async () => {
        leaseHeld = false;
      },
      createProductionArtifactDraft: async () => {
        createCalls += 1;
        signalStarted?.();
        await blocked;
        return { source: { sourceId: "17" }, submissionOutcome: "created" } as never;
      },
    });
    try {
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_submit",
        actorAddress: wallet.address,
        chainId: 31337,
        issuedAt: new Date().toISOString(),
        payload: { sourceType: "url", sourceUrl: "https://example.com/concurrent.pdf" },
        requestNonce: "source-concurrent-replay",
        scopeKey: `submit:${wallet.address.toLowerCase()}`,
      });
      const submit = () =>
        fetch(`${baseUrl}/sources`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        });
      const first = submit();
      await started;
      const concurrent = await submit();
      expect(concurrent.status).to.equal(409);
      expect((await concurrent.json()).error).to.equal("public_write_request_in_progress");
      expect(createCalls).to.equal(1);
      unblock?.();
      expect((await first).status).to.equal(200);
      expect(leaseHeld).to.equal(false);
    } finally {
      unblock?.();
      await close();
    }
  });

  it("keeps a proven accepted source replay from rewriting its accepted request", async () => {
    const wallet = Wallet.createRandom();
    let recorded: PublicWriteRequestView | undefined;
    let acceptanceWrites = 0;
    let reconstructionCalls = 0;
    let ingestCalls = 0;
    const { baseUrl, close } = await startServer({
      readPublicWriteRequestByHash: async () => recorded,
      readSourceRecord: async (_pool, sourceId) =>
        sourceId === "7"
          ? ({ canonicalSourceKey: "url:https://example.com/stable.pdf" } as never)
          : undefined,
      readSourceSubmissionRecordByRequestHash: async () =>
        recorded
          ? ({
              canonicalSourceKey: "url:https://example.com/stable.pdf",
              requestHash: recorded.requestHash,
              sourceId: "7",
            } as never)
          : undefined,
      createProductionArtifactDraft: async () => {
        ingestCalls += 1;
        throw new Error("accepted replay must not ingest");
      },
      reconstructSourceSubmission: async () => {
        reconstructionCalls += 1;
        return { source: { sourceId: "7" }, submissionOutcome: "created" } as never;
      },
      markPublicWriteRequestAccepted: async () => {
        acceptanceWrites += 1;
        if (!recorded) throw new Error("missing recorded request");
        return recorded;
      },
    });
    try {
      const signed = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_submit",
        actorAddress: wallet.address,
        chainId: 31337,
        issuedAt: new Date().toISOString(),
        payload: { sourceType: "url", sourceUrl: "https://example.com/stable.pdf" },
        requestNonce: "source-accepted-replay",
        scopeKey: `submit:${wallet.address.toLowerCase()}`,
      });
      recorded = {
        ...signed.envelope,
        actionType: "source_submit",
        createdAt: "2026-07-12T00:00:00.000Z",
        outcomeDetail: "source:7",
        requestHash: hashPublicWriteEnvelope(signed.envelope),
        requestId: "91",
        signature: signed.signature,
        status: "accepted",
        updatedAt: "2026-07-12T00:00:01.000Z",
      };
      const submit = () =>
        fetch(`${baseUrl}/sources`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        });
      expect((await submit()).status).to.equal(200);
      expect((await submit()).status).to.equal(200);
      expect(reconstructionCalls).to.equal(2);
      expect(ingestCalls).to.equal(0);
      expect(acceptanceWrites).to.equal(0);
      expect(recorded.updatedAt).to.equal("2026-07-12T00:00:01.000Z");
      expect(recorded.outcomeDetail).to.equal("source:7");
    } finally {
      await close();
    }
  });

  it("fails corrupt accepted source replays closed before leases, quotas, or writes", async () => {
    for (const scenario of [
      "missing-source",
      "mismatched-source",
      "missing-submission",
      "bad-outcome",
    ] as const) {
      const wallet = Wallet.createRandom();
      let recorded: PublicWriteRequestView | undefined;
      let mutationCalls = 0;
      const { baseUrl, close } = await startServer({
        readPublicWriteRequestByHash: async () => recorded,
        readSourceRecord: async () =>
          scenario === "missing-source"
            ? undefined
            : ({
                canonicalSourceKey:
                  scenario === "mismatched-source"
                    ? "url:https://example.com/other.pdf"
                    : "url:https://example.com/stable.pdf",
              } as never),
        readSourceSubmissionRecordByRequestHash: async () =>
          scenario === "missing-submission" || !recorded
            ? undefined
            : ({
                canonicalSourceKey: "url:https://example.com/stable.pdf",
                requestHash: recorded.requestHash,
                sourceId: "7",
              } as never),
        reservePublicWriteRequestExecution: async () => {
          mutationCalls += 1;
          return true;
        },
        createProductionArtifactDraft: async () => {
          mutationCalls += 1;
          throw new Error("must not ingest");
        },
        reconstructSourceSubmission: async () => {
          mutationCalls += 1;
          throw new Error("must not reconstruct corrupt state");
        },
        markPublicWriteRequestAccepted: async () => {
          mutationCalls += 1;
          if (!recorded) throw new Error("missing request");
          return recorded;
        },
        markPublicWriteRequestRejected: async () => {
          mutationCalls += 1;
          if (!recorded) throw new Error("missing request");
          return recorded;
        },
      });
      try {
        const signed = await buildSignedPublicWriteBody(wallet, {
          actionType: "source_submit",
          actorAddress: wallet.address,
          chainId: 31337,
          issuedAt: new Date().toISOString(),
          payload: { sourceType: "url", sourceUrl: "https://example.com/stable.pdf" },
          requestNonce: `source-corrupt-${scenario}`,
          scopeKey: `submit:${wallet.address.toLowerCase()}`,
        });
        recorded = {
          ...signed.envelope,
          actionType: "source_submit",
          createdAt: "2026-07-12T00:00:00.000Z",
          outcomeDetail: scenario === "bad-outcome" ? "corrupt" : "source:7",
          requestHash: hashPublicWriteEnvelope(signed.envelope),
          requestId: "91",
          signature: signed.signature,
          status: "accepted",
          updatedAt: "2026-07-12T00:00:01.000Z",
        };
        const response = await fetch(`${baseUrl}/sources`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signed),
        });
        expect(response.status, scenario).to.equal(409);
        expect(await response.json()).to.deep.equal({
          error: "public_write_request_reconciliation_mismatch",
        });
        expect(mutationCalls, scenario).to.equal(0);
      } finally {
        await close();
      }
    }
  });

  it("rate-limits repeated public source submissions under a dedicated source scope", async () => {
    const wallet = Wallet.createRandom();
    let createCalls = 0;
    const { baseUrl, close } = await startServer(
      {
        createProductionArtifactDraft: async (_input, _authorAddress) => {
          createCalls += 1;
          const outcome = createCalls === 1 ? "created" : "duplicate";
          return {
            extractionArtifact: {
              artifactKey: "source-extraction-preview-1",
              byteLength: 256,
              contentType: "application/json",
              kind: "claim-draft-extraction",
              sha256: "0xextract",
              storagePath: "/tmp/source-extraction-preview-1.json",
            },
            preview: {
              candidateStatements: ["Example extracted claim"],
              extractedTextPreview: "Example extracted claim",
              metadata: "{}",
              methodology: "Automatically extracted from the source snapshot.",
              predictionHooks: "source discovery",
              scope: "Limited to the submitted source snapshot.",
              sourceDescriptor: "https://arxiv.org/abs/2405.15793",
              statement: "Example extracted claim",
              summary: "Example extracted source summary",
              title: "Example source",
            },
            snapshotArtifact: {
              artifactKey: "source-snapshot-1",
              byteLength: 1024,
              contentType: "application/pdf",
              kind: "artifact-source-snapshot",
              sha256: "0xsnapshot",
              storagePath: "/tmp/source-snapshot-1.pdf",
            },
            source: {
              canonicalSourceKey: "arxiv:2405.15793",
              createdAt: "2026-04-16T00:00:00.000Z",
              discoveryMode: "user_submitted",
              extractionArtifactKey: "source-extraction-preview-1",
              publishedClaimId: null,
              snapshotArtifactKey: "source-snapshot-1",
              sourceId: "7",
              sourceMetadata: {
                locator: "https://arxiv.org/abs/2405.15793",
              },
              sourceType: "url",
              status: "extracting",
              submittedByActor: wallet.address,
              submittedByAgentId: null,
              updatedAt: "2026-04-16T00:00:00.000Z",
            },
            submission: {
              canonicalSourceKey: "arxiv:2405.15793",
              createdAt: "2026-04-16T00:00:00.000Z",
              discoveryMode: "user_submitted",
              normalizedLocator: "https://arxiv.org/abs/2405.15793",
              rawLocator: "https://doi.org/10.48550/arxiv.2405.15793",
              sourceId: "7",
              submissionId: String(createCalls),
              submissionOutcome: outcome,
              submittedByActor: wallet.address,
              submittedByAgentId: null,
            },
            submissionOutcome: outcome,
          };
        },
        readSourceRecord: async (_pool, sourceId) =>
          sourceId === "7" ? ({ canonicalSourceKey: "arxiv:2405.15793" } as never) : undefined,
      },
      {
        rateLimitConfig: {
          sourceSubmission: {
            maxRequests: 1,
            windowMs: 60_000,
          },
        } as PartialApiRateLimitConfig,
      },
    );

    try {
      const firstSigned = await buildSignedPublicWriteBody(wallet, {
        actionType: "source_submit",
        actorAddress: wallet.address,
        chainId: 31337,
        issuedAt: new Date().toISOString(),
        payload: {
          sourceType: "url",
          sourceUrl: "https://doi.org/10.48550/arxiv.2405.15793",
        },
        requestNonce: "nonce-source-1",
        scopeKey: `submit:${wallet.address.toLowerCase()}`,
      });
      const firstResponse = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(firstSigned),
      });
      expect(firstResponse.status).to.equal(200);

      const replayResponse = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(firstSigned),
      });
      expect(replayResponse.status).to.equal(200);

      const secondResponse = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          await buildSignedPublicWriteBody(wallet, {
            actionType: "source_submit",
            actorAddress: wallet.address,
            chainId: 31337,
            issuedAt: new Date().toISOString(),
            payload: {
              sourceType: "url",
              sourceUrl: "https://example.com/a-different-source.pdf",
            },
            requestNonce: "nonce-source-2",
            scopeKey: `submit:${wallet.address.toLowerCase()}`,
          }),
        ),
      });
      const secondPayload = await secondResponse.json();
      expect(secondResponse.status).to.equal(429);
      expect(secondPayload.error).to.equal("rate_limited");

      const thirdResponse = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          await buildSignedPublicWriteBody(wallet, {
            actionType: "source_submit",
            actorAddress: wallet.address,
            chainId: 31337,
            issuedAt: new Date().toISOString(),
            payload: {
              sourceType: "url",
              sourceUrl: "https://doi.org/10.48550/ARXIV.2405.15793?utm_source=feed",
            },
            requestNonce: "nonce-source-3",
            scopeKey: `submit:${wallet.address.toLowerCase()}`,
          }),
        ),
      });
      expect(thirdResponse.status).to.equal(429);
      expect(await thirdResponse.json()).to.deep.equal({
        error: "rate_limited",
        retryAfterSeconds: 60,
        scope: "sourceSubmission",
      });
      expect(createCalls).to.equal(2);
    } finally {
      await close();
    }
  });

  it("returns duplicate submission outcomes without creating a new source", async () => {
    const wallet = Wallet.createRandom();
    let createCalls = 0;
    const { baseUrl, close } = await startServer({
      createProductionArtifactDraft: async (_input, _authorAddress) => {
        createCalls += 1;
        const outcome = createCalls === 1 ? "created" : "duplicate";
        return {
          extractionArtifact: {
            artifactKey: "source-extraction-preview-1",
            byteLength: 256,
            contentType: "application/json",
            kind: "claim-draft-extraction",
            sha256: "0xextract",
            storagePath: "/tmp/source-extraction-preview-1.json",
          },
          preview: {
            candidateStatements: ["Example extracted claim"],
            extractedTextPreview: "Example extracted claim",
            metadata: "{}",
            methodology: "Automatically extracted from the source snapshot.",
            predictionHooks: "source discovery",
            scope: "Limited to the submitted source snapshot.",
            sourceDescriptor: "https://arxiv.org/abs/2405.15793",
            statement: "Example extracted claim",
            summary: "Example extracted source summary",
            title: "Example source",
          },
          snapshotArtifact: {
            artifactKey: "source-snapshot-1",
            byteLength: 1024,
            contentType: "application/pdf",
            kind: "artifact-source-snapshot",
            sha256: "0xsnapshot",
            storagePath: "/tmp/source-snapshot-1.pdf",
          },
          source: {
            canonicalSourceKey: "arxiv:2405.15793",
            createdAt: "2026-04-16T00:00:00.000Z",
            discoveryMode: "user_submitted",
            extractionArtifactKey: "source-extraction-preview-1",
            publishedClaimId: null,
            snapshotArtifactKey: "source-snapshot-1",
            sourceId: "7",
            sourceMetadata: {
              locator: "https://arxiv.org/abs/2405.15793",
            },
            sourceType: "url",
            status: "extracting",
            submittedByActor: wallet.address,
            submittedByAgentId: null,
            updatedAt: "2026-04-16T00:00:00.000Z",
          },
          submission: {
            canonicalSourceKey: "arxiv:2405.15793",
            createdAt: "2026-04-16T00:00:00.000Z",
            discoveryMode: "user_submitted",
            normalizedLocator: "https://arxiv.org/abs/2405.15793",
            rawLocator: "https://doi.org/10.48550/arxiv.2405.15793",
            sourceId: "7",
            submissionId: String(createCalls),
            submissionOutcome: outcome,
            submittedByActor: wallet.address,
            submittedByAgentId: null,
          },
          submissionOutcome: outcome,
        };
      },
    });

    try {
      const firstResponse = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          await buildSignedPublicWriteBody(wallet, {
            actionType: "source_submit",
            actorAddress: wallet.address,
            chainId: 31337,
            issuedAt: new Date().toISOString(),
            payload: {
              sourceType: "url",
              sourceUrl: "doi:10.48550/arxiv.2405.15793",
            },
            requestNonce: "nonce-source-duplicate-1",
            scopeKey: `submit:${wallet.address.toLowerCase()}`,
          }),
        ),
      });
      const firstPayload = await firstResponse.json();

      const secondResponse = await fetch(`${baseUrl}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          await buildSignedPublicWriteBody(wallet, {
            actionType: "source_submit",
            actorAddress: wallet.address,
            chainId: 31337,
            issuedAt: new Date().toISOString(),
            payload: {
              sourceType: "url",
              sourceUrl: "https://doi.org/10.48550/ARXIV.2405.15793",
            },
            requestNonce: "nonce-source-duplicate-2",
            scopeKey: `submit:${wallet.address.toLowerCase()}`,
          }),
        ),
      });
      const secondPayload = await secondResponse.json();

      expect(firstPayload.result.source.sourceId).to.equal(secondPayload.result.source.sourceId);
      expect(secondPayload.result.submissionOutcome).to.equal("duplicate");
      expect(createCalls).to.equal(2);
    } finally {
      await close();
    }
  });

  it("rate-limits repeated agent source submissions under a dedicated source scope", async () => {
    const wallet = Wallet.createRandom();
    let ingestCalls = 0;
    const { baseUrl, close } = await startServer(
      {
        ingestSource: async (_pool, input, options) => {
          ingestCalls += 1;
          const outcome = ingestCalls === 1 ? "created" : "duplicate";
          return {
            extractionArtifact: {
              artifactKey: "source-extraction-preview-1",
              byteLength: 256,
              contentType: "application/json",
              kind: "claim-draft-extraction",
              sha256: "0xextract",
              storagePath: "/tmp/source-extraction-preview-1.json",
            },
            preview: {
              candidateStatements: ["Example extracted claim"],
              extractedTextPreview: "Example extracted claim",
              metadata: "{}",
              methodology: "Automatically extracted from the source snapshot.",
              predictionHooks: "source discovery",
              scope: "Limited to the submitted source snapshot.",
              sourceDescriptor:
                input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
              statement: "Example extracted claim",
              summary: "Example extracted source summary",
              title: "Example source",
            },
            snapshotArtifact: {
              artifactKey: "source-snapshot-1",
              byteLength: 1024,
              contentType: "application/pdf",
              kind: "artifact-source-snapshot",
              sha256: "0xsnapshot",
              storagePath: "/tmp/source-snapshot-1.pdf",
            },
            source: {
              canonicalSourceKey: "arxiv:2405.15793",
              createdAt: "2026-04-16T00:00:00.000Z",
              discoveryMode: "agent_discovered",
              extractionArtifactKey: "source-extraction-preview-1",
              publishedClaimId: null,
              snapshotArtifactKey: "source-snapshot-1",
              sourceId: "7",
              sourceMetadata: {
                locator: input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
              },
              sourceType: input.sourceType,
              status: "extracting",
              submittedByActor: options?.submittedByActor ?? null,
              submittedByAgentId: options?.submittedByAgentId ?? null,
              updatedAt: "2026-04-16T00:00:00.000Z",
            },
            sourceLocator:
              input.sourceType === "repository" ? input.repositoryUrl : input.sourceUrl,
            sourceType: input.sourceType,
            sourceVersion: {
              contentType: "application/pdf",
              extension: "pdf",
              finalUrl: input.sourceType === "url" ? input.sourceUrl : null,
              ref: input.sourceType === "repository" ? (input.ref ?? null) : null,
            },
            submission: {
              canonicalSourceKey: "arxiv:2405.15793",
              createdAt: "2026-04-16T00:00:00.000Z",
              discoveryMode: "agent_discovered",
              normalizedLocator: "https://arxiv.org/abs/2405.15793",
              rawLocator: "https://arxiv.org/abs/2405.15793",
              sourceId: "7",
              submissionId: String(ingestCalls),
              submissionOutcome: outcome,
              submittedByActor: options?.submittedByActor ?? null,
              submittedByAgentId: options?.submittedByAgentId ?? null,
            },
            submissionOutcome: outcome,
          };
        },
        readAgent: async (_pool, agentId) =>
          agentId === "1"
            ? {
                agentId: "1",
                operator: wallet.address,
                metadataHash: "0x07",
                uri: "ipfs://agent",
                budgetBalance: "100",
                reservedBudget: "0",
                spendLimit: "50",
                active: true,
              }
            : undefined,
      },
      {
        rateLimitConfig: {
          agentSourceSubmission: {
            maxRequests: 1,
            windowMs: 60_000,
          },
        } as PartialApiRateLimitConfig,
      },
    );

    try {
      const firstResponse = await fetch(`${baseUrl}/agent/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          await buildSignedAgentRequestBody(wallet, {
            actionType: "source_discovery_submission",
            actorAddress: wallet.address,
            agentId: "1",
            issuedAt: new Date().toISOString(),
            payload: {
              sourceType: "url",
              sourceUrl: "https://arxiv.org/abs/2405.15793",
            },
            requestNonce: "nonce-agent-source-1",
            scopeKey: "source-discovery:arxiv:2405.15793",
          }),
        ),
      });
      expect(firstResponse.status).to.equal(200);

      const secondResponse = await fetch(`${baseUrl}/agent/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          await buildSignedAgentRequestBody(wallet, {
            actionType: "source_discovery_submission",
            actorAddress: wallet.address,
            agentId: "1",
            issuedAt: new Date().toISOString(),
            payload: {
              sourceType: "url",
              sourceUrl: "doi:10.48550/arxiv.2405.15793",
            },
            requestNonce: "nonce-agent-source-2",
            scopeKey: "source-discovery:arxiv.2405.15793",
          }),
        ),
      });
      const secondPayload = await secondResponse.json();
      expect(secondResponse.status).to.equal(429);
      expect(secondPayload.error).to.equal("rate_limited");

      const thirdResponse = await fetch(`${baseUrl}/agent/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          await buildSignedAgentRequestBody(wallet, {
            actionType: "source_discovery_submission",
            actorAddress: wallet.address,
            agentId: "1",
            issuedAt: new Date().toISOString(),
            payload: {
              sourceType: "url",
              sourceUrl: "https://doi.org/10.48550/ARXIV.2405.15793?utm_source=feed",
            },
            requestNonce: "nonce-agent-source-3",
            scopeKey: "source-discovery:arxiv.2405.15793",
          }),
        ),
      });
      expect(thirdResponse.status).to.equal(429);
      expect(await thirdResponse.json()).to.deep.equal({
        error: "rate_limited",
        retryAfterSeconds: 60,
        scope: "agentSourceSubmission",
      });
      expect(ingestCalls).to.equal(1);
    } finally {
      await close();
    }
  });

  it("claims replication jobs through signed agent requests and records the request", async () => {
    const wallet = Wallet.createRandom();
    const job: ReplicationJobView = {
      jobId: "2",
      claimId: "1",
      requestedBy: "local-coordinator",
      status: "open",
      onchainReplicationId: null,
      specHash: "0xreplication-spec",
      specURI: "ipfs://replication-spec-2",
      requestId: null,
      submissionActor: null,
      submissionTxHash: null,
      submittedAt: null,
      assignedWorker: null,
      assignedAgentId: null,
      assignedAt: null,
      resultArtifactKey: null,
      resultHash: null,
      evidenceHash: null,
      evidenceURI: null,
      failureReason: null,
      createdAt: "2026-04-02T12:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
      completedAt: null,
    };

    const { baseUrl, close } = await startServer({
      claimReplicationJobById: async (_pool, input) => {
        if (input.jobId !== "2" || job.status !== "open") {
          return undefined;
        }
        job.status = "assigned";
        job.assignedAgentId = input.agentId ?? null;
        job.assignedWorker = input.workerId;
        job.assignedAt = "2026-04-02T12:00:10.000Z";
        job.updatedAt = "2026-04-02T12:00:10.000Z";
        return {
          job,
          run: {
            runId: "21",
            jobId: "2",
            workerId: input.workerId,
            agentId: input.agentId ?? null,
            requestId: null,
            status: "running",
            submissionTxHash: null,
            executionManifestHash: null,
            resultArtifactKey: null,
            resultHash: null,
            evidenceHash: null,
            evidenceURI: null,
            failureReason: null,
            lastHeartbeatAt: "2026-04-02T12:00:10.000Z",
            startedAt: "2026-04-02T12:00:10.000Z",
            finishedAt: null,
          },
        };
      },
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const signed = await buildSignedAgentRequestBody(wallet, {
        actionType: "replication_job_claim",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          workerId: "replication-worker-c",
        },
        requestNonce: "nonce-replication-claim-2",
        scopeKey: "replication-job:2",
      });

      const response = await fetch(`${baseUrl}/agent/replication-jobs/2/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });

      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.job.jobId).to.equal("2");
      expect(payload.result.job.assignedAgentId).to.equal("1");
      expect(payload.result.job.assignedWorker).to.equal("replication-worker-c");

      const requestsResponse = await fetch(`${baseUrl}/agent-requests?scopeKey=replication-job:2`);
      expect(requestsResponse.status).to.equal(200);
      const requestsPayload = await requestsResponse.json();
      expect(
        requestsPayload.items.some(
          (item: AgentRequestView) =>
            item.requestHash === hashAgentRequestEnvelope(signed.envelope),
        ),
      ).to.equal(true);
    } finally {
      await close();
    }
  });

  it("records signed heartbeats for assigned artifact maintenance task runs", async () => {
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const claimSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "artifact_task_claim",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          workerId: "artifact-worker-heartbeat",
        },
        requestNonce: "nonce-artifact-claim-heartbeat",
        scopeKey: "artifact-maintenance-task:2",
      });
      const claimResponse = await fetch(`${baseUrl}/agent/artifact-maintenance-tasks/2/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimSigned),
      });
      expect(claimResponse.status).to.equal(200);
      const claimPayload = await claimResponse.json();
      const runId = claimPayload.result.run.runId;

      const heartbeatSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "artifact_task_heartbeat",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          runId,
          workerId: "artifact-worker-heartbeat",
        },
        requestNonce: "nonce-artifact-heartbeat-1",
        scopeKey: "artifact-maintenance-task:2",
      });
      const heartbeatResponse = await fetch(
        `${baseUrl}/agent/artifact-maintenance-tasks/2/heartbeat`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(heartbeatSigned),
        },
      );

      expect(heartbeatResponse.status).to.equal(200);
      const heartbeatPayload = await heartbeatResponse.json();
      expect(heartbeatPayload.ok).to.equal(true);
      expect(heartbeatPayload.result.runId).to.equal(runId);
      expect(heartbeatPayload.result.lastHeartbeatAt).to.equal("2026-03-11T00:11:25.000Z");
    } finally {
      await close();
    }
  });

  it("records signed heartbeats for running review task runs", async () => {
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const claimSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "review_task_claim",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          workerId: "review-worker-heartbeat",
        },
        requestNonce: "nonce-review-claim-heartbeat",
        scopeKey: "review-task:2",
      });
      const claimResponse = await fetch(`${baseUrl}/agent/review-tasks/2/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimSigned),
      });
      expect(claimResponse.status).to.equal(200);
      const claimPayload = await claimResponse.json();
      const runId = claimPayload.result.run.runId;

      const heartbeatSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "review_task_heartbeat",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          runId,
          workerId: "review-worker-heartbeat",
        },
        requestNonce: "nonce-review-heartbeat-1",
        scopeKey: "review-task:2",
      });
      const heartbeatResponse = await fetch(`${baseUrl}/agent/review-tasks/2/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(heartbeatSigned),
      });

      expect(heartbeatResponse.status).to.equal(200);
      const heartbeatPayload = await heartbeatResponse.json();
      expect(heartbeatPayload.ok).to.equal(true);
      expect(heartbeatPayload.result.runId).to.equal(runId);
      expect(heartbeatPayload.result.lastHeartbeatAt).to.equal("2026-03-11T00:11:25.000Z");
    } finally {
      await close();
    }
  });

  it("records signed heartbeats for assigned replication job runs", async () => {
    const wallet = Wallet.createRandom();
    const claimedRun: ReplicationJobRunView = {
      runId: "22",
      jobId: "2",
      workerId: "replication-worker-heartbeat",
      agentId: "1",
      requestId: null,
      status: "running",
      submissionTxHash: null,
      executionManifestHash: null,
      resultArtifactKey: null,
      resultHash: null,
      evidenceHash: null,
      evidenceURI: null,
      failureReason: null,
      lastHeartbeatAt: "2026-04-02T12:00:00.000Z",
      startedAt: "2026-04-02T12:00:00.000Z",
      finishedAt: null,
    };
    const { baseUrl, close } = await startServer({
      claimReplicationJobById: async (_pool, input) => ({
        job: {
          jobId: "2",
          claimId: "1",
          requestedBy: "local-coordinator",
          status: "assigned",
          onchainReplicationId: null,
          specHash: "0xreplication-spec",
          specURI: "ipfs://replication-spec-2",
          requestId: null,
          submissionActor: null,
          submissionTxHash: null,
          submittedAt: null,
          assignedWorker: input.workerId,
          assignedAgentId: input.agentId ?? null,
          assignedAt: "2026-04-02T12:00:00.000Z",
          resultArtifactKey: null,
          resultHash: null,
          evidenceHash: null,
          evidenceURI: null,
          failureReason: null,
          createdAt: "2026-04-02T11:59:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          completedAt: null,
        },
        run: {
          ...claimedRun,
          workerId: input.workerId,
          agentId: input.agentId ?? null,
        },
      }),
      heartbeatReplicationJobRun: async (_pool, input) => {
        if (input.jobId !== "2" || input.runId !== "22") {
          return undefined;
        }
        return {
          ...claimedRun,
          lastHeartbeatAt: "2026-04-02T12:00:30.000Z",
        };
      },
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const claimSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "replication_job_claim",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          workerId: "replication-worker-heartbeat",
        },
        requestNonce: "nonce-replication-claim-heartbeat",
        scopeKey: "replication-job:2",
      });
      const claimResponse = await fetch(`${baseUrl}/agent/replication-jobs/2/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimSigned),
      });
      expect(claimResponse.status).to.equal(200);

      const heartbeatSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "replication_job_heartbeat",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          runId: "22",
          workerId: "replication-worker-heartbeat",
        },
        requestNonce: "nonce-replication-heartbeat-1",
        scopeKey: "replication-job:2",
      });
      const heartbeatResponse = await fetch(`${baseUrl}/agent/replication-jobs/2/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(heartbeatSigned),
      });

      expect(heartbeatResponse.status).to.equal(200);
      const heartbeatPayload = await heartbeatResponse.json();
      expect(heartbeatPayload.ok).to.equal(true);
      expect(heartbeatPayload.result.runId).to.equal("22");
      expect(heartbeatPayload.result.lastHeartbeatAt).to.equal("2026-04-02T12:00:30.000Z");
    } finally {
      await close();
    }
  });

  it("accepts signed agent review submissions for claimed review tasks", async () => {
    const wallet = Wallet.createRandom();
    let persistedResultArtifactKey: string | null = null;
    const { baseUrl, close } = await startServer(
      {
        readAgent: async (_pool, agentId) =>
          agentId === "1"
            ? {
                agentId: "1",
                operator: wallet.address,
                metadataHash: "0x07",
                uri: "ipfs://agent",
                budgetBalance: "100",
                reservedBudget: "0",
                spendLimit: "50",
                active: true,
              }
            : undefined,
        upsertPersistedArtifact: async (_pool, artifact) => {
          persistedResultArtifactKey = artifact.artifactKey;
        },
      },
      {
        env: {
          SP_ARTIFACT_BACKEND: "http",
        },
      },
    );

    try {
      const claimSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "review_task_claim",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          workerId: "review-worker-c",
        },
        requestNonce: "nonce-review-claim-3",
        scopeKey: "review-task:2",
      });

      const claimResponse = await fetch(`${baseUrl}/agent/review-tasks/2/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimSigned),
      });
      expect(claimResponse.status).to.equal(200);
      const claimPayload = await claimResponse.json();
      const runId = claimPayload.result.run.runId;

      const suppliedResultArtifact = createInlineJsonArtifact("agent-review-submission-result", {
        summary: "Open contradiction pressure remains moderate.",
      });
      const submitSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "review_task_submission",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          runId,
          verdict: "flag",
          confidenceBps: 7800,
          summary: "Open contradiction pressure remains moderate.",
          dimensions: {
            contradictionPressure: 6200,
            challengePressure: 5800,
          },
          issues: [
            {
              category: "contradiction",
              severity: "high",
              summary: "Open contradiction pressure remains elevated.",
            },
          ],
          resultArtifact: suppliedResultArtifact,
        },
        requestNonce: "nonce-review-submit-3",
        scopeKey: "review-task:2",
      });

      const submitResponse = await fetch(`${baseUrl}/agent/review-tasks/2/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submitSigned),
      });

      expect(submitResponse.status).to.equal(200);
      const submitPayload = await submitResponse.json();
      expect(submitPayload.ok).to.equal(true);
      expect(submitPayload.result.submission.taskId).to.equal("2");
      expect(submitPayload.result.submission.verdict).to.equal("flag");
      expect(submitPayload.result.submission.resultArtifactKey).to.equal(
        suppliedResultArtifact.artifactKey,
      );
      expect(persistedResultArtifactKey).to.equal(suppliedResultArtifact.artifactKey);

      const submissionsResponse = await fetch(`${baseUrl}/review-tasks/2/submissions`);
      expect(submissionsResponse.status).to.equal(200);
      const submissionsPayload = await submissionsResponse.json();
      expect(
        submissionsPayload.items.some((item: ReviewSubmissionView) => item.taskId === "2"),
      ).to.equal(true);
    } finally {
      await close();
    }
  });

  it("accepts signed agent replication submissions for assigned replication jobs", async () => {
    const wallet = Wallet.createRandom();
    const job: ReplicationJobView = {
      jobId: "2",
      claimId: "1",
      requestedBy: "local-coordinator",
      status: "assigned",
      onchainReplicationId: null,
      specHash: "0xreplication-spec",
      specURI: "ipfs://replication-spec-2",
      requestId: null,
      submissionActor: null,
      submissionTxHash: null,
      submittedAt: null,
      assignedWorker: "replication-worker-submit",
      assignedAgentId: "1",
      assignedAt: "2026-04-02T12:00:00.000Z",
      resultArtifactKey: null,
      resultHash: null,
      evidenceHash: null,
      evidenceURI: null,
      failureReason: null,
      createdAt: "2026-04-02T11:59:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
      completedAt: null,
    };
    let run: ReplicationJobRunView = {
      runId: "23",
      jobId: "2",
      workerId: "replication-worker-submit",
      agentId: "1",
      requestId: null,
      status: "running",
      submissionTxHash: null,
      executionManifestHash: null,
      resultArtifactKey: null,
      resultHash: null,
      evidenceHash: null,
      evidenceURI: null,
      failureReason: null,
      lastHeartbeatAt: "2026-04-02T12:00:30.000Z",
      startedAt: "2026-04-02T12:00:00.000Z",
      finishedAt: null,
    };
    const persistedKinds: string[] = [];

    const { baseUrl, close } = await startServer({
      completeReplicationJob: async (_pool, input) => {
        run = {
          ...run,
          requestId: input.requestId ?? null,
          status: "completed",
          submissionTxHash: input.submissionTxHash ?? null,
          executionManifestHash: input.executionManifestHash,
          resultArtifactKey: input.resultArtifactKey,
          resultHash: input.resultHash,
          evidenceHash: input.evidenceHash,
          evidenceURI: input.evidenceURI,
          finishedAt: "2026-04-02T12:01:00.000Z",
        };
        return {
          ...job,
          status: "completed",
          requestId: input.requestId ?? null,
          onchainReplicationId: input.onchainReplicationId ?? null,
          resultArtifactKey: input.resultArtifactKey,
          resultHash: input.resultHash,
          evidenceHash: input.evidenceHash,
          evidenceURI: input.evidenceURI,
          submissionActor: input.submissionActor ?? null,
          submissionTxHash: input.submissionTxHash ?? null,
          submittedAt: "2026-04-02T12:01:00.000Z",
          updatedAt: "2026-04-02T12:01:00.000Z",
          completedAt: "2026-04-02T12:01:00.000Z",
        };
      },
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
      readReplicationJob: async (_pool, jobId) => (jobId === "2" ? job : undefined),
      readReplicationJobRuns: async (_pool, jobId) => (jobId === "2" ? [run] : []),
      submitPersistedReplicationResult: async () => ({
        onchainReplicationId: "9",
        operatorRequestArtifactKey: "operator-request-artifact-9",
        operatorRequestId: "9",
        submissionActor: "0x0000000000000000000000000000000000000007",
        submissionTxHash: "0xfeed",
      }),
      upsertPersistedArtifact: async (_pool, artifact) => {
        persistedKinds.push(artifact.kind);
      },
    });

    try {
      const signed = await buildSignedAgentRequestBody(wallet, {
        actionType: "replication_job_submission",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          runId: "23",
          summary: "Reference replication submission.",
        },
        requestNonce: "nonce-replication-submit-2",
        scopeKey: "replication-job:2",
      });

      const response = await fetch(`${baseUrl}/agent/replication-jobs/2/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });

      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.job.jobId).to.equal("2");
      expect(payload.result.job.status).to.equal("completed");
      expect(payload.result.operatorRequestId).to.equal("9");
      expect(payload.result.resultArtifactKey).to.be.a("string");
      expect(payload.result.run.status).to.equal("completed");
      expect(persistedKinds).to.include("replication-result");
    } finally {
      await close();
    }
  });

  it("accepts signed agent audit submissions for assigned artifact maintenance tasks", async () => {
    const wallet = Wallet.createRandom();
    let recordedAudits = 0;
    let recordedRequestStatus = "";
    const { baseUrl, close } = await startServer({
      createArtifactMaintenanceTask: async (_pool, input) => ({
        taskId: "8",
        artifactKey: input.artifactKey,
        taskType: input.taskType,
        status: "open",
        requestedBy: input.requestedBy,
        targetReplicaKey: input.targetReplicaKey ?? null,
        targetProvider: input.targetProvider ?? null,
        assignedWorker: null,
        assignedAgentId: null,
        assignedAt: null,
        resultArtifactKey: null,
        failureReason: null,
        repairSourceReplicaKey: null,
        repairLocator: null,
        createdAt: "2026-04-02T12:00:00.000Z",
        updatedAt: "2026-04-02T12:00:00.000Z",
        completedAt: null,
      }),
      completeArtifactMaintenanceTask: async (_pool, input) => ({
        taskId: input.taskId,
        artifactKey: "replication-result-abc123",
        taskType: "audit",
        status: "completed",
        requestedBy: "artifact-maintenance-scheduler",
        targetReplicaKey: null,
        targetProvider: null,
        assignedWorker: "artifact-worker-a",
        assignedAgentId: "1",
        assignedAt: "2026-04-02T12:00:00.000Z",
        resultArtifactKey: input.resultArtifactKey ?? "artifact-maintenance-agent-audit-result-1",
        failureReason: null,
        repairSourceReplicaKey: null,
        repairLocator: null,
        createdAt: "2026-04-02T12:00:00.000Z",
        updatedAt: "2026-04-02T12:01:00.000Z",
        completedAt: "2026-04-02T12:01:00.000Z",
      }),
      insertAgentRequest: async (_pool, input) => {
        recordedRequestStatus = input.status;
        return {
          requestId: "99",
          actionType: input.actionType,
          agentId: input.agentId,
          actorAddress: input.actorAddress.toLowerCase(),
          requestNonce: input.requestNonce,
          scopeKey: input.scopeKey,
          requestHash: input.requestHash,
          signature: input.signature,
          payload: input.payload,
          status: input.status,
          outcomeDetail: input.outcomeDetail ?? null,
          createdAt: "2026-04-02T12:01:00.000Z",
          updatedAt: "2026-04-02T12:01:00.000Z",
        };
      },
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
      readArtifactMaintenanceTask: async (_pool, taskId) =>
        taskId === "7"
          ? {
              taskId: "7",
              artifactKey: "replication-result-abc123",
              taskType: "audit",
              status: "assigned",
              requestedBy: "artifact-maintenance-scheduler",
              targetReplicaKey: null,
              targetProvider: null,
              assignedWorker: "artifact-worker-a",
              assignedAgentId: "1",
              assignedAt: "2026-04-02T12:00:00.000Z",
              resultArtifactKey: null,
              failureReason: null,
              repairSourceReplicaKey: null,
              repairLocator: null,
              createdAt: "2026-04-02T11:59:00.000Z",
              updatedAt: "2026-04-02T12:00:00.000Z",
              completedAt: null,
            }
          : undefined,
      readArtifactMaintenanceTaskRuns: async (_pool, taskId) =>
        taskId === "7"
          ? [
              {
                runId: "77",
                taskId: "7",
                workerId: "artifact-worker-a",
                agentId: "1",
                status: "running",
                summaryArtifactKey: null,
                failureReason: null,
                lastHeartbeatAt: "2026-04-02T12:00:30.000Z",
                startedAt: "2026-04-02T12:00:00.000Z",
                finishedAt: null,
              },
            ]
          : [],
      recordPersistedArtifactAudit: async () => {
        recordedAudits += 1;
      },
      upsertPersistedArtifact: async () => {},
    });

    try {
      const signed = await buildSignedAgentRequestBody(wallet, {
        actionType: "artifact_task_audit_submission",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          audits: [
            {
              detail: "pin failed health check",
              locator: "ipfs://bafyreplicationresult",
              provider: "ipfs:pinata",
              replicaKey: "pinata-public",
              status: "unreachable",
            },
          ],
        },
        requestNonce: "nonce-audit-1",
        scopeKey: "artifact-maintenance-task:7",
      });

      const response = await fetch(`${baseUrl}/agent/artifact-maintenance-tasks/7/audit-results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });

      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.task.status).to.equal("completed");
      expect(payload.result.createdRepairTasks).to.have.length(1);
      expect(payload.result.createdRepairTasks[0].taskId).to.equal("8");
      expect(recordedAudits).to.equal(1);
      expect(recordedRequestStatus).to.equal("accepted");
    } finally {
      await close();
    }
  });

  it("accepts signed agent repair submissions for assigned artifact maintenance tasks", async () => {
    const wallet = Wallet.createRandom();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-agent-repair-"));
    const replicaPath = path.join(tempRoot, "replication-result.json");
    const replicaContent = Buffer.from('{"status":"ok"}', "utf8");
    await writeFile(replicaPath, replicaContent);
    const sha256 = `0x${sha256Hex(replicaContent)}`;
    let recordedReplica: { locator: string; replicaKey: string } | null = null;
    const verificationStatuses: string[] = [];

    const { baseUrl, close } = await startServer({
      completeArtifactMaintenanceTask: async (_pool, input) => ({
        taskId: input.taskId,
        artifactKey: "replication-result-abc123",
        taskType: "repair",
        status: "completed",
        requestedBy: "artifact-audit:7",
        targetReplicaKey: "pinata-public",
        targetProvider: "filesystem",
        assignedWorker: "artifact-worker-b",
        assignedAgentId: "1",
        assignedAt: "2026-04-02T12:10:00.000Z",
        resultArtifactKey: input.resultArtifactKey ?? "artifact-maintenance-agent-repair-result-1",
        failureReason: null,
        repairSourceReplicaKey: input.repairSourceReplicaKey ?? null,
        repairLocator: input.repairLocator ?? null,
        createdAt: "2026-04-02T12:09:00.000Z",
        updatedAt: "2026-04-02T12:11:00.000Z",
        completedAt: "2026-04-02T12:11:00.000Z",
      }),
      insertAgentRequest: async (_pool, input) => ({
        requestId: "100",
        actionType: input.actionType,
        agentId: input.agentId,
        actorAddress: input.actorAddress.toLowerCase(),
        requestNonce: input.requestNonce,
        scopeKey: input.scopeKey,
        requestHash: input.requestHash,
        signature: input.signature,
        payload: input.payload,
        status: input.status,
        outcomeDetail: input.outcomeDetail ?? null,
        createdAt: "2026-04-02T12:11:00.000Z",
        updatedAt: "2026-04-02T12:11:00.000Z",
      }),
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
      readArtifactMaintenanceTask: async (_pool, taskId) =>
        taskId === "9"
          ? {
              taskId: "9",
              artifactKey: "replication-result-abc123",
              taskType: "repair",
              status: "assigned",
              requestedBy: "artifact-audit:7",
              targetReplicaKey: "pinata-public",
              targetProvider: "filesystem",
              assignedWorker: "artifact-worker-b",
              assignedAgentId: "1",
              assignedAt: "2026-04-02T12:10:00.000Z",
              resultArtifactKey: null,
              failureReason: null,
              repairSourceReplicaKey: null,
              repairLocator: null,
              createdAt: "2026-04-02T12:09:00.000Z",
              updatedAt: "2026-04-02T12:10:00.000Z",
              completedAt: null,
            }
          : undefined,
      readArtifactMaintenanceTaskRuns: async (_pool, taskId) =>
        taskId === "9"
          ? [
              {
                runId: "91",
                taskId: "9",
                workerId: "artifact-worker-b",
                agentId: "1",
                status: "running",
                summaryArtifactKey: null,
                failureReason: null,
                lastHeartbeatAt: "2026-04-02T12:10:30.000Z",
                startedAt: "2026-04-02T12:10:00.000Z",
                finishedAt: null,
              },
            ]
          : [],
      readPersistedArtifact: async (_pool, artifactKey) =>
        artifactKey === "replication-result-abc123"
          ? {
              artifactKey,
              byteLength: replicaContent.byteLength,
              contentType: "application/json",
              createdAt: "2026-04-02T12:09:00.000Z",
              kind: "replication-result",
              sha256,
              storagePath: replicaPath,
            }
          : undefined,
      recordPersistedArtifactAudit: async (_pool, _artifactKey, audit) => {
        verificationStatuses.push(audit.status);
      },
      upsertPersistedArtifact: async () => {},
      upsertPersistedArtifactReplica: async (_pool, _artifactKey, replica) => {
        recordedReplica = {
          locator: replica.locator,
          replicaKey: replica.replicaKey,
        };
      },
    });

    try {
      const signed = await buildSignedAgentRequestBody(wallet, {
        actionType: "artifact_task_repair_submission",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          repairSourceReplicaKey: "primary",
          repairedReplica: {
            locator: replicaPath,
            provider: "filesystem",
            replicaKey: "pinata-public",
          },
        },
        requestNonce: "nonce-repair-1",
        scopeKey: "artifact-maintenance-task:9",
      });

      const response = await fetch(`${baseUrl}/agent/artifact-maintenance-tasks/9/repair-results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });

      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.ok).to.equal(true);
      expect(payload.result.task.status).to.equal("completed");
      expect(recordedReplica).to.deep.equal({
        locator: replicaPath,
        replicaKey: "pinata-public",
      });
      expect(verificationStatuses).to.deep.equal(["verified"]);
    } finally {
      await close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rate limits public demo mutation endpoints", async () => {
    const { baseUrl, close } = await startServer(
      {
        createDemoClaim: async () => ({
          artifactId: "9",
          claimId: "3",
          createdBy: "0x0000000000000000000000000000000000000001",
          job: null,
          txHashes: {
            addArtifact: "0xartifact",
            createClaim: "0xcreate",
            depositAuthorBond: "0xbond",
            fundClaimRewardPool: "0xbounty",
            publishClaim: "0xpublish",
          },
        }),
      },
      {
        rateLimitConfig: {
          publicDemoActions: {
            maxRequests: 1,
            windowMs: 60_000,
          },
        },
      },
    );

    try {
      const firstResponse = await fetch(`${baseUrl}/demo/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statement: "First claim",
          artifactUri: "ipfs://first-claim",
        }),
      });
      expect(firstResponse.status).to.equal(200);
      expect(firstResponse.headers.get("x-ratelimit-limit")).to.equal("1");
      expect(firstResponse.headers.get("x-ratelimit-remaining")).to.equal("0");

      const secondResponse = await fetch(`${baseUrl}/demo/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statement: "Second claim",
          artifactUri: "ipfs://second-claim",
        }),
      });
      expect(secondResponse.status).to.equal(429);
      expect(secondResponse.headers.get("retry-after")).to.equal("60");
      expect(await secondResponse.json()).to.deep.equal({
        error: "rate_limited",
        retryAfterSeconds: 60,
        scope: "publicDemoActions",
      });
    } finally {
      await close();
    }
  });

  it("uses file-backed RPC URLs when deriving remote runtime rate-limit defaults", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-api-env-"));
    const rpcUrlPath = path.join(tempRoot, "rpc-url");
    await writeFile(rpcUrlPath, "https://base.example.org\n", "utf8");
    const { baseUrl, close } = await startServer(
      {
        createDemoClaim: async () => ({
          artifactId: "9",
          claimId: "3",
          createdBy: "0x0000000000000000000000000000000000000001",
          job: null,
          txHashes: {
            addArtifact: "0xartifact",
            createClaim: "0xcreate",
            depositAuthorBond: "0xbond",
            fundClaimRewardPool: "0xbounty",
            publishClaim: "0xpublish",
          },
        }),
      },
      { env: { SP_RPC_URL_FILE: rpcUrlPath } },
    );

    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await fetch(`${baseUrl}/demo/claims`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            artifactUri: `ipfs://file-backed-rpc-${index}`,
            statement: `File-backed RPC rate-limit claim ${index}`,
          }),
        });
        expect(response.status).to.equal(200);
      }

      const limitedResponse = await fetch(`${baseUrl}/demo/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactUri: "ipfs://file-backed-rpc-limited",
          statement: "File-backed RPC rate-limit claim limited",
        }),
      });
      expect(limitedResponse.status).to.equal(429);
      expect(await limitedResponse.json()).to.deep.equal({
        error: "rate_limited",
        retryAfterSeconds: 60,
        scope: "publicDemoActions",
      });
    } finally {
      await close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects invalid JSON bodies on demo action routes", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/demo/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });
      expect(response.status).to.equal(400);
      expect(await response.json()).to.deep.equal({ error: "invalid_json_body" });
    } finally {
      await close();
    }
  });

  it("rejects oversized JSON bodies on mutation routes", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/demo/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactUri: "ipfs://oversized-body",
          metadata: "x".repeat(1_048_576),
          statement: "Oversized JSON body",
        }),
      });
      expect(response.status).to.equal(413);
      expect(await response.json()).to.deep.equal({
        error: "json_body_too_large",
        maxBytes: 1_048_576,
      });
    } finally {
      await close();
    }
  });

  it("returns paginated claim results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readClaimsPage: async (_pool, options) => ({
        items: [
          {
            claimId: "2",
            author: "0x0000000000000000000000000000000000000002",
            domainId: options.domainId ?? 2,
            metadataHash: "0x22",
            resolutionModule: "0x0000000000000000000000000000000000000020",
            status: options.status ?? 3,
            revisionOfClaimId: null,
            createdAtBlock: 10,
          },
        ],
        total: 4,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/claims?limit=1&offset=2&domainId=2&status=3&author=0xabc`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(4);
      expect(payload.limit).to.equal(1);
      expect(payload.offset).to.equal(2);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].domainId).to.equal(2);
      expect(payload.items[0].status).to.equal(3);
    } finally {
      await close();
    }
  });

  it("accepts leading zeroes in decimal integer query parameters", async () => {
    const { baseUrl, close } = await startServer({
      readClaimsPage: async (_pool, options) => ({
        items: [],
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
        total: 0,
      }),
    });

    try {
      const response = await fetch(`${baseUrl}/claims?limit=01&offset=002`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.limit).to.equal(1);
      expect(payload.offset).to.equal(2);
    } finally {
      await close();
    }
  });

  it("rejects non-decimal integer query parameters", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/claims?limit=1e2`);
      expect(response.status).to.equal(400);
      expect(await response.json()).to.deep.equal({
        error: "invalid_query_parameter",
        expected: "integer",
        parameter: "limit",
      });
    } finally {
      await close();
    }
  });

  it("returns the latest domain leaderboard payload and entries", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/domains/1/leaderboard?limit=10&offset=0`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.payload.payloadId).to.equal("1");
      expect(payload.leaderboard.total).to.equal(1);
      expect(payload.leaderboard.items).to.have.length(1);
      expect(payload.leaderboard.items[0].domainId).to.equal(1);
      expect(payload.leaderboard.items[0].rank).to.equal(1);
    } finally {
      await close();
    }
  });

  it("returns filtered agent results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readAgentsPage: async (_pool, options) => ({
        items: [
          {
            agentId: "2",
            operator: options.operator ?? "0x0000000000000000000000000000000000000099",
            metadataHash: "0x17",
            uri: "ipfs://agent-2",
            budgetBalance: "20",
            reservedBudget: "5",
            spendLimit: "10",
            active: options.active ?? false,
          },
        ],
        total: 1,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/agents?limit=5&offset=0&active=false&operator=0xdef`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.limit).to.equal(5);
      expect(payload.offset).to.equal(0);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].active).to.equal(false);
      expect(payload.items[0].operator).to.equal("0xdef");
    } finally {
      await close();
    }
  });

  it("rejects invalid pagination parameters with HTTP 400", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/claims?limit=abc`);
      expect(response.status).to.equal(400);
      expect(await response.json()).to.deep.equal({
        error: "invalid_query_parameter",
        parameter: "limit",
        expected: "integer",
      });

      const negativeResponse = await fetch(`${baseUrl}/claims?offset=-1`);
      expect(negativeResponse.status).to.equal(400);
      expect(await negativeResponse.json()).to.deep.equal({
        error: "invalid_query_parameter",
        parameter: "offset",
        expected: "integer",
      });
    } finally {
      await close();
    }
  });

  it("returns full claim details with collection counts by default", async () => {
    const { baseUrl, close } = await startServer({
      readArtifactsByClaim: async () => [
        {
          artifactId: "7",
          claimId: "1",
          artifactType: 1,
          contentDigest: "0xaa",
          uri: "ipfs://artifact-7",
          submitter: "0x0000000000000000000000000000000000000007",
        },
      ],
      readReplicationsByClaim: async () => [
        {
          replicationId: "8",
          claimId: "1",
          replicator: "0x0000000000000000000000000000000000000008",
          agentId: "0",
          resultHash: "0xbb",
          outcome: 1,
          resolutionStatus: 1,
          confidenceBps: 9100,
          resolverType: 1,
          resolutionHash: "0xcc",
          evidenceHash: "0xdd",
          evidenceURI: "ipfs://replication-8",
        },
      ],
      readCheckpointsByClaim: async () => [
        {
          checkpointId: "9",
          domainId: 1,
          subjectType: 1,
          subjectActor: "0x0000000000000000000000000000000000000001",
          subjectClaimId: "1",
          subjectAgentId: "0",
          subjectModule: "0x0000000000000000000000000000000000000010",
          scoreVectorHash: "0xee",
          payloadHash: "0xff",
          uri: "ipfs://checkpoint-9",
        },
      ],
      readForecastsByClaim: async () => [],
      readChallengesByClaim: async () => [],
      readAppealsByClaim: async () => [],
    });

    try {
      const response = await fetch(`${baseUrl}/claims/1`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.claimId).to.equal("1");
      expect(payload.collectionCounts).to.deep.equal({
        artifacts: 1,
        replications: 1,
        checkpoints: 1,
        forecasts: 0,
        challenges: 0,
        appeals: 0,
      });
      expect(payload.artifacts).to.have.length(1);
      expect(payload.replications).to.have.length(1);
      expect(payload.checkpoints).to.have.length(1);
      expect(payload.review.summary.tasks).to.equal(2);
      expect(payload.review.vector).to.be.an("array").that.is.not.empty;
      expect(payload.review.certifications).to.be.an("array").that.is.not.empty;
      expect(payload.review.explanation.materialSignals).to.be.an("array");
      expect(payload.review.explanation.missingPrerequisites).to.be.an("array");
      expect(payload.review.explanation.recentChanges).to.be.an("array");
      expect(payload.review.explanation.readerSummary).to.include.keys(
        "verdictSummary",
        "keyDrivers",
        "openQuestions",
        "latestScientificUpdate",
      );
      expect(payload.review.explanation.readerSummary.verdictSummary).to.equal(
        "Review summary: 2 submissions, 2 distinct agents, and 1 task types across 2 tasks. Support narrative: Artifact completeness is currently supporting the claim at 85%; the strongest recent signal is Artifact Completeness Check submission 2. Uncertainty narrative: Review freshness is still unresolved at 40%.",
      );
      expect(payload.review.explanation.readerSummary.keyDrivers).to.be.an("array");
      expect(payload.review.explanation.readerSummary.keyDrivers[0]).to.include({
        kind: "support",
        label: "Artifact completeness",
      });
      expect(payload.review.explanation.readerSummary.keyDrivers[0]?.references).to.be.an("array");
      expect(payload.review.explanation.readerSummary.openQuestions).to.be.an("array");
      expect(payload.review.explanation.readerSummary.openQuestions[0]).to.include({
        label: "Method and statistics",
      });
      expect(payload.review.explanation.readerSummary.openQuestions[0]?.references).to.be.an(
        "array",
      );
      expect(payload.review.explanation.readerSummary.latestScientificUpdate).to.equal(
        "A second independent agent corroborated artifact completeness.",
      );
      expect(payload.review.explanation.materialSignals[0]?.references).to.be.an("array");
      expect(payload.review.explanation.missingPrerequisites[0]).to.include.keys(
        "label",
        "reason",
        "references",
      );
      expect(payload.review.estimates.supportEstimateBps).to.be.a("number");
      expect(payload.review.estimates.uncertaintyBps).to.be.a("number");
      expect(payload.workGraph.summary.totalItems).to.be.greaterThan(0);
      expect(payload.workGraph.items).to.be.an("array").that.is.not.empty;
      expect(payload.workGraph.subjects[0].subjectType).to.equal("claim");
      expect(payload.rewards.totalPoolWei).to.equal("183000000000000000");
      expect(payload.rewards.policy).to.include.keys("attention", "narrative", "signals");
      expect(payload.rewards.policy.signals[0]).to.include.keys(
        "schedulerPressureBps",
        "minimumCoverageItems",
        "reassignmentReadyItems",
        "uncoveredDemand",
      );
      expect(payload.rewards.settled.totalAmountWei).to.equal("40000000000000000");
      expect(payload.rewards.recentSettlements.items).to.have.length(2);
    } finally {
      await close();
    }
  });

  it("returns summary claim details without nested collections when requested", async () => {
    const { baseUrl, close } = await startServer({
      readArtifactsPage: async (_pool, options) => ({
        items: [],
        total: options.claimId === "1" ? 2 : 0,
        limit: options.limit ?? 1,
        offset: options.offset ?? 0,
      }),
      readReplicationsPage: async (_pool, options) => ({
        items: [],
        total: options.claimId === "1" ? 3 : 0,
        limit: options.limit ?? 1,
        offset: options.offset ?? 0,
      }),
      readCheckpointsPage: async (_pool, options) => ({
        items: [],
        total: options.claimId === "1" ? 4 : 0,
        limit: options.limit ?? 1,
        offset: options.offset ?? 0,
      }),
      readForecastsPage: async (_pool, options) => ({
        items: [],
        total: options.claimId === "1" ? 5 : 0,
        limit: options.limit ?? 1,
        offset: options.offset ?? 0,
      }),
      readChallengesPage: async (_pool, options) => ({
        items: [],
        total: options.claimId === "1" ? 6 : 0,
        limit: options.limit ?? 1,
        offset: options.offset ?? 0,
      }),
      readAppealsPage: async (_pool, options) => ({
        items: [],
        total: options.claimId === "1" ? 7 : 0,
        limit: options.limit ?? 1,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(`${baseUrl}/claims/1?view=summary`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.claimId).to.equal("1");
      expect(payload.collectionCounts).to.deep.equal({
        artifacts: 2,
        replications: 3,
        checkpoints: 4,
        forecasts: 5,
        challenges: 6,
        appeals: 7,
      });
      expect(payload).to.not.have.property("artifacts");
      expect(payload).to.not.have.property("replications");
      expect(payload).to.not.have.property("checkpoints");
    } finally {
      await close();
    }
  });

  it("returns aggregated claim review state and review task detail", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const reviewResponse = await fetch(`${baseUrl}/claims/1/review`);
      expect(reviewResponse.status).to.equal(200);
      const reviewPayload = await reviewResponse.json();
      expect(reviewPayload.summary.tasks).to.equal(2);
      expect(reviewPayload.summary.submissions).to.equal(2);
      expect(reviewPayload.certifications).to.be.an("array").that.is.not.empty;
      expect(reviewPayload.vector).to.be.an("array").that.is.not.empty;
      expect(reviewPayload.explanation.materialSignals).to.be.an("array");
      expect(reviewPayload.explanation.materialSignals[0]?.references).to.be.an("array");
      expect(reviewPayload.explanation.recentChanges).to.be.an("array");
      expect(reviewPayload.explanation.readerSummary).to.include.keys(
        "verdictSummary",
        "keyDrivers",
        "openQuestions",
        "latestScientificUpdate",
      );
      expect(reviewPayload.explanation.readerSummary.verdictSummary).to.equal(
        "Review summary: 2 submissions, 2 distinct agents, and 1 task types across 2 tasks. Support narrative: Artifact completeness is currently supporting the claim at 85%; the strongest recent signal is Artifact Completeness Check submission 2. Uncertainty narrative: Review freshness is still unresolved at 40%.",
      );
      expect(reviewPayload.explanation.readerSummary.keyDrivers).to.be.an("array");
      expect(reviewPayload.explanation.readerSummary.keyDrivers[0]).to.include({
        kind: "support",
        label: "Artifact completeness",
      });
      expect(reviewPayload.explanation.readerSummary.keyDrivers[0]?.references).to.be.an("array");
      expect(reviewPayload.explanation.readerSummary.openQuestions).to.be.an("array");
      expect(reviewPayload.explanation.readerSummary.openQuestions[0]).to.include({
        label: "Method and statistics",
      });
      expect(reviewPayload.explanation.readerSummary.openQuestions[0]?.references).to.be.an(
        "array",
      );
      expect(reviewPayload.explanation.readerSummary.latestScientificUpdate).to.equal(
        "A second independent agent corroborated artifact completeness.",
      );
      expect(reviewPayload.explanation.supportNarrative).to.be.a("string");
      expect(reviewPayload.estimates.supportEstimateBps).to.be.a("number");
      expect(reviewPayload.estimates.uncertaintyBps).to.be.a("number");
      expect(reviewPayload.agentCalibration).to.be.an("array");
      expect(reviewPayload.agentCalibration[0]).to.include.keys(
        "agentId",
        "averageCalibrationBps",
        "samples",
        "weightBps",
      );
      expect(reviewPayload.agentCalibration[0].recentContributions).to.be.an("array");

      const taskResponse = await fetch(`${baseUrl}/review-tasks/1`);
      expect(taskResponse.status).to.equal(200);
      const taskPayload = await taskResponse.json();
      expect(taskPayload.task.taskId).to.equal("1");
      expect(taskPayload.runs).to.have.length(2);
      expect(taskPayload.submissions).to.have.length(2);
    } finally {
      await close();
    }
  });

  it("falls back to deterministic replication ordering when timestamps are incomplete", async () => {
    const { baseUrl, close } = await startServer({
      readReviewSubmissionsPage: async (_pool, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReplicationsByClaim: async () => [
        {
          replicationId: "8",
          claimId: "1",
          replicator: "0x0000000000000000000000000000000000000008",
          agentId: "0",
          resultHash: "0xbb",
          outcome: 1,
          resolutionStatus: 1,
          confidenceBps: 9100,
          resolverType: 1,
          resolutionHash: "0xcc",
          evidenceHash: "0xdd",
          evidenceURI: "ipfs://replication-8",
        },
        {
          replicationId: "7",
          claimId: "1",
          replicator: "0x0000000000000000000000000000000000000007",
          agentId: "0",
          resultHash: "0xaa",
          outcome: 1,
          resolutionStatus: 1,
          confidenceBps: 9000,
          resolverType: 1,
          resolutionHash: "0xee",
          evidenceHash: "0xff",
          evidenceURI: "ipfs://replication-7",
        },
      ],
    });

    try {
      const response = await fetch(`${baseUrl}/claims/1/review`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(
        payload.explanation.recentChanges.map((entry: { label: string }) => entry.label),
      ).to.deep.equal(["Replication 8", "Replication 7"]);
      expect(payload.explanation.readerSummary.verdictSummary).to.equal(
        "Review summary: 0 submissions, 0 distinct agents, and 0 task types across 2 tasks. Support narrative: Replication support is currently supporting the claim at 85%; the strongest recent signal is Replication Job 1. Uncertainty narrative: Artifact completeness is still unresolved at 0%; the latest relevant work is Artifact Completeness Check.",
      );
      expect(payload.explanation.readerSummary.keyDrivers).to.be.an("array");
      expect(payload.explanation.readerSummary.keyDrivers[0]).to.include({
        label: "Replication support",
      });
      expect(payload.explanation.readerSummary.latestScientificUpdate).to.equal(
        "A resolved replication is currently supporting the claim.",
      );
    } finally {
      await close();
    }
  });

  it("returns a generic claim work graph across review, replication, and maintenance", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/claims/1/work-graph`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.claimId).to.equal("1");
      expect(payload.summary.totalItems).to.be.greaterThan(0);
      expect(payload.summary.lanes.evaluation).to.be.greaterThan(0);
      expect(payload.summary.autoClaimableItems).to.be.a("number");
      expect(payload.summary.minimumCoverageItems).to.be.a("number");
      expect(payload.summary.redundancyTargetItems).to.be.a("number");
      expect(payload.summary.uncoveredDemand).to.be.a("number");
      expect(payload.summary.reassignmentReadyItems).to.be.a("number");
      expect(payload.items.some((item: { kind: string }) => item.kind === "review_task")).to.equal(
        true,
      );
      expect(
        payload.items.some((item: { kind: string }) => item.kind === "replication_job"),
      ).to.equal(true);
      expect(
        payload.items.some((item: { kind: string }) => item.kind === "artifact_maintenance"),
      ).to.equal(true);
      expect(payload.items[0].orchestration).to.include.keys(
        "attemptCount",
        "canClaim",
        "recommendedAction",
        "successfulContributionCount",
      );
      expect(payload.items[0].routing).to.include.keys(
        "blockedByOpenWork",
        "priorityBps",
        "rationale",
        "tier",
      );
      expect(payload.items[0].scheduling).to.include.keys(
        "autoClaimable",
        "blockingItemIds",
        "desiredAdditionalClaims",
        "needsMinimumCoverage",
        "needsRedundantCoverage",
        "prefersFreshContributor",
        "reassignmentPreferred",
        "unresolvedDependencyCount",
      );
      expect(payload.edges).to.be.an("array").that.is.not.empty;
    } finally {
      await close();
    }
  });

  it("paginates claim review state instead of truncating tasks and submissions", async () => {
    const pagedTasks: ReviewTaskView[] = Array.from({ length: 105 }, (_, index) => ({
      taskId: `paged-review-task-${index + 1}`,
      claimId: "1",
      taskType: "artifact_completeness_check",
      status: "open",
      requestedBy: "test-suite",
      inputArtifactKeys: [],
      requiredCapabilities: [],
      resultArtifactKey: null,
      consensusPolicy: {
        maxSubmissions: 1,
        minSubmissions: 1,
        requireDistinctAgents: false,
      },
      schemaVersion: "review-task.v1",
      scopeKey: `claim:1:paged-review-task:${index + 1}`,
      subjectId: "claim:1",
      subjectType: "claim",
      sourceId: null,
      failureReason: null,
      createdAt: `2026-04-16T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
        index % 60,
      ).padStart(2, "0")}.000Z`,
      updatedAt: `2026-04-16T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
        index % 60,
      ).padStart(2, "0")}.000Z`,
      completedAt: null,
    }));
    const pagedSubmissions: ReviewSubmissionView[] = Array.from({ length: 205 }, (_, index) => {
      const task = pagedTasks[index % pagedTasks.length];
      if (!task) {
        throw new Error("missing paged review task fixture");
      }
      return {
        submissionId: `paged-review-submission-${index + 1}`,
        taskId: task.taskId,
        runId: `paged-review-run-${index + 1}`,
        claimId: "1",
        reviewerActor: "0x0000000000000000000000000000000000000003",
        reviewerAgentId: "1",
        reviewType: "artifact_completeness_check",
        verdict: "pass",
        confidenceBps: 9000,
        evidenceArtifactKey: null,
        resultArtifactKey: null,
        schemaVersion: "review-task.v1",
        dimensions: {
          artifactCompleteness: 9000,
        },
        payload: {
          summary: `Submission ${index + 1}`,
        },
        createdAt: `2026-04-17T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}.000Z`,
        sourceId: null,
      };
    });

    const { baseUrl, close } = await startServer({
      readReviewSubmissionsPage: async (_pool, options) => {
        const filtered = pagedSubmissions.filter(
          (submission) =>
            (options.claimId === undefined ? true : submission.claimId === options.claimId) &&
            (options.taskId === undefined ? true : submission.taskId === options.taskId) &&
            (options.reviewerAgentId === undefined
              ? true
              : submission.reviewerAgentId === options.reviewerAgentId) &&
            (options.verdict === undefined ? true : submission.verdict === options.verdict),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
      readReviewTasksPage: async (_pool, options) => {
        const filtered = pagedTasks.filter(
          (task) =>
            (options.claimId === undefined ? true : task.claimId === options.claimId) &&
            (options.status === undefined ? true : task.status === options.status) &&
            (options.taskType === undefined ? true : task.taskType === options.taskType),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/claims/1/review`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.summary.tasks).to.equal(pagedTasks.length);
      expect(payload.summary.submissions).to.equal(pagedSubmissions.length);
      expect(payload.recentSubmissions).to.have.length(6);
    } finally {
      await close();
    }
  });

  it("paginates claim work graph reads instead of truncating work items", async () => {
    const pagedTasks: ReviewTaskView[] = Array.from({ length: 105 }, (_, index) => ({
      taskId: `graph-review-task-${index + 1}`,
      claimId: "1",
      taskType: "artifact_completeness_check",
      status: "open",
      requestedBy: "test-suite",
      inputArtifactKeys: [],
      requiredCapabilities: [],
      resultArtifactKey: null,
      consensusPolicy: {
        maxSubmissions: 1,
        minSubmissions: 1,
        requireDistinctAgents: false,
      },
      schemaVersion: "review-task.v1",
      scopeKey: `claim:1:graph-review-task:${index + 1}`,
      subjectId: "claim:1",
      subjectType: "claim",
      sourceId: null,
      failureReason: null,
      createdAt: `2026-04-16T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
        index % 60,
      ).padStart(2, "0")}.000Z`,
      updatedAt: `2026-04-16T01:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
        index % 60,
      ).padStart(2, "0")}.000Z`,
      completedAt: null,
    }));

    const { baseUrl, close } = await startServer({
      readArtifactsByClaim: async () => [],
      readClaimReplicationJobsPage: async (_pool, _claimId, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readPersistedArtifactMaintenanceTasksPage: async (_pool, _artifactKey, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReviewSubmissionsPage: async (_pool, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReviewTasksPage: async (_pool, options) => {
        const filtered = pagedTasks.filter(
          (task) =>
            (options.claimId === undefined ? true : task.claimId === options.claimId) &&
            (options.status === undefined ? true : task.status === options.status) &&
            (options.taskType === undefined ? true : task.taskType === options.taskType),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/claims/1/work-graph`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.summary.totalItems).to.equal(pagedTasks.length);
      expect(
        payload.items.filter((item: { kind: string }) => item.kind === "review_task"),
      ).to.have.length(pagedTasks.length);
    } finally {
      await close();
    }
  });

  it("returns source work graphs and source-scoped generic work items", async () => {
    const source: SourceRecordView = {
      canonicalSourceKey: "arxiv:2405.15793v1",
      createdAt: "2026-04-16T00:00:00.000Z",
      discoveryMode: "agent_discovered",
      extractionArtifactKey: "source-extraction-preview-7",
      publishedClaimId: null,
      snapshotArtifactKey: "source-snapshot-7",
      sourceId: "7",
      sourceMetadata: {
        title: "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering",
      },
      sourceType: "url",
      status: "extracting",
      submittedByActor: null,
      submittedByAgentId: "2",
      updatedAt: "2026-04-16T00:05:00.000Z",
    };
    const tasks: ReviewTaskView[] = [
      {
        claimId: null,
        completedAt: null,
        consensusPolicy: {
          maxSubmissions: 4,
          minSubmissions: 2,
          requireDistinctAgents: true,
        },
        createdAt: "2026-04-16T00:10:00.000Z",
        failureReason: null,
        inputArtifactKeys: ["source-snapshot-7"],
        requestedBy: "source-ingestion",
        requiredCapabilities: ["claim-extraction", "literature-scan"],
        resultArtifactKey: null,
        schemaVersion: "review-task.v1",
        scopeKey: "source:7:claim-extraction",
        sourceId: "7",
        subjectId: "source:7",
        subjectType: "source_record",
        status: "open",
        taskId: "9",
        taskType: "claim_extraction_check",
        updatedAt: "2026-04-16T00:10:00.000Z",
      },
    ];
    const runs: ReviewTaskRunView[] = [
      {
        agentId: "4",
        failureReason: null,
        finishedAt: "2026-04-16T00:12:00.000Z",
        lastHeartbeatAt: "2026-04-16T00:11:30.000Z",
        runId: "21",
        startedAt: "2026-04-16T00:11:00.000Z",
        status: "completed",
        taskId: "9",
        workerId: "extractor-a",
      },
    ];
    const submissions: ReviewSubmissionView[] = [
      {
        claimId: null,
        confidenceBps: 7800,
        createdAt: "2026-04-16T00:12:00.000Z",
        dimensions: {
          reviewCoverage: 6000,
        },
        evidenceArtifactKey: "source-snapshot-7",
        payload: {
          summary: "Bounded benchmark-improvement claim extracted from the paper abstract.",
        },
        resultArtifactKey: "source-candidate-7",
        reviewType: "claim_extraction_check",
        reviewerActor: "0x0000000000000000000000000000000000000004",
        reviewerAgentId: "4",
        runId: "21",
        schemaVersion: "review-task.v1",
        sourceId: "7",
        submissionId: "31",
        taskId: "9",
        verdict: "pass",
      },
    ];
    const candidates: SourceExtractionCandidate[] = [
      {
        anchors: [
          {
            label: "Abstract",
            text: "SWE-agent resolves real GitHub issues by interacting with repositories and execution environments.",
          },
        ],
        candidateId: "candidate-7-1",
        claimType: "benchmark_claim",
        confidenceBps: 7800,
        createdAt: "2026-04-16T00:12:00.000Z",
        methodology: "Automatically extracted from the manuscript snapshot.",
        reviewerAgentId: "4",
        scope: "Limited to the quantitative benchmark claim described in the paper abstract.",
        statement:
          "SWE-agent improves automated software engineering performance on real GitHub issues.",
        submissionId: "31",
        taskId: "9",
      },
    ];

    const { baseUrl, close } = await startServer({
      readReviewSubmission: async (_pool, submissionId) =>
        submissions.find((submission) => submission.submissionId === submissionId),
      readReviewSubmissionsPage: async (_pool, options) => {
        const filtered = submissions.filter(
          (submission) =>
            (options.sourceId === undefined ? true : submission.sourceId === options.sourceId) &&
            (options.taskId === undefined ? true : submission.taskId === options.taskId),
        );
        return {
          items: filtered,
          limit: options.limit ?? filtered.length,
          offset: options.offset ?? 0,
          total: filtered.length,
        };
      },
      readReviewTask: async (_pool, taskId) => tasks.find((task) => task.taskId === taskId),
      readReviewTaskRuns: async (_pool, taskId) => runs.filter((run) => run.taskId === taskId),
      readReviewTasksPage: async (_pool, options) => {
        const filtered = tasks.filter(
          (task) =>
            (options.sourceId === undefined ? true : task.sourceId === options.sourceId) &&
            (options.status === undefined ? true : task.status === options.status) &&
            (options.taskType === undefined ? true : task.taskType === options.taskType),
        );
        return {
          items: filtered,
          limit: options.limit ?? filtered.length,
          offset: options.offset ?? 0,
          total: filtered.length,
        };
      },
      readSourceExtractionCandidates: async (_pool, sourceId) =>
        sourceId === "7" ? candidates : [],
      readSourceByCanonicalKey: async (_pool, canonicalSourceKey) =>
        sourceLookupCounts.has(canonicalSourceKey)
          ? {
              canonicalSourceKey,
              createdAt: "2026-04-16T00:00:00.000Z",
              discoveryMode: "user_submitted",
              extractionArtifactKey: "source-extraction-preview-1",
              publishedClaimId: null,
              snapshotArtifactKey: "source-snapshot-1",
              sourceId: "7",
              sourceMetadata: {},
              sourceType: "url",
              status: "extracting",
              submittedByActor: null,
              submittedByAgentId: null,
              updatedAt: "2026-04-16T00:00:00.000Z",
            }
          : (() => {
              sourceLookupCounts.set(canonicalSourceKey, 1);
              return undefined;
            })(),
      readSourcePublicationDecisionsPage: async () => ({
        items: [],
        limit: 20,
        offset: 0,
        total: 0,
      }),
      readSourceSubmissionRecordsPage: async (_pool, options) => ({
        items:
          options.sourceId === "7"
            ? [
                {
                  canonicalSourceKey: "arxiv:2405.15793",
                  createdAt: "2026-04-16T00:11:00.000Z",
                  discoveryMode: "user_submitted",
                  normalizedLocator: "https://arxiv.org/abs/2405.15793",
                  rawLocator: "https://arxiv.org/abs/2405.15793",
                  sourceId: "7",
                  submissionId: "2",
                  submissionOutcome: "duplicate",
                  submittedByActor: "0x0000000000000000000000000000000000000002",
                  submittedByAgentId: null,
                },
                {
                  canonicalSourceKey: "arxiv:2405.15793",
                  createdAt: "2026-04-16T00:10:00.000Z",
                  discoveryMode: "user_submitted",
                  normalizedLocator: "https://arxiv.org/abs/2405.15793",
                  rawLocator: "https://doi.org/10.48550/arxiv.2405.15793",
                  sourceId: "7",
                  submissionId: "1",
                  submissionOutcome: "created",
                  submittedByActor: "0x0000000000000000000000000000000000000001",
                  submittedByAgentId: null,
                },
              ]
            : [],
        limit: options.limit ?? 10,
        offset: options.offset ?? 0,
        total: options.sourceId === "7" ? 2 : 0,
      }),
      readSourceRecord: async (_pool, sourceId) => (sourceId === "7" ? source : undefined),
    });

    try {
      const sourceResponse = await fetch(`${baseUrl}/sources/7`);
      expect(sourceResponse.status).to.equal(200);
      const sourcePayload = await sourceResponse.json();
      expect(sourcePayload.source.sourceId).to.equal("7");
      expect(sourcePayload.workGraph.sourceId).to.equal("7");
      expect(sourcePayload.workGraph.items).to.have.length(1);
      expect(sourcePayload.recentSubmissions.items).to.have.length(2);
      expect(sourcePayload.recentSubmissions.items[0]).to.deep.include({
        submissionOutcome: "duplicate",
      });

      const graphResponse = await fetch(`${baseUrl}/sources/7/work-graph`);
      expect(graphResponse.status).to.equal(200);
      const graphPayload = await graphResponse.json();
      expect(graphPayload.summary.totalItems).to.equal(1);
      expect(graphPayload.summary.minimumCoverageItems).to.equal(1);
      expect(
        graphPayload.subjects.some(
          (subject: { subjectType: string }) => subject.subjectType === "source_record",
        ),
      ).to.equal(true);

      const workItemsResponse = await fetch(
        `${baseUrl}/work-items?sourceId=7&kind=review_task&status=open`,
      );
      expect(workItemsResponse.status).to.equal(200);
      const workItemsPayload = await workItemsResponse.json();
      expect(workItemsPayload.total).to.equal(1);
      expect(workItemsPayload.items[0].claimId).to.equal(null);
      expect(workItemsPayload.items[0].subjectId).to.equal("source:7");

      const workItemDetailResponse = await fetch(
        `${baseUrl}/work-items/review-task%3A9?sourceId=7`,
      );
      expect(workItemDetailResponse.status).to.equal(200);
      const workItemDetailPayload = await workItemDetailResponse.json();
      expect(workItemDetailPayload.claimId).to.equal(null);
      expect(workItemDetailPayload.item.itemId).to.equal("review-task:9");
      expect(workItemDetailPayload.subject.subjectType).to.equal("source_record");
      expect(workItemDetailPayload.source.task.taskId).to.equal("9");
    } finally {
      await close();
    }
  });

  it("returns source publication decisions plus source and machine-published claim feeds/events", async () => {
    const sources: SourceRecordView[] = [
      {
        canonicalSourceKey: "arxiv:2405.15793v1",
        createdAt: "2026-04-16T00:00:00.000Z",
        discoveryMode: "agent_discovered",
        extractionArtifactKey: "source-extraction-preview-7",
        publishedClaimId: "21",
        snapshotArtifactKey: "source-snapshot-7",
        sourceId: "7",
        sourceMetadata: {
          title: "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering",
        },
        sourceType: "url",
        status: "published",
        submittedByActor: null,
        submittedByAgentId: "2",
        updatedAt: "2026-04-16T00:20:00.000Z",
      },
      {
        canonicalSourceKey: "github:openai/rae@main",
        createdAt: "2026-04-16T00:05:00.000Z",
        discoveryMode: "user_submitted",
        extractionArtifactKey: "source-extraction-preview-8",
        publishedClaimId: null,
        snapshotArtifactKey: "source-snapshot-8",
        sourceId: "8",
        sourceMetadata: {
          title: "RAE repository",
        },
        sourceType: "repository",
        status: "ready_for_publication",
        submittedByActor: "0x0000000000000000000000000000000000000008",
        submittedByAgentId: null,
        updatedAt: "2026-04-16T00:25:00.000Z",
      },
    ];
    const decisions: SourcePublicationDecisionView[] = [
      {
        competingStrengthRatio: 0.3,
        createdAt: "2026-04-16T00:18:00.000Z",
        decisionArtifactKey: "source-publication-decision-7",
        decisionId: "71",
        publishedClaimId: "21",
        reason: "auto_publish_threshold_met",
        shouldPublish: true,
        sourceId: "7",
        winningCluster: {
          averageConfidenceBps: 8050,
          clusterKey: "general|github-issues|benchmark_claim",
          distinctAgents: 2,
          memberCount: 2,
          methodology: "Consensus extraction from the manuscript abstract and benchmark table.",
          scope: "Autonomous software engineering benchmark performance on real GitHub issues.",
          statement:
            "SWE-agent improves automated software engineering performance on real GitHub issues.",
        },
      },
      {
        competingStrengthRatio: 0.92,
        createdAt: "2026-04-16T00:24:00.000Z",
        decisionArtifactKey: "source-publication-decision-8",
        decisionId: "81",
        publishedClaimId: null,
        reason: "competing_cluster_too_close",
        shouldPublish: false,
        sourceId: "8",
        winningCluster: {
          averageConfidenceBps: 7410,
          clusterKey: "general|representation-learning|general",
          distinctAgents: 2,
          memberCount: 2,
          methodology:
            "Consensus extraction from repository documentation and linked paper summary.",
          scope: "Representation learning claims described in the repository overview.",
          statement: "RAE improves representation learning quality relative to older baselines.",
        },
      },
    ];
    const claims: ReadModel["claims"] = [
      {
        author: "0x0000000000000000000000000000000000000009",
        claimId: "21",
        createdAtBlock: 77,
        domainId: 2,
        metadataHash: "0x21",
        resolutionModule: "0x0000000000000000000000000000000000000021",
        revisionOfClaimId: null,
        status: 1,
      },
      {
        author: "0x0000000000000000000000000000000000000010",
        claimId: "22",
        createdAtBlock: 81,
        domainId: 1,
        metadataHash: "0x22",
        resolutionModule: "0x0000000000000000000000000000000000000022",
        revisionOfClaimId: null,
        status: 4,
      },
    ];
    const candidatesBySourceId = new Map<string, SourceExtractionCandidate[]>([
      [
        "7",
        [
          {
            anchors: [{ label: "Abstract", text: "SWE-agent resolves more real GitHub issues." }],
            candidateId: "candidate-7-1",
            claimType: "benchmark_claim",
            confidenceBps: 8050,
            createdAt: "2026-04-16T00:12:00.000Z",
            methodology: "Automatically extracted from the manuscript snapshot.",
            reviewerAgentId: "4",
            scope: "Autonomous software engineering benchmark performance on real GitHub issues.",
            statement:
              "SWE-agent improves automated software engineering performance on real GitHub issues.",
            submissionId: "31",
            taskId: "9",
          },
        ],
      ],
      [
        "8",
        [
          {
            anchors: [{ label: "README", text: "RAE improves representation learning quality." }],
            candidateId: "candidate-8-1",
            claimType: "general",
            confidenceBps: 7410,
            createdAt: "2026-04-16T00:22:00.000Z",
            methodology: "Automatically extracted from repository documentation.",
            reviewerAgentId: "5",
            scope: "Representation learning claims described in the repository overview.",
            statement: "RAE improves representation learning quality relative to older baselines.",
            submissionId: "41",
            taskId: "10",
          },
        ],
      ],
    ]);
    const tasks: ReviewTaskView[] = [
      {
        claimId: null,
        completedAt: "2026-04-16T00:17:00.000Z",
        consensusPolicy: {
          maxSubmissions: 4,
          minSubmissions: 2,
          requireDistinctAgents: true,
        },
        createdAt: "2026-04-16T00:10:00.000Z",
        failureReason: null,
        inputArtifactKeys: ["source-snapshot-7"],
        requestedBy: "source-ingestion",
        requiredCapabilities: ["claim-extraction", "literature-scan"],
        resultArtifactKey: "source-candidate-7",
        schemaVersion: "review-task.v1",
        scopeKey: "source:7:claim-extraction",
        sourceId: "7",
        subjectId: "source:7",
        subjectType: "source_record",
        status: "completed",
        taskId: "9",
        taskType: "claim_extraction_check",
        updatedAt: "2026-04-16T00:17:00.000Z",
      },
      {
        claimId: null,
        completedAt: null,
        consensusPolicy: {
          maxSubmissions: 4,
          minSubmissions: 2,
          requireDistinctAgents: true,
        },
        createdAt: "2026-04-16T00:20:00.000Z",
        failureReason: null,
        inputArtifactKeys: ["source-snapshot-8"],
        requestedBy: "source-ingestion",
        requiredCapabilities: ["claim-extraction", "literature-scan"],
        resultArtifactKey: null,
        schemaVersion: "review-task.v1",
        scopeKey: "source:8:claim-extraction",
        sourceId: "8",
        subjectId: "source:8",
        subjectType: "source_record",
        status: "open",
        taskId: "10",
        taskType: "claim_extraction_check",
        updatedAt: "2026-04-16T00:20:00.000Z",
      },
    ];

    const { baseUrl, close } = await startServer({
      readClaim: async (_pool, claimId) => claims.find((claim) => claim.claimId === claimId),
      readClaimsPage: async (_pool, options) => {
        const filtered = claims.filter(
          (claim) =>
            (options.domainId === undefined ? true : claim.domainId === options.domainId) &&
            (options.status === undefined ? true : claim.status === options.status),
        );
        return {
          items: filtered.slice(
            options.offset ?? 0,
            (options.offset ?? 0) + (options.limit ?? filtered.length),
          ),
          limit: options.limit ?? filtered.length,
          offset: options.offset ?? 0,
          total: filtered.length,
        };
      },
      readReviewTasksPage: async (_pool, options) => {
        const filtered = tasks.filter(
          (task) =>
            (options.sourceId === undefined ? true : task.sourceId === options.sourceId) &&
            (options.status === undefined ? true : task.status === options.status),
        );
        return {
          items: filtered,
          limit: options.limit ?? filtered.length,
          offset: options.offset ?? 0,
          total: filtered.length,
        };
      },
      readSourceExtractionCandidates: async (_pool, sourceId) =>
        candidatesBySourceId.get(sourceId) ?? [],
      readSourceExtractionCandidatesForSources: async (_pool, sourceIds) =>
        new Map(sourceIds.map((sourceId) => [sourceId, candidatesBySourceId.get(sourceId) ?? []])),
      readSourcePublicationDecisionsPage: async (_pool, options) => {
        const filtered = decisions.filter(
          (decision) =>
            (options.sourceId === undefined ? true : decision.sourceId === options.sourceId) &&
            (typeof options.shouldPublish === "boolean"
              ? decision.shouldPublish === options.shouldPublish
              : true),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? filtered.length;
        return {
          items: filtered.slice(offset, offset + limit),
          limit,
          offset,
          total: filtered.length,
        };
      },
      readSourceRecord: async (_pool, sourceId) =>
        sources.find((source) => source.sourceId === sourceId),
      readSourcesPage: async (_pool, options) => {
        const filtered = sources.filter((source) =>
          options.status === undefined ? true : source.status === options.status,
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? filtered.length;
        return {
          items: filtered.slice(offset, offset + limit),
          limit,
          offset,
          total: filtered.length,
        };
      },
    });

    try {
      const decisionsResponse = await fetch(
        `${baseUrl}/sources/8/publication-decisions?shouldPublish=false`,
      );
      expect(decisionsResponse.status).to.equal(200);
      const decisionsPayload = await decisionsResponse.json();
      expect(decisionsPayload.total).to.equal(1);
      expect(decisionsPayload.items[0].reason).to.equal("competing_cluster_too_close");

      const sourceFeedResponse = await fetch(`${baseUrl}/feeds/sources?status=published`);
      expect(sourceFeedResponse.status).to.equal(200);
      const sourceFeedPayload = await sourceFeedResponse.json();
      expect(sourceFeedPayload.total).to.equal(1);
      expect(sourceFeedPayload.items[0].source.sourceId).to.equal("7");
      expect(sourceFeedPayload.items[0].candidateCount).to.equal(1);
      expect(sourceFeedPayload.items[0].latestDecision.shouldPublish).to.equal(true);

      const claimFeedResponse = await fetch(
        `${baseUrl}/feeds/claims?machineProposed=true&domainId=2`,
      );
      expect(claimFeedResponse.status).to.equal(200);
      const claimFeedPayload = await claimFeedResponse.json();
      expect(claimFeedPayload.total).to.equal(1);
      expect(claimFeedPayload.items[0].claim.claimId).to.equal("21");
      expect(claimFeedPayload.items[0].claim.machineProposed).to.equal(true);
      expect(claimFeedPayload.items[0].claim.sourceId).to.equal("7");

      const recordFeedResponse = await fetch(`${baseUrl}/feeds/claims?claimId=21&view=record`);
      expect(recordFeedResponse.status).to.equal(200);
      const recordFeedPayload = await recordFeedResponse.json();
      expect(recordFeedPayload.total).to.equal(1);
      expect(recordFeedPayload.items[0].record.claim.claimId).to.equal("21");
      expect(recordFeedPayload.items[0].record.source.source.sourceId).to.equal("7");
      expect(recordFeedPayload.items[0].record.source.candidates).to.have.length(1);

      const sourceEventsResponse = await fetch(
        `${baseUrl}/events/sources?eventType=source.published&sourceId=7`,
      );
      expect(sourceEventsResponse.status).to.equal(200);
      const sourceEventsPayload = await sourceEventsResponse.json();
      expect(sourceEventsPayload.total).to.equal(1);
      expect(sourceEventsPayload.items[0].eventType).to.equal("source.published");
      expect(sourceEventsPayload.items[0].claimId).to.equal("21");

      const claimEventsResponse = await fetch(`${baseUrl}/events/claims?claimId=21`);
      expect(claimEventsResponse.status).to.equal(200);
      const claimEventsPayload = await claimEventsResponse.json();
      expect(claimEventsPayload.total).to.equal(1);
      expect(claimEventsPayload.items[0].eventType).to.equal("claim.published.machine_proposed");
      expect(claimEventsPayload.items[0].sourceId).to.equal("7");
    } finally {
      await close();
    }
  });

  it("returns claim reward state with pool balances and settlement history", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/claims/1/rewards?limit=1&workKind=review`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.claimId).to.equal("1");
      expect(payload.totalPoolWei).to.equal("183000000000000000");
      expect(payload.policy.signals).to.be.an("array").that.is.not.empty;
      expect(payload.policy.attention).to.include.keys(
        "challengeActivityPressureBps",
        "forecastActivityPressureBps",
      );
      expect(payload.policy.signals[0]).to.include.keys(
        "schedulerPressureBps",
        "minimumCoverageItems",
        "freshContributorItems",
      );
      expect(payload.pools).to.be.an("array").that.is.not.empty;
      expect(payload.recentSettlements.items).to.have.length(1);
      expect(payload.recentSettlements.items[0].workKind).to.equal("review");
      expect(payload.settled.byWorkKind[0].workKind).to.equal("review");
    } finally {
      await close();
    }
  });

  it("returns generic reward settlement history across the protocol", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(
        `${baseUrl}/reward-settlements?claimId=1&recipient=0x0000000000000000000000000000000000000003&workKind=replication&limit=5`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.recentSettlements.total).to.equal(1);
      expect(payload.recentSettlements.items).to.have.length(1);
      expect(payload.recentSettlements.items[0].itemId).to.equal("replication-job:1");
      expect(payload.settled.settlementCount).to.equal(1);
      expect(payload.settled.totalAmountWei).to.equal("25000000000000000");
    } finally {
      await close();
    }
  });

  it("returns generic work items across claims with filtering", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(
        `${baseUrl}/work-items?claimId=1&kind=review_task&status=open&claimable=true&limit=10&offset=0`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0]).to.include({
        claimId: "1",
        itemId: "review-task:2",
        kind: "review_task",
        lane: "evaluation",
        status: "open",
      });
      expect(payload.items[0].agentActions.claim).to.equal("review_task_claim");
      expect(payload.items[0].policy.requiredCapabilities).to.deep.equal([
        "literature-scan",
        "claim-comparison",
      ]);
      expect(payload.items[0].orchestration.canClaim).to.equal(true);
      expect(payload.items[0].orchestration.recommendedAction).to.equal("claim");
      expect(payload.items[0].routing.priorityBps).to.be.a("number");
      expect(payload.items[0].routing.tier).to.be.a("string");
      expect(payload.items[0].scheduling.autoClaimable).to.equal(true);
    } finally {
      await close();
    }
  });

  it("returns generic work item detail with related edges and subject context", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/work-items/review-task%3A1?claimId=1`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.claimId).to.equal("1");
      expect(payload.item.itemId).to.equal("review-task:1");
      expect(payload.item.kind).to.equal("review_task");
      expect(payload.agentActions.claim).to.equal("review_task_claim");
      expect(payload.source.kind).to.equal("review_task");
      expect(payload.source.task.taskId).to.equal("1");
      expect(payload.source.submissions).to.have.length(2);
      expect(payload.subject).to.deep.include({
        subjectId: "claim:1",
        subjectType: "claim",
      });
      expect(payload.item.orchestration).to.include({
        canClaim: false,
        recommendedAction: "complete",
      });
      expect(payload.item.routing).to.include.keys("priorityBps", "tier");
      expect(payload.edges).to.be.an("array").that.is.not.empty;
      expect(
        payload.edges.some(
          (edge: { fromId: string; relation: string; toId: string }) =>
            edge.fromId === "claim:1" &&
            edge.relation === "evaluates" &&
            edge.toId === "review-task:1",
        ),
      ).to.equal(true);
    } finally {
      await close();
    }
  });

  it("returns per-agent review calibration history", async () => {
    const calibrationClaims = [
      {
        claimId: "1",
        author: "0x0000000000000000000000000000000000000001",
        domainId: 1,
        metadataHash: "0x01",
        resolutionModule: "0x0000000000000000000000000000000000000010",
        status: 1,
        revisionOfClaimId: null,
        createdAtBlock: 2,
      },
      {
        claimId: "2",
        author: "0x0000000000000000000000000000000000000001",
        domainId: 1,
        metadataHash: "0x02",
        resolutionModule: "0x0000000000000000000000000000000000000010",
        status: 4,
        revisionOfClaimId: null,
        createdAtBlock: 8,
      },
      {
        claimId: "3",
        author: "0x0000000000000000000000000000000000000001",
        domainId: 1,
        metadataHash: "0x03",
        resolutionModule: "0x0000000000000000000000000000000000000010",
        status: 5,
        revisionOfClaimId: null,
        createdAtBlock: 12,
      },
    ];
    const calibrationSubmissions: ReviewSubmissionView[] = [
      {
        submissionId: "hist-1",
        taskId: "hist-task-1",
        runId: "hist-run-1",
        claimId: "2",
        reviewerActor: "0x0000000000000000000000000000000000000003",
        reviewerAgentId: "1",
        reviewType: "artifact_completeness_check",
        verdict: "pass",
        confidenceBps: 9000,
        evidenceArtifactKey: null,
        resultArtifactKey: null,
        schemaVersion: "review-task.v1",
        dimensions: {
          artifactCompleteness: 8800,
        },
        payload: {
          summary: "Artifacts are complete on the resolved corroborating claim.",
        },
        createdAt: "2026-03-10T00:00:00.000Z",
      },
      {
        submissionId: "hist-2",
        taskId: "hist-task-2",
        runId: "hist-run-2",
        claimId: "3",
        reviewerActor: "0x0000000000000000000000000000000000000003",
        reviewerAgentId: "1",
        reviewType: "contradiction_scan",
        verdict: "flag",
        confidenceBps: 7800,
        evidenceArtifactKey: null,
        resultArtifactKey: null,
        schemaVersion: "review-task.v1",
        dimensions: {
          contradictionPressure: 7600,
        },
        payload: {
          summary: "Contradiction pressure was correctly elevated on the refuted claim.",
        },
        createdAt: "2026-03-11T00:00:00.000Z",
      },
    ];
    const { baseUrl, close } = await startServer({
      readClaimsPage: async (_pool, options) => ({
        items: calibrationClaims.slice(
          options.offset ?? 0,
          (options.offset ?? 0) + (options.limit ?? 20),
        ),
        total: calibrationClaims.length,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReviewSubmissionsPage: async (_pool, options) => {
        const filtered = calibrationSubmissions.filter(
          (submission) =>
            (options.claimId === undefined ? true : submission.claimId === options.claimId) &&
            (options.reviewerAgentId === undefined
              ? true
              : submission.reviewerAgentId === options.reviewerAgentId) &&
            (options.taskId === undefined ? true : submission.taskId === options.taskId) &&
            (options.verdict === undefined ? true : submission.verdict === options.verdict),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/agents/1/review-calibration?limit=1`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.agentId).to.equal("1");
      expect(payload.reviewerActor).to.equal("0x0000000000000000000000000000000000000003");
      expect(payload.samples).to.equal(2);
      expect(payload.averageCalibrationBps).to.equal(9750);
      expect(payload.weightBps).to.equal(9850);
      expect(payload.contributions.total).to.equal(2);
      expect(payload.contributions.limit).to.equal(1);
      expect(payload.contributions.items).to.have.length(1);
      expect(payload.contributions.items[0]).to.include({
        claimId: "3",
        calibrationBps: 10000,
        predictedSupportBps: 2000,
        outcomeSupportBps: 2000,
        reviewType: "contradiction_scan",
        verdict: "flag",
      });
    } finally {
      await close();
    }
  });

  it("paginates per-agent review calibration history instead of truncating at 1000 rows", async () => {
    const sampleCount = 1005;
    const calibrationClaims = Array.from({ length: sampleCount }, (_, index) => ({
      claimId: `${index + 1}`,
      author: "0x0000000000000000000000000000000000000001",
      domainId: 1,
      metadataHash: `0x${String(index + 1).padStart(2, "0")}`,
      resolutionModule: "0x0000000000000000000000000000000000000010",
      status: 4,
      revisionOfClaimId: null,
      createdAtBlock: index + 1,
    }));
    const calibrationSubmissions: ReviewSubmissionView[] = Array.from(
      { length: sampleCount },
      (_, index) => ({
        submissionId: `hist-paged-${index + 1}`,
        taskId: `hist-paged-task-${index + 1}`,
        runId: `hist-paged-run-${index + 1}`,
        claimId: `${index + 1}`,
        reviewerActor: "0x0000000000000000000000000000000000000003",
        reviewerAgentId: "1",
        reviewType: "artifact_completeness_check",
        verdict: "pass",
        confidenceBps: 9000,
        evidenceArtifactKey: null,
        resultArtifactKey: null,
        schemaVersion: "review-task.v1",
        dimensions: {
          artifactCompleteness: 9000,
        },
        payload: {
          summary: `Calibration sample ${index + 1}`,
        },
        createdAt: `2026-03-12T${String(Math.floor(index / 3600)).padStart(2, "0")}:${String(
          Math.floor((index % 3600) / 60),
        ).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      }),
    );
    const { baseUrl, close } = await startServer({
      readClaimsPage: async (_pool, options) => ({
        items: calibrationClaims.slice(
          options.offset ?? 0,
          (options.offset ?? 0) + (options.limit ?? 20),
        ),
        total: calibrationClaims.length,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReviewSubmissionsPage: async (_pool, options) => {
        const filtered = calibrationSubmissions.filter(
          (submission) =>
            (options.claimId === undefined ? true : submission.claimId === options.claimId) &&
            (options.reviewerAgentId === undefined
              ? true
              : submission.reviewerAgentId === options.reviewerAgentId) &&
            (options.taskId === undefined ? true : submission.taskId === options.taskId) &&
            (options.verdict === undefined ? true : submission.verdict === options.verdict),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/agents/1/review-calibration?limit=1`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.samples).to.equal(sampleCount);
      expect(payload.contributions.total).to.equal(sampleCount);
      expect(payload.averageCalibrationBps).to.equal(9500);
    } finally {
      await close();
    }
  });

  it("returns per-agent reward state with budget, withdrawable balance, and settlements", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/agents/1/rewards?limit=1`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.agentId).to.equal("1");
      expect(payload.operator).to.equal("0x0000000000000000000000000000000000000003");
      expect(payload.budgetBalanceWei).to.equal("100");
      expect(payload.withdrawableRewardBalanceWei).to.equal("20000000000000000");
      expect(payload.recentSettlements.items).to.have.length(1);
      expect(payload.settled.totalAmountWei).to.equal("40000000000000000");
    } finally {
      await close();
    }
  });

  it("returns generic recipient reward state with withdrawable balance and settlements", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(
        `${baseUrl}/recipients/0x0000000000000000000000000000000000000003/rewards?workKind=replication`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.recipient).to.equal("0x0000000000000000000000000000000000000003");
      expect(payload.withdrawableRewardBalanceWei).to.equal("20000000000000000");
      expect(payload.recentSettlements.items).to.have.length(1);
      expect(payload.recentSettlements.items[0].workKind).to.equal("replication");
      expect(payload.settled.totalAmountWei).to.equal("25000000000000000");
    } finally {
      await close();
    }
  });

  it("returns reward protocol config for wallet-assisted funding and withdrawal", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/reward-config`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload).to.include({
        chainId: 31337,
        network: "localhost",
      });
      expect(payload.claimRewardVaultAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
      expect(payload.rpcUrl).to.equal("http://127.0.0.1:8545");
    } finally {
      await close();
    }
  });

  it("returns per-agent offchain work summaries", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/agents/1/work-summary?domainId=1`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload).to.deep.include({
        agentId: "1",
        domainId: 1,
      });
      expect(payload.summary).to.include({
        agentId: "1",
        averageReviewCalibrationBps: null,
        calibratedReviewSamples: 0,
        effectiveReviewWeightBps: 10000,
        maintenanceAuditCount: 1,
        maintenanceFailureCount: 0,
        maintenanceRepairCount: 0,
        qualifiedReplicationCount: 0,
        refutedReplicationCount: 0,
        replicationCount: 0,
        reviewSubmissionCount: 1,
        supportedReplicationCount: 0,
        workScore: 4,
      });
    } finally {
      await close();
    }
  });

  it("paginates per-agent offchain work summaries instead of truncating at 1000 rows", async () => {
    const sampleCount = 1005;
    const claims = Array.from({ length: sampleCount }, (_, index) => ({
      claimId: `${index + 1}`,
      author: "0x0000000000000000000000000000000000000001",
      domainId: 1,
      metadataHash: `0xwork${index + 1}`,
      resolutionModule: "0x0000000000000000000000000000000000000010",
      status: 4,
      revisionOfClaimId: null,
      createdAtBlock: index + 1,
    }));
    const tasks: ReviewTaskView[] = claims.map((claim, index) => ({
      taskId: `work-summary-task-${index + 1}`,
      claimId: claim.claimId,
      taskType: "artifact_completeness_check",
      status: "completed",
      requestedBy: "test-suite",
      inputArtifactKeys: [],
      requiredCapabilities: [],
      resultArtifactKey: null,
      consensusPolicy: {
        maxSubmissions: 1,
        minSubmissions: 1,
        requireDistinctAgents: false,
      },
      schemaVersion: "review-task.v1",
      scopeKey: `claim:${claim.claimId}:work-summary`,
      subjectId: `claim:${claim.claimId}`,
      subjectType: "claim",
      sourceId: null,
      failureReason: null,
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:05:00.000Z",
      completedAt: "2026-03-13T00:05:00.000Z",
    }));
    const submissions: ReviewSubmissionView[] = claims.map((claim, index) => {
      const task = tasks[index];
      if (!task) {
        throw new Error("missing work-summary review task fixture");
      }
      return {
        submissionId: `work-summary-submission-${index + 1}`,
        taskId: task.taskId,
        runId: `work-summary-run-${index + 1}`,
        claimId: claim.claimId,
        reviewerActor: "0x0000000000000000000000000000000000000003",
        reviewerAgentId: "1",
        reviewType: "artifact_completeness_check",
        verdict: "pass",
        confidenceBps: 9000,
        evidenceArtifactKey: null,
        resultArtifactKey: null,
        schemaVersion: "review-task.v1",
        dimensions: {
          artifactCompleteness: 9000,
        },
        payload: {
          summary: `Work summary sample ${index + 1}`,
        },
        createdAt: "2026-03-13T00:06:00.000Z",
      };
    });

    const { baseUrl, close } = await startServer({
      readClaimsPage: async (_pool, options) => ({
        items: claims.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 20)),
        total: claims.length,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReplicationsPage: async (_pool, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReplicationJobsPage: async (_pool, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readReviewSubmissionsPage: async (_pool, options) => {
        const filtered = submissions.filter(
          (submission) =>
            (options.claimId === undefined ? true : submission.claimId === options.claimId) &&
            (options.reviewerAgentId === undefined
              ? true
              : submission.reviewerAgentId === options.reviewerAgentId) &&
            (options.taskId === undefined ? true : submission.taskId === options.taskId) &&
            (options.verdict === undefined ? true : submission.verdict === options.verdict),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
      readReviewTasksPage: async (_pool, options) => {
        const filtered = tasks.filter(
          (task) =>
            (options.claimId === undefined ? true : task.claimId === options.claimId) &&
            (options.status === undefined ? true : task.status === options.status) &&
            (options.taskType === undefined ? true : task.taskType === options.taskType),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
    });

    try {
      const response = await fetch(`${baseUrl}/agents/1/work-summary?domainId=1`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.summary.reviewSubmissionCount).to.equal(sampleCount);
      expect(payload.summary.calibratedReviewSamples).to.equal(sampleCount);
      expect(payload.summary.averageReviewCalibrationBps).to.equal(9500);
    } finally {
      await close();
    }
  });

  it("returns agent runtime events across work, request, and checkpoint feeds", async () => {
    const { baseUrl, close } = await startServer({
      readCheckpointPublicationsPage: async (_pool, options) => ({
        items: [
          {
            publicationId: "9",
            payloadId: "2",
            domainId: 1,
            publisher: "0x0000000000000000000000000000000000000007",
            requestId: "12",
            subjectType: 3,
            subjectActor: "0x0000000000000000000000000000000000000000",
            subjectClaimId: "0",
            subjectAgentId: options.subjectAgentId ?? "1",
            subjectModule: "0x0000000000000000000000000000000000000000",
            scoreVectorHash: "0xa900",
            payloadHash: "0xa901",
            uri: "ipfs://agent-checkpoint",
            status: "submitted",
            checkpointId: "7",
            txHash: "0xfeed",
            failureReason: null,
            createdAt: "2026-03-11T00:12:00.000Z",
            publishedAt: "2026-03-11T00:12:10.000Z",
            updatedAt: "2026-03-11T00:12:10.000Z",
          },
        ],
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
        total: 1,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/agent-runtime/events?agentId=1&limit=10&since=2026-03-11T00:00:00.000Z`,
      );
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.total).to.be.greaterThan(0);
      expect(
        payload.items.every((item: { agentIds: string[] }) => item.agentIds.includes("1")),
      ).to.equal(true);
      expect(
        payload.items.some(
          (item: { eventType: string }) => item.eventType === "agent_request.accepted",
        ),
      ).to.equal(true);
      expect(
        payload.items.some(
          (item: { eventType: string }) => item.eventType === "checkpoint_publication.submitted",
        ),
      ).to.equal(true);
      expect(
        payload.items.some((item: { eventType: string }) =>
          item.eventType.startsWith("work_item."),
        ),
      ).to.equal(true);
    } finally {
      await close();
    }
  });

  it("paginates agent runtime events instead of truncating accepted requests at 1000 rows", async () => {
    const sampleCount = 1005;
    const requests: AgentRequestView[] = Array.from({ length: sampleCount }, (_, index) => ({
      requestId: `${index + 1}`,
      actionType: "review_task_claim",
      agentId: "1",
      actorAddress: "0x0000000000000000000000000000000000000003",
      requestNonce: `nonce-${index + 1}`,
      scopeKey: `review-task:${index + 1}`,
      requestHash: `0x${String(index + 1).padStart(64, "0")}`,
      signature: "0xsigned-agent",
      payload: {
        claimId: "1",
        workerId: `worker-${index + 1}`,
      },
      status: "accepted",
      outcomeDetail: `claimed review task ${index + 1}`,
      createdAt: `2026-03-14T${String(Math.floor(index / 3600)).padStart(2, "0")}:${String(
        Math.floor((index % 3600) / 60),
      ).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      updatedAt: `2026-03-14T${String(Math.floor(index / 3600)).padStart(2, "0")}:${String(
        Math.floor((index % 3600) / 60),
      ).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    }));
    const { baseUrl, close } = await startServer({
      readAgentRequestsPage: async (_pool, options) => {
        const filtered = requests.filter(
          (request) =>
            (options.actionType === undefined ? true : request.actionType === options.actionType) &&
            (options.agentId === undefined ? true : request.agentId === options.agentId) &&
            (options.scopeKey === undefined ? true : request.scopeKey === options.scopeKey) &&
            (options.status === undefined ? true : request.status === options.status),
        );
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 20;
        return {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length,
          limit,
          offset,
        };
      },
      readCheckpointPublicationsPage: async (_pool, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
      readClaimsPage: async (_pool, options) => ({
        items: [],
        total: 0,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(`${baseUrl}/agent-runtime/events?agentId=1&limit=1`);
      expect(response.status).to.equal(200);
      const payload = await response.json();
      expect(payload.total).to.equal(sampleCount);
      expect(payload.items).to.have.length(1);
    } finally {
      await close();
    }
  });

  it("returns agent webhook subscriptions and deliveries", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const subscriptionsResponse = await fetch(
        `${baseUrl}/agent-webhook-subscriptions?agentId=1&status=active`,
      );
      expect(subscriptionsResponse.status).to.equal(200);
      const subscriptionsPayload = await subscriptionsResponse.json();
      expect(subscriptionsPayload.total).to.equal(1);
      expect(subscriptionsPayload.items[0]).to.include({
        agentId: "1",
        status: "active",
        subscriptionId: "1",
        targetUrl: "redacted",
      });
      expect(subscriptionsPayload.items[0]).to.not.have.property("signingSecret");

      const subscriptionResponse = await fetch(`${baseUrl}/agent-webhook-subscriptions/1`);
      expect(subscriptionResponse.status).to.equal(200);
      const subscriptionPayload = await subscriptionResponse.json();
      expect(subscriptionPayload.signingSecretPreview).to.equal("redacted");

      const deliveriesResponse = await fetch(
        `${baseUrl}/agent-webhook-subscriptions/1/deliveries?status=delivered`,
      );
      expect(deliveriesResponse.status).to.equal(200);
      const deliveriesPayload = await deliveriesResponse.json();
      expect(deliveriesPayload.total).to.equal(1);
      expect(deliveriesPayload.items[0]).to.include({
        deliveryId: "1",
        eventId: "agent-request:1:accepted",
        eventType: "agent_request.accepted",
        subscriptionId: "1",
      });

      const deliveryResponse = await fetch(`${baseUrl}/agent-webhook-deliveries/1`);
      expect(deliveryResponse.status).to.equal(200);
      const deliveryPayload = await deliveryResponse.json();
      expect(deliveryPayload.responseStatus).to.equal(200);
      expect(deliveryPayload.responseBody).to.equal(undefined);
      expect(deliveryPayload.signature).to.equal(undefined);
    } finally {
      await close();
    }
  });

  it("creates, pings, and deletes agent webhook subscriptions through signed agent requests", async () => {
    const wallet = Wallet.createRandom();
    const { baseUrl, close } = await startServer({
      readAgent: async (_pool, agentId) =>
        agentId === "1"
          ? {
              agentId: "1",
              operator: wallet.address,
              metadataHash: "0x07",
              uri: "ipfs://agent",
              budgetBalance: "100",
              reservedBudget: "0",
              spendLimit: "50",
              active: true,
            }
          : undefined,
    });

    try {
      const createSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "webhook_subscription_create",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {
          eventTypes: ["work_item.claimable", "agent_request.accepted"],
          label: "Agent inbox",
          targetUrl: "https://hooks.example.org/agents/1",
        },
        requestNonce: "nonce-webhook-create-1",
        scopeKey: "agent-webhook-subscriptions:1",
      });
      const createResponse = await fetch(`${baseUrl}/agent/webhook-subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createSigned),
      });
      expect(createResponse.status).to.equal(200);
      const createPayload = await createResponse.json();
      expect(createPayload.ok).to.equal(true);
      expect(createPayload.result.subscription).to.include({
        agentId: "1",
        label: "Agent inbox",
        targetUrl: "https://hooks.example.org/agents/1",
      });
      expect(createPayload.result.signingSecret).to.be.a("string");

      const subscriptionId = createPayload.result.subscription.subscriptionId;

      const pingSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "webhook_subscription_ping",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {},
        requestNonce: "nonce-webhook-ping-1",
        scopeKey: `agent-webhook-subscription:${subscriptionId}`,
      });
      const pingResponse = await fetch(
        `${baseUrl}/agent/webhook-subscriptions/${subscriptionId}/ping`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pingSigned),
        },
      );
      expect(pingResponse.status).to.equal(200);
      const pingPayload = await pingResponse.json();
      expect(pingPayload.result.delivery.eventType).to.equal("webhook.ping");

      const deleteSigned = await buildSignedAgentRequestBody(wallet, {
        actionType: "webhook_subscription_delete",
        actorAddress: wallet.address,
        agentId: "1",
        issuedAt: new Date().toISOString(),
        payload: {},
        requestNonce: "nonce-webhook-delete-1",
        scopeKey: `agent-webhook-subscription:${subscriptionId}`,
      });
      const deleteResponse = await fetch(
        `${baseUrl}/agent/webhook-subscriptions/${subscriptionId}/delete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(deleteSigned),
        },
      );
      expect(deleteResponse.status).to.equal(200);
      const deletePayload = await deleteResponse.json();
      expect(deletePayload.result.status).to.equal("inactive");
    } finally {
      await close();
    }
  });

  it("rejects invalid claim view parameters with HTTP 400", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/claims/1?view=verbose`);
      expect(response.status).to.equal(400);
      expect(await response.json()).to.deep.equal({
        error: "invalid_query_parameter",
        parameter: "view",
        expected: "full|summary",
      });
    } finally {
      await close();
    }
  });

  it("rejects invalid agent runtime event timestamp filters with HTTP 400", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/agent-runtime/events?since=not-a-date`);
      expect(response.status).to.equal(400);
      expect(await response.json()).to.deep.equal({
        error: "invalid_query_parameter",
        parameter: "since",
        expected: "iso8601 timestamp",
      });
    } finally {
      await close();
    }
  });

  it("returns filtered forecast results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readForecastsPage: async (_pool, options) => ({
        items: [
          {
            forecastId: "2",
            claimId: options.claimId ?? "2",
            forecaster: options.forecaster ?? "0x0000000000000000000000000000000000000011",
            agentId: options.agentId ?? "7",
            commitmentHash: "0x18",
            stakeAmount: "25",
            committedAt: 11,
            revealDeadline: 12,
            revealed: options.revealed ?? true,
            settled: options.settled ?? true,
            direction: 1,
            confidenceBps: 7500,
            effectiveDecisionIdAtCommit: "8",
            resolutionDecisionId: "9",
            finalStatus: options.finalStatus ?? 2,
            matched: false,
            payoutAmount: "0",
          },
        ],
        total: 2,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/forecasts?limit=5&offset=1&claimId=2&forecaster=0xabc&agentId=7&revealed=true&settled=true&finalStatus=2`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(2);
      expect(payload.limit).to.equal(5);
      expect(payload.offset).to.equal(1);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("2");
      expect(payload.items[0].settled).to.equal(true);
      expect(payload.items[0].finalStatus).to.equal(2);
      expect(payload.items[0].effectiveDecisionIdAtCommit).to.equal("8");
      expect(payload.items[0].resolutionDecisionId).to.equal("9");
    } finally {
      await close();
    }
  });

  it("returns filtered challenge results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readChallengesPage: async (_pool, options) => ({
        items: [
          {
            challengeId: "2",
            claimId: options.claimId ?? "3",
            replicationId: options.replicationId ?? "4",
            challenger: options.challenger ?? "0x0000000000000000000000000000000000000012",
            agentId: options.agentId ?? "8",
            evidenceHash: "0x19",
            evidenceURI: "ipfs://challenge-2",
            bondAmount: "7",
            status: options.status ?? 2,
            resolutionHash: "0x20",
            createdAt: 13,
            resolvedAt: 14,
            payoutAmount: "1",
            refundedAmount: "0",
          },
        ],
        total: 3,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/challenges?limit=3&offset=0&claimId=3&replicationId=4&challenger=0xdef&agentId=8&status=2`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(3);
      expect(payload.limit).to.equal(3);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("3");
      expect(payload.items[0].status).to.equal(2);
    } finally {
      await close();
    }
  });

  it("returns filtered appeal results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readAppealsPage: async (_pool, options) => ({
        items: [
          {
            appealId: "2",
            claimId: options.claimId ?? "4",
            replicationId: options.replicationId ?? "5",
            challengeId: options.challengeId ?? "6",
            appellant: options.appellant ?? "0x0000000000000000000000000000000000000013",
            reason: options.reason ?? 3,
            filingHash: "0x21",
            uri: "ipfs://appeal-2",
            status: options.status ?? 2,
            adjudicationHash: "0x22",
            adjudicationURI: "ipfs://adjudication-2",
            bondAmount: "9",
            createdAt: 15,
            adjudicatedAt: 16,
            refundedAmount: "0",
          },
        ],
        total: 1,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/appeals?limit=2&offset=0&claimId=4&replicationId=5&challengeId=6&appellant=0x123&reason=3&status=2`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.limit).to.equal(2);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].challengeId).to.equal("6");
      expect(payload.items[0].reason).to.equal(3);
      expect(payload.items[0].status).to.equal(2);
    } finally {
      await close();
    }
  });

  it("returns filtered artifact results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readArtifactsPage: async (_pool, options) => ({
        items: [
          {
            artifactId: "2",
            claimId: options.claimId ?? "9",
            artifactType: options.artifactType ?? 2,
            contentDigest: "0x23",
            uri: "ipfs://artifact-2",
            submitter: options.submitter ?? "0x0000000000000000000000000000000000000014",
          },
        ],
        total: 3,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/artifacts?limit=3&offset=1&claimId=9&artifactType=2&submitter=0xaaa`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(3);
      expect(payload.limit).to.equal(3);
      expect(payload.offset).to.equal(1);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("9");
      expect(payload.items[0].artifactType).to.equal(2);
    } finally {
      await close();
    }
  });

  it("returns replication jobs for a claim", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/claims/1/replication-jobs?limit=10&offset=0`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("1");
    } finally {
      await close();
    }
  });

  it("returns replication job detail with runs and persisted artifact metadata", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/replication-jobs/1`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.jobId).to.equal("1");
      expect(payload.resultArtifact.artifactKey).to.equal("replication-result-abc123");
      expect(payload.resultArtifact.replicas).to.have.length(2);
      expect(payload.resultArtifact.provenance.sourceType).to.equal("repository");
      expect(payload.resultArtifact.storagePolicy.durabilityClass).to.equal("A");
      expect(payload.resultArtifact.storageAttestations).to.have.length(1);
      expect(payload.resultArtifact.recentAudits.total).to.equal(2);
      expect(payload.runs).to.have.length(1);
      expect(payload.runs[0].status).to.equal("completed");
    } finally {
      await close();
    }
  });

  it("returns persisted artifact detail with replicas, audits, and provenance", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/persisted-artifacts/replication-result-abc123`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.artifactKey).to.equal("replication-result-abc123");
      expect(payload.replicas).to.have.length(2);
      expect(payload.replicas[1]?.providerMetadata?.filecoin?.dealCount).to.equal(1);
      expect(payload.recentAudits.items).to.have.length(2);
      expect(payload.provenance.sourceLocator).to.equal(
        "https://github.com/example/repro-benchmark",
      );
      expect(payload.storagePolicy.requiredIndependentRetrievalPaths).to.equal(2);
      expect(payload.storageAttestations[0].commitmentKind).to.equal("filecoin");
    } finally {
      await close();
    }
  });

  it("streams persisted artifact content through the public API", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifact-content-"));
    const filePath = path.join(tempRoot, "replication-result.json");
    const body = Buffer.from('{"status":"ok","kind":"replication-result"}\n', "utf8");
    await writeFile(filePath, body);

    const { baseUrl, close } = await startServer({
      readPersistedArtifact: async (_pool, artifactKey) =>
        artifactKey === "replication-result-abc123"
          ? {
              artifactKey,
              byteLength: body.byteLength,
              contentType: "application/json",
              createdAt: "2026-03-11T00:05:00.000Z",
              kind: "replication-result",
              sha256: `0x${sha256Hex(body)}`,
              storagePath: filePath,
            }
          : null,
    });

    try {
      const response = await fetch(
        `${baseUrl}/persisted-artifacts/replication-result-abc123/content`,
      );
      expect(response.status).to.equal(200);
      expect(response.headers.get("content-type")).to.contain("application/json");
      expect(response.headers.get("content-length")).to.equal(String(body.byteLength));
      expect(Buffer.from(await response.arrayBuffer()).equals(body)).to.equal(true);
    } finally {
      await close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("returns paginated audit history for a persisted artifact", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(
        `${baseUrl}/persisted-artifacts/replication-result-abc123/audits?limit=5&offset=0`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(2);
      expect(payload.items[0].provider).to.equal("filesystem");
    } finally {
      await close();
    }
  });

  it("returns persisted artifact maintenance tasks", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(
        `${baseUrl}/persisted-artifacts/replication-result-abc123/maintenance-tasks?limit=5&offset=0`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(2);
      expect(payload.items[0].artifactKey).to.equal("replication-result-abc123");
      expect(payload.items[0].taskType).to.equal("audit");
    } finally {
      await close();
    }
  });

  it("returns artifact maintenance task detail with artifact context and runs", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/artifact-maintenance-tasks/1`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.task.taskId).to.equal("1");
      expect(payload.task.taskType).to.equal("audit");
      expect(payload.artifact.artifactKey).to.equal("replication-result-abc123");
      expect(payload.runs).to.have.length(1);
      expect(payload.runs[0].summaryArtifactKey).to.equal("artifact-maintenance-audit-result-1111");
    } finally {
      await close();
    }
  });

  it("returns filtered claim replication results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readReplicationsPage: async (_pool, options) => ({
        items: [
          {
            replicationId: "2",
            claimId: options.claimId ?? "11",
            replicator: options.replicator ?? "0x0000000000000000000000000000000000000015",
            agentId: options.agentId ?? "12",
            resultHash: "0x24",
            outcome: options.outcome ?? 1,
            resolutionStatus: options.resolutionStatus ?? 2,
            confidenceBps: options.confidenceBps ?? 8500,
            resolverType: options.resolverType ?? 3,
            resolutionHash: "0x25",
            evidenceHash: "0x26",
            evidenceURI: "ipfs://replication-2",
          },
        ],
        total: 2,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/claims/11/replications?limit=2&offset=0&replicator=0xbbb&agentId=12&outcome=1&resolutionStatus=2&resolverType=3&confidenceBps=8500`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(2);
      expect(payload.limit).to.equal(2);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("11");
      expect(payload.items[0].resolutionStatus).to.equal(2);
      expect(payload.items[0].resolverType).to.equal(3);
    } finally {
      await close();
    }
  });

  it("returns filtered actor checkpoint results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readCheckpointsPage: async (_pool, options) => ({
        items: [
          {
            checkpointId: "2",
            domainId: options.domainId ?? 4,
            subjectType: options.subjectType ?? 2,
            subjectActor: options.subjectActor ?? "0x0000000000000000000000000000000000000016",
            subjectClaimId: options.claimId ?? "13",
            subjectAgentId: options.subjectAgentId ?? "14",
            subjectModule: options.subjectModule ?? "0x0000000000000000000000000000000000000030",
            scoreVectorHash: "0x27",
            payloadHash: "0x28",
            uri: "ipfs://checkpoint-2",
          },
        ],
        total: 1,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const actor = "0x0000000000000000000000000000000000000016";
      const response = await fetch(
        `${baseUrl}/actors/${actor}/checkpoints?limit=4&offset=0&claimId=13&domainId=4&subjectType=2&subjectAgentId=14&subjectModule=0x0000000000000000000000000000000000000030`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.limit).to.equal(4);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].subjectActor).to.equal(actor);
      expect(payload.items[0].subjectClaimId).to.equal("13");
      expect(payload.items[0].domainId).to.equal(4);
    } finally {
      await close();
    }
  });

  it("returns filtered claim forecast results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readForecastsPage: async (_pool, options) => ({
        items: [
          {
            forecastId: "3",
            claimId: options.claimId ?? "21",
            forecaster: options.forecaster ?? "0x0000000000000000000000000000000000000017",
            agentId: options.agentId ?? "15",
            commitmentHash: "0x29",
            stakeAmount: "30",
            committedAt: 17,
            revealDeadline: 18,
            revealed: options.revealed ?? true,
            settled: options.settled ?? false,
            direction: 0,
            confidenceBps: 6500,
            finalStatus: options.finalStatus ?? null,
            matched: null,
            payoutAmount: null,
          },
        ],
        total: 1,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/claims/21/forecasts?limit=4&offset=0&forecaster=0xccc&agentId=15&revealed=true&settled=false`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.limit).to.equal(4);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("21");
      expect(payload.items[0].settled).to.equal(false);
    } finally {
      await close();
    }
  });

  it("returns filtered claim challenge results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readChallengesPage: async (_pool, options) => ({
        items: [
          {
            challengeId: "3",
            claimId: options.claimId ?? "22",
            replicationId: options.replicationId ?? "31",
            challenger: options.challenger ?? "0x0000000000000000000000000000000000000018",
            agentId: options.agentId ?? "16",
            evidenceHash: "0x30",
            evidenceURI: "ipfs://challenge-3",
            bondAmount: "11",
            status: options.status ?? 3,
            resolutionHash: "0x31",
            createdAt: 19,
            resolvedAt: 20,
            payoutAmount: "0",
            refundedAmount: "0",
          },
        ],
        total: 2,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/claims/22/challenges?limit=2&offset=1&replicationId=31&challenger=0xddd&agentId=16&status=3`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(2);
      expect(payload.offset).to.equal(1);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("22");
      expect(payload.items[0].status).to.equal(3);
    } finally {
      await close();
    }
  });

  it("returns filtered claim appeal results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readAppealsPage: async (_pool, options) => ({
        items: [
          {
            appealId: "3",
            claimId: options.claimId ?? "23",
            replicationId: options.replicationId ?? "32",
            challengeId: options.challengeId ?? "33",
            appellant: options.appellant ?? "0x0000000000000000000000000000000000000019",
            reason: options.reason ?? 4,
            filingHash: "0x32",
            uri: "ipfs://appeal-3",
            status: options.status ?? 3,
            adjudicationHash: null,
            adjudicationURI: null,
            bondAmount: "13",
            createdAt: 21,
            adjudicatedAt: null,
            refundedAmount: null,
          },
        ],
        total: 1,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/claims/23/appeals?limit=1&offset=0&replicationId=32&challengeId=33&appellant=0xeee&reason=4&status=3`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].claimId).to.equal("23");
      expect(payload.items[0].reason).to.equal(4);
      expect(payload.items[0].status).to.equal(3);
    } finally {
      await close();
    }
  });

  it("returns filtered agent controller results when query parameters are provided", async () => {
    const { baseUrl, close } = await startServer({
      readAgentControllersPage: async (_pool, options) => ({
        items: [
          {
            agentId: options.agentId ?? "24",
            controller: options.controller ?? "0x0000000000000000000000000000000000000020",
            authorized: options.authorized ?? true,
          },
        ],
        total: 1,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(
        `${baseUrl}/agents/24/controllers?limit=6&offset=0&controller=0xfff&authorized=true`,
      );
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.total).to.equal(1);
      expect(payload.limit).to.equal(6);
      expect(payload.items).to.have.length(1);
      expect(payload.items[0].agentId).to.equal("24");
      expect(payload.items[0].authorized).to.equal(true);
    } finally {
      await close();
    }
  });

  it("returns full agent details with controller counts by default", async () => {
    const { baseUrl, close } = await startServer({
      readAgentControllers: async () => [
        {
          agentId: "1",
          controller: "0x0000000000000000000000000000000000000021",
          authorized: true,
        },
        {
          agentId: "1",
          controller: "0x0000000000000000000000000000000000000022",
          authorized: false,
        },
      ],
    });

    try {
      const response = await fetch(`${baseUrl}/agents/1`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.agentId).to.equal("1");
      expect(payload.controllerCount).to.equal(2);
      expect(payload.controllers).to.have.length(2);
    } finally {
      await close();
    }
  });

  it("returns summary agent details without controllers when requested", async () => {
    const { baseUrl, close } = await startServer({
      readAgentControllersPage: async (_pool, options) => ({
        items: [],
        total: options.agentId === "1" ? 3 : 0,
        limit: options.limit ?? 1,
        offset: options.offset ?? 0,
      }),
    });

    try {
      const response = await fetch(`${baseUrl}/agents/1?view=summary`);
      expect(response.status).to.equal(200);

      const payload = await response.json();
      expect(payload.agentId).to.equal("1");
      expect(payload.controllerCount).to.equal(3);
      expect(payload).to.not.have.property("controllers");
    } finally {
      await close();
    }
  });

  it("rejects invalid agent view parameters with HTTP 400", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/agents/1?view=expanded`);
      expect(response.status).to.equal(400);
      expect(await response.json()).to.deep.equal({
        error: "invalid_query_parameter",
        parameter: "view",
        expected: "full|summary",
      });
    } finally {
      await close();
    }
  });

  it("returns resolution runs and detailed rationale metadata", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const [listResponse, detailResponse] = await Promise.all([
        fetch(`${baseUrl}/resolution-runs?limit=5&offset=0&status=submitted&jobId=1`),
        fetch(`${baseUrl}/resolution-runs/1`),
      ]);

      expect(listResponse.status).to.equal(200);
      expect(detailResponse.status).to.equal(200);

      const listPayload = await listResponse.json();
      const detailPayload = await detailResponse.json();
      expect(listPayload.items).to.have.length(1);
      expect(listPayload.items[0].replicationId).to.equal("1");
      expect(detailPayload.runId).to.equal("1");
      expect(detailPayload.rationaleArtifact).to.not.equal(null);
      expect(detailPayload.txHashes).to.deep.equal(["0xaaa", "0xbbb", "0xccc"]);
    } finally {
      await close();
    }
  });

  it("returns checkpoint publication audit records", async () => {
    const { baseUrl, close } = await startServer();

    try {
      const [domainResponse, detailResponse] = await Promise.all([
        fetch(`${baseUrl}/domains/1/checkpoint-publications?limit=5&offset=0&status=submitted`),
        fetch(`${baseUrl}/checkpoint-publications/1`),
      ]);

      expect(domainResponse.status).to.equal(200);
      expect(detailResponse.status).to.equal(200);

      const domainPayload = await domainResponse.json();
      const detailPayload = await detailResponse.json();
      expect(domainPayload.items).to.have.length(1);
      expect(domainPayload.items[0].payloadId).to.equal("1");
      expect(detailPayload.publicationId).to.equal("1");
      expect(detailPayload.checkpointId).to.equal("2");
    } finally {
      await close();
    }
  });
});
