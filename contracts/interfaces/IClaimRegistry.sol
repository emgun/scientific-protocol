// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

interface IClaimRegistry {
    function claimExists(uint256 claimId) external view returns (bool);
    function getClaim(uint256 claimId) external view returns (ProtocolTypes.ClaimRecord memory);
    function getClaimAuthor(uint256 claimId) external view returns (address);
    function getClaimResolutionModule(uint256 claimId) external view returns (address);
    function getRequiredAuthorBond(uint256 claimId) external view returns (uint256);
    function getResolutionDecision(
        uint256 decisionId
    ) external view returns (ProtocolTypes.ResolutionDecision memory);
    function getLatestResolutionDecisionId(uint256 claimId) external view returns (uint256);
    function getClaimStatusForResolution(
        ProtocolTypes.ResolutionStatus status
    ) external pure returns (ProtocolTypes.ClaimStatus);
}
