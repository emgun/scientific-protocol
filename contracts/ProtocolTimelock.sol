// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title ProtocolTimelock
/// @notice Timelock executor for all DAO-approved protocol administration actions.
/// @dev The governor should be the only proposer and canceller after bootstrap, while execution can remain open.
contract ProtocolTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address initialAdmin
    ) TimelockController(minDelay, proposers, executors, initialAdmin) {}
}
