// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEpistemicMarket {
    function challengeExists(uint256 challengeId) external view returns (bool);

    function getChallengeClaimId(uint256 challengeId) external view returns (uint256);
}
