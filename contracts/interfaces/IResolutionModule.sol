// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

interface IResolutionModule {
    function moduleKind() external view returns (ProtocolTypes.ResolutionModuleKind);
    function moduleName() external view returns (string memory);
    function validateResolution(
        uint256 claimId,
        uint256 replicationId,
        ProtocolTypes.ResolutionResult calldata result
    ) external view returns (bool);
}
