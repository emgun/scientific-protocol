// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ProtocolTreasury
/// @notice Governance-owned treasury for protocol budgets, grants, and ecosystem disbursements.
/// @dev Ownership is expected to be transferred to the protocol timelock during deployment bootstrap.
contract ProtocolTreasury is Ownable {
    using SafeERC20 for IERC20;

    error ProtocolTreasuryInvalidAmount(uint256 amount);
    error ProtocolTreasuryInvalidRecipient();
    error ProtocolTreasuryTransferFailed(address recipient, uint256 amount);

    event TreasuryEtherDeposited(address indexed funder, uint256 amount);
    event TreasuryEtherReleased(address indexed recipient, uint256 amount, address indexed actor);
    event TreasuryTokenReleased(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        address actor
    );

    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {
        emit TreasuryEtherDeposited(msg.sender, msg.value);
    }

    /// @notice Releases ETH from the treasury to a recipient.
    function releaseEther(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) {
            revert ProtocolTreasuryInvalidRecipient();
        }
        if (amount == 0) {
            revert ProtocolTreasuryInvalidAmount(amount);
        }

        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert ProtocolTreasuryTransferFailed(recipient, amount);
        }

        emit TreasuryEtherReleased(recipient, amount, msg.sender);
    }

    /// @notice Releases ERC20 assets from the treasury to a recipient.
    function releaseToken(address token, address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0) || token == address(0)) {
            revert ProtocolTreasuryInvalidRecipient();
        }
        if (amount == 0) {
            revert ProtocolTreasuryInvalidAmount(amount);
        }

        IERC20(token).safeTransfer(recipient, amount);
        emit TreasuryTokenReleased(token, recipient, amount, msg.sender);
    }
}
