import { describe, it } from "node:test";
import { expect } from "chai";
import { ScientificProtocolApiError, ScientificProtocolClient } from "../src/sdk/index.js";

describe("ScientificProtocolClient", () => {
  it("builds read queries against the public API", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        return new Response(
          JSON.stringify({
            items: [],
            limit: 10,
            offset: 5,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    const response = await client.listClaims({ domainId: 1, limit: 10, offset: 5, status: 4 });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/claims?domainId=1&limit=10&offset=5&status=4",
    );
    expect(capturedMethod).to.equal("GET");
    expect(response).to.deep.equal({ items: [], limit: 10, offset: 5, total: 0 });
  });

  it("builds governance queries against the public API", async () => {
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrls.push(String(input));
        return new Response(
          JSON.stringify({
            items: [],
            limit: 10,
            offset: 0,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getGovernance();
    await client.listGovernanceEvents({ limit: 5, offset: 10, proposalId: "101" });
    await client.getGovernanceTreasury({ limit: 5, offset: 10 });
    await client.listGovernanceProposals({ limit: 10, state: "Queued" });
    await client.getGovernanceProposal("101", { limit: 5, offset: 10 });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/governance",
      "https://demo.example.org/governance/events?limit=5&offset=10&proposalId=101",
      "https://demo.example.org/governance/treasury?limit=5&offset=10",
      "https://demo.example.org/governance/proposals?limit=10&state=Queued",
      "https://demo.example.org/governance/proposals/101?limit=5&offset=10",
    ]);
  });

  it("builds persisted artifact detail queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            artifactKey: "replication-result-abc123",
            byteLength: 12,
            contentType: "application/json",
            createdAt: "2026-03-11T00:05:00.000Z",
            kind: "replication-result",
            sha256: "0x1234",
            storagePath: "ipfs://bafyartifact",
            provenance: null,
            recentAudits: {
              items: [],
              limit: 10,
              offset: 0,
              total: 0,
            },
            replicas: [],
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getPersistedArtifact("replication-result-abc123");

    expect(capturedUrl).to.equal(
      "https://demo.example.org/persisted-artifacts/replication-result-abc123",
    );
  });

  it("builds persisted artifact content urls against the public API", () => {
    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async () => new Response(null, { status: 200 }),
    });

    expect(client.getPersistedArtifactContentUrl("replication-result-abc123")).to.equal(
      "https://demo.example.org/persisted-artifacts/replication-result-abc123/content",
    );
  });

  it("builds artifact maintenance task queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            items: [],
            limit: 10,
            offset: 0,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.listArtifactMaintenanceTasks({
      artifactKey: "replication-result-abc123",
      limit: 10,
      status: "open",
      taskType: "repair",
    });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/artifact-maintenance-tasks?artifactKey=replication-result-abc123&limit=10&status=open&taskType=repair",
    );
  });

  it("builds persisted artifact maintenance task queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            items: [],
            limit: 20,
            offset: 0,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getPersistedArtifactMaintenanceTasks("replication-result-abc123", {
      status: "completed",
    });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/persisted-artifacts/replication-result-abc123/maintenance-tasks?status=completed",
    );
  });

  it("builds agent request queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            items: [],
            limit: 20,
            offset: 0,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.listAgentRequests({
      agentId: "1",
      scopeKey: "artifact-maintenance-task:2",
      status: "accepted",
    });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/agent-requests?agentId=1&scopeKey=artifact-maintenance-task%3A2&status=accepted",
    );
  });

  it("builds agent review calibration queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            agentId: "1",
            averageCalibrationBps: 9750,
            reviewerActor: "0x0000000000000000000000000000000000000003",
            samples: 2,
            weightBps: 9850,
            contributions: {
              items: [],
              limit: 5,
              offset: 10,
              total: 2,
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getAgentReviewCalibration("1", { limit: 5, offset: 10 });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/agents/1/review-calibration?limit=5&offset=10",
    );
  });

  it("builds agent work summary queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            agentId: "1",
            domainId: 1,
            summary: {
              agentId: "1",
              averageReviewCalibrationBps: null,
              calibratedReviewSamples: 0,
              effectiveReviewWeightBps: 10000,
              fraudSignalReplicationCount: 0,
              inconclusiveReplicationCount: 0,
              maintenanceAuditCount: 1,
              maintenanceFailureCount: 0,
              maintenanceRepairCount: 0,
              qualifiedReplicationCount: 0,
              refutedReplicationCount: 0,
              replicationCount: 0,
              reviewSubmissionCount: 1,
              supportedReplicationCount: 0,
              workScore: 4,
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getAgentWorkSummary("1", { domainId: 1 });

    expect(capturedUrl).to.equal("https://demo.example.org/agents/1/work-summary?domainId=1");
  });

  it("builds claim reward queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            claimId: "1",
            pools: [],
            recentSettlements: { items: [], limit: 5, offset: 10, total: 0 },
            settled: { byWorkKind: [], settlementCount: 0, totalAmountWei: "0" },
            totalPoolWei: "0",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getClaimRewards("1", { limit: 5, offset: 10, workKind: "review" });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/claims/1/rewards?limit=5&offset=10&workKind=review",
    );
  });

  it("builds agent reward queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            agentId: "1",
            budgetBalanceWei: "100",
            operator: "0x0000000000000000000000000000000000000003",
            recentSettlements: { items: [], limit: 2, offset: 0, total: 0 },
            settled: { byWorkKind: [], settlementCount: 0, totalAmountWei: "0" },
            withdrawableRewardBalanceWei: "0",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getAgentRewards("1", { limit: 2, policyVersion: "auto-v1" });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/agents/1/rewards?limit=2&policyVersion=auto-v1",
    );
  });

  it("builds generic reward settlement queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            recentSettlements: { items: [], limit: 5, offset: 10, total: 0 },
            settled: { byWorkKind: [], settlementCount: 0, totalAmountWei: "0" },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getRewardSettlements({
      claimId: 1,
      limit: 5,
      offset: 10,
      recipient: "0x0000000000000000000000000000000000000003",
      workKind: "replication",
    });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/reward-settlements?claimId=1&limit=5&offset=10&recipient=0x0000000000000000000000000000000000000003&workKind=replication",
    );
  });

  it("builds recipient reward queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            recipient: "0x0000000000000000000000000000000000000003",
            recentSettlements: { items: [], limit: 5, offset: 0, total: 0 },
            settled: { byWorkKind: [], settlementCount: 0, totalAmountWei: "0" },
            withdrawableRewardBalanceWei: "0",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getRecipientRewards("0x0000000000000000000000000000000000000003", {
      limit: 5,
      workKind: "replication",
    });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/recipients/0x0000000000000000000000000000000000000003/rewards?limit=5&workKind=replication",
    );
  });

  it("builds reward config queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            chainId: 31337,
            claimRewardVaultAddress: "0x00000000000000000000000000000000000000aa",
            network: "localhost",
            rpcUrl: "http://127.0.0.1:8545",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getRewardConfig();

    expect(capturedUrl).to.equal("https://demo.example.org/reward-config");
  });

  it("builds write config queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            artifactRegistryAddress: "0x00000000000000000000000000000000000000ab",
            bondEscrowAddress: "0x00000000000000000000000000000000000000ac",
            chainId: 31337,
            claimRegistryAddress: "0x00000000000000000000000000000000000000ad",
            claimRewardVaultAddress: "0x00000000000000000000000000000000000000aa",
            network: "localhost",
            rpcUrl: "http://127.0.0.1:8545",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getWriteConfig();

    expect(capturedUrl).to.equal("https://demo.example.org/write-config");
  });

  it("builds agent runtime event queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            items: [],
            limit: 5,
            offset: 10,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getAgentRuntimeEvents({
      agentId: 7,
      claimId: 3,
      limit: 5,
      offset: 10,
      since: "2026-04-08T00:00:00.000Z",
    });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/agent-runtime/events?agentId=7&claimId=3&limit=5&offset=10&since=2026-04-08T00%3A00%3A00.000Z",
    );
  });

  it("builds agent webhook read queries against the public API", async () => {
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrls.push(String(input));
        return new Response(
          JSON.stringify({
            items: [],
            limit: 5,
            offset: 10,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.getAgentWebhookSubscriptions({
      agentId: 1,
      limit: 5,
      offset: 10,
      status: "active",
    });
    await client.getAgentWebhookDeliveries({
      agentId: 1,
      limit: 5,
      status: "retrying",
      subscriptionId: 3,
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/agent-webhook-subscriptions?agentId=1&limit=5&offset=10&status=active",
      "https://demo.example.org/agent-webhook-deliveries?agentId=1&limit=5&status=retrying&subscriptionId=3",
    ]);
  });

  it("builds review task queries against the public API", async () => {
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            items: [],
            limit: 20,
            offset: 0,
            total: 0,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.listReviewTasks({
      claimId: "7",
      limit: 20,
      status: "open",
      taskType: "method_consistency_check",
    });

    expect(capturedUrl).to.equal(
      "https://demo.example.org/review-tasks?claimId=7&limit=20&status=open&taskType=method_consistency_check",
    );
  });

  it("builds source queries against the public API", async () => {
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input) => {
        capturedUrls.push(String(input));
        return new Response(
          JSON.stringify({
            candidates: [],
            publicationDecisions: {
              items: [],
              limit: 10,
              offset: 0,
              total: 0,
            },
            source: {
              canonicalSourceKey: "arxiv:2405.15793",
              createdAt: "2026-04-16T00:00:00.000Z",
              discoveryMode: "agent_discovered",
              extractionArtifactKey: "source-extraction-preview-1",
              publishedClaimId: null,
              snapshotArtifactKey: "source-snapshot-1",
              sourceId: "7",
              sourceMetadata: {},
              sourceType: "url",
              status: "extracting",
              submittedByActor: null,
              submittedByAgentId: "3",
              updatedAt: "2026-04-16T00:00:00.000Z",
            },
            tasks: [],
            workGraph: {
              edges: [],
              items: [],
              sourceId: "7",
              subjects: [],
              summary: {
                activeLeases: 0,
                autoClaimableItems: 0,
                completedItems: 0,
                dependencyBlockedItems: 0,
                failedItems: 0,
                freshContributorItems: 0,
                lanes: { evaluation: 0, execution: 0, maintenance: 0, synthesis: 0 },
                latestActivityAt: null,
                minimumCoverageItems: 0,
                openItems: 0,
                participatingAgents: 0,
                reassignmentReadyItems: 0,
                redundancyTargetItems: 0,
                totalItems: 0,
                uncoveredDemand: 0,
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.listSources({ limit: 5, status: "extracting" });
    await client.getSource("7");
    await client.getSourcePublicationDecisions("7", { limit: 5, shouldPublish: false });
    await client.getSourceWorkGraph("7");
    await client.listSourceFeed({ limit: 5, status: "extracting" });
    await client.listClaimFeed({ domainId: 1, machineProposed: true });
    await client.listSourceEvents({ sourceId: 7, eventType: "source.published" });
    await client.listClaimEvents({ claimId: 7 });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/sources?limit=5&status=extracting",
      "https://demo.example.org/sources/7",
      "https://demo.example.org/sources/7/publication-decisions?limit=5&shouldPublish=false",
      "https://demo.example.org/sources/7/work-graph",
      "https://demo.example.org/feeds/sources?limit=5&status=extracting",
      "https://demo.example.org/feeds/claims?domainId=1&machineProposed=true",
      "https://demo.example.org/events/sources?sourceId=7&eventType=source.published",
      "https://demo.example.org/events/claims?claimId=7",
    ]);
  });

  it("posts agent-discovered sources through the signed machine API", async () => {
    let capturedBody = "";
    let capturedMethod = "";
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org/",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        capturedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              extractionArtifact: null,
              preview: null,
              snapshotArtifact: null,
              source: {
                canonicalSourceKey: "arxiv:2405.15793",
                createdAt: "2026-04-16T00:00:00.000Z",
                discoveryMode: "agent_discovered",
                extractionArtifactKey: "source-extraction-preview-1",
                publishedClaimId: null,
                snapshotArtifactKey: "source-snapshot-1",
                sourceId: "7",
                sourceMetadata: {},
                sourceType: "url",
                status: "extracting",
                submittedByActor: null,
                submittedByAgentId: "3",
                updatedAt: "2026-04-16T00:00:00.000Z",
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.agent.submitSource({
      envelope: {
        actionType: "source_discovery_submission",
        actorAddress: "0x0000000000000000000000000000000000000001",
        agentId: "3",
        issuedAt: "2026-04-16T00:00:00.000Z",
        payload: {
          sourceType: "url",
          sourceUrl: "https://arxiv.org/abs/2405.15793",
        },
        requestNonce: "nonce-1",
        scopeKey: "source-discovery:arxiv:2405.15793",
      },
      signature: "0xsigned",
    });

    expect(capturedUrl).to.equal("https://demo.example.org/agent/sources");
    expect(capturedMethod).to.equal("POST");
    expect(capturedBody).to.contain('"actionType":"source_discovery_submission"');
  });

  it("posts demo mutations as JSON payloads", async () => {
    let capturedBody = "";
    let capturedMethod = "";
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        capturedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              artifactId: "1",
              claimId: "3",
              createdBy: "0xabc",
              job: null,
              txHashes: {
                addArtifact: "0x1",
                createClaim: "0x2",
                depositAuthorBond: "0x3",
                fundClaimRewardPool: "0x4",
                publishClaim: "0x5",
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.demo.createClaim({
      artifactUri: "ipfs://artifact",
      statement: "Fresh benchmark claim",
    });

    expect(capturedUrl).to.equal("https://demo.example.org/demo/claims");
    expect(capturedMethod).to.equal("POST");
    expect(JSON.parse(capturedBody)).to.deep.equal({
      artifactUri: "ipfs://artifact",
      statement: "Fresh benchmark claim",
    });
  });

  it("posts production claim mutations as signed JSON payloads", async () => {
    let capturedBody = "";
    let capturedMethod = "";
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        capturedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "91",
            result: {
              artifactId: "29",
              author: "0xabc",
              claimId: "23",
              job: null,
              submittedBy: "0xdef",
              txHashes: {
                addArtifact: "0x1",
                createClaim: "0x2",
                publishClaim: "0x3",
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.production.createClaim({
      envelope: {
        actionType: "claim_create",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-09T00:00:00.000Z",
        payload: { statement: "Fresh benchmark claim", artifactUri: "ipfs://artifact" },
        requestNonce: "nonce-1",
        scopeKey: "submit:0xabc",
      },
      signature: "0xsigned",
    });

    expect(capturedUrl).to.equal("https://demo.example.org/claims");
    expect(capturedMethod).to.equal("POST");
    expect(JSON.parse(capturedBody)).to.deep.equal({
      envelope: {
        actionType: "claim_create",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-09T00:00:00.000Z",
        payload: { statement: "Fresh benchmark claim", artifactUri: "ipfs://artifact" },
        requestNonce: "nonce-1",
        scopeKey: "submit:0xabc",
      },
      signature: "0xsigned",
    });
  });

  it("posts production source ingestion mutations as signed JSON payloads", async () => {
    let capturedMethod = "";
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "92",
            result: {
              submission: {
                canonicalSourceKey: "arxiv:2405.15793",
                createdAt: "2026-04-16T00:00:00.000Z",
                discoveryMode: "user_submitted",
                normalizedLocator: "https://arxiv.org/abs/2405.15793",
                rawLocator: "https://arxiv.org/abs/2405.15793",
                sourceId: "7",
                submissionId: "1",
                submissionOutcome: "created",
                submittedByActor: "0xabc",
                submittedByAgentId: null,
              },
              submissionOutcome: "created",
              source: {
                canonicalSourceKey: "arxiv:2405.15793",
                createdAt: "2026-04-16T00:00:00.000Z",
                discoveryMode: "user_submitted",
                extractionArtifactKey: "source-extraction-preview-1",
                publishedClaimId: null,
                snapshotArtifactKey: "source-snapshot-1",
                sourceId: "7",
                sourceMetadata: {},
                sourceType: "url",
                status: "extracting",
                submittedByActor: "0xabc",
                submittedByAgentId: null,
                updatedAt: "2026-04-16T00:00:00.000Z",
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.production.createSource({
      envelope: {
        actionType: "claim_draft_from_artifact",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-16T00:00:00.000Z",
        payload: {
          sourceType: "url",
          sourceUrl: "https://arxiv.org/abs/2405.15793",
        },
        requestNonce: "nonce-2",
        scopeKey: "submit:0xabc",
      },
      signature: "0xsigned",
    });

    expect(capturedUrl).to.equal("https://demo.example.org/sources");
    expect(capturedMethod).to.equal("POST");
  });

  it("posts production source confirmation and rejection mutations as signed JSON payloads", async () => {
    const capturedUrls: string[] = [];
    const capturedMethods: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrls.push(String(input));
        capturedMethods.push(init?.method ?? "GET");
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "101",
            result: {
              publishedClaimId: "29",
              source: {
                canonicalSourceKey: "arxiv:2405.15793",
                createdAt: "2026-04-16T00:00:00.000Z",
                discoveryMode: "user_submitted",
                extractionArtifactKey: "source-extraction-preview-1",
                publishedClaimId: "29",
                snapshotArtifactKey: "source-snapshot-1",
                sourceId: "7",
                sourceMetadata: {},
                sourceType: "url",
                status: "published",
                submittedByActor: "0xabc",
                submittedByAgentId: null,
                updatedAt: "2026-04-16T00:00:00.000Z",
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.production.confirmSourcePublication("7", {
      envelope: {
        actionType: "source_publication_confirm",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-16T00:00:00.000Z",
        payload: {
          candidateId: "candidate-7-1",
          sourceId: "7",
        },
        requestNonce: "nonce-3",
        scopeKey: "source:7:confirm",
      },
      signature: "0xsigned",
    });

    await client.production.rejectSourcePublication("8", {
      envelope: {
        actionType: "source_publication_reject",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-16T00:00:00.000Z",
        payload: {
          reason: "low signal",
          sourceId: "8",
        },
        requestNonce: "nonce-4",
        scopeKey: "source:8:reject",
      },
      signature: "0xsigned",
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/sources/7/confirm",
      "https://demo.example.org/sources/8/reject",
    ]);
    expect(capturedMethods).to.deep.equal(["POST", "POST"]);
  });

  it("posts production operator lifecycle mutations as signed JSON payloads", async () => {
    const capturedBodies: string[] = [];
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrls.push(String(input));
        capturedBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            ok: true,
            requestId: "111",
            result: {
              workerId: "wallet-worker",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.production.processReplicationJob("8", {
      envelope: {
        actionType: "replication_job_process",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-20T00:00:00.000Z",
        payload: { workerId: "wallet-worker" },
        requestNonce: "nonce-5",
        scopeKey: "replication-job:8:process",
      },
      signature: "0xsigned",
    });

    await client.production.resolveReplicationJob("8", {
      envelope: {
        actionType: "replication_job_resolve",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-20T00:00:00.000Z",
        payload: { claimStatus: 4, confidenceBps: 9300, resolutionStatus: 1 },
        requestNonce: "nonce-6",
        scopeKey: "replication-job:8:resolve",
      },
      signature: "0xsigned",
    });

    await client.production.recomputeDomain(1, {
      envelope: {
        actionType: "domain_recompute",
        actorAddress: "0xabc",
        chainId: 31337,
        issuedAt: "2026-04-20T00:00:00.000Z",
        payload: {},
        requestNonce: "nonce-7",
        scopeKey: "domain:1:recompute",
      },
      signature: "0xsigned",
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/replication-jobs/8/process",
      "https://demo.example.org/replication-jobs/8/resolve",
      "https://demo.example.org/domains/1/recompute",
    ]);
    expect(capturedBodies.map((entry) => JSON.parse(entry))).to.deep.equal([
      {
        envelope: {
          actionType: "replication_job_process",
          actorAddress: "0xabc",
          chainId: 31337,
          issuedAt: "2026-04-20T00:00:00.000Z",
          payload: { workerId: "wallet-worker" },
          requestNonce: "nonce-5",
          scopeKey: "replication-job:8:process",
        },
        signature: "0xsigned",
      },
      {
        envelope: {
          actionType: "replication_job_resolve",
          actorAddress: "0xabc",
          chainId: 31337,
          issuedAt: "2026-04-20T00:00:00.000Z",
          payload: { claimStatus: 4, confidenceBps: 9300, resolutionStatus: 1 },
          requestNonce: "nonce-6",
          scopeKey: "replication-job:8:resolve",
        },
        signature: "0xsigned",
      },
      {
        envelope: {
          actionType: "domain_recompute",
          actorAddress: "0xabc",
          chainId: 31337,
          issuedAt: "2026-04-20T00:00:00.000Z",
          payload: {},
          requestNonce: "nonce-7",
          scopeKey: "domain:1:recompute",
        },
        signature: "0xsigned",
      },
    ]);
  });

  it("posts demo artifact maintenance mutations as JSON payloads", async () => {
    let capturedBody = "";
    let capturedMethod = "";
    let capturedUrl = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        capturedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              taskId: "5",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.demo.openArtifactMaintenanceTask({
      artifactKey: "replication-result-abc123",
      taskType: "repair",
      targetReplicaKey: "pinata-public",
    });

    expect(capturedUrl).to.equal("https://demo.example.org/demo/artifact-maintenance-tasks");
    expect(capturedMethod).to.equal("POST");
    expect(JSON.parse(capturedBody)).to.deep.equal({
      artifactKey: "replication-result-abc123",
      taskType: "repair",
      targetReplicaKey: "pinata-public",
    });
  });

  it("posts signed generic maintenance work-item mutations as JSON payloads", async () => {
    const capturedBodies: string[] = [];
    const capturedMethods: string[] = [];
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrls.push(String(input));
        capturedMethods.push(init?.method ?? "GET");
        capturedBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              taskId: "2",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.agent.claimWorkItem("artifact-maintenance:2", {
      envelope: {
        actionType: "artifact_task_claim",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:00.000Z",
        payload: { workerId: "artifact-worker-b" },
        requestNonce: "nonce-claim-1",
        scopeKey: "artifact-maintenance-task:2",
      },
      signature: "0xsigned",
    });

    await client.agent.heartbeatWorkItem("artifact-maintenance:2", {
      envelope: {
        actionType: "artifact_task_heartbeat",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:30.000Z",
        payload: { runId: "12", workerId: "artifact-worker-b" },
        requestNonce: "nonce-heartbeat-1",
        scopeKey: "artifact-maintenance-task:2",
      },
      signature: "0xheartbeat",
    });

    await client.agent.submitWorkResults("artifact-maintenance:2", {
      envelope: {
        actionType: "artifact_task_repair_submission",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:01:00.000Z",
        payload: {
          repairSourceReplicaKey: "primary",
          repairedReplica: {
            locator: "ipfs://bafyrepair",
            provider: "ipfs:pinata",
            replicaKey: "pinata-public",
          },
          runId: "12",
        },
        requestNonce: "nonce-repair-1",
        scopeKey: "artifact-maintenance-task:2",
      },
      signature: "0xrepair",
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/agent/artifact-maintenance-tasks/2/claim",
      "https://demo.example.org/agent/artifact-maintenance-tasks/2/heartbeat",
      "https://demo.example.org/agent/artifact-maintenance-tasks/2/repair-results",
    ]);
    expect(capturedMethods).to.deep.equal(["POST", "POST", "POST"]);
    expect(JSON.parse(capturedBodies[0] ?? "")).to.deep.equal({
      envelope: {
        actionType: "artifact_task_claim",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:00.000Z",
        payload: { workerId: "artifact-worker-b" },
        requestNonce: "nonce-claim-1",
        scopeKey: "artifact-maintenance-task:2",
      },
      signature: "0xsigned",
    });
    expect(JSON.parse(capturedBodies[1] ?? "")).to.deep.equal({
      envelope: {
        actionType: "artifact_task_heartbeat",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:30.000Z",
        payload: { runId: "12", workerId: "artifact-worker-b" },
        requestNonce: "nonce-heartbeat-1",
        scopeKey: "artifact-maintenance-task:2",
      },
      signature: "0xheartbeat",
    });
    expect(JSON.parse(capturedBodies[2] ?? "")).to.deep.equal({
      envelope: {
        actionType: "artifact_task_repair_submission",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:01:00.000Z",
        payload: {
          repairSourceReplicaKey: "primary",
          repairedReplica: {
            locator: "ipfs://bafyrepair",
            provider: "ipfs:pinata",
            replicaKey: "pinata-public",
          },
          runId: "12",
        },
        requestNonce: "nonce-repair-1",
        scopeKey: "artifact-maintenance-task:2",
      },
      signature: "0xrepair",
    });
  });

  it("posts signed generic review work-item mutations as JSON payloads", async () => {
    const capturedBodies: string[] = [];
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrls.push(String(input));
        capturedBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              taskId: "7",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.agent.claimWorkItem("review-task:7", {
      envelope: {
        actionType: "review_task_claim",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:00.000Z",
        payload: { workerId: "review-worker-a" },
        requestNonce: "nonce-review-claim-1",
        scopeKey: "review-task:7",
      },
      signature: "0xsigned-claim",
    });

    await client.agent.heartbeatWorkItem("review-task:7", {
      envelope: {
        actionType: "review_task_heartbeat",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:30.000Z",
        payload: {
          runId: "12",
          workerId: "review-worker-a",
        },
        requestNonce: "nonce-review-heartbeat-1",
        scopeKey: "review-task:7",
      },
      signature: "0xsigned-heartbeat",
    });

    await client.agent.submitWorkResults("review-task:7", {
      envelope: {
        actionType: "review_task_submission",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:01:00.000Z",
        payload: {
          runId: "12",
          verdict: "pass",
          confidenceBps: 8200,
          dimensions: {
            artifactCompleteness: 8600,
          },
          summary: "Artifacts are complete.",
        },
        requestNonce: "nonce-review-submit-1",
        scopeKey: "review-task:7",
      },
      signature: "0xsigned-submit",
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/agent/review-tasks/7/claim",
      "https://demo.example.org/agent/review-tasks/7/heartbeat",
      "https://demo.example.org/agent/review-tasks/7/submissions",
    ]);
    expect(JSON.parse(capturedBodies[0] ?? "")).to.deep.equal({
      envelope: {
        actionType: "review_task_claim",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:00.000Z",
        payload: { workerId: "review-worker-a" },
        requestNonce: "nonce-review-claim-1",
        scopeKey: "review-task:7",
      },
      signature: "0xsigned-claim",
    });
    expect(JSON.parse(capturedBodies[1] ?? "")).to.deep.equal({
      envelope: {
        actionType: "review_task_heartbeat",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:30.000Z",
        payload: {
          runId: "12",
          workerId: "review-worker-a",
        },
        requestNonce: "nonce-review-heartbeat-1",
        scopeKey: "review-task:7",
      },
      signature: "0xsigned-heartbeat",
    });
    expect(JSON.parse(capturedBodies[2] ?? "")).to.deep.equal({
      envelope: {
        actionType: "review_task_submission",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:01:00.000Z",
        payload: {
          runId: "12",
          verdict: "pass",
          confidenceBps: 8200,
          dimensions: {
            artifactCompleteness: 8600,
          },
          summary: "Artifacts are complete.",
        },
        requestNonce: "nonce-review-submit-1",
        scopeKey: "review-task:7",
      },
      signature: "0xsigned-submit",
    });
  });

  it("posts signed webhook subscription mutations as JSON payloads", async () => {
    const capturedBodies: string[] = [];
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrls.push(String(input));
        capturedBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            ok: true,
            result: {},
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.agent.createWebhookSubscription({
      envelope: {
        actionType: "webhook_subscription_create",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-08T12:00:00.000Z",
        payload: {
          eventTypes: ["work_item.claimable", "agent_request.accepted"],
          targetUrl: "https://hooks.example.org/osp",
        },
        requestNonce: "nonce-webhook-create-1",
        scopeKey: "agent-webhook-subscriptions:1",
      },
      signature: "0xwebhook-create",
    });

    await client.agent.deleteWebhookSubscription(5, {
      envelope: {
        actionType: "webhook_subscription_delete",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-08T12:01:00.000Z",
        payload: {},
        requestNonce: "nonce-webhook-delete-1",
        scopeKey: "agent-webhook-subscription:5",
      },
      signature: "0xwebhook-delete",
    });

    await client.agent.pingWebhookSubscription(5, {
      envelope: {
        actionType: "webhook_subscription_ping",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-08T12:02:00.000Z",
        payload: {},
        requestNonce: "nonce-webhook-ping-1",
        scopeKey: "agent-webhook-subscription:5",
      },
      signature: "0xwebhook-ping",
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/agent/webhook-subscriptions",
      "https://demo.example.org/agent/webhook-subscriptions/5/delete",
      "https://demo.example.org/agent/webhook-subscriptions/5/ping",
    ]);
    expect(JSON.parse(capturedBodies[0] ?? "")).to.deep.equal({
      envelope: {
        actionType: "webhook_subscription_create",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-08T12:00:00.000Z",
        payload: {
          eventTypes: ["work_item.claimable", "agent_request.accepted"],
          targetUrl: "https://hooks.example.org/osp",
        },
        requestNonce: "nonce-webhook-create-1",
        scopeKey: "agent-webhook-subscriptions:1",
      },
      signature: "0xwebhook-create",
    });
  });

  it("posts signed generic replication work-item mutations as JSON payloads", async () => {
    const capturedBodies: string[] = [];
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input, init) => {
        capturedUrls.push(String(input));
        capturedBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              jobId: "2",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.agent.claimWorkItem("replication-job:2", {
      envelope: {
        actionType: "replication_job_claim",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:00.000Z",
        payload: { workerId: "replication-worker-a" },
        requestNonce: "nonce-replication-claim-1",
        scopeKey: "replication-job:2",
      },
      signature: "0xreplication-claim",
    });

    await client.agent.heartbeatWorkItem("replication-job:2", {
      envelope: {
        actionType: "replication_job_heartbeat",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:30.000Z",
        payload: {
          runId: "12",
          workerId: "replication-worker-a",
        },
        requestNonce: "nonce-replication-heartbeat-1",
        scopeKey: "replication-job:2",
      },
      signature: "0xreplication-heartbeat",
    });

    await client.agent.submitWorkResults("replication-job:2", {
      envelope: {
        actionType: "replication_job_submission",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:01:00.000Z",
        payload: {
          runId: "12",
          summary: "Reference replication submission.",
        },
        requestNonce: "nonce-replication-submit-1",
        scopeKey: "replication-job:2",
      },
      signature: "0xreplication-submit",
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/agent/replication-jobs/2/claim",
      "https://demo.example.org/agent/replication-jobs/2/heartbeat",
      "https://demo.example.org/agent/replication-jobs/2/submissions",
    ]);
    expect(JSON.parse(capturedBodies[0] ?? "")).to.deep.equal({
      envelope: {
        actionType: "replication_job_claim",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:00.000Z",
        payload: { workerId: "replication-worker-a" },
        requestNonce: "nonce-replication-claim-1",
        scopeKey: "replication-job:2",
      },
      signature: "0xreplication-claim",
    });
    expect(JSON.parse(capturedBodies[1] ?? "")).to.deep.equal({
      envelope: {
        actionType: "replication_job_heartbeat",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:00:30.000Z",
        payload: {
          runId: "12",
          workerId: "replication-worker-a",
        },
        requestNonce: "nonce-replication-heartbeat-1",
        scopeKey: "replication-job:2",
      },
      signature: "0xreplication-heartbeat",
    });
    expect(JSON.parse(capturedBodies[2] ?? "")).to.deep.equal({
      envelope: {
        actionType: "replication_job_submission",
        actorAddress: "0x0000000000000000000000000000000000000003",
        agentId: "1",
        issuedAt: "2026-04-02T12:01:00.000Z",
        payload: {
          runId: "12",
          summary: "Reference replication submission.",
        },
        requestNonce: "nonce-replication-submit-1",
        scopeKey: "replication-job:2",
      },
      signature: "0xreplication-submit",
    });
  });

  it("requests claim review, work graph, and generic work-item endpoints", async () => {
    const capturedUrls: string[] = [];

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async (input) => {
        capturedUrls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    });

    await client.getClaimReview(9);
    await client.getClaimWorkGraph(9);
    await client.getWorkItem("review-task:4", { claimId: 9 });
    await client.getWorkItem("review-task:12", { sourceId: 7 });
    await client.listWorkItems({
      claimId: 9,
      claimable: true,
      kind: "review_task",
      status: "open",
    });
    await client.listWorkItems({
      sourceId: 7,
      kind: "review_task",
      status: "open",
    });

    expect(capturedUrls).to.deep.equal([
      "https://demo.example.org/claims/9/review",
      "https://demo.example.org/claims/9/work-graph",
      "https://demo.example.org/work-items/review-task%3A4?claimId=9",
      "https://demo.example.org/work-items/review-task%3A12?sourceId=7",
      "https://demo.example.org/work-items?claimId=9&claimable=true&kind=review_task&status=open",
      "https://demo.example.org/work-items?sourceId=7&kind=review_task&status=open",
    ]);
  });

  it("sends demo admin credentials to protected endpoints", async () => {
    let authorization = "";
    let adminHeader = "";

    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      demoAdminToken: "secret-admin-token",
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization") ?? "";
        adminHeader = headers.get("x-sp-demo-admin-token") ?? "";
        return new Response(
          JSON.stringify({
            ok: true,
            tokenConfigured: true,
            counts: {
              agentControllers: 0,
              agents: 0,
              appeals: 0,
              artifacts: 0,
              challenges: 0,
              checkpoints: 0,
              claims: 0,
              forecasts: 0,
              replications: 0,
            },
            sync: {
              blocksRemaining: 0,
              chainHeadBlock: 1,
              cursorBlock: 1,
              indexer: {
                lastErrorAt: null,
                lastErrorMessage: null,
                lastFinishedAt: null,
                lastStartedAt: null,
                lastSuccessAt: null,
                name: "read_model",
                status: "idle",
                updatedAt: "2026-03-26T00:00:00.000Z",
              },
              lagBlocks: 0,
              rpcError: null,
              rpcReachable: true,
              syncedToHead: true,
            },
            scenarios: [],
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await client.demo.getAdminStatus();

    expect(authorization).to.equal("Bearer secret-admin-token");
    expect(adminHeader).to.equal("secret-admin-token");
  });

  it("raises a typed error for failed API requests", async () => {
    const client = new ScientificProtocolClient({
      baseUrl: "https://demo.example.org",
      fetch: async () =>
        new Response(JSON.stringify({ error: "claim_not_found" }), {
          headers: { "content-type": "application/json" },
          status: 404,
        }),
    });

    let thrown: unknown = null;
    try {
      await client.getClaim("999");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(ScientificProtocolApiError);
    expect((thrown as ScientificProtocolApiError).status).to.equal(404);
    expect((thrown as ScientificProtocolApiError).body).to.deep.equal({
      error: "claim_not_found",
    });
  });
});
