// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IResolutionModuleRegistry {
    function isRegisteredModule(address module) external view returns (bool);
    function getDomainModule(uint64 domainId) external view returns (address);
}
