// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessController} from "./interfaces/IAccessController.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";

contract AccessController is IAccessController {
    error AccessControllerUnauthorized(bytes32 role, address account);
    error AccessControllerZeroAddress();

    event RoleAdminChanged(
        bytes32 indexed role,
        bytes32 indexed previousAdminRole,
        bytes32 indexed newAdminRole
    );
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    mapping(bytes32 role => mapping(address account => bool granted)) private _roles;
    mapping(bytes32 role => bytes32 adminRole) private _roleAdmins;

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) {
            revert AccessControllerZeroAddress();
        }

        _roles[ProtocolRoles.DEFAULT_ADMIN_ROLE][initialAdmin] = true;
        emit RoleGranted(ProtocolRoles.DEFAULT_ADMIN_ROLE, initialAdmin, initialAdmin);
    }

    function hasRole(bytes32 role, address account) external view override returns (bool) {
        return _roles[role][account];
    }

    function getRoleAdmin(bytes32 role) public view returns (bytes32) {
        bytes32 adminRole = _roleAdmins[role];
        return adminRole == bytes32(0) ? ProtocolRoles.DEFAULT_ADMIN_ROLE : adminRole;
    }

    function setRoleAdmin(
        bytes32 role,
        bytes32 adminRole
    ) external onlyRole(ProtocolRoles.DEFAULT_ADMIN_ROLE) {
        bytes32 previousAdminRole = getRoleAdmin(role);
        _roleAdmins[role] = adminRole;
        emit RoleAdminChanged(role, previousAdminRole, adminRole);
    }

    function grantRole(bytes32 role, address account) external onlyRole(getRoleAdmin(role)) {
        if (account == address(0)) {
            revert AccessControllerZeroAddress();
        }
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) external onlyRole(getRoleAdmin(role)) {
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    /// @notice Renounces a role held by the caller without requiring the role admin.
    function renounceRole(bytes32 role) external {
        if (_roles[role][msg.sender]) {
            _roles[role][msg.sender] = false;
            emit RoleRevoked(role, msg.sender, msg.sender);
        }
    }

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) {
            revert AccessControllerUnauthorized(role, msg.sender);
        }
        _;
    }
}
