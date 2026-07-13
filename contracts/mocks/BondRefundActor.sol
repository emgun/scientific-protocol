// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBondRefundEscrow {
    function depositAuthorBond(uint256 claimId) external payable;
    function withdrawAuthorBondRefund(uint256 amount, address payable recipient) external;
}

/// @notice Test helper covering contract authors, rejecting receivers, and withdrawal reentrancy.
contract BondRefundActor {
    IBondRefundEscrow public immutable escrow;
    bool public rejectValue;
    bool public attemptReentry;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address escrow_) {
        escrow = IBondRefundEscrow(escrow_);
    }

    function setReceiveBehavior(bool rejectValue_, bool attemptReentry_) external {
        rejectValue = rejectValue_;
        attemptReentry = attemptReentry_;
    }

    function depositAuthorBond(uint256 claimId) external payable {
        escrow.depositAuthorBond{value: msg.value}(claimId);
    }

    function withdrawAuthorBondRefund(uint256 amount, address payable recipient) external {
        escrow.withdrawAuthorBondRefund(amount, recipient);
    }

    receive() external payable {
        if (rejectValue) revert("reject value");
        if (attemptReentry) {
            reentryAttempted = true;
            try escrow.withdrawAuthorBondRefund(msg.value, payable(address(this))) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}
