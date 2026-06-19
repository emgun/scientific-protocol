// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {AccessManaged} from "./utils/AccessManaged.sol";

contract ProtocolParameters is AccessManaged {
    event UintParameterSet(bytes32 indexed key, uint256 value, address indexed actor);
    event AddressParameterSet(bytes32 indexed key, address value, address indexed actor);

    mapping(bytes32 key => uint256 value) private _uintParameters;
    mapping(bytes32 key => address value) private _addressParameters;

    constructor(address accessController_) AccessManaged(accessController_) {}

    function setUintParameter(
        bytes32 key,
        uint256 value
    ) external onlyRole(ProtocolRoles.PARAMETER_ADMIN_ROLE) {
        _uintParameters[key] = value;
        emit UintParameterSet(key, value, msg.sender);
    }

    function setAddressParameter(
        bytes32 key,
        address value
    ) external onlyRole(ProtocolRoles.PARAMETER_ADMIN_ROLE) {
        _addressParameters[key] = value;
        emit AddressParameterSet(key, value, msg.sender);
    }

    function getUintParameter(bytes32 key) external view returns (uint256) {
        return _uintParameters[key];
    }

    function getAddressParameter(bytes32 key) external view returns (address) {
        return _addressParameters[key];
    }
}
