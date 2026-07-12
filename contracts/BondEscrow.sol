// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessManaged} from "./utils/AccessManaged.sol";
import {DepositPausable} from "./utils/DepositPausable.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IReplicationRegistry} from "./interfaces/IReplicationRegistry.sol";

/// @title BondEscrow
/// @notice Claim author bonds and claim-local replication bounties with bound recipients.
contract BondEscrow is DepositPausable, ReentrancyGuard {
    error BondEscrowUnknownClaim(uint256 claimId);
    error BondEscrowUnauthorizedAuthor(uint256 claimId, address actor);
    error BondEscrowInvalidAmount(uint256 amount);
    error BondEscrowInsufficientBountyBalance(
        uint256 claimId,
        uint256 requested,
        uint256 available
    );
    error BondEscrowReservationExists(uint256 claimId, uint256 replicationId);
    error BondEscrowReservationMissing(uint256 claimId, uint256 replicationId);
    error BondEscrowAlreadyReleased(uint256 claimId, uint256 replicationId);
    error BondEscrowAlreadyCancelled(uint256 claimId, uint256 replicationId);
    error BondEscrowUnknownReplication(uint256 replicationId);
    error BondEscrowReplicationClaimMismatch(
        uint256 claimId,
        uint256 replicationId,
        uint256 actualClaimId
    );
    error BondEscrowUnresolvedReplication(uint256 replicationId);
    error BondEscrowTransferFailed(address recipient, uint256 amount);
    error BondEscrowInvalidRecipient(address recipient);
    error BondEscrowInsufficientAuthorBond(uint256 claimId, uint256 requested, uint256 available);

    struct BountyReservation {
        address recipient;
        uint256 amount;
        bool released;
        bool cancelled;
    }

    event AuthorBondDeposited(uint256 indexed claimId, address indexed funder, uint256 amount);
    event ReplicationBountyFunded(uint256 indexed claimId, address indexed funder, uint256 amount);
    event BountyPayoutReserved(
        uint256 indexed claimId,
        uint256 indexed replicationId,
        address indexed recipient,
        uint256 amount
    );
    event BountyPayoutReleased(
        uint256 indexed claimId,
        uint256 indexed replicationId,
        address indexed recipient,
        uint256 amount
    );
    event BountyPayoutCancelled(
        uint256 indexed claimId,
        uint256 indexed replicationId,
        address indexed recipient,
        uint256 amount,
        address actor
    );
    event AuthorBondSlashed(uint256 indexed claimId, address indexed recipient, uint256 amount);
    event AuthorBondRefunded(uint256 indexed claimId, address indexed recipient, uint256 amount);

    IClaimRegistry public immutable claimRegistry;
    IReplicationRegistry public immutable replicationRegistry;

    mapping(uint256 claimId => uint256 amount) public authorBondBalances;
    mapping(uint256 claimId => uint256 amount) public bountyBalances;
    mapping(uint256 claimId => uint256 amount) public reservedBountyBalances;
    mapping(uint256 claimId => mapping(uint256 replicationId => BountyReservation reservation))
        private _reservations;

    constructor(
        address accessController_,
        address claimRegistry_,
        address replicationRegistry_
    ) AccessManaged(accessController_) {
        claimRegistry = IClaimRegistry(claimRegistry_);
        replicationRegistry = IReplicationRegistry(replicationRegistry_);
    }

    /// @notice Deposits the author bond for an existing claim.
    function depositAuthorBond(
        uint256 claimId
    ) external payable nonReentrant whenDepositsNotPaused {
        if (!claimRegistry.claimExists(claimId)) {
            revert BondEscrowUnknownClaim(claimId);
        }
        if (msg.sender != claimRegistry.getClaimAuthor(claimId)) {
            revert BondEscrowUnauthorizedAuthor(claimId, msg.sender);
        }
        if (msg.value == 0) {
            revert BondEscrowInvalidAmount(msg.value);
        }

        authorBondBalances[claimId] += msg.value;
        emit AuthorBondDeposited(claimId, msg.sender, msg.value);
    }

    /// @notice Funds an open replication bounty for an existing claim.
    function fundReplicationBounty(
        uint256 claimId
    ) external payable nonReentrant whenDepositsNotPaused {
        if (!claimRegistry.claimExists(claimId)) {
            revert BondEscrowUnknownClaim(claimId);
        }
        if (msg.value == 0) {
            revert BondEscrowInvalidAmount(msg.value);
        }

        bountyBalances[claimId] += msg.value;
        emit ReplicationBountyFunded(claimId, msg.sender, msg.value);
    }

    /// @notice Reserves bounty funds for a specific replication payout.
    function reserveBountyPayout(
        uint256 claimId,
        uint256 replicationId,
        uint256 amount
    ) external onlyRole(ProtocolRoles.ESCROW_ADMIN_ROLE) {
        if (amount == 0) {
            revert BondEscrowInvalidAmount(amount);
        }
        if (!claimRegistry.claimExists(claimId)) {
            revert BondEscrowUnknownClaim(claimId);
        }
        if (!replicationRegistry.replicationExists(replicationId)) {
            revert BondEscrowUnknownReplication(replicationId);
        }
        uint256 replicationClaimId = replicationRegistry.getReplicationClaimId(replicationId);
        if (replicationClaimId != claimId) {
            revert BondEscrowReplicationClaimMismatch(claimId, replicationId, replicationClaimId);
        }
        address recipient = replicationRegistry.getReplicationReplicator(replicationId);
        _requireValidRecipient(recipient);

        BountyReservation storage reservation = _reservations[claimId][replicationId];
        if (reservation.amount != 0) {
            revert BondEscrowReservationExists(claimId, replicationId);
        }

        uint256 availableBounty = bountyBalances[claimId] - reservedBountyBalances[claimId];
        if (availableBounty < amount) {
            revert BondEscrowInsufficientBountyBalance(claimId, amount, availableBounty);
        }

        reservation.recipient = recipient;
        reservation.amount = amount;
        reservedBountyBalances[claimId] += amount;
        emit BountyPayoutReserved(claimId, replicationId, recipient, amount);
    }

    /// @notice Releases a previously reserved payout to the reserved recipient.
    function releaseReservedPayout(
        uint256 claimId,
        uint256 replicationId
    ) external onlyRole(ProtocolRoles.ESCROW_ADMIN_ROLE) nonReentrant {
        BountyReservation storage reservation = _reservations[claimId][replicationId];
        if (reservation.amount == 0) {
            revert BondEscrowReservationMissing(claimId, replicationId);
        }
        if (reservation.released) {
            revert BondEscrowAlreadyReleased(claimId, replicationId);
        }
        if (reservation.cancelled) {
            revert BondEscrowAlreadyCancelled(claimId, replicationId);
        }
        if (!replicationRegistry.isReplicationResolved(replicationId)) {
            revert BondEscrowUnresolvedReplication(replicationId);
        }

        reservation.released = true;
        reservedBountyBalances[claimId] -= reservation.amount;
        bountyBalances[claimId] -= reservation.amount;
        _safeTransferValue(reservation.recipient, reservation.amount);
        emit BountyPayoutReleased(
            claimId,
            replicationId,
            reservation.recipient,
            reservation.amount
        );
    }

    /// @notice Cancels an unreleased reservation and returns the amount to the claim bounty pool.
    /// @dev Cancellation is terminal for the claim/replication pair and does not transfer value.
    function cancelReservedPayout(
        uint256 claimId,
        uint256 replicationId
    ) external onlyRole(ProtocolRoles.ESCROW_ADMIN_ROLE) {
        BountyReservation storage reservation = _reservations[claimId][replicationId];
        if (reservation.amount == 0) {
            revert BondEscrowReservationMissing(claimId, replicationId);
        }
        if (reservation.released) {
            revert BondEscrowAlreadyReleased(claimId, replicationId);
        }
        if (reservation.cancelled) {
            revert BondEscrowAlreadyCancelled(claimId, replicationId);
        }

        reservation.cancelled = true;
        reservedBountyBalances[claimId] -= reservation.amount;
        emit BountyPayoutCancelled(
            claimId,
            replicationId,
            reservation.recipient,
            reservation.amount,
            msg.sender
        );
    }

    /// @notice Slashes author bond value to a protocol-designated recipient.
    /// @dev Trust assumption: `ESCROW_ADMIN_ROLE` can move any tracked bond balance to any
    /// recipient. This role must be held by the protocol timelock (or an equivalently
    /// constrained executor), never by a discretionary EOA.
    function slashAuthorBond(
        uint256 claimId,
        uint256 amount,
        address recipient
    ) external onlyRole(ProtocolRoles.ESCROW_ADMIN_ROLE) nonReentrant {
        uint256 availableBond = authorBondBalances[claimId];
        if (amount == 0) {
            revert BondEscrowInvalidAmount(amount);
        }
        _requireValidRecipient(recipient);
        if (availableBond < amount) {
            revert BondEscrowInsufficientAuthorBond(claimId, amount, availableBond);
        }

        authorBondBalances[claimId] = availableBond - amount;
        _safeTransferValue(recipient, amount);
        emit AuthorBondSlashed(claimId, recipient, amount);
    }

    /// @notice Refunds author bond value to an approved recipient.
    function refundAuthorBond(
        uint256 claimId,
        uint256 amount,
        address recipient
    ) external onlyRole(ProtocolRoles.ESCROW_ADMIN_ROLE) nonReentrant {
        uint256 availableBond = authorBondBalances[claimId];
        if (amount == 0) {
            revert BondEscrowInvalidAmount(amount);
        }
        _requireValidRecipient(recipient);
        if (availableBond < amount) {
            revert BondEscrowInsufficientAuthorBond(claimId, amount, availableBond);
        }

        authorBondBalances[claimId] = availableBond - amount;
        _safeTransferValue(recipient, amount);
        emit AuthorBondRefunded(claimId, recipient, amount);
    }

    function getReservation(
        uint256 claimId,
        uint256 replicationId
    ) external view returns (BountyReservation memory) {
        return _reservations[claimId][replicationId];
    }

    function isAuthorBondSatisfied(uint256 claimId) external view returns (bool) {
        return authorBondBalances[claimId] >= claimRegistry.getRequiredAuthorBond(claimId);
    }

    function _safeTransferValue(address recipient, uint256 amount) internal {
        // Recipients are never arbitrary: every payout path is either a refund to the
        // original depositor or a transfer to a recipient fixed by a role-gated flow.
        // slither-disable-next-line arbitrary-send-eth
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert BondEscrowTransferFailed(recipient, amount);
        }
    }

    function _requireValidRecipient(address recipient) internal pure {
        if (recipient == address(0)) {
            revert BondEscrowInvalidRecipient(recipient);
        }
    }
}
