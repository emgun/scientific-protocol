// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IResolutionModule} from "../interfaces/IResolutionModule.sol";
import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

abstract contract BaseResolutionModule is IResolutionModule {
    error ResolutionModuleInvalidStatus(ProtocolTypes.ResolutionStatus status);
    error ResolutionModuleInvalidResolverType(ProtocolTypes.ResolverType resolverType);
    error ResolutionModuleInvalidConfidence(uint16 confidenceBps);
    error ResolutionModuleMissingEvidence();

    string private _name;
    ProtocolTypes.ResolutionModuleKind private _kind;

    constructor(string memory name_, ProtocolTypes.ResolutionModuleKind kind_) {
        _name = name_;
        _kind = kind_;
    }

    function moduleKind() external view override returns (ProtocolTypes.ResolutionModuleKind) {
        return _kind;
    }

    function moduleName() external view override returns (string memory) {
        return _name;
    }

    function validateResolution(
        uint256,
        uint256,
        ProtocolTypes.ResolutionResult calldata result
    ) external view override returns (bool) {
        _validateConfidence(result.confidenceBps);
        _validateEvidence(result.evidenceHash, result.evidenceURI);
        _validateStatus(result.status);
        _validateResolverType(result.resolverType);
        return true;
    }

    function _validateConfidence(uint16 confidenceBps) internal pure {
        if (confidenceBps == 0 || confidenceBps > 10_000) {
            revert ResolutionModuleInvalidConfidence(confidenceBps);
        }
    }

    function _validateEvidence(bytes32 evidenceHash, string calldata evidenceURI) internal pure {
        if (evidenceHash == bytes32(0) && bytes(evidenceURI).length == 0) {
            revert ResolutionModuleMissingEvidence();
        }
    }

    function _validateStatus(ProtocolTypes.ResolutionStatus status) internal view virtual;
    function _validateResolverType(ProtocolTypes.ResolverType resolverType) internal view virtual;
}
