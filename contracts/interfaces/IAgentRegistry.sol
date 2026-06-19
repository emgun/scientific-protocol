// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentRegistry {
    function agentExists(uint256 agentId) external view returns (bool);
    function isActiveAgent(uint256 agentId) external view returns (bool);
    function fundAgentBudget(uint256 agentId) external payable;
    function isAuthorizedController(
        uint256 agentId,
        address controller
    ) external view returns (bool);
}
