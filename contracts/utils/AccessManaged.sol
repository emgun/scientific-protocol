// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessController} from "../interfaces/IAccessController.sol";

abstract contract AccessManaged {
    error AccessManagedMissingRole(bytes32 role, address account);
    error AccessManagedZeroAddress();

    IAccessController public immutable accessController;

    constructor(address accessController_) {
        if (accessController_ == address(0)) {
            revert AccessManagedZeroAddress();
        }

        accessController = IAccessController(accessController_);
    }

    modifier onlyRole(bytes32 role) {
        if (!accessController.hasRole(role, msg.sender)) {
            revert AccessManagedMissingRole(role, msg.sender);
        }
        _;
    }
}
