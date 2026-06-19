// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseResolutionModule} from "./BaseResolutionModule.sol";
import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

contract WetLabResolutionModule is BaseResolutionModule {
    constructor()
        BaseResolutionModule("Wet Lab And Human Review", ProtocolTypes.ResolutionModuleKind.WetLab)
    {}

    function _validateStatus(ProtocolTypes.ResolutionStatus status) internal pure override {
        if (
            status != ProtocolTypes.ResolutionStatus.Supported &&
            status != ProtocolTypes.ResolutionStatus.Qualified &&
            status != ProtocolTypes.ResolutionStatus.Inconclusive &&
            status != ProtocolTypes.ResolutionStatus.Refuted &&
            status != ProtocolTypes.ResolutionStatus.FraudSignal &&
            status != ProtocolTypes.ResolutionStatus.Escalated
        ) {
            revert ResolutionModuleInvalidStatus(status);
        }
    }

    function _validateResolverType(ProtocolTypes.ResolverType resolverType) internal pure override {
        if (
            resolverType != ProtocolTypes.ResolverType.WetLabCouncil &&
            resolverType != ProtocolTypes.ResolverType.HumanResolver &&
            resolverType != ProtocolTypes.ResolverType.AppealCourt
        ) {
            revert ResolutionModuleInvalidResolverType(resolverType);
        }
    }
}
