// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

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
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(initialOwner) {}

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

    /// @dev Rejects transfers between non-zero accounts to keep voting units soulbound; mints
    /// (from == 0) and burns (to == 0) remain the only supply movements.
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from != address(0) && to != address(0)) {
            revert ProtocolGovernanceTokenTransfersDisabled(from, to, value);
        }

        super._update(from, to, value);
    }

    /// @inheritdoc ERC20Permit
    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
