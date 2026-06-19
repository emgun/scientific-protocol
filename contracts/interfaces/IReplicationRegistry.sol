// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReplicationRegistry {
    function replicationExists(uint256 replicationId) external view returns (bool);

    function getReplicationClaimId(uint256 replicationId) external view returns (uint256);
}
