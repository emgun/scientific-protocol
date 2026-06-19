// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ProtocolRoles {
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant CLAIM_SUBMITTER_ROLE = keccak256("CLAIM_SUBMITTER_ROLE");
    bytes32 internal constant PARAMETER_ADMIN_ROLE = keccak256("PARAMETER_ADMIN_ROLE");
    bytes32 internal constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 internal constant CHECKPOINT_PUBLISHER_ROLE = keccak256("CHECKPOINT_PUBLISHER_ROLE");
    bytes32 internal constant MODULE_ADMIN_ROLE = keccak256("MODULE_ADMIN_ROLE");
    bytes32 internal constant ESCROW_ADMIN_ROLE = keccak256("ESCROW_ADMIN_ROLE");
    bytes32 internal constant AGENT_BUDGET_MANAGER_ROLE = keccak256("AGENT_BUDGET_MANAGER_ROLE");
    bytes32 internal constant MARKET_SETTLER_ROLE = keccak256("MARKET_SETTLER_ROLE");
    bytes32 internal constant REWARD_SETTLER_ROLE = keccak256("REWARD_SETTLER_ROLE");
    bytes32 internal constant COURT_ROLE = keccak256("COURT_ROLE");
}
