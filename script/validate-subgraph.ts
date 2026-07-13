import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { parse } from "yaml";
import { getDeploymentPath, loadDeploymentFile } from "../src/shared/deployment.js";

type DataSource = {
  name: string;
  source: { address: string; startBlock: number };
  mapping: { entities: string[]; eventHandlers: Array<{ handler: string }> };
};

export async function validateSubgraph(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
  const manifest = parse(await readFile("subgraph/subgraph.yaml", "utf8")) as {
    dataSources: DataSource[];
  };
  const expected = new Map([
    ["ClaimRegistry", deployment.addresses.claimRegistry],
    ["ArtifactRegistry", deployment.addresses.artifactRegistry],
    ["ReplicationRegistry", deployment.addresses.replicationRegistry],
    ["ReputationCheckpointRegistry", deployment.addresses.reputationCheckpointRegistry],
    ["AgentRegistry", deployment.addresses.agentRegistry],
    ["ProtocolGovernor", deployment.addresses.protocolGovernor],
  ]);
  const excludedDataSources = ["EpistemicMarket"];
  assert.equal(manifest.dataSources.length, expected.size);
  for (const excluded of excludedDataSources) {
    assert.equal(
      manifest.dataSources.some((source) => source.name === excluded),
      false,
      `${excluded} is outside the v0.3 core claim/evidence/governance subgraph scope`,
    );
  }
  for (const source of manifest.dataSources) {
    assert.equal(source.source.address.toLowerCase(), expected.get(source.name)?.toLowerCase());
    assert.equal(source.source.startBlock, deployment.deploymentBlock);
    assert.ok(source.mapping.entities.length > 0);
    assert.ok(source.mapping.eventHandlers.length > 0);
    await access(`subgraph/build/${source.name}/${source.name}.wasm`);
  }
  const handlers = manifest.dataSources.flatMap((source) =>
    source.mapping.eventHandlers.map((handler) => handler.handler),
  );
  for (const required of [
    "handleClaimCreated",
    "handleArtifactAdded",
    "handleReplicationSubmitted",
    "handleResolutionDecisionRecorded",
    "handleEffectiveResolutionDecisionUpdated",
    "handleReputationCheckpointPublished",
    "handleAgentRegistered",
    "handleProposalCreated",
  ]) {
    assert.ok(handlers.includes(required), `missing subgraph handler ${required}`);
  }
}

await validateSubgraph();
