import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const { ethers } = await network.connect();

const ROLE = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));

const PROPOSAL_STATE = {
  Active: 1,
  Executed: 7,
  Pending: 0,
  Queued: 5,
  Succeeded: 4,
} as const;

function extractEventArg(
  contract: {
    interface: { parseLog: (log: unknown) => { name?: string; args: Record<string, unknown> } };
  },
  receipt: { logs: Array<unknown> },
  eventName: string,
  argName: string,
): unknown {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed.args[argName];
      }
    } catch {
      // Ignore unrelated logs.
    }
  }

  throw new Error(`missing ${eventName}.${argName}`);
}

async function mineBlocks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await ethers.provider.send("evm_mine", []);
  }
}

async function increaseTime(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function deployGovernanceProtocol() {
  const [admin, voter, recipient, lowVotesHolder] = await ethers.getSigners();

  const AccessController = await ethers.getContractFactory(
    "contracts/AccessController.sol:AccessController",
  );
  const accessController = await AccessController.deploy(admin.address);
  await accessController.waitForDeployment();

  for (const role of ["PARAMETER_ADMIN_ROLE", "MODULE_ADMIN_ROLE", "RESOLVER_ROLE"]) {
    await (await accessController.grantRole(ROLE(role), admin.address)).wait();
  }

  const ProtocolParameters = await ethers.getContractFactory(
    "contracts/ProtocolParameters.sol:ProtocolParameters",
  );
  const protocolParameters = await ProtocolParameters.deploy(await accessController.getAddress());
  await protocolParameters.waitForDeployment();

  const ResolutionModuleRegistry = await ethers.getContractFactory(
    "contracts/ResolutionModuleRegistry.sol:ResolutionModuleRegistry",
  );
  const resolutionModuleRegistry = await ResolutionModuleRegistry.deploy(
    await accessController.getAddress(),
  );
  await resolutionModuleRegistry.waitForDeployment();

  const ComputationalResolutionModule = await ethers.getContractFactory(
    "contracts/modules/ComputationalResolutionModule.sol:ComputationalResolutionModule",
  );
  const computationalModule = await ComputationalResolutionModule.deploy();
  await computationalModule.waitForDeployment();

  const BenchmarkResolutionModule = await ethers.getContractFactory(
    "contracts/modules/BenchmarkResolutionModule.sol:BenchmarkResolutionModule",
  );
  const benchmarkModule = await BenchmarkResolutionModule.deploy();
  await benchmarkModule.waitForDeployment();

  await (
    await resolutionModuleRegistry.registerModule(
      await computationalModule.getAddress(),
      "ipfs://modules/computational",
    )
  ).wait();
  await (
    await resolutionModuleRegistry.registerModule(
      await benchmarkModule.getAddress(),
      "ipfs://modules/benchmark",
    )
  ).wait();
  await (
    await resolutionModuleRegistry.setDomainModule(1, await computationalModule.getAddress())
  ).wait();

  const ProtocolGovernanceToken = await ethers.getContractFactory(
    "contracts/ProtocolGovernanceToken.sol:ProtocolGovernanceToken",
  );
  const governanceToken = await ProtocolGovernanceToken.deploy(
    "Scientific Protocol Governance Vote",
    "OSGV",
    admin.address,
  );
  await governanceToken.waitForDeployment();

  await (await governanceToken.mint(admin.address, ethers.parseUnits("900", 18))).wait();
  await (await governanceToken.mint(voter.address, ethers.parseUnits("200", 18))).wait();
  await (await governanceToken.mint(lowVotesHolder.address, ethers.parseUnits("50", 18))).wait();

  const ProtocolTimelock = await ethers.getContractFactory(
    "contracts/ProtocolTimelock.sol:ProtocolTimelock",
  );
  const timelock = await ProtocolTimelock.deploy(60, [], [], admin.address);
  await timelock.waitForDeployment();

  const ProtocolGovernor = await ethers.getContractFactory(
    "contracts/ProtocolGovernor.sol:ProtocolGovernor",
  );
  const governor = await ProtocolGovernor.deploy(
    "Scientific Protocol Governor",
    await governanceToken.getAddress(),
    await timelock.getAddress(),
    1,
    5,
    ethers.parseUnits("100", 18),
    10,
  );
  await governor.waitForDeployment();

  const ProtocolTreasury = await ethers.getContractFactory(
    "contracts/ProtocolTreasury.sol:ProtocolTreasury",
  );
  const treasury = await ProtocolTreasury.deploy(admin.address);
  await treasury.waitForDeployment();

  await (
    await admin.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("1"),
    })
  ).wait();

  await (
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress())
  ).wait();
  await (
    await timelock.grantRole(await timelock.CANCELLER_ROLE(), await governor.getAddress())
  ).wait();
  await (await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress)).wait();
  await (await governanceToken.transferOwnership(await timelock.getAddress())).wait();
  await (await treasury.transferOwnership(await timelock.getAddress())).wait();

  const defaultAdminRole = "0x0000000000000000000000000000000000000000000000000000000000000000";
  await (await accessController.grantRole(defaultAdminRole, await timelock.getAddress())).wait();
  await (
    await accessController.grantRole(ROLE("PARAMETER_ADMIN_ROLE"), await timelock.getAddress())
  ).wait();
  await (
    await accessController.grantRole(ROLE("MODULE_ADMIN_ROLE"), await timelock.getAddress())
  ).wait();
  await (await accessController.revokeRole(ROLE("PARAMETER_ADMIN_ROLE"), admin.address)).wait();
  await (await accessController.revokeRole(ROLE("MODULE_ADMIN_ROLE"), admin.address)).wait();
  await (await accessController.revokeRole(defaultAdminRole, admin.address)).wait();
  await (await timelock.renounceRole(await timelock.TIMELOCK_ADMIN_ROLE(), admin.address)).wait();

  return {
    accessController,
    admin,
    benchmarkModule,
    computationalModule,
    governanceToken,
    governor,
    lowVotesHolder,
    protocolParameters,
    recipient,
    resolutionModuleRegistry,
    timelock,
    treasury,
    voter,
  };
}

describe("ProtocolGovernance", () => {
  it("executes a batched governance proposal across protocol admin surfaces", async () => {
    const protocol = await deployGovernanceProtocol();
    const parameterKey = ethers.keccak256(ethers.toUtf8Bytes("governance.parameter.demo"));
    const treasuryReleaseAmount = ethers.parseEther("0.25");

    const targets = [
      await protocol.accessController.getAddress(),
      await protocol.protocolParameters.getAddress(),
      await protocol.resolutionModuleRegistry.getAddress(),
      await protocol.treasury.getAddress(),
    ];
    const values = [0, 0, 0, 0];
    const calldatas = [
      protocol.accessController.interface.encodeFunctionData("grantRole", [
        ROLE("RESOLVER_ROLE"),
        protocol.recipient.address,
      ]),
      protocol.protocolParameters.interface.encodeFunctionData("setUintParameter", [
        parameterKey,
        42,
      ]),
      protocol.resolutionModuleRegistry.interface.encodeFunctionData("setDomainModule", [
        1,
        await protocol.benchmarkModule.getAddress(),
      ]),
      protocol.treasury.interface.encodeFunctionData("releaseEther", [
        protocol.recipient.address,
        treasuryReleaseAmount,
      ]),
    ];
    const description =
      "Grant resolver capacity, update parameters, rotate module, and fund recipient";
    const descriptionHash = ethers.id(description);
    const proposalId = await protocol.governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash,
    );

    const proposeReceipt = await (
      await protocol.governor
        .connect(protocol.admin)
        .propose(targets, values, calldatas, description)
    ).wait();
    assert.equal(
      extractEventArg(
        protocol.governor,
        proposeReceipt,
        "ProposalCreated",
        "proposalId",
      )?.toString(),
      proposalId.toString(),
    );
    assert.equal(Number(await protocol.governor.state(proposalId)), PROPOSAL_STATE.Pending);

    await mineBlocks(2);
    assert.equal(Number(await protocol.governor.state(proposalId)), PROPOSAL_STATE.Active);

    await (await protocol.governor.connect(protocol.admin).castVote(proposalId, 1)).wait();
    await (await protocol.governor.connect(protocol.voter).castVote(proposalId, 1)).wait();

    await mineBlocks(6);
    assert.equal(Number(await protocol.governor.state(proposalId)), PROPOSAL_STATE.Succeeded);

    const queueReceipt = await (
      await protocol.governor
        .connect(protocol.admin)
        .queue(targets, values, calldatas, descriptionHash)
    ).wait();
    assert.equal(
      extractEventArg(protocol.governor, queueReceipt, "ProposalQueued", "proposalId")?.toString(),
      proposalId.toString(),
    );
    assert.equal(Number(await protocol.governor.state(proposalId)), PROPOSAL_STATE.Queued);

    const recipientBalanceBefore = await ethers.provider.getBalance(protocol.recipient.address);
    await increaseTime(61);

    const executeReceipt = await (
      await protocol.governor
        .connect(protocol.voter)
        .execute(targets, values, calldatas, descriptionHash)
    ).wait();
    assert.equal(
      extractEventArg(
        protocol.governor,
        executeReceipt,
        "ProposalExecuted",
        "proposalId",
      )?.toString(),
      proposalId.toString(),
    );

    assert.equal(
      await protocol.accessController.hasRole(ROLE("RESOLVER_ROLE"), protocol.recipient.address),
      true,
    );
    assert.equal(await protocol.protocolParameters.getUintParameter(parameterKey), 42n);
    assert.equal(
      await protocol.resolutionModuleRegistry.getDomainModule(1),
      await protocol.benchmarkModule.getAddress(),
    );
    assert.equal(
      (await ethers.provider.getBalance(protocol.recipient.address)) - recipientBalanceBefore,
      treasuryReleaseAmount,
    );
    assert.equal(Number(await protocol.governor.state(proposalId)), PROPOSAL_STATE.Executed);
  });

  it("keeps governance votes non-transferable and treasury control timelocked", async () => {
    const protocol = await deployGovernanceProtocol();

    await assert.rejects(
      protocol.governanceToken
        .connect(protocol.admin)
        .transfer(protocol.recipient.address, ethers.parseUnits("1", 18)),
      /ProtocolGovernanceTokenTransfersDisabled/,
    );
    await assert.rejects(
      protocol.treasury
        .connect(protocol.voter)
        .releaseEther(protocol.recipient.address, ethers.parseEther("0.1")),
      /Ownable: caller is not the owner/,
    );

    assert.equal(await protocol.treasury.owner(), await protocol.timelock.getAddress());
    assert.equal(await protocol.governanceToken.owner(), await protocol.timelock.getAddress());
  });

  it("enforces the proposal threshold and timelock delay", async () => {
    const protocol = await deployGovernanceProtocol();
    const parameterKey = ethers.keccak256(ethers.toUtf8Bytes("governance.parameter.threshold"));
    const targets = [await protocol.protocolParameters.getAddress()];
    const values = [0];
    const calldatas = [
      protocol.protocolParameters.interface.encodeFunctionData("setUintParameter", [
        parameterKey,
        7,
      ]),
    ];
    const description = "Threshold and delay enforcement";
    const descriptionHash = ethers.id(description);
    const proposalId = await protocol.governor.hashProposal(
      targets,
      values,
      calldatas,
      descriptionHash,
    );

    await assert.rejects(
      protocol.governor
        .connect(protocol.lowVotesHolder)
        .propose(targets, values, calldatas, description),
      /Governor: proposer votes below proposal threshold/,
    );

    await (
      await protocol.governor
        .connect(protocol.admin)
        .propose(targets, values, calldatas, description)
    ).wait();
    await mineBlocks(2);
    await (await protocol.governor.connect(protocol.admin).castVote(proposalId, 1)).wait();
    await mineBlocks(6);
    await (await protocol.governor.queue(targets, values, calldatas, descriptionHash)).wait();

    await assert.rejects(
      protocol.governor.execute(targets, values, calldatas, descriptionHash),
      /TimelockController: operation is not ready/,
    );
  });
});
