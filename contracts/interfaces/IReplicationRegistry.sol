// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

interface IReplicationRegistry {
    function replicationExists(uint256 replicationId) external view returns (bool);

    function getReplicationClaimId(uint256 replicationId) external view returns (uint256);

    function getReplicationReplicator(uint256 replicationId) external view returns (address);

    function isReplicationResolved(uint256 replicationId) external view returns (bool);

    function getReplication(
        uint256 replicationId
    ) external view returns (ProtocolTypes.ReplicationRecord memory);
}
