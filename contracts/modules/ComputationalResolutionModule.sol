// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseResolutionModule} from "./BaseResolutionModule.sol";
import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

contract ComputationalResolutionModule is BaseResolutionModule {
    constructor()
        BaseResolutionModule(
            "Computational Reproducibility",
            ProtocolTypes.ResolutionModuleKind.Computational
        )
    {}

    function _validateStatus(ProtocolTypes.ResolutionStatus status) internal pure override {
        if (
            status != ProtocolTypes.ResolutionStatus.Supported &&
            status != ProtocolTypes.ResolutionStatus.Qualified &&
            status != ProtocolTypes.ResolutionStatus.Inconclusive &&
            status != ProtocolTypes.ResolutionStatus.Refuted &&
            status != ProtocolTypes.ResolutionStatus.FraudSignal
        ) {
            revert ResolutionModuleInvalidStatus(status);
        }
    }

    function _validateResolverType(ProtocolTypes.ResolverType resolverType) internal pure override {
        if (
            resolverType != ProtocolTypes.ResolverType.ComputationOracle &&
            resolverType != ProtocolTypes.ResolverType.AgentWorker &&
            resolverType != ProtocolTypes.ResolverType.HumanResolver
        ) {
            revert ResolutionModuleInvalidResolverType(resolverType);
        }
    }
}
