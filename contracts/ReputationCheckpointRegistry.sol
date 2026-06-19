// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessManaged} from "./utils/AccessManaged.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IResolutionModuleRegistry} from "./interfaces/IResolutionModuleRegistry.sol";

contract ReputationCheckpointRegistry is AccessManaged {
    error ReputationCheckpointRegistryInvalidSubject(
        ProtocolTypes.CheckpointSubjectType subjectType
    );
    error ReputationCheckpointRegistryUnknownClaim(uint256 claimId);
    error ReputationCheckpointRegistryUnknownAgent(uint256 agentId);
    error ReputationCheckpointRegistryUnknownModule(address module);
    error ReputationCheckpointRegistryUnknownCheckpoint(uint256 checkpointId);

    struct CheckpointRecord {
        uint256 checkpointId;
        uint64 domainId;
        ProtocolTypes.CheckpointSubjectType subjectType;
        address subjectActor;
        uint256 subjectClaimId;
        uint256 subjectAgentId;
        address subjectModule;
        bytes32 scoreVectorHash;
        bytes32 payloadHash;
        string uri;
        uint256 publishedAt;
    }

    event ReputationCheckpointPublished(
        uint256 indexed checkpointId,
        uint64 indexed domainId,
        ProtocolTypes.CheckpointSubjectType indexed subjectType,
        address subjectActor,
        uint256 subjectClaimId,
        uint256 subjectAgentId,
        address subjectModule,
        bytes32 scoreVectorHash,
        bytes32 payloadHash,
        string uri
    );

    uint256 public nextCheckpointId = 1;

    IClaimRegistry public immutable claimRegistry;
    IAgentRegistry public immutable agentRegistry;
    IResolutionModuleRegistry public immutable resolutionModuleRegistry;

    mapping(uint256 checkpointId => CheckpointRecord record) private _checkpoints;

    constructor(
        address accessController_,
        address claimRegistry_,
        address agentRegistry_,
        address resolutionModuleRegistry_
    ) AccessManaged(accessController_) {
        claimRegistry = IClaimRegistry(claimRegistry_);
        agentRegistry = IAgentRegistry(agentRegistry_);
        resolutionModuleRegistry = IResolutionModuleRegistry(resolutionModuleRegistry_);
    }

    /// @notice Publishes an append-only reputation checkpoint for actors, claims, agents, or modules.
    function publishCheckpoint(
        uint64 domainId,
        ProtocolTypes.CheckpointSubjectType subjectType,
        address subjectActor,
        uint256 subjectClaimId,
        uint256 subjectAgentId,
        address subjectModule,
        bytes32 scoreVectorHash,
        bytes32 payloadHash,
        string calldata uri
    ) external onlyRole(ProtocolRoles.CHECKPOINT_PUBLISHER_ROLE) returns (uint256 checkpointId) {
        _validateSubject(subjectType, subjectActor, subjectClaimId, subjectAgentId, subjectModule);

        checkpointId = nextCheckpointId++;
        _checkpoints[checkpointId] = CheckpointRecord({
            checkpointId: checkpointId,
            domainId: domainId,
            subjectType: subjectType,
            subjectActor: subjectActor,
            subjectClaimId: subjectClaimId,
            subjectAgentId: subjectAgentId,
            subjectModule: subjectModule,
            scoreVectorHash: scoreVectorHash,
            payloadHash: payloadHash,
            uri: uri,
            publishedAt: block.timestamp
        });

        emit ReputationCheckpointPublished(
            checkpointId,
            domainId,
            subjectType,
            subjectActor,
            subjectClaimId,
            subjectAgentId,
            subjectModule,
            scoreVectorHash,
            payloadHash,
            uri
        );
    }

    function getCheckpoint(uint256 checkpointId) external view returns (CheckpointRecord memory) {
        CheckpointRecord memory checkpoint = _checkpoints[checkpointId];
        if (checkpoint.checkpointId == 0) {
            revert ReputationCheckpointRegistryUnknownCheckpoint(checkpointId);
        }
        return checkpoint;
    }

    function _validateSubject(
        ProtocolTypes.CheckpointSubjectType subjectType,
        address subjectActor,
        uint256 subjectClaimId,
        uint256 subjectAgentId,
        address subjectModule
    ) internal view {
        if (subjectType == ProtocolTypes.CheckpointSubjectType.Actor) {
            if (
                subjectActor == address(0) ||
                subjectClaimId != 0 ||
                subjectAgentId != 0 ||
                subjectModule != address(0)
            ) {
                revert ReputationCheckpointRegistryInvalidSubject(subjectType);
            }
            return;
        }

        if (subjectType == ProtocolTypes.CheckpointSubjectType.Claim) {
            if (subjectActor != address(0) || subjectAgentId != 0 || subjectModule != address(0)) {
                revert ReputationCheckpointRegistryInvalidSubject(subjectType);
            }
            if (!claimRegistry.claimExists(subjectClaimId)) {
                revert ReputationCheckpointRegistryUnknownClaim(subjectClaimId);
            }
            return;
        }

        if (subjectType == ProtocolTypes.CheckpointSubjectType.ActorClaimPair) {
            if (subjectActor == address(0) || subjectAgentId != 0 || subjectModule != address(0)) {
                revert ReputationCheckpointRegistryInvalidSubject(subjectType);
            }
            if (!claimRegistry.claimExists(subjectClaimId)) {
                revert ReputationCheckpointRegistryUnknownClaim(subjectClaimId);
            }
            return;
        }

        if (subjectType == ProtocolTypes.CheckpointSubjectType.Agent) {
            if (subjectActor != address(0) || subjectClaimId != 0 || subjectModule != address(0)) {
                revert ReputationCheckpointRegistryInvalidSubject(subjectType);
            }
            if (!agentRegistry.agentExists(subjectAgentId)) {
                revert ReputationCheckpointRegistryUnknownAgent(subjectAgentId);
            }
            return;
        }

        if (subjectType == ProtocolTypes.CheckpointSubjectType.Module) {
            if (subjectActor != address(0) || subjectClaimId != 0 || subjectAgentId != 0) {
                revert ReputationCheckpointRegistryInvalidSubject(subjectType);
            }
            if (!resolutionModuleRegistry.isRegisteredModule(subjectModule)) {
                revert ReputationCheckpointRegistryUnknownModule(subjectModule);
            }
            return;
        }

        revert ReputationCheckpointRegistryInvalidSubject(subjectType);
    }
}
