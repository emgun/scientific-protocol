// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";

/// @notice Append-only artifact commitments bound to existing claims.
/// @dev Intentionally permissionless: anyone may attach an artifact commitment to any claim,
/// and the submitter is recorded onchain. Read models and downstream policy are responsible
/// for filtering by submitter; the registry itself does not arbitrate relevance or spam.
contract ArtifactRegistry {
    error ArtifactRegistryUnknownClaim(uint256 claimId);
    error ArtifactRegistryUnknownArtifact(uint256 artifactId);

    event ArtifactAdded(
        uint256 indexed artifactId,
        uint256 indexed claimId,
        ProtocolTypes.ArtifactType artifactType,
        bytes32 contentDigest,
        string uri,
        address indexed submitter
    );

    uint256 public nextArtifactId = 1;

    IClaimRegistry public immutable claimRegistry;

    mapping(uint256 artifactId => ProtocolTypes.ArtifactCommitment artifact) private _artifacts;
    mapping(uint256 claimId => uint256[] artifactIds) private _claimArtifacts;

    constructor(address claimRegistry_) {
        claimRegistry = IClaimRegistry(claimRegistry_);
    }

    /// @notice Adds an append-only artifact commitment under an existing claim.
    function addArtifact(
        uint256 claimId,
        ProtocolTypes.ArtifactType artifactType,
        bytes32 contentDigest,
        string calldata uri,
        bytes32 metadataHash
    ) external returns (uint256 artifactId) {
        if (!claimRegistry.claimExists(claimId)) {
            revert ArtifactRegistryUnknownClaim(claimId);
        }

        artifactId = nextArtifactId++;
        _artifacts[artifactId] = ProtocolTypes.ArtifactCommitment({
            artifactId: artifactId,
            claimId: claimId,
            artifactType: artifactType,
            contentDigest: contentDigest,
            uri: uri,
            metadataHash: metadataHash,
            submitter: msg.sender,
            createdAt: block.timestamp
        });

        _claimArtifacts[claimId].push(artifactId);
        emit ArtifactAdded(artifactId, claimId, artifactType, contentDigest, uri, msg.sender);
    }

    function getArtifact(
        uint256 artifactId
    ) external view returns (ProtocolTypes.ArtifactCommitment memory) {
        ProtocolTypes.ArtifactCommitment memory artifact = _artifacts[artifactId];
        if (artifact.artifactId == 0) {
            revert ArtifactRegistryUnknownArtifact(artifactId);
        }
        return artifact;
    }

    function getClaimArtifactIds(uint256 claimId) external view returns (uint256[] memory) {
        return _claimArtifacts[claimId];
    }
}
