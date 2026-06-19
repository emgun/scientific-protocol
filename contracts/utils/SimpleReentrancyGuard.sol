// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract SimpleReentrancyGuard {
    error ReentrancyGuardReentrantCall();

    uint256 private _entered;

    modifier nonReentrant() {
        if (_entered == 1) {
            revert ReentrancyGuardReentrantCall();
        }

        _entered = 1;
        _;
        _entered = 0;
    }
}
