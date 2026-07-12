// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessManaged} from "./utils/AccessManaged.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IBondEscrow} from "./interfaces/IBondEscrow.sol";
import {IProtocolParameters} from "./interfaces/IProtocolParameters.sol";
import {IReplicationRegistry} from "./interfaces/IReplicationRegistry.sol";
import {IResolutionModuleRegistry} from "./interfaces/IResolutionModuleRegistry.sol";

/// @title ClaimRegistry
/// @notice Append-only claims whose publication and outcomes are bound to economic and evidence records.
contract ClaimRegistry is AccessManaged, IClaimRegistry {
    error ClaimRegistryInvalidAuthor(address expected, address received);
    error ClaimRegistryZeroAuthor();
    error ClaimRegistryAuthorBondBelowMinimum(uint256 authorBondAmount, uint256 minimumBond);
    error ClaimRegistryUnknownClaim(uint256 claimId);
    error ClaimRegistryUnauthorizedRevision(uint256 claimId, address actor);
    error ClaimRegistryInvalidStatusTransition(
        ProtocolTypes.ClaimStatus from,
        ProtocolTypes.ClaimStatus to
    );
    error ClaimRegistryTerminalClaim(uint256 claimId);
    error ClaimRegistryMissingResolutionModule(uint64 domainId);
    error ClaimRegistryUnregisteredResolutionModule(address module);
    error ClaimRegistryProtocolDependenciesAlreadyConfigured();
    error ClaimRegistryProtocolDependenciesNotConfigured();
    error ClaimRegistryInvalidProtocolDependency(address dependency);
    error ClaimRegistryAuthorBondUnsatisfied(uint256 claimId, uint256 requiredAuthorBond);
    error ClaimRegistryResolutionDecisionRequired(
        uint256 claimId,
        ProtocolTypes.ClaimStatus status
    );
    error ClaimRegistryUnknownReplication(uint256 replicationId);
    error ClaimRegistryReplicationClaimMismatch(
        uint256 claimId,
        uint256 replicationId,
        uint256 actualClaimId
    );
    error ClaimRegistryUnresolvedReplication(uint256 replicationId);
    error ClaimRegistryReplicationDecisionExists(uint256 replicationId, uint256 decisionId);
    error ClaimRegistryUnknownResolutionDecision(uint256 decisionId);
    error ClaimRegistryInvalidResolutionStatus(ProtocolTypes.ResolutionStatus status);

    event ClaimCreated(
        uint256 indexed claimId,
        address indexed author,
        uint64 indexed domainId,
        bytes32 metadataHash,
        address resolutionModule,
        uint256 requiredAuthorBond
    );
    event ClaimRevised(
        uint256 indexed priorClaimId,
        uint256 indexed newClaimId,
        address indexed author
    );
    event ClaimStatusUpdated(
        uint256 indexed claimId,
        ProtocolTypes.ClaimStatus oldStatus,
        ProtocolTypes.ClaimStatus newStatus,
        address indexed actor
    );
    event ClaimProtocolDependenciesConfigured(
        address indexed bondEscrow,
        address indexed replicationRegistry,
        address indexed actor
    );
    event ResolutionDecisionRecorded(
        uint256 indexed decisionId,
        uint256 indexed claimId,
        uint256 indexed replicationId,
        address resolutionModule,
        ProtocolTypes.ResolutionStatus status,
        ProtocolTypes.ClaimStatus claimStatus,
        uint16 confidenceBps,
        bytes32 resolutionHash,
        bytes32 evidenceHash,
        ProtocolTypes.ResolverType resolverType,
        address actor
    );

    /// @notice Governance-set floor for `requiredAuthorBond` on new claims.
    /// @dev Defaults to zero until governance sets it through `ProtocolParameters`. The bond
    /// amount itself stays author-declared above this floor; deposit enforcement happens in
    /// `BondEscrow.isAuthorBondSatisfied`, which downstream policy consults before treating a
    /// claim as economically backed.
    bytes32 public constant MIN_AUTHOR_BOND_PARAMETER_KEY = keccak256("osp.claim.minAuthorBond");

    uint256 public nextClaimId = 1;
    uint256 public nextResolutionDecisionId = 1;

    mapping(uint256 claimId => ProtocolTypes.ClaimRecord claimRecord) private _claims;
    mapping(uint256 decisionId => ProtocolTypes.ResolutionDecision decision) private _decisions;
    mapping(uint256 claimId => uint256[] decisionIds) private _claimDecisionIds;
    mapping(uint256 claimId => uint256 decisionId) private _latestClaimDecisionId;
    mapping(uint256 replicationId => uint256 decisionId) private _replicationDecisionId;

    IResolutionModuleRegistry public immutable resolutionModuleRegistry;
    IProtocolParameters public immutable protocolParameters;
    IBondEscrow public bondEscrow;
    IReplicationRegistry public replicationRegistry;

    constructor(
        address accessController_,
        address resolutionModuleRegistry_,
        address protocolParameters_
    ) AccessManaged(accessController_) {
        resolutionModuleRegistry = IResolutionModuleRegistry(resolutionModuleRegistry_);
        protocolParameters = IProtocolParameters(protocolParameters_);
    }

    /// @notice Binds the circular escrow and replication dependencies once after deployment.
    /// @dev The deployer must call this before renouncing the shared default admin role.
    function configureProtocolDependencies(
        address bondEscrow_,
        address replicationRegistry_
    ) external onlyRole(ProtocolRoles.DEFAULT_ADMIN_ROLE) {
        if (address(bondEscrow) != address(0) || address(replicationRegistry) != address(0)) {
            revert ClaimRegistryProtocolDependenciesAlreadyConfigured();
        }
        if (bondEscrow_ == address(0)) {
            revert ClaimRegistryInvalidProtocolDependency(bondEscrow_);
        }
        if (replicationRegistry_ == address(0)) {
            revert ClaimRegistryInvalidProtocolDependency(replicationRegistry_);
        }
        bondEscrow = IBondEscrow(bondEscrow_);
        replicationRegistry = IReplicationRegistry(replicationRegistry_);
        emit ClaimProtocolDependenciesConfigured(bondEscrow_, replicationRegistry_, msg.sender);
    }

    /// @notice Creates a new scientific claim with append-only metadata commitments.
    function createClaim(
        ProtocolTypes.ClaimSummary calldata summary,
        uint256 authorBondAmount,
        address resolutionModule
    ) external returns (uint256 claimId) {
        _requireClaimAuthor(summary.author);
        claimId = _createClaim(summary, authorBondAmount, 0, resolutionModule);
    }

    /// @notice Creates a new scientific claim on behalf of an author after offchain authentication.
    /// @dev This keeps the public write path service-assisted without letting the submitter rewrite authorship in place.
    function createClaimOnBehalf(
        ProtocolTypes.ClaimSummary calldata summary,
        uint256 authorBondAmount,
        address resolutionModule
    ) external onlyRole(ProtocolRoles.CLAIM_SUBMITTER_ROLE) returns (uint256 claimId) {
        _requireNonzeroClaimAuthor(summary.author);
        claimId = _createClaim(summary, authorBondAmount, 0, resolutionModule);
    }

    /// @notice Revises a claim by creating a new immutable record linked to the prior version.
    function reviseClaim(
        uint256 priorClaimId,
        ProtocolTypes.ClaimSummary calldata summary,
        uint256 authorBondAmount,
        address resolutionModule
    ) external returns (uint256 newClaimId) {
        ProtocolTypes.ClaimRecord memory priorClaim = _requireExistingClaim(priorClaimId);
        _requireClaimAuthor(summary.author);

        if (priorClaim.summary.author != msg.sender) {
            revert ClaimRegistryUnauthorizedRevision(priorClaimId, msg.sender);
        }
        if (_isTerminalStatus(priorClaim.status)) {
            revert ClaimRegistryTerminalClaim(priorClaimId);
        }

        newClaimId = _createClaim(summary, authorBondAmount, priorClaimId, resolutionModule);
        emit ClaimRevised(priorClaimId, newClaimId, msg.sender);
    }

    /// @notice Updates the current claim lifecycle status through the explicit transition graph.
    function setClaimStatus(
        uint256 claimId,
        ProtocolTypes.ClaimStatus newStatus
    ) external onlyRole(ProtocolRoles.RESOLVER_ROLE) {
        ProtocolTypes.ClaimRecord storage claimRecord = _claims[claimId];
        if (claimRecord.claimId == 0) {
            revert ClaimRegistryUnknownClaim(claimId);
        }

        ProtocolTypes.ClaimStatus oldStatus = claimRecord.status;
        if (_isResolutionDerivedStatus(newStatus)) {
            revert ClaimRegistryResolutionDecisionRequired(claimId, newStatus);
        }
        if (!_isAllowedTransition(oldStatus, newStatus)) {
            revert ClaimRegistryInvalidStatusTransition(oldStatus, newStatus);
        }

        if (newStatus == ProtocolTypes.ClaimStatus.Published) {
            _requireProtocolDependencies();
            if (!bondEscrow.isAuthorBondSatisfied(claimId)) {
                revert ClaimRegistryAuthorBondUnsatisfied(claimId, claimRecord.requiredAuthorBond);
            }
        }

        claimRecord.status = newStatus;
        emit ClaimStatusUpdated(claimId, oldStatus, newStatus, msg.sender);
    }

    /// @notice Atomically records the canonical claim decision from a resolved replication and
    /// advances claim state using only the copied resolution result.
    function finalizeClaimResolution(
        uint256 claimId,
        uint256 replicationId
    ) external onlyRole(ProtocolRoles.RESOLVER_ROLE) returns (uint256 decisionId) {
        _requireProtocolDependencies();
        ProtocolTypes.ClaimRecord storage claimRecord = _claims[claimId];
        if (claimRecord.claimId == 0) {
            revert ClaimRegistryUnknownClaim(claimId);
        }
        if (!replicationRegistry.replicationExists(replicationId)) {
            revert ClaimRegistryUnknownReplication(replicationId);
        }
        ProtocolTypes.ReplicationRecord memory replication = replicationRegistry.getReplication(
            replicationId
        );
        if (replication.claimId != claimId) {
            revert ClaimRegistryReplicationClaimMismatch(
                claimId,
                replicationId,
                replication.claimId
            );
        }
        if (replication.resolvedAt == 0) {
            revert ClaimRegistryUnresolvedReplication(replicationId);
        }
        uint256 existingDecisionId = _replicationDecisionId[replicationId];
        if (existingDecisionId != 0) {
            revert ClaimRegistryReplicationDecisionExists(replicationId, existingDecisionId);
        }

        ProtocolTypes.ClaimStatus decisionStatus = getClaimStatusForResolution(
            replication.resolutionStatus
        );
        ProtocolTypes.ClaimStatus oldStatus = claimRecord.status;

        decisionId = nextResolutionDecisionId++;
        _decisions[decisionId] = ProtocolTypes.ResolutionDecision({
            decisionId: decisionId,
            claimId: claimId,
            replicationId: replicationId,
            resolutionModule: claimRecord.resolutionModule,
            status: replication.resolutionStatus,
            claimStatus: decisionStatus,
            confidenceBps: replication.confidenceBps,
            resolutionHash: replication.resolutionHash,
            evidenceHash: replication.resolutionEvidenceHash,
            resolverType: replication.resolverType,
            createdAt: block.timestamp,
            actor: msg.sender
        });
        _claimDecisionIds[claimId].push(decisionId);
        _latestClaimDecisionId[claimId] = decisionId;
        _replicationDecisionId[replicationId] = decisionId;

        // Every resolved replication remains recordable. Claim state advances only when the
        // derived status is a valid forward transition; a later or weaker replication must not
        // erase a stronger/terminal state merely because it was finalized later.
        if (decisionStatus != oldStatus && _isAllowedTransition(oldStatus, decisionStatus)) {
            claimRecord.status = decisionStatus;
            emit ClaimStatusUpdated(claimId, oldStatus, decisionStatus, msg.sender);
        }
        emit ResolutionDecisionRecorded(
            decisionId,
            claimId,
            replicationId,
            claimRecord.resolutionModule,
            replication.resolutionStatus,
            decisionStatus,
            replication.confidenceBps,
            replication.resolutionHash,
            replication.resolutionEvidenceHash,
            replication.resolverType,
            msg.sender
        );
    }

    function claimExists(uint256 claimId) external view override returns (bool) {
        return _claims[claimId].claimId != 0;
    }

    function getClaim(
        uint256 claimId
    ) external view override returns (ProtocolTypes.ClaimRecord memory) {
        return _requireExistingClaim(claimId);
    }

    function getClaimAuthor(uint256 claimId) external view override returns (address) {
        return _requireExistingClaim(claimId).summary.author;
    }

    function getClaimResolutionModule(uint256 claimId) external view override returns (address) {
        return _requireExistingClaim(claimId).resolutionModule;
    }

    function getRequiredAuthorBond(uint256 claimId) external view override returns (uint256) {
        return _requireExistingClaim(claimId).requiredAuthorBond;
    }

    function getResolutionDecision(
        uint256 decisionId
    ) external view override returns (ProtocolTypes.ResolutionDecision memory) {
        ProtocolTypes.ResolutionDecision memory decision = _decisions[decisionId];
        if (decision.decisionId == 0) {
            revert ClaimRegistryUnknownResolutionDecision(decisionId);
        }
        return decision;
    }

    function getLatestResolutionDecisionId(
        uint256 claimId
    ) external view override returns (uint256) {
        return _latestClaimDecisionId[claimId];
    }

    function getClaimResolutionDecisionIds(
        uint256 claimId
    ) external view returns (uint256[] memory) {
        return _claimDecisionIds[claimId];
    }

    function _createClaim(
        ProtocolTypes.ClaimSummary calldata summary,
        uint256 authorBondAmount,
        uint256 revisionOfClaimId,
        address requestedResolutionModule
    ) internal returns (uint256 claimId) {
        uint256 minimumBond = protocolParameters.getUintParameter(MIN_AUTHOR_BOND_PARAMETER_KEY);
        if (authorBondAmount < minimumBond) {
            revert ClaimRegistryAuthorBondBelowMinimum(authorBondAmount, minimumBond);
        }

        claimId = nextClaimId++;

        address resolvedModule = requestedResolutionModule;
        if (resolvedModule == address(0)) {
            resolvedModule = resolutionModuleRegistry.getDomainModule(summary.domainId);
        }
        if (resolvedModule == address(0)) {
            revert ClaimRegistryMissingResolutionModule(summary.domainId);
        }
        if (!resolutionModuleRegistry.isRegisteredModule(resolvedModule)) {
            revert ClaimRegistryUnregisteredResolutionModule(resolvedModule);
        }

        _claims[claimId] = ProtocolTypes.ClaimRecord({
            claimId: claimId,
            summary: summary,
            status: ProtocolTypes.ClaimStatus.Draft,
            revisionOfClaimId: revisionOfClaimId,
            createdAt: block.timestamp,
            requiredAuthorBond: authorBondAmount,
            resolutionModule: resolvedModule
        });

        emit ClaimCreated(
            claimId,
            summary.author,
            summary.domainId,
            summary.metadataHash,
            resolvedModule,
            authorBondAmount
        );
    }

    function _requireClaimAuthor(address author) internal view {
        if (author != msg.sender) {
            revert ClaimRegistryInvalidAuthor(msg.sender, author);
        }
    }

    function _requireNonzeroClaimAuthor(address author) internal pure {
        if (author == address(0)) {
            revert ClaimRegistryZeroAuthor();
        }
    }

    function _requireExistingClaim(
        uint256 claimId
    ) internal view returns (ProtocolTypes.ClaimRecord memory) {
        ProtocolTypes.ClaimRecord memory claimRecord = _claims[claimId];
        if (claimRecord.claimId == 0) {
            revert ClaimRegistryUnknownClaim(claimId);
        }
        return claimRecord;
    }

    function _isTerminalStatus(ProtocolTypes.ClaimStatus status) internal pure returns (bool) {
        return
            status == ProtocolTypes.ClaimStatus.Fraudulent ||
            status == ProtocolTypes.ClaimStatus.Deprecated;
    }

    function _requireProtocolDependencies() internal view {
        if (address(bondEscrow) == address(0) || address(replicationRegistry) == address(0)) {
            revert ClaimRegistryProtocolDependenciesNotConfigured();
        }
    }

    function _isResolutionDerivedStatus(
        ProtocolTypes.ClaimStatus status
    ) internal pure returns (bool) {
        return
            status == ProtocolTypes.ClaimStatus.ProvisionallySupported ||
            status == ProtocolTypes.ClaimStatus.Qualified ||
            status == ProtocolTypes.ClaimStatus.Refuted ||
            status == ProtocolTypes.ClaimStatus.Fraudulent;
    }

    /// @notice Returns the single claim-status recommendation for a resolved replication status.
    /// @dev Pending is not a resolution and therefore reverts.
    function getClaimStatusForResolution(
        ProtocolTypes.ResolutionStatus status
    ) public pure override returns (ProtocolTypes.ClaimStatus) {
        if (status == ProtocolTypes.ResolutionStatus.Supported) {
            return ProtocolTypes.ClaimStatus.ProvisionallySupported;
        }
        if (status == ProtocolTypes.ResolutionStatus.Qualified) {
            return ProtocolTypes.ClaimStatus.Qualified;
        }
        if (status == ProtocolTypes.ResolutionStatus.Refuted) {
            return ProtocolTypes.ClaimStatus.Refuted;
        }
        if (status == ProtocolTypes.ResolutionStatus.FraudSignal) {
            return ProtocolTypes.ClaimStatus.Fraudulent;
        }
        if (
            status == ProtocolTypes.ResolutionStatus.Inconclusive ||
            status == ProtocolTypes.ResolutionStatus.Escalated
        ) {
            return ProtocolTypes.ClaimStatus.UnderReplication;
        }
        revert ClaimRegistryInvalidResolutionStatus(status);
    }

    function _isAllowedTransition(
        ProtocolTypes.ClaimStatus from,
        ProtocolTypes.ClaimStatus to
    ) internal pure returns (bool) {
        if (from == ProtocolTypes.ClaimStatus.Draft) {
            return
                to == ProtocolTypes.ClaimStatus.Published ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }

        if (from == ProtocolTypes.ClaimStatus.Published) {
            return
                to == ProtocolTypes.ClaimStatus.UnderReplication ||
                to == ProtocolTypes.ClaimStatus.Qualified ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }

        if (from == ProtocolTypes.ClaimStatus.UnderReplication) {
            return
                to == ProtocolTypes.ClaimStatus.ProvisionallySupported ||
                to == ProtocolTypes.ClaimStatus.Qualified ||
                to == ProtocolTypes.ClaimStatus.Refuted ||
                to == ProtocolTypes.ClaimStatus.Fraudulent ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }

        if (from == ProtocolTypes.ClaimStatus.ProvisionallySupported) {
            return
                to == ProtocolTypes.ClaimStatus.Qualified ||
                to == ProtocolTypes.ClaimStatus.Refuted ||
                to == ProtocolTypes.ClaimStatus.Fraudulent ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }

        if (from == ProtocolTypes.ClaimStatus.Qualified) {
            return
                to == ProtocolTypes.ClaimStatus.Refuted ||
                to == ProtocolTypes.ClaimStatus.Fraudulent ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }

        if (from == ProtocolTypes.ClaimStatus.Refuted) {
            return to == ProtocolTypes.ClaimStatus.Deprecated;
        }

        if (from == ProtocolTypes.ClaimStatus.Fraudulent) {
            return to == ProtocolTypes.ClaimStatus.Deprecated;
        }

        return false;
    }
}
