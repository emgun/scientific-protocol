// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {ProtocolDeployer} from "./utils/ProtocolDeployer.sol";
import {AgentRegistry} from "../contracts/AgentRegistry.sol";
import {ClaimRewardVault} from "../contracts/ClaimRewardVault.sol";
import {ProtocolRoles} from "../contracts/libraries/ProtocolRoles.sol";

contract RewardVaultHandler is Test {
    ClaimRewardVault internal immutable vault;
    AgentRegistry internal immutable agents;
    address internal immutable admin;
    uint256 internal immutable claimId;
    uint256 internal immutable agentId;

    address internal immutable recipientA = makeAddr("rewardRecipientA");
    address internal immutable recipientB = makeAddr("rewardRecipientB");

    uint256 internal settlementNonce;

    constructor(
        address vault_,
        address agents_,
        address admin_,
        uint256 claimId_,
        uint256 agentId_
    ) {
        vault = ClaimRewardVault(vault_);
        agents = AgentRegistry(agents_);
        admin = admin_;
        claimId = claimId_;
        agentId = agentId_;
    }

    receive() external payable {}

    function fundPool(uint256 amountSeed, uint256 workKindSeed) external {
        uint8 workKind = uint8(workKindSeed % vault.WORK_KIND_COUNT());
        uint256 amount = bound(amountSeed, 0.01 ether, 1 ether);
        vault.fundClaimRewards{value: amount}(claimId, workKind);
    }

    function accrueReward(
        uint256 amountSeed,
        uint256 workKindSeed,
        uint256 topUpSeed,
        bool useAgent
    ) external {
        uint8 workKind = uint8(workKindSeed % vault.WORK_KIND_COUNT());
        uint256 available = vault.claimRewardPools(claimId, workKind);
        if (available == 0) {
            return;
        }
        uint256 amount = bound(amountSeed, 1, available);
        uint16 budgetTopUpBps = useAgent ? uint16(bound(topUpSeed, 0, 10_000)) : 0;
        address recipient = topUpSeed % 2 == 0 ? recipientA : recipientB;
        if (topUpSeed % 5 == 0) {
            recipient = address(this);
        }

        vm.prank(admin);
        vault.accrueWorkReward(
            claimId,
            workKind,
            keccak256(abi.encodePacked("settlement", settlementNonce++)),
            recipient,
            useAgent ? agentId : 0,
            amount,
            budgetTopUpBps
        );
    }

    function withdrawAccrued(uint256 amountSeed) external {
        uint256 available = vault.accruedRewardBalances(address(this));
        if (available == 0) {
            return;
        }
        vault.withdrawAccruedRewards(bound(amountSeed, 1, available), address(this));
    }

    function trackedLiabilities() external view returns (uint256 total) {
        for (uint8 workKind = 0; workKind < vault.WORK_KIND_COUNT(); workKind++) {
            total += vault.claimRewardPools(claimId, workKind);
        }
        total += vault.accruedRewardBalances(address(this));
        total += vault.accruedRewardBalances(recipientA);
        total += vault.accruedRewardBalances(recipientB);
    }
}

contract RewardVaultInvariantTest is StdInvariant, ProtocolDeployer {
    RewardVaultHandler internal handler;
    ClaimRewardVault internal vault;

    function setUp() public {
        deployProtocol();
        uint256 claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), 1 ether);

        vm.startPrank(admin);
        accessController.grantRole(ProtocolRoles.REWARD_SETTLER_ROLE, admin);
        vault = new ClaimRewardVault(
            address(accessController),
            address(claimRegistry),
            address(agentRegistry)
        );
        vm.stopPrank();

        vm.prank(agentOperator);
        uint256 agentId = agentRegistry.registerAgent(
            keccak256("vault-agent"),
            "ipfs://agent/vault",
            type(uint256).max
        );

        handler = new RewardVaultHandler(
            address(vault),
            address(agentRegistry),
            admin,
            claimId,
            agentId
        );
        vm.deal(address(handler), 1_000 ether);
        targetContract(address(handler));
    }

    /// @dev The vault must always hold exactly the sum of its claim pools and accrued recipient
    /// balances; agent budget top-ups leave for the agent registry at accrual time.
    function invariant_VaultBalanceMatchesLiabilities() public view {
        assertEq(address(vault).balance, handler.trackedLiabilities());
    }
}

contract AgentBudgetHandler is Test {
    AgentRegistry internal immutable agents;
    address internal immutable admin;

    constructor(address agents_, address admin_) {
        agents = AgentRegistry(agents_);
        admin = admin_;
    }

    receive() external payable {}

    function registerAgent(uint256 amountSeed, uint256 spendLimitSeed) external {
        if (agents.nextAgentId() > 8) {
            return;
        }
        agents.registerAgent{value: bound(amountSeed, 0, 1 ether)}(
            keccak256(abi.encodePacked("agent", agents.nextAgentId())),
            "ipfs://agent/budget",
            bound(spendLimitSeed, 0.1 ether, 100 ether)
        );
    }

    function fundBudget(uint256 agentSeed, uint256 amountSeed) external {
        uint256 agentId = _pickAgent(agentSeed);
        if (agentId == 0) {
            return;
        }
        agents.fundAgentBudget{value: bound(amountSeed, 0.01 ether, 1 ether)}(agentId);
    }

    function reserveBudget(uint256 agentSeed, uint256 amountSeed) external {
        uint256 agentId = _pickAgent(agentSeed);
        if (agentId == 0) {
            return;
        }
        AgentRegistry.AgentRecord memory agent = agents.getAgent(agentId);
        if (!agent.active) {
            return;
        }
        uint256 headroom =
            agent.spendLimit > agent.reservedBudget ? agent.spendLimit - agent.reservedBudget : 0;
        if (agent.budgetBalance <= agent.reservedBudget) {
            return;
        }
        uint256 available = agent.budgetBalance - agent.reservedBudget;
        uint256 maxReserve = available < headroom ? available : headroom;
        if (maxReserve == 0) {
            return;
        }
        vm.prank(admin);
        agents.reserveBudget(agentId, bound(amountSeed, 1, maxReserve));
    }

    function releaseBudget(uint256 agentSeed, uint256 amountSeed) external {
        uint256 agentId = _pickAgent(agentSeed);
        if (agentId == 0) {
            return;
        }
        uint256 reserved = agents.getAgent(agentId).reservedBudget;
        if (reserved == 0) {
            return;
        }
        vm.prank(admin);
        agents.releaseBudget(agentId, bound(amountSeed, 1, reserved));
    }

    function consumeBudget(uint256 agentSeed, uint256 amountSeed) external {
        uint256 agentId = _pickAgent(agentSeed);
        if (agentId == 0) {
            return;
        }
        AgentRegistry.AgentRecord memory agent = agents.getAgent(agentId);
        if (!agent.active || agent.reservedBudget == 0) {
            return;
        }
        vm.prank(admin);
        agents.consumeBudget(agentId, bound(amountSeed, 1, agent.reservedBudget), address(this));
    }

    function withdrawBudget(uint256 agentSeed, uint256 amountSeed) external {
        uint256 agentId = _pickAgent(agentSeed);
        if (agentId == 0) {
            return;
        }
        AgentRegistry.AgentRecord memory agent = agents.getAgent(agentId);
        if (agent.budgetBalance <= agent.reservedBudget) {
            return;
        }
        uint256 available = agent.budgetBalance - agent.reservedBudget;
        agents.withdrawBudget(agentId, bound(amountSeed, 1, available), address(this));
    }

    function setAgentActive(uint256 agentSeed, bool active) external {
        uint256 agentId = _pickAgent(agentSeed);
        if (agentId == 0) {
            return;
        }
        agents.setAgentActive(agentId, active);
    }

    function setSpendLimit(uint256 agentSeed, uint256 limitSeed) external {
        uint256 agentId = _pickAgent(agentSeed);
        if (agentId == 0) {
            return;
        }
        agents.setSpendLimit(agentId, bound(limitSeed, 0, 100 ether));
    }

    function trackedBudgets() external view returns (uint256 total) {
        uint256 nextAgentId = agents.nextAgentId();
        for (uint256 agentId = 1; agentId < nextAgentId; agentId++) {
            total += agents.getAgent(agentId).budgetBalance;
        }
    }

    function _pickAgent(uint256 seed) internal view returns (uint256) {
        uint256 nextAgentId = agents.nextAgentId();
        if (nextAgentId <= 1) {
            return 0;
        }
        return bound(seed, 1, nextAgentId - 1);
    }
}

contract AgentBudgetInvariantTest is StdInvariant, ProtocolDeployer {
    AgentBudgetHandler internal handler;

    function setUp() public {
        deployProtocol();
        handler = new AgentBudgetHandler(address(agentRegistry), admin);
        vm.deal(address(handler), 1_000 ether);
        targetContract(address(handler));
    }

    /// @dev The registry must always hold exactly the sum of all tracked agent budgets.
    function invariant_RegistryBalanceMatchesBudgets() public view {
        assertEq(address(agentRegistry).balance, handler.trackedBudgets());
    }

    /// @dev No agent's reservation may ever exceed its tracked budget balance.
    function invariant_ReservedNeverExceedsBudget() public view {
        uint256 nextAgentId = agentRegistry.nextAgentId();
        for (uint256 agentId = 1; agentId < nextAgentId; agentId++) {
            AgentRegistry.AgentRecord memory agent = agentRegistry.getAgent(agentId);
            assertLe(agent.reservedBudget, agent.budgetBalance);
        }
    }
}
