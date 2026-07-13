import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import {
  CHECKPOINT_OPERATOR_ROLES,
  CLAIM_SUBMITTER_OPERATOR_ROLES,
  LOCAL_DEPLOYMENT_BOOTSTRAP_ROLES,
  RESOLVER_OPERATOR_ROLES,
  resolveMinimumAuthorBondWei,
  TIMELOCK_MANAGED_ROLES,
} from "../script/deploy-protocol.js";
import {
  type DeploymentFile,
  deploymentFileExists,
  getDeploymentPath,
  loadDeploymentFile,
  saveDeploymentFile,
} from "../src/shared/deployment.js";

const sampleDeployment: DeploymentFile = {
  addresses: {
    accessController: "0x0000000000000000000000000000000000000001",
    agentRegistry: "0x0000000000000000000000000000000000000002",
    appealsRegistry: "0x0000000000000000000000000000000000000003",
    artifactRegistry: "0x0000000000000000000000000000000000000004",
    benchmarkModule: "0x0000000000000000000000000000000000000005",
    bondEscrow: "0x0000000000000000000000000000000000000006",
    claimRegistry: "0x0000000000000000000000000000000000000007",
    claimRewardVault: "0x0000000000000000000000000000000000000008",
    computationalModule: "0x0000000000000000000000000000000000000009",
    epistemicMarket: "0x0000000000000000000000000000000000000010",
    protocolGovernor: "0x0000000000000000000000000000000000000011",
    protocolGovernanceToken: "0x0000000000000000000000000000000000000012",
    protocolParameters: "0x0000000000000000000000000000000000000013",
    protocolTimelock: "0x0000000000000000000000000000000000000014",
    protocolTreasury: "0x0000000000000000000000000000000000000015",
    replicationRegistry: "0x0000000000000000000000000000000000000016",
    reputationCheckpointRegistry: "0x0000000000000000000000000000000000000017",
    resolutionModuleRegistry: "0x0000000000000000000000000000000000000018",
    wetLabModule: "0x0000000000000000000000000000000000000019",
  },
  chainId: 84532,
  deployedAt: "2026-03-17T00:00:00.000Z",
  deploymentBlock: 123,
  network: "base-sepolia",
  parameters: { minimumAuthorBondWei: "5000000000000000" },
};

describe("DeploymentFile", () => {
  it("keeps author-bond custody timelocked and bounty settlement operational", () => {
    expect(LOCAL_DEPLOYMENT_BOOTSTRAP_ROLES).not.to.include("ESCROW_ADMIN_ROLE");
    expect(RESOLVER_OPERATOR_ROLES).to.include("BOUNTY_SETTLER_ROLE");
    expect(RESOLVER_OPERATOR_ROLES).not.to.include("ESCROW_ADMIN_ROLE");
    expect(TIMELOCK_MANAGED_ROLES).to.include("ESCROW_ADMIN_ROLE");
    expect(CLAIM_SUBMITTER_OPERATOR_ROLES).to.deep.equal(["CLAIM_SUBMITTER_ROLE"]);
    expect(CHECKPOINT_OPERATOR_ROLES).to.deep.equal([
      "CHECKPOINT_PUBLISHER_ROLE",
      "REWARD_SETTLER_ROLE",
    ]);
    expect(new Set(LOCAL_DEPLOYMENT_BOOTSTRAP_ROLES).size).to.equal(
      LOCAL_DEPLOYMENT_BOOTSTRAP_ROLES.length,
    );
  });

  it("uses one explicit nonzero author-bond floor for remote deployments", () => {
    expect(() => resolveMinimumAuthorBondWei({})).to.throw(/require SP_MIN_AUTHOR_BOND/);
    expect(resolveMinimumAuthorBondWei({}, { localDevelopment: true })).to.equal(
      5_000_000_000_000_000n,
    );
    expect(resolveMinimumAuthorBondWei({ SP_MIN_AUTHOR_BOND_ETH: "0.01" })).to.equal(
      10_000_000_000_000_000n,
    );
    expect(resolveMinimumAuthorBondWei({ SP_MIN_AUTHOR_BOND_WEI: "7" })).to.equal(7n);
    expect(() => resolveMinimumAuthorBondWei({ SP_MIN_AUTHOR_BOND_WEI: "0" })).to.throw(
      /nonzero minimum author bond/,
    );
    expect(() => resolveMinimumAuthorBondWei({ SP_MIN_AUTHOR_BOND_ETH: "-0.001" })).to.throw(
      /cannot be negative/,
    );
    expect(
      resolveMinimumAuthorBondWei({ SP_MIN_AUTHOR_BOND_WEI: "0" }, { localDevelopment: true }),
    ).to.equal(0n);
    expect(() =>
      resolveMinimumAuthorBondWei({
        SP_MIN_AUTHOR_BOND_ETH: "0.01",
        SP_MIN_AUTHOR_BOND_WEI: "1",
      }),
    ).to.throw(/only one/);
  });
  it("resolves deployment paths from explicit env input", () => {
    expect(getDeploymentPath({ SP_DEPLOYMENT_PATH: " ops/staging.addresses.json " })).to.equal(
      "ops/staging.addresses.json",
    );
  });

  it("resolves deployment paths from file-backed env input", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-deployment-path-"));
    const deploymentPathFile = path.join(tempRoot, "deployment-path");
    try {
      await writeFile(deploymentPathFile, " ops/file-backed.addresses.json \n", "utf8");

      expect(getDeploymentPath({ SP_DEPLOYMENT_PATH_FILE: deploymentPathFile })).to.equal(
        "ops/file-backed.addresses.json",
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("loads deployment metadata from SP_DEPLOYMENT_JSON", async () => {
    const deployment = await loadDeploymentFile(undefined, {
      env: {
        SP_DEPLOYMENT_JSON: JSON.stringify(sampleDeployment),
      },
    });

    expect(deployment).to.deep.equal(sampleDeployment);
    expect(
      await deploymentFileExists(undefined, {
        env: { SP_DEPLOYMENT_JSON: JSON.stringify(sampleDeployment) },
      }),
    ).to.equal(true);
  });

  it("loads deployment metadata from SP_DEPLOYMENT_JSON_FILE", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-deployment-json-"));
    const deploymentJsonPath = path.join(tempRoot, "deployment.json");
    try {
      await writeFile(deploymentJsonPath, JSON.stringify(sampleDeployment), "utf8");

      const deployment = await loadDeploymentFile(undefined, {
        env: {
          SP_DEPLOYMENT_JSON_FILE: deploymentJsonPath,
        },
      });

      expect(deployment).to.deep.equal(sampleDeployment);
      expect(
        await deploymentFileExists(undefined, {
          env: { SP_DEPLOYMENT_JSON_FILE: deploymentJsonPath },
        }),
      ).to.equal(true);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects malformed deployment metadata before contract use", async () => {
    await assert.rejects(
      loadDeploymentFile(undefined, {
        env: {
          SP_DEPLOYMENT_JSON: JSON.stringify({
            ...sampleDeployment,
            addresses: {
              ...sampleDeployment.addresses,
              claimRegistry: "not-an-address",
            },
          }),
        },
      }),
      /failed to parse deployment file from SP_DEPLOYMENT_JSON: deployment file from SP_DEPLOYMENT_JSON has invalid address for claimRegistry/,
    );

    await assert.rejects(
      loadDeploymentFile(undefined, {
        env: {
          SP_DEPLOYMENT_JSON: JSON.stringify({
            ...sampleDeployment,
            addresses: undefined,
          }),
        },
      }),
      /failed to parse deployment file from SP_DEPLOYMENT_JSON: deployment file from SP_DEPLOYMENT_JSON is missing addresses/,
    );

    await assert.rejects(
      loadDeploymentFile(undefined, {
        env: {
          SP_DEPLOYMENT_JSON: JSON.stringify({
            ...sampleDeployment,
            deployedAt: "not-a-date",
          }),
        },
      }),
      /failed to parse deployment file from SP_DEPLOYMENT_JSON: deployment file from SP_DEPLOYMENT_JSON has invalid deployedAt/,
    );
    const { parameters: _parameters, ...withoutParameters } = sampleDeployment;
    await assert.rejects(
      loadDeploymentFile(undefined, {
        env: { SP_DEPLOYMENT_JSON: JSON.stringify(withoutParameters) },
      }),
      /missing parameters/,
    );
  });

  it("saves and loads deployment metadata through gcs paths", async () => {
    const objects = new Map<string, string>();
    const fakeClient = {
      async saveObject(input: { bucket: string; key: string; body: string }): Promise<void> {
        objects.set(`${input.bucket}/${input.key}`, input.body);
      },
      async readObject(input: { bucket: string; key: string }): Promise<string> {
        return objects.get(`${input.bucket}/${input.key}`) ?? "";
      },
      async objectExists(input: { bucket: string; key: string }): Promise<boolean> {
        return objects.has(`${input.bucket}/${input.key}`);
      },
    };

    const deploymentPath = "gs://sp-demo/runtime/staging.addresses.json";
    await saveDeploymentFile(sampleDeployment, deploymentPath, { gcsClient: fakeClient });
    expect(await deploymentFileExists(deploymentPath, { gcsClient: fakeClient })).to.equal(true);
    expect(await loadDeploymentFile(deploymentPath, { gcsClient: fakeClient })).to.deep.equal(
      sampleDeployment,
    );
  });

  it("saves and loads deployment metadata on the filesystem", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-deployment-"));
    const deploymentPath = path.join(tempRoot, "staging.addresses.json");
    try {
      await saveDeploymentFile(sampleDeployment, deploymentPath);
      expect(await deploymentFileExists(deploymentPath)).to.equal(true);
      expect(await loadDeploymentFile(deploymentPath)).to.deep.equal(sampleDeployment);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
