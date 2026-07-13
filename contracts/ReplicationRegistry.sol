// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessManaged} from "./utils/AccessManaged.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IReplicationRegistry} from "./interfaces/IReplicationRegistry.sol";
import {IResolutionModule} from "./interfaces/IResolutionModule.sol";

/// @title ReplicationRegistry
/// @notice Append-only replication submissions and role-gated, module-validated outcomes.
contract ReplicationRegistry is AccessManaged, IReplicationRegistry {
    error ReplicationRegistryUnknownClaim(uint256 claimId);
    error ReplicationRegistryUnknownReplication(uint256 replicationId);
    error ReplicationRegistryUnauthorizedAgent(uint256 agentId, address actor);
    error ReplicationRegistryAlreadyResolved(uint256 replicationId);
    error ReplicationRegistryModuleRejected(address module, uint256 replicationId);

    event ReplicationSubmitted(
        uint256 indexed replicationId,
        uint256 indexed claimId,
        address indexed replicator,
        uint256 agentId,
        bytes32 resultHash
    );
    event ReplicationResolved(
        uint256 indexed replicationId,
        ProtocolTypes.ReplicationOutcome outcome,
        ProtocolTypes.ResolutionStatus status,
        bytes32 resolutionHash,
        address indexed resolver,
        uint16 confidenceBps,
        ProtocolTypes.ResolverType resolverType,
        bytes32 evidenceHash,
        string evidenceURI
    );

    uint256 public nextReplicationId = 1;

    IClaimRegistry public immutable claimRegistry;
    IAgentRegistry public immutable agentRegistry;

    mapping(uint256 replicationId => ProtocolTypes.ReplicationRecord replication)
        private _replications;
    mapping(uint256 claimId => uint256[] replicationIds) private _claimReplications;

    constructor(
        address accessController_,
        address claimRegistry_,
        address agentRegistry_
    ) AccessManaged(accessController_) {
        claimRegistry = IClaimRegistry(claimRegistry_);
        agentRegistry = IAgentRegistry(agentRegistry_);
    }

    /// @notice Submits a replication record, optionally attributing the action to a registered agent.
    function submitReplication(
        uint256 claimId,
        bytes32 environmentHash,
        bytes32 resultHash,
        bytes32 evidenceHash,
        uint256 agentId
    ) external returns (uint256 replicationId) {
        if (!claimRegistry.claimExists(claimId)) {
            revert ReplicationRegistryUnknownClaim(claimId);
        }
        if (agentId != 0 && !agentRegistry.isAuthorizedController(agentId, msg.sender)) {
            revert ReplicationRegistryUnauthorizedAgent(agentId, msg.sender);
        }

        replicationId = nextReplicationId++;
        _replications[replicationId] = ProtocolTypes.ReplicationRecord({
            replicationId: replicationId,
            claimId: claimId,
            replicator: msg.sender,
            agentId: agentId,
            environmentHash: environmentHash,
            resultHash: resultHash,
            evidenceHash: evidenceHash,
            outcome: ProtocolTypes.ReplicationOutcome.Pending,
            resolutionStatus: ProtocolTypes.ResolutionStatus.Pending,
            resolutionHash: bytes32(0),
            resolutionEvidenceHash: bytes32(0),
            resolutionEvidenceURI: "",
            resolverType: ProtocolTypes.ResolverType.Unknown,
            confidenceBps: 0,
            submittedAt: block.timestamp,
            resolvedAt: 0,
            resolver: address(0)
        });

        _claimReplications[claimId].push(replicationId);
        emit ReplicationSubmitted(replicationId, claimId, msg.sender, agentId, resultHash);
    }

    /// @notice Resolves a replication with normalized module output while preserving append-only history.
    function resolveReplicationOutcome(
        uint256 replicationId,
        ProtocolTypes.ResolutionResult calldata result
    ) external onlyRole(ProtocolRoles.RESOLVER_ROLE) {
        ProtocolTypes.ReplicationRecord storage replication = _replications[replicationId];
        if (replication.replicationId == 0) {
            revert ReplicationRegistryUnknownReplication(replicationId);
        }
        if (replication.resolvedAt != 0) {
            revert ReplicationRegistryAlreadyResolved(replicationId);
        }

        address module = claimRegistry.getClaimResolutionModule(replication.claimId);
        bool accepted = IResolutionModule(module).validateResolution(
            replication.claimId,
            replicationId,
            result
        );
        if (!accepted) {
            revert ReplicationRegistryModuleRejected(module, replicationId);
        }

        ProtocolTypes.ReplicationOutcome outcome = _mapResolutionStatus(result.status);

        replication.outcome = outcome;
        replication.resolutionStatus = result.status;
        replication.resolutionHash = result.resolutionHash;
        replication.resolutionEvidenceHash = result.evidenceHash;
        replication.resolutionEvidenceURI = result.evidenceURI;
        replication.resolverType = result.resolverType;
        replication.confidenceBps = result.confidenceBps;
        replication.resolvedAt = block.timestamp;
        replication.resolver = msg.sender;

        emit ReplicationResolved(
            replicationId,
            outcome,
            result.status,
            result.resolutionHash,
            msg.sender,
            result.confidenceBps,
            result.resolverType,
            result.evidenceHash,
            result.evidenceURI
        );
    }

    function getReplication(
        uint256 replicationId
    ) external view override returns (ProtocolTypes.ReplicationRecord memory) {
        ProtocolTypes.ReplicationRecord memory replication = _replications[replicationId];
        if (replication.replicationId == 0) {
            revert ReplicationRegistryUnknownReplication(replicationId);
        }
        return replication;
    }

    function getClaimReplicationIds(uint256 claimId) external view returns (uint256[] memory) {
        return _claimReplications[claimId];
    }

    function replicationExists(uint256 replicationId) external view override returns (bool) {
        return _replications[replicationId].replicationId != 0;
    }

    function getReplicationClaimId(uint256 replicationId) external view override returns (uint256) {
        return _replications[replicationId].claimId;
    }

    function getReplicationReplicator(
        uint256 replicationId
    ) external view override returns (address) {
        return _replications[replicationId].replicator;
    }

    function isReplicationResolved(uint256 replicationId) external view override returns (bool) {
        return _replications[replicationId].resolvedAt != 0;
    }

    function _mapResolutionStatus(
        ProtocolTypes.ResolutionStatus status
    ) internal pure returns (ProtocolTypes.ReplicationOutcome) {
        if (status == ProtocolTypes.ResolutionStatus.Supported) {
            return ProtocolTypes.ReplicationOutcome.Supports;
        }
        if (status == ProtocolTypes.ResolutionStatus.Qualified) {
            return ProtocolTypes.ReplicationOutcome.PartiallySupports;
        }
        if (
            status == ProtocolTypes.ResolutionStatus.Inconclusive ||
            status == ProtocolTypes.ResolutionStatus.Escalated
        ) {
            return ProtocolTypes.ReplicationOutcome.Inconclusive;
        }
        if (status == ProtocolTypes.ResolutionStatus.Refuted) {
            return ProtocolTypes.ReplicationOutcome.FailsToSupport;
        }
        if (status == ProtocolTypes.ResolutionStatus.FraudSignal) {
            return ProtocolTypes.ReplicationOutcome.FraudSignal;
        }
        return ProtocolTypes.ReplicationOutcome.InvalidSubmission;
    }
}
