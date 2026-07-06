// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolRoles} from "../libraries/ProtocolRoles.sol";
import {AccessManaged} from "./AccessManaged.sol";

/// @title DepositPausable
/// @notice Guardian circuit breaker limited to value inflows.
/// @dev Only deposit-style entry points are pausable. Withdrawals, refunds, settlements, and
/// resolutions must never sit behind this switch so participants can always exit with their
/// funds even while the guardian halts new value from entering a contract under incident review.
abstract contract DepositPausable is AccessManaged {
    error DepositsPausedError();

    event DepositsPauseSet(bool paused, address indexed actor);

    bool public depositsPaused;

    modifier whenDepositsNotPaused() {
        if (depositsPaused) {
            revert DepositsPausedError();
        }
        _;
    }

    /// @notice Pauses or resumes deposit-style entry points.
    function setDepositsPaused(bool paused) external onlyRole(ProtocolRoles.PAUSER_ROLE) {
        depositsPaused = paused;
        emit DepositsPauseSet(paused, msg.sender);
    }
}
