// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IResolutionModule} from "../interfaces/IResolutionModule.sol";
import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

/// @title RejectingResolutionModule
/// @notice Test-only module that exercises the interface's non-reverting rejection path.
contract RejectingResolutionModule is IResolutionModule {
    function moduleKind() external pure returns (ProtocolTypes.ResolutionModuleKind) {
        return ProtocolTypes.ResolutionModuleKind.Computational;
    }

    function moduleName() external pure returns (string memory) {
        return "Rejecting test module";
    }

    function validateResolution(
        uint256,
        uint256,
        ProtocolTypes.ResolutionResult calldata
    ) external pure returns (bool) {
        return false;
    }
}
