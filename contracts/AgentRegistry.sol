// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessManaged} from "./utils/AccessManaged.sol";
import {DepositPausable} from "./utils/DepositPausable.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

contract AgentRegistry is DepositPausable, ReentrancyGuard, IAgentRegistry {
    error AgentRegistryUnknownAgent(uint256 agentId);
    error AgentRegistryUnauthorizedAgent(uint256 agentId, address actor);
    error AgentRegistryInvalidAmount(uint256 amount);
    error AgentRegistrySpendLimitExceeded(uint256 agentId, uint256 requested, uint256 limit);
    error AgentRegistryInsufficientBudget(uint256 agentId, uint256 requested, uint256 available);
    error AgentRegistryTransferFailed(address recipient, uint256 amount);
    error AgentRegistryInvalidRecipient(address recipient);
    error AgentRegistryInactiveAgent(uint256 agentId);

    struct AgentRecord {
        uint256 agentId;
        address operator;
        bytes32 metadataHash;
        string uri;
        uint256 budgetBalance;
        uint256 reservedBudget;
        uint256 spendLimit;
        bool active;
    }

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed operator,
        bytes32 metadataHash,
        string uri,
        uint256 spendLimit
    );
    event AgentControllerAuthorization(
        uint256 indexed agentId,
        address indexed controller,
        bool authorized
    );
    event AgentBudgetDeposited(uint256 indexed agentId, address indexed funder, uint256 amount);
    event AgentSpendLimitUpdated(
        uint256 indexed agentId,
        uint256 newSpendLimit,
        address indexed actor
    );
    event AgentBudgetReserved(uint256 indexed agentId, uint256 amount, address indexed actor);
    event AgentBudgetReleased(uint256 indexed agentId, uint256 amount, address indexed actor);
    event AgentBudgetConsumed(
        uint256 indexed agentId,
        uint256 amount,
        address indexed recipient,
        address actor
    );
    event AgentBudgetWithdrawn(uint256 indexed agentId, uint256 amount, address indexed recipient);
    event AgentStatusUpdated(uint256 indexed agentId, bool active, address indexed actor);

    uint256 public nextAgentId = 1;

    mapping(uint256 agentId => AgentRecord record) private _agents;
    mapping(uint256 agentId => mapping(address controller => bool authorized)) private _controllers;

    constructor(address accessController_) AccessManaged(accessController_) {}

    /// @notice Registers a sovereign agent with operator-linked controls and optional initial budget.
    function registerAgent(
        bytes32 metadataHash,
        string calldata uri,
        uint256 spendLimit
    ) external payable whenDepositsNotPaused returns (uint256 agentId) {
        agentId = nextAgentId++;

        _agents[agentId] = AgentRecord({
            agentId: agentId,
            operator: msg.sender,
            metadataHash: metadataHash,
            uri: uri,
            budgetBalance: msg.value,
            reservedBudget: 0,
            spendLimit: spendLimit,
            active: true
        });

        _controllers[agentId][msg.sender] = true;
        emit AgentRegistered(agentId, msg.sender, metadataHash, uri, spendLimit);
        if (msg.value != 0) {
            emit AgentBudgetDeposited(agentId, msg.sender, msg.value);
        }
    }

    function authorizeController(uint256 agentId, address controller, bool authorized) external {
        AgentRecord storage agent = _requireOperator(agentId);
        _controllers[agentId][controller] = authorized;
        emit AgentControllerAuthorization(agent.agentId, controller, authorized);
    }

    function setSpendLimit(uint256 agentId, uint256 spendLimit) external {
        AgentRecord storage agent = _requireOperator(agentId);
        agent.spendLimit = spendLimit;
        emit AgentSpendLimitUpdated(agentId, spendLimit, msg.sender);
    }

    function setAgentActive(uint256 agentId, bool active) external {
        AgentRecord storage agent = _requireOperator(agentId);
        agent.active = active;
        emit AgentStatusUpdated(agentId, active, msg.sender);
    }

    /// @notice Funds an existing agent budget without requiring operator-only custody.
    /// @dev Used by operators, funders, and protocol-native reward layers alike to stream value
    /// directly into agent capacity.
    function fundAgentBudget(uint256 agentId) external payable nonReentrant whenDepositsNotPaused {
        AgentRecord storage agent = _agents[agentId];
        if (agent.agentId == 0) {
            revert AgentRegistryUnknownAgent(agentId);
        }
        if (msg.value == 0) {
            revert AgentRegistryInvalidAmount(msg.value);
        }

        agent.budgetBalance += msg.value;
        emit AgentBudgetDeposited(agentId, msg.sender, msg.value);
    }

    function reserveBudget(
        uint256 agentId,
        uint256 amount
    ) external onlyRole(ProtocolRoles.AGENT_BUDGET_MANAGER_ROLE) {
        AgentRecord storage agent = _requireExistingAgent(agentId);
        _requireActiveAgent(agent);
        if (amount == 0) {
            revert AgentRegistryInvalidAmount(amount);
        }

        uint256 reservedAfter = agent.reservedBudget + amount;
        if (reservedAfter > agent.spendLimit) {
            revert AgentRegistrySpendLimitExceeded(agentId, reservedAfter, agent.spendLimit);
        }
        if (agent.budgetBalance < reservedAfter) {
            revert AgentRegistryInsufficientBudget(agentId, reservedAfter, agent.budgetBalance);
        }

        agent.reservedBudget = reservedAfter;
        emit AgentBudgetReserved(agentId, amount, msg.sender);
    }

    function releaseBudget(
        uint256 agentId,
        uint256 amount
    ) external onlyRole(ProtocolRoles.AGENT_BUDGET_MANAGER_ROLE) {
        AgentRecord storage agent = _requireExistingAgent(agentId);
        if (amount == 0) {
            revert AgentRegistryInvalidAmount(amount);
        }
        if (agent.reservedBudget < amount) {
            revert AgentRegistryInsufficientBudget(agentId, amount, agent.reservedBudget);
        }

        agent.reservedBudget -= amount;
        emit AgentBudgetReleased(agentId, amount, msg.sender);
    }

    function consumeBudget(
        uint256 agentId,
        uint256 amount,
        address recipient
    ) external onlyRole(ProtocolRoles.AGENT_BUDGET_MANAGER_ROLE) nonReentrant {
        AgentRecord storage agent = _requireExistingAgent(agentId);
        _requireActiveAgent(agent);
        if (amount == 0) {
            revert AgentRegistryInvalidAmount(amount);
        }
        _requireValidRecipient(recipient);
        if (agent.reservedBudget < amount || agent.budgetBalance < amount) {
            revert AgentRegistryInsufficientBudget(agentId, amount, agent.budgetBalance);
        }

        agent.reservedBudget -= amount;
        agent.budgetBalance -= amount;
        _safeTransferValue(recipient, amount);
        emit AgentBudgetConsumed(agentId, amount, recipient, msg.sender);
    }

    function withdrawBudget(
        uint256 agentId,
        uint256 amount,
        address recipient
    ) external nonReentrant {
        AgentRecord storage agent = _requireOperator(agentId);
        if (amount == 0) {
            revert AgentRegistryInvalidAmount(amount);
        }
        _requireValidRecipient(recipient);

        uint256 availableBudget = agent.budgetBalance - agent.reservedBudget;
        if (availableBudget < amount) {
            revert AgentRegistryInsufficientBudget(agentId, amount, availableBudget);
        }

        agent.budgetBalance -= amount;
        _safeTransferValue(recipient, amount);
        emit AgentBudgetWithdrawn(agentId, amount, recipient);
    }

    function agentExists(uint256 agentId) external view override returns (bool) {
        return _agents[agentId].agentId != 0;
    }

    function isActiveAgent(uint256 agentId) external view override returns (bool) {
        AgentRecord storage agent = _agents[agentId];
        return agent.agentId != 0 && agent.active;
    }

    function isAuthorizedController(
        uint256 agentId,
        address controller
    ) external view override returns (bool) {
        AgentRecord storage agent = _agents[agentId];
        return agent.agentId != 0 && agent.active && _controllers[agentId][controller];
    }

    function getAgent(uint256 agentId) external view returns (AgentRecord memory) {
        return _requireExistingAgent(agentId);
    }

    function _requireOperator(uint256 agentId) internal view returns (AgentRecord storage agent) {
        agent = _requireExistingAgent(agentId);
        if (msg.sender != agent.operator) {
            revert AgentRegistryUnauthorizedAgent(agentId, msg.sender);
        }
    }

    function _requireExistingAgent(
        uint256 agentId
    ) internal view returns (AgentRecord storage agent) {
        agent = _agents[agentId];
        if (agent.agentId == 0) {
            revert AgentRegistryUnknownAgent(agentId);
        }
    }

    function _safeTransferValue(address recipient, uint256 amount) internal {
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert AgentRegistryTransferFailed(recipient, amount);
        }
    }

    function _requireActiveAgent(AgentRecord storage agent) internal view {
        if (!agent.active) {
            revert AgentRegistryInactiveAgent(agent.agentId);
        }
    }

    function _requireValidRecipient(address recipient) internal pure {
        if (recipient == address(0)) {
            revert AgentRegistryInvalidRecipient(recipient);
        }
    }
}
