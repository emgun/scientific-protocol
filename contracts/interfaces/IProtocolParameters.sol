// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProtocolParameters {
    function getUintParameter(bytes32 key) external view returns (uint256);

    function getAddressParameter(bytes32 key) external view returns (address);
}
