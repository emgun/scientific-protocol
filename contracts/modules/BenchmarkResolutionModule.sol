// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseResolutionModule} from "./BaseResolutionModule.sol";
import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

contract BenchmarkResolutionModule is BaseResolutionModule {
    constructor()
        BaseResolutionModule(
            "Benchmark And Performance",
            ProtocolTypes.ResolutionModuleKind.Benchmark
        )
    {}

    function _validateStatus(ProtocolTypes.ResolutionStatus status) internal pure override {
        if (
            status != ProtocolTypes.ResolutionStatus.Supported &&
            status != ProtocolTypes.ResolutionStatus.Qualified &&
            status != ProtocolTypes.ResolutionStatus.Inconclusive &&
            status != ProtocolTypes.ResolutionStatus.Refuted
        ) {
            revert ResolutionModuleInvalidStatus(status);
        }
    }

    function _validateResolverType(ProtocolTypes.ResolverType resolverType) internal pure override {
        if (
            resolverType != ProtocolTypes.ResolverType.BenchmarkOracle &&
            resolverType != ProtocolTypes.ResolverType.HumanResolver
        ) {
            revert ResolutionModuleInvalidResolverType(resolverType);
        }
    }
}
