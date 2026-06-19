// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {ProtocolDeployer} from "./utils/ProtocolDeployer.sol";
import {ProtocolTypes} from "../contracts/libraries/ProtocolTypes.sol";

contract EscrowHandler is Test {
    uint256 internal constant STEP = 0.25 ether;

    address internal immutable admin;
    address internal immutable author;
    address internal immutable replicator;
    BondEscrowLike internal immutable bondEscrow;
    ClaimRegistryLike internal immutable claimRegistry;
    ReplicationRegistryLike internal immutable replicationRegistry;
    uint256 internal immutable claimId;
    uint256 internal immutable initialAuthorBond;
    uint256 internal immutable initialBounty;

    mapping(uint256 => bool) internal hasReservation;
    mapping(uint256 => bool) internal releasedReservation;
    uint256 internal releasedTotal;

    constructor(
        address admin_,
        address author_,
        address replicator_,
        address bondEscrow_,
        address claimRegistry_,
        address replicationRegistry_,
        uint256 claimId_,
        uint256 initialAuthorBond_,
        uint256 initialBounty_
    ) {
        admin = admin_;
        author = author_;
        replicator = replicator_;
        bondEscrow = BondEscrowLike(bondEscrow_);
        claimRegistry = ClaimRegistryLike(claimRegistry_);
        replicationRegistry = ReplicationRegistryLike(replicationRegistry_);
        claimId = claimId_;
        initialAuthorBond = initialAuthorBond_;
        initialBounty = initialBounty_;
    }

    function submitReplication(uint256 seed) external {
        vm.prank(replicator);
        replicationRegistry.submitReplication(
            claimId,
            keccak256(abi.encodePacked("env", seed)),
            keccak256(abi.encodePacked("result", seed)),
            keccak256(abi.encodePacked("evidence", seed)),
            0
        );
    }

    function reservePayout(uint256 replicationSeed, uint256 amountSeed) external {
        uint256 nextReplicationId = replicationRegistry.nextReplicationId();
        if (nextReplicationId <= 1) {
            return;
        }
        uint256 replicationId = bound(replicationSeed, 1, nextReplicationId - 1);
        if (hasReservation[replicationId]) {
            return;
        }

        uint256 bountyBalance = bondEscrow.bountyBalances(claimId);
        uint256 reserved = bondEscrow.reservedBountyBalances(claimId);
        if (bountyBalance <= reserved) {
            return;
        }

        uint256 available = bountyBalance - reserved;
        uint256 maxUnits = available / STEP;
        if (maxUnits == 0) {
            return;
        }
        uint256 amount = STEP * bound(amountSeed, 1, maxUnits);

        vm.prank(admin);
        bondEscrow.reserveBountyPayout(claimId, replicationId, replicator, amount);
        hasReservation[replicationId] = true;
    }

    function releasePayout(uint256 replicationSeed) external {
        uint256 nextReplicationId = replicationRegistry.nextReplicationId();
        if (nextReplicationId <= 1) {
            return;
        }
        uint256 replicationId = bound(replicationSeed, 1, nextReplicationId - 1);
        if (!hasReservation[replicationId] || releasedReservation[replicationId]) {
            return;
        }

        BondEscrowLike.BountyReservation memory reservation = bondEscrow.getReservation(
            claimId,
            replicationId
        );
        vm.prank(admin);
        bondEscrow.releaseReservedPayout(claimId, replicationId);
        releasedReservation[replicationId] = true;
        releasedTotal += reservation.amount;
    }

    function slashAuthorBond(uint256 amountSeed) external {
        uint256 available = bondEscrow.authorBondBalances(claimId);
        if (available < STEP) {
            return;
        }
        uint256 amount = STEP * bound(amountSeed, 1, available / STEP);
        vm.prank(admin);
        bondEscrow.slashAuthorBond(claimId, amount, address(0xBEEF));
    }

    function refundAuthorBond(uint256 amountSeed) external {
        uint256 available = bondEscrow.authorBondBalances(claimId);
        if (available < STEP) {
            return;
        }
        uint256 amount = STEP * bound(amountSeed, 1, available / STEP);
        vm.prank(admin);
        bondEscrow.refundAuthorBond(claimId, amount, author);
    }

    function progressClaimStatus(uint8 choice) external {
        ProtocolTypes.ClaimStatus currentStatus = claimRegistry.getClaim(claimId).status;
        if (currentStatus == ProtocolTypes.ClaimStatus.Published) {
            ProtocolTypes.ClaimStatus[3] memory options = [
                ProtocolTypes.ClaimStatus.UnderReplication,
                ProtocolTypes.ClaimStatus.Qualified,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            vm.prank(admin);
            claimRegistry.setClaimStatus(claimId, options[choice % options.length]);
            return;
        }
        if (currentStatus == ProtocolTypes.ClaimStatus.UnderReplication) {
            ProtocolTypes.ClaimStatus[5] memory options = [
                ProtocolTypes.ClaimStatus.ProvisionallySupported,
                ProtocolTypes.ClaimStatus.Qualified,
                ProtocolTypes.ClaimStatus.Refuted,
                ProtocolTypes.ClaimStatus.Fraudulent,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            vm.prank(admin);
            claimRegistry.setClaimStatus(claimId, options[choice % options.length]);
            return;
        }
        if (currentStatus == ProtocolTypes.ClaimStatus.ProvisionallySupported) {
            ProtocolTypes.ClaimStatus[4] memory options = [
                ProtocolTypes.ClaimStatus.Qualified,
                ProtocolTypes.ClaimStatus.Refuted,
                ProtocolTypes.ClaimStatus.Fraudulent,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            vm.prank(admin);
            claimRegistry.setClaimStatus(claimId, options[choice % options.length]);
        }
    }

    function invariantReleasedTotal() external view returns (uint256) {
        return releasedTotal;
    }
}

interface BondEscrowLike {
    struct BountyReservation {
        address recipient;
        uint256 amount;
        bool released;
    }

    function bountyBalances(uint256 claimId) external view returns (uint256);
    function reservedBountyBalances(uint256 claimId) external view returns (uint256);
    function authorBondBalances(uint256 claimId) external view returns (uint256);
    function reserveBountyPayout(
        uint256 claimId,
        uint256 replicationId,
        address recipient,
        uint256 amount
    ) external;
    function releaseReservedPayout(uint256 claimId, uint256 replicationId) external;
    function slashAuthorBond(uint256 claimId, uint256 amount, address recipient) external;
    function refundAuthorBond(uint256 claimId, uint256 amount, address recipient) external;
    function getReservation(
        uint256 claimId,
        uint256 replicationId
    ) external view returns (BountyReservation memory);
}

interface ClaimRegistryLike {
    function getClaim(uint256 claimId) external view returns (ProtocolTypes.ClaimRecord memory);
    function setClaimStatus(uint256 claimId, ProtocolTypes.ClaimStatus newStatus) external;
}

interface ReplicationRegistryLike {
    function nextReplicationId() external view returns (uint256);
    function submitReplication(
        uint256 claimId,
        bytes32 environmentHash,
        bytes32 resultHash,
        bytes32 evidenceHash,
        uint256 agentId
    ) external returns (uint256 replicationId);
}

contract ProtocolInvariantTest is StdInvariant, ProtocolDeployer {
    EscrowHandler internal handler;
    uint256 internal claimId;
    uint256 internal initialAuthorBond = 5 ether;
    uint256 internal initialBounty = 10 ether;

    function setUp() public {
        deployProtocol();
        claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), initialAuthorBond);

        vm.prank(author);
        bondEscrow.depositAuthorBond{value: initialAuthorBond}(claimId);
        vm.prank(admin);
        bondEscrow.fundReplicationBounty{value: initialBounty}(claimId);

        handler = new EscrowHandler(
            admin,
            author,
            replicator,
            address(bondEscrow),
            address(claimRegistry),
            address(replicationRegistry),
            claimId,
            initialAuthorBond,
            initialBounty
        );
        targetContract(address(handler));
    }

    function invariant_ReservedBountyNeverExceedsTrackedBounty() public view {
        assertLe(bondEscrow.reservedBountyBalances(claimId), bondEscrow.bountyBalances(claimId));
    }

    function invariant_BountyAccountingConservesFunds() public view {
        assertEq(
            bondEscrow.bountyBalances(claimId) + handler.invariantReleasedTotal(),
            initialBounty
        );
    }

    function invariant_AuthorBondNeverExceedsInitialDeposit() public view {
        assertLe(bondEscrow.authorBondBalances(claimId), initialAuthorBond);
    }

    function invariant_ClaimAndReplicationIdsRemainMonotonic() public view {
        assertGe(claimRegistry.nextClaimId(), 2);
        assertGe(replicationRegistry.nextReplicationId(), 1);
    }
}
