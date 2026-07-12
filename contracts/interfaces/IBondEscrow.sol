// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBondEscrow {
    function isAuthorBondSatisfied(uint256 claimId) external view returns (bool);
}
