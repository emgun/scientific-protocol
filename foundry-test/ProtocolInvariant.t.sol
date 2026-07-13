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
    mapping(uint256 => bool) internal cancelledReservation;
    uint256 internal releasedTotal;
    uint256 internal slashedTotal;
    uint256 internal withdrawnRefundTotal;

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
        uint256 replicationId = replicationRegistry.submitReplication(
            claimId,
            keccak256(abi.encodePacked("env", seed)),
            keccak256(abi.encodePacked("result", seed)),
            keccak256(abi.encodePacked("evidence", seed)),
            0
        );
        vm.prank(admin);
        replicationRegistry.resolveReplicationOutcome(
            replicationId,
            ProtocolTypes.ResolutionResult({
                status: ProtocolTypes.ResolutionStatus.Supported,
                confidenceBps: 9_000,
                resolutionHash: keccak256(abi.encodePacked("resolution", seed)),
                resolverType: ProtocolTypes.ResolverType.ComputationOracle,
                evidenceHash: keccak256(abi.encodePacked("resolution-evidence", seed)),
                evidenceURI: "ipfs://resolution"
            })
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
        bondEscrow.reserveBountyPayout(claimId, replicationId, amount);
        hasReservation[replicationId] = true;
    }

    function releasePayout(uint256 replicationSeed) external {
        uint256 nextReplicationId = replicationRegistry.nextReplicationId();
        if (nextReplicationId <= 1) {
            return;
        }
        uint256 replicationId = bound(replicationSeed, 1, nextReplicationId - 1);
        if (
            !hasReservation[replicationId] ||
            releasedReservation[replicationId] ||
            cancelledReservation[replicationId]
        ) {
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

    function cancelPayout(uint256 replicationSeed) external {
        uint256 nextReplicationId = replicationRegistry.nextReplicationId();
        if (nextReplicationId <= 1) {
            return;
        }
        uint256 replicationId = bound(replicationSeed, 1, nextReplicationId - 1);
        if (
            !hasReservation[replicationId] ||
            releasedReservation[replicationId] ||
            cancelledReservation[replicationId]
        ) {
            return;
        }

        vm.prank(admin);
        bondEscrow.cancelReservedPayout(claimId, replicationId);
        cancelledReservation[replicationId] = true;
    }

    function slashAuthorBond(uint256 amountSeed) external {
        uint256 available = bondEscrow.authorBondBalances(claimId);
        if (available < STEP) {
            return;
        }
        uint256 amount = STEP * bound(amountSeed, 1, available / STEP);
        vm.prank(admin);
        bondEscrow.slashAuthorBond(claimId, amount);
        slashedTotal += amount;
    }

    function refundAuthorBond(uint256 amountSeed) external {
        uint256 available = bondEscrow.authorBondBalances(claimId);
        if (available < STEP) {
            return;
        }
        uint256 amount = STEP * bound(amountSeed, 1, available / STEP);
        vm.prank(admin);
        bondEscrow.refundAuthorBond(claimId, amount);
    }

    function withdrawAuthorRefund(uint256 amountSeed) external {
        uint256 available = bondEscrow.authorRefundCredits(author);
        if (available < STEP) {
            return;
        }
        uint256 amount = STEP * bound(amountSeed, 1, available / STEP);
        vm.prank(author);
        bondEscrow.withdrawAuthorBondRefund(amount, payable(author));
        withdrawnRefundTotal += amount;
    }

    function progressClaimStatus(uint8 choice) external {
        ProtocolTypes.ClaimStatus currentStatus = claimRegistry.getClaim(claimId).status;
        if (currentStatus == ProtocolTypes.ClaimStatus.Published) {
            ProtocolTypes.ClaimStatus[2] memory options = [
                ProtocolTypes.ClaimStatus.UnderReplication,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            vm.prank(admin);
            claimRegistry.setClaimStatus(claimId, options[choice % options.length]);
            return;
        }
        if (currentStatus == ProtocolTypes.ClaimStatus.UnderReplication) {
            vm.prank(admin);
            claimRegistry.setClaimStatus(claimId, ProtocolTypes.ClaimStatus.Deprecated);
        }
    }

    function invariantReleasedTotal() external view returns (uint256) {
        return releasedTotal;
    }

    function invariantSlashedTotal() external view returns (uint256) {
        return slashedTotal;
    }

    function invariantWithdrawnRefundTotal() external view returns (uint256) {
        return withdrawnRefundTotal;
    }
}

interface BondEscrowLike {
    struct BountyReservation {
        address recipient;
        uint256 amount;
        bool released;
        bool cancelled;
    }

    function bountyBalances(uint256 claimId) external view returns (uint256);
    function reservedBountyBalances(uint256 claimId) external view returns (uint256);
    function authorBondBalances(uint256 claimId) external view returns (uint256);
    function authorRefundCredits(address author) external view returns (uint256);
    function slashRecipient() external view returns (address);
    function reserveBountyPayout(uint256 claimId, uint256 replicationId, uint256 amount) external;
    function releaseReservedPayout(uint256 claimId, uint256 replicationId) external;
    function cancelReservedPayout(uint256 claimId, uint256 replicationId) external;
    function slashAuthorBond(uint256 claimId, uint256 amount) external;
    function refundAuthorBond(uint256 claimId, uint256 amount) external;
    function withdrawAuthorBondRefund(uint256 amount, address payable recipient) external;
    function getReservation(
        uint256 claimId,
        uint256 replicationId
    ) external view returns (BountyReservation memory);
}

interface ClaimRegistryLike {
    function getClaim(uint256 claimId) external view returns (ProtocolTypes.ClaimRecord memory);
    function setClaimStatus(uint256 claimId, ProtocolTypes.ClaimStatus newStatus) external;
}

contract PublicationHandler is Test {
    ClaimRegistryLike internal immutable claimRegistry;
    BondEscrowLike internal immutable bondEscrow;
    address internal immutable admin;
    address internal immutable author;
    bool internal violated;

    constructor(address claimRegistry_, address bondEscrow_, address admin_, address author_) {
        claimRegistry = ClaimRegistryLike(claimRegistry_);
        bondEscrow = BondEscrowLike(bondEscrow_);
        admin = admin_;
        author = author_;
    }

    function publicationAttempt(uint96 requiredSeed, uint96 depositSeed) external {
        uint256 required = bound(uint256(requiredSeed), 1, 0.01 ether);
        vm.prank(author);
        (bool created, bytes memory result) = address(claimRegistry).call(
            abi.encodeWithSignature(
                "createClaim((bytes32,bytes32,bytes32,bytes32,bytes32,uint64,address),uint256,address)",
                ProtocolTypes.ClaimSummary({
                    statementHash: keccak256(abi.encodePacked("publication", requiredSeed)),
                    methodologyHash: keccak256("method"),
                    scopeHash: keccak256("scope"),
                    metadataHash: keccak256("metadata"),
                    predictionHooksHash: keccak256("hooks"),
                    domainId: uint64(1),
                    author: author
                }),
                required,
                address(0)
            )
        );
        if (!created) return;
        uint256 claimId = abi.decode(result, (uint256));
        uint256 deposit = bound(uint256(depositSeed), 0, required);
        if (deposit != 0) {
            vm.deal(author, author.balance + deposit);
            vm.prank(author);
            (bool deposited, ) = address(bondEscrow).call{value: deposit}(
                abi.encodeWithSignature("depositAuthorBond(uint256)", claimId)
            );
            if (!deposited) return;
        }
        vm.prank(admin);
        (bool published, ) = address(claimRegistry).call(
            abi.encodeWithSignature(
                "setClaimStatus(uint256,uint8)",
                claimId,
                ProtocolTypes.ClaimStatus.Published
            )
        );
        if (!published) return;
        ProtocolTypes.ClaimRecord memory claim = claimRegistry.getClaim(claimId);
        if (
            claim.status == ProtocolTypes.ClaimStatus.Published &&
            bondEscrow.authorBondBalances(claimId) < required
        ) violated = true;
    }

    function publicationGateViolated() external view returns (bool) {
        return violated;
    }
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
    function resolveReplicationOutcome(
        uint256 replicationId,
        ProtocolTypes.ResolutionResult calldata result
    ) external;
}

contract ProtocolInvariantTest is StdInvariant, ProtocolDeployer {
    EscrowHandler internal handler;
    uint256 internal claimId;
    uint256 internal initialAuthorBond = 5 ether;
    uint256 internal initialBounty = 10 ether;

    function setUp() public {
        deployProtocol();
        claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), initialAuthorBond);
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

    function invariant_AuthorBondAccountingConservesFunds() public view {
        assertEq(
            bondEscrow.authorBondBalances(claimId) +
                bondEscrow.authorRefundCredits(author) +
                handler.invariantSlashedTotal() +
                handler.invariantWithdrawnRefundTotal(),
            initialAuthorBond
        );
    }

    function invariant_ClaimAndReplicationIdsRemainMonotonic() public view {
        assertGe(claimRegistry.nextClaimId(), 2);
        assertGe(replicationRegistry.nextReplicationId(), 1);
    }
}

contract PublicationInvariantTest is StdInvariant, ProtocolDeployer {
    PublicationHandler internal handler;

    function setUp() public {
        deployProtocol();
        handler = new PublicationHandler(
            address(claimRegistry),
            address(bondEscrow),
            admin,
            author
        );
        targetContract(address(handler));
    }

    function invariant_NoClaimPublishesBelowItsRequiredBond() public view {
        assertFalse(handler.publicationGateViolated());
    }
}
