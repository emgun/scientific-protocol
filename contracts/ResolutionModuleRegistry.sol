// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessManaged} from "./utils/AccessManaged.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IResolutionModule} from "./interfaces/IResolutionModule.sol";
import {IResolutionModuleRegistry} from "./interfaces/IResolutionModuleRegistry.sol";

contract ResolutionModuleRegistry is AccessManaged, IResolutionModuleRegistry {
    error ResolutionModuleRegistryUnregisteredModule(address module);
    error ResolutionModuleRegistryZeroAddress();

    struct ModuleRegistration {
        bool exists;
        bool enabled;
        ProtocolTypes.ResolutionModuleKind kind;
        string name;
        string metadataURI;
    }

    event ResolutionModuleRegistered(
        address indexed module,
        ProtocolTypes.ResolutionModuleKind indexed kind,
        string name,
        string metadataURI,
        address indexed actor
    );
    event DomainResolutionModuleSet(
        uint64 indexed domainId,
        address indexed module,
        address indexed actor
    );
    event ResolutionModuleStatusUpdated(
        address indexed module,
        bool enabled,
        address indexed actor
    );

    mapping(address module => ModuleRegistration registration) private _modules;
    mapping(uint64 domainId => address module) private _domainModules;

    constructor(address accessController_) AccessManaged(accessController_) {}

    function registerModule(
        address module,
        string calldata metadataURI
    ) external onlyRole(ProtocolRoles.MODULE_ADMIN_ROLE) {
        if (module == address(0)) {
            revert ResolutionModuleRegistryZeroAddress();
        }

        ProtocolTypes.ResolutionModuleKind kind = IResolutionModule(module).moduleKind();
        string memory name = IResolutionModule(module).moduleName();

        _modules[module] = ModuleRegistration({
            exists: true,
            enabled: true,
            kind: kind,
            name: name,
            metadataURI: metadataURI
        });

        emit ResolutionModuleRegistered(module, kind, name, metadataURI, msg.sender);
    }

    /// @notice Enables or disables a previously registered module.
    /// @dev Disabled modules stop accepting new claims (both via domain defaults and explicit
    /// module addresses) without rewriting the history of claims already bound to them.
    function setModuleEnabled(
        address module,
        bool enabled
    ) external onlyRole(ProtocolRoles.MODULE_ADMIN_ROLE) {
        ModuleRegistration storage registration = _modules[module];
        if (!registration.exists) {
            revert ResolutionModuleRegistryUnregisteredModule(module);
        }

        registration.enabled = enabled;
        emit ResolutionModuleStatusUpdated(module, enabled, msg.sender);
    }

    function setDomainModule(
        uint64 domainId,
        address module
    ) external onlyRole(ProtocolRoles.MODULE_ADMIN_ROLE) {
        if (!isRegisteredModule(module)) {
            revert ResolutionModuleRegistryUnregisteredModule(module);
        }

        _domainModules[domainId] = module;
        emit DomainResolutionModuleSet(domainId, module, msg.sender);
    }

    function isRegisteredModule(address module) public view override returns (bool) {
        return _modules[module].enabled;
    }

    function getDomainModule(uint64 domainId) external view override returns (address) {
        return _domainModules[domainId];
    }
}
