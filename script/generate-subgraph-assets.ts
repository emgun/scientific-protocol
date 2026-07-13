import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDeploymentPath, loadDeploymentFile } from "../src/shared/deployment.js";

const contracts = [
  {
    name: "ClaimRegistry",
    addressKey: "claimRegistry",
    artifact: "artifacts/contracts/ClaimRegistry.sol/ClaimRegistry.json",
    mapping: "claim-registry.ts",
    entities: ["Claim", "ResolutionDecision"],
    handlers: [
      [
        "ClaimCreated(indexed uint256,indexed address,indexed uint64,bytes32,address,uint256)",
        "handleClaimCreated",
      ],
      ["ClaimRevised(indexed uint256,indexed uint256,indexed address)", "handleClaimRevised"],
      [
        "ClaimStatusUpdated(indexed uint256,uint8,uint8,indexed address)",
        "handleClaimStatusUpdated",
      ],
      [
        "ResolutionDecisionRecorded(indexed uint256,indexed uint256,indexed uint256,address,uint8,uint8,uint16,bytes32,bytes32,uint8,address)",
        "handleResolutionDecisionRecorded",
      ],
      [
        "EffectiveResolutionDecisionUpdated(indexed uint256,indexed uint256,indexed uint8,address)",
        "handleEffectiveResolutionDecisionUpdated",
      ],
    ],
  },
  {
    name: "ArtifactRegistry",
    addressKey: "artifactRegistry",
    artifact: "artifacts/contracts/ArtifactRegistry.sol/ArtifactRegistry.json",
    mapping: "artifact-registry.ts",
    entities: ["Artifact"],
    handlers: [
      [
        "ArtifactAdded(indexed uint256,indexed uint256,uint8,bytes32,string,indexed address)",
        "handleArtifactAdded",
      ],
    ],
  },
  {
    name: "ReplicationRegistry",
    addressKey: "replicationRegistry",
    artifact: "artifacts/contracts/ReplicationRegistry.sol/ReplicationRegistry.json",
    mapping: "replication-registry.ts",
    entities: ["Replication"],
    handlers: [
      [
        "ReplicationSubmitted(indexed uint256,indexed uint256,indexed address,uint256,bytes32)",
        "handleReplicationSubmitted",
      ],
      [
        "ReplicationResolved(indexed uint256,uint8,uint8,bytes32,indexed address,uint16,uint8,bytes32,string)",
        "handleReplicationResolved",
      ],
    ],
  },
  {
    name: "ReputationCheckpointRegistry",
    addressKey: "reputationCheckpointRegistry",
    artifact:
      "artifacts/contracts/ReputationCheckpointRegistry.sol/ReputationCheckpointRegistry.json",
    mapping: "checkpoint-registry.ts",
    entities: ["ReputationCheckpoint"],
    handlers: [
      [
        "ReputationCheckpointPublished(indexed uint256,indexed uint64,indexed uint8,address,uint256,uint256,address,bytes32,bytes32,string)",
        "handleReputationCheckpointPublished",
      ],
    ],
  },
  {
    name: "AgentRegistry",
    addressKey: "agentRegistry",
    artifact: "artifacts/contracts/AgentRegistry.sol/AgentRegistry.json",
    mapping: "agent-registry.ts",
    entities: ["Agent"],
    handlers: [
      [
        "AgentRegistered(indexed uint256,indexed address,bytes32,string,uint256)",
        "handleAgentRegistered",
      ],
      ["AgentStatusUpdated(indexed uint256,bool,indexed address)", "handleAgentStatusUpdated"],
      [
        "AgentSpendLimitUpdated(indexed uint256,uint256,indexed address)",
        "handleAgentSpendLimitUpdated",
      ],
      [
        "AgentBudgetDeposited(indexed uint256,indexed address,uint256)",
        "handleAgentBudgetDeposited",
      ],
      ["AgentBudgetReserved(indexed uint256,uint256,indexed address)", "handleAgentBudgetReserved"],
      ["AgentBudgetReleased(indexed uint256,uint256,indexed address)", "handleAgentBudgetReleased"],
      [
        "AgentBudgetConsumed(indexed uint256,uint256,indexed address,address)",
        "handleAgentBudgetConsumed",
      ],
      [
        "AgentBudgetWithdrawn(indexed uint256,uint256,indexed address)",
        "handleAgentBudgetWithdrawn",
      ],
    ],
  },
  {
    name: "ProtocolGovernor",
    addressKey: "protocolGovernor",
    artifact: "artifacts/contracts/ProtocolGovernor.sol/ProtocolGovernor.json",
    mapping: "governor.ts",
    entities: ["GovernanceProposal"],
    handlers: [
      [
        "ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)",
        "handleProposalCreated",
      ],
      ["ProposalQueued(uint256,uint256)", "handleProposalQueued"],
      ["ProposalExecuted(uint256)", "handleProposalExecuted"],
      ["ProposalCanceled(uint256)", "handleProposalCanceled"],
    ],
  },
] as const;

function dataSource(input: {
  name: string;
  address: string;
  network: string;
  startBlock: number;
  mapping: string;
  entities: readonly string[];
  handlers: readonly (readonly [string, string])[];
}): string {
  const handlers = input.handlers
    .map(([event, handler]) => `        - event: ${event}\n          handler: ${handler}`)
    .join("\n");
  return `  - kind: ethereum/contract
    name: ${input.name}
    network: ${input.network}
    source:
      address: "${input.address}"
      abi: ${input.name}
      startBlock: ${input.startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities: [${input.entities.join(", ")}]
      abis:
        - name: ${input.name}
          file: ./abis/${input.name}.json
      eventHandlers:
${handlers}
      file: ./src/${input.mapping}`;
}

export async function generateSubgraphAssets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
  const network = env.SP_SUBGRAPH_NETWORK?.trim() || deployment.network;
  const output = path.resolve("subgraph");
  await mkdir(path.join(output, "abis"), { recursive: true });

  const sources: string[] = [];
  for (const contract of contracts) {
    const artifact = JSON.parse(await readFile(contract.artifact, "utf8")) as { abi: unknown[] };
    await writeFile(
      path.join(output, "abis", `${contract.name}.json`),
      `${JSON.stringify(artifact.abi, null, 2)}\n`,
    );
    const address = deployment.addresses[contract.addressKey as keyof typeof deployment.addresses];
    sources.push(
      dataSource({
        name: contract.name,
        address,
        network,
        startBlock: deployment.deploymentBlock,
        mapping: contract.mapping,
        entities: contract.entities,
        handlers: contract.handlers,
      }),
    );
  }

  await writeFile(
    path.join(output, "subgraph.yaml"),
    `specVersion: 1.3.0
indexerHints:
  prune: auto
schema:
  file: ./schema.graphql
dataSources:
${sources.join("\n")}\n`,
  );
}

await generateSubgraphAssets();
