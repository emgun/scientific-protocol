// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAccessController} from "./interfaces/IAccessController.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";

/// @title AccessController
/// @notice Shared role registry for the protocol contract suite.
/// @dev Role bookkeeping is delegated to OpenZeppelin AccessControl so the protocol carries no
/// hand-rolled authorization logic. Protocol contracts stay attached to this single controller
/// through the thin `AccessManaged` connector rather than each contract owning its own role state.
contract AccessController is AccessControl, IAccessController {
    error AccessControllerZeroAddress();

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) {
            revert AccessControllerZeroAddress();
        }

        _grantRole(ProtocolRoles.DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    /// @notice Reassigns which role administers `role`.
    /// @dev Kept as an explicit admin-gated surface; OpenZeppelin only exposes `_setRoleAdmin`
    /// internally.
    function setRoleAdmin(
        bytes32 role,
        bytes32 adminRole
    ) external onlyRole(ProtocolRoles.DEFAULT_ADMIN_ROLE) {
        _setRoleAdmin(role, adminRole);
    }

    /// @inheritdoc IAccessController
    function hasRole(
        bytes32 role,
        address account
    ) public view override(AccessControl, IAccessController) returns (bool) {
        return super.hasRole(role, account);
    }
}
