// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";

/// @title ProtocolGovernanceToken
/// @notice Non-transferable voting units used exclusively for protocol governance.
/// @dev The token is soulbound by design so governance power can be distributed without
/// introducing a liquid protocol asset or premature tokenomics into the MVP stack.
contract ProtocolGovernanceToken is ERC20, ERC20Permit, ERC20Votes, Ownable {
    error ProtocolGovernanceTokenTransfersDisabled(address from, address to, uint256 value);
    error ProtocolGovernanceTokenZeroAddress();

    event VotingUnitsMinted(address indexed account, uint256 amount, address indexed actor);
    event VotingUnitsBurned(address indexed account, uint256 amount, address indexed actor);

    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (initialOwner == address(0)) {
            revert ProtocolGovernanceTokenZeroAddress();
        }

        _transferOwnership(initialOwner);
    }

    /// @notice Mints governance voting units to an account.
    /// @dev Newly minted accounts are self-delegated by default on first allocation so they can vote immediately.
    function mint(address account, uint256 amount) external onlyOwner {
        if (account == address(0)) {
            revert ProtocolGovernanceTokenZeroAddress();
        }

        _mint(account, amount);
        if (delegates(account) == address(0)) {
            _delegate(account, account);
        }

        emit VotingUnitsMinted(account, amount, msg.sender);
    }

    /// @notice Burns governance voting units from an account.
    function burn(address account, uint256 amount) external onlyOwner {
        if (account == address(0)) {
            revert ProtocolGovernanceTokenZeroAddress();
        }

        _burn(account, amount);
        emit VotingUnitsBurned(account, amount, msg.sender);
    }

    /// @inheritdoc ERC20
    function _beforeTokenTransfer(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            revert ProtocolGovernanceTokenTransfersDisabled(from, to, value);
        }

        super._beforeTokenTransfer(from, to, value);
    }

    /// @inheritdoc ERC20Votes
    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20, ERC20Votes) {
        super._afterTokenTransfer(from, to, amount);
    }

    /// @inheritdoc ERC20Votes
    function _mint(address account, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._mint(account, amount);
    }

    /// @inheritdoc ERC20Votes
    function _burn(address account, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._burn(account, amount);
    }
}
