// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessManaged} from "./utils/AccessManaged.sol";
import {DepositPausable} from "./utils/DepositPausable.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";

/// @title ClaimRewardVault
/// @notice Holds claim-scoped reward pools across protocol work classes and accrues pull-based value over time.
/// @dev Heavy evidence and settlement policy stay offchain, while reward balances and pool depletion stay onchain.
contract ClaimRewardVault is DepositPausable, ReentrancyGuard {
    error ClaimRewardVaultUnknownClaim(uint256 claimId);
    error ClaimRewardVaultUnknownAgent(uint256 agentId);
    error ClaimRewardVaultInactiveAgent(uint256 agentId);
    error ClaimRewardVaultInvalidAmount(uint256 amount);
    error ClaimRewardVaultInvalidRecipient(address recipient);
    error ClaimRewardVaultInvalidBudgetTopUpBps(uint16 budgetTopUpBps);
    error ClaimRewardVaultInvalidWorkKind(uint8 workKind);
    error ClaimRewardVaultDuplicateSettlement(bytes32 settlementId);
    error ClaimRewardVaultInsufficientPoolBalance(
        uint256 claimId,
        uint8 workKind,
        uint256 requested,
        uint256 available
    );
    error ClaimRewardVaultTransferFailed(address recipient, uint256 amount);

    uint8 public constant WORK_KIND_REVIEW = 0;
    uint8 public constant WORK_KIND_REPLICATION = 1;
    uint8 public constant WORK_KIND_MAINTENANCE = 2;
    uint8 public constant WORK_KIND_CHALLENGE = 3;
    uint8 public constant WORK_KIND_SYNTHESIS = 4;
    uint8 public constant WORK_KIND_FORECAST = 5;
    uint8 public constant WORK_KIND_COUNT = 6;

    IAgentRegistry public immutable agentRegistry;
    IClaimRegistry public immutable claimRegistry;

    mapping(uint256 claimId => mapping(uint8 workKind => uint256 balance)) public claimRewardPools;
    mapping(address recipient => uint256 amount) public accruedRewardBalances;
    mapping(bytes32 settlementId => bool settled) public settledRewards;

    event ClaimRewardFunded(
        uint256 indexed claimId,
        uint8 indexed workKind,
        address indexed funder,
        uint256 amount,
        uint256 newPoolBalance
    );
    event WorkRewardAccrued(
        uint256 indexed claimId,
        uint8 indexed workKind,
        bytes32 indexed settlementId,
        uint256 agentId,
        address recipient,
        uint256 recipientAmount,
        uint256 agentBudgetAmount
    );
    event RewardWithdrawn(address indexed account, address indexed recipient, uint256 amount);

    constructor(
        address accessController_,
        address claimRegistry_,
        address agentRegistry_
    ) AccessManaged(accessController_) {
        claimRegistry = IClaimRegistry(claimRegistry_);
        agentRegistry = IAgentRegistry(agentRegistry_);
    }

    /// @notice Funds a claim-local reward pool for one work class.
    /// @dev Open funding is the first market signal for how much attention a claim or work class deserves.
    function fundClaimRewards(
        uint256 claimId,
        uint8 workKind
    ) external payable whenDepositsNotPaused {
        if (!claimRegistry.claimExists(claimId)) {
            revert ClaimRewardVaultUnknownClaim(claimId);
        }
        _requireValidWorkKind(workKind);
        if (msg.value == 0) {
            revert ClaimRewardVaultInvalidAmount(msg.value);
        }

        uint256 newPoolBalance = claimRewardPools[claimId][workKind] + msg.value;
        claimRewardPools[claimId][workKind] = newPoolBalance;
        emit ClaimRewardFunded(claimId, workKind, msg.sender, msg.value, newPoolBalance);
    }

    /// @notice Accrues value from a claim-local reward pool into a recipient balance and optionally into an agent budget.
    /// @dev Settlement ids stay unique so value can accrue continuously over time without ambiguous double-counting.
    function accrueWorkReward(
        uint256 claimId,
        uint8 workKind,
        bytes32 settlementId,
        address recipient,
        uint256 agentId,
        uint256 amount,
        uint16 budgetTopUpBps
    ) external onlyRole(ProtocolRoles.REWARD_SETTLER_ROLE) nonReentrant {
        if (!claimRegistry.claimExists(claimId)) {
            revert ClaimRewardVaultUnknownClaim(claimId);
        }
        _requireValidWorkKind(workKind);
        if (amount == 0) {
            revert ClaimRewardVaultInvalidAmount(amount);
        }
        if (settledRewards[settlementId]) {
            revert ClaimRewardVaultDuplicateSettlement(settlementId);
        }
        if (budgetTopUpBps > 10_000) {
            revert ClaimRewardVaultInvalidBudgetTopUpBps(budgetTopUpBps);
        }
        if (agentId == 0 && budgetTopUpBps != 0) {
            revert ClaimRewardVaultUnknownAgent(agentId);
        }
        if (agentId != 0 && !agentRegistry.agentExists(agentId)) {
            revert ClaimRewardVaultUnknownAgent(agentId);
        }

        uint256 available = claimRewardPools[claimId][workKind];
        if (available < amount) {
            revert ClaimRewardVaultInsufficientPoolBalance(claimId, workKind, amount, available);
        }

        uint256 agentBudgetAmount = (amount * uint256(budgetTopUpBps)) / 10_000;
        uint256 recipientAmount = amount - agentBudgetAmount;
        if (recipientAmount != 0 && recipient == address(0)) {
            revert ClaimRewardVaultInvalidRecipient(recipient);
        }
        if (agentBudgetAmount != 0 && !agentRegistry.isActiveAgent(agentId)) {
            revert ClaimRewardVaultInactiveAgent(agentId);
        }

        settledRewards[settlementId] = true;
        claimRewardPools[claimId][workKind] = available - amount;

        if (recipientAmount != 0) {
            accruedRewardBalances[recipient] += recipientAmount;
        }
        if (agentBudgetAmount != 0) {
            agentRegistry.fundAgentBudget{value: agentBudgetAmount}(agentId);
        }

        emit WorkRewardAccrued(
            claimId,
            workKind,
            settlementId,
            agentId,
            recipient,
            recipientAmount,
            agentBudgetAmount
        );
    }

    /// @notice Withdraws previously accrued rewards using a pull-based flow.
    function withdrawAccruedRewards(uint256 amount, address recipient) external nonReentrant {
        if (amount == 0) {
            revert ClaimRewardVaultInvalidAmount(amount);
        }
        if (recipient == address(0)) {
            revert ClaimRewardVaultInvalidRecipient(recipient);
        }

        uint256 available = accruedRewardBalances[msg.sender];
        if (available < amount) {
            revert ClaimRewardVaultInvalidAmount(amount);
        }

        accruedRewardBalances[msg.sender] = available - amount;
        _safeTransferValue(recipient, amount);
        emit RewardWithdrawn(msg.sender, recipient, amount);
    }

    function _requireValidWorkKind(uint8 workKind) internal pure {
        if (workKind >= WORK_KIND_COUNT) {
            revert ClaimRewardVaultInvalidWorkKind(workKind);
        }
    }

    function _safeTransferValue(address recipient, uint256 amount) internal {
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert ClaimRewardVaultTransferFailed(recipient, amount);
        }
    }
}
