// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessManaged} from "./utils/AccessManaged.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IProtocolParameters} from "./interfaces/IProtocolParameters.sol";
import {IResolutionModuleRegistry} from "./interfaces/IResolutionModuleRegistry.sol";

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

    /// @notice Governance-set floor for `requiredAuthorBond` on new claims.
    /// @dev Defaults to zero until governance sets it through `ProtocolParameters`. The bond
    /// amount itself stays author-declared above this floor; deposit enforcement happens in
    /// `BondEscrow.isAuthorBondSatisfied`, which downstream policy consults before treating a
    /// claim as economically backed.
    bytes32 public constant MIN_AUTHOR_BOND_PARAMETER_KEY = keccak256("osp.claim.minAuthorBond");

    uint256 public nextClaimId = 1;

    mapping(uint256 claimId => ProtocolTypes.ClaimRecord claimRecord) private _claims;

    IResolutionModuleRegistry public immutable resolutionModuleRegistry;
    IProtocolParameters public immutable protocolParameters;

    constructor(
        address accessController_,
        address resolutionModuleRegistry_,
        address protocolParameters_
    ) AccessManaged(accessController_) {
        resolutionModuleRegistry = IResolutionModuleRegistry(resolutionModuleRegistry_);
        protocolParameters = IProtocolParameters(protocolParameters_);
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
        if (!_isAllowedTransition(oldStatus, newStatus)) {
            revert ClaimRegistryInvalidStatusTransition(oldStatus, newStatus);
        }

        claimRecord.status = newStatus;
        emit ClaimStatusUpdated(claimId, oldStatus, newStatus, msg.sender);
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
