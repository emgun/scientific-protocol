// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolDeployer} from "./utils/ProtocolDeployer.sol";
import {ProtocolTypes} from "../contracts/libraries/ProtocolTypes.sol";

contract ProtocolFuzzTest is ProtocolDeployer {
    function setUp() public {
        deployProtocol();
    }

    function testFuzz_ValidClaimStatusTransitions(uint8[5] memory choices) public {
        uint256 claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), 1 ether);
        ProtocolTypes.ClaimStatus currentStatus = claimRegistry.getClaim(claimId).status;

        for (uint256 i = 0; i < choices.length; i++) {
            ProtocolTypes.ClaimStatus nextStatus = _pickAllowedStatus(currentStatus, choices[i]);
            vm.prank(admin);
            claimRegistry.setClaimStatus(claimId, nextStatus);
            currentStatus = claimRegistry.getClaim(claimId).status;
            assertEq(uint256(currentStatus), uint256(nextStatus));

            if (
                currentStatus == ProtocolTypes.ClaimStatus.Deprecated ||
                currentStatus == ProtocolTypes.ClaimStatus.Refuted ||
                currentStatus == ProtocolTypes.ClaimStatus.Fraudulent
            ) {
                break;
            }
        }
    }

    function testFuzz_InvalidClaimStatusTransitionsRevert(
        uint8 fromChoice,
        uint8 invalidTargetRaw
    ) public {
        uint256 claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), 1 ether);
        ProtocolTypes.ClaimStatus[] memory reachable = new ProtocolTypes.ClaimStatus[](3);
        reachable[0] = ProtocolTypes.ClaimStatus.Published;
        reachable[1] = ProtocolTypes.ClaimStatus.UnderReplication;
        reachable[2] = ProtocolTypes.ClaimStatus.ProvisionallySupported;
        ProtocolTypes.ClaimStatus fromStatus = reachable[fromChoice % reachable.length];
        ProtocolTypes.ClaimStatus invalidTarget = ProtocolTypes.ClaimStatus(invalidTargetRaw % 8);

        if (fromStatus == ProtocolTypes.ClaimStatus.UnderReplication) {
            vm.prank(admin);
            claimRegistry.setClaimStatus(claimId, ProtocolTypes.ClaimStatus.UnderReplication);
        } else if (fromStatus == ProtocolTypes.ClaimStatus.ProvisionallySupported) {
            vm.startPrank(admin);
            claimRegistry.setClaimStatus(claimId, ProtocolTypes.ClaimStatus.UnderReplication);
            claimRegistry.setClaimStatus(claimId, ProtocolTypes.ClaimStatus.ProvisionallySupported);
            vm.stopPrank();
        }

        vm.assume(!_isAllowedTransition(fromStatus, invalidTarget));
        vm.prank(admin);
        vm.expectRevert();
        claimRegistry.setClaimStatus(claimId, invalidTarget);
    }

    function testFuzz_ReserveBountyPayoutNeverExceedsAvailable(
        uint96 fundedRaw,
        uint96 firstRaw,
        uint96 secondRaw
    ) public {
        uint256 funded = bound(uint256(fundedRaw), 1 ether, 25 ether);
        uint256 claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), 1 ether);

        vm.prank(admin);
        bondEscrow.fundReplicationBounty{value: funded}(claimId);

        vm.startPrank(replicator);
        uint256 replicationIdOne = replicationRegistry.submitReplication(
            claimId,
            keccak256("env-1"),
            keccak256("result-1"),
            keccak256("evidence-1"),
            0
        );
        uint256 replicationIdTwo = replicationRegistry.submitReplication(
            claimId,
            keccak256("env-2"),
            keccak256("result-2"),
            keccak256("evidence-2"),
            0
        );
        vm.stopPrank();

        uint256 firstReservation = bound(uint256(firstRaw), 1, funded);
        vm.prank(admin);
        bondEscrow.reserveBountyPayout(claimId, replicationIdOne, firstReservation);

        uint256 availableAfterFirst = funded - firstReservation;
        uint256 secondReservation = bound(uint256(secondRaw), 1, funded);

        if (secondReservation > availableAfterFirst) {
            vm.prank(admin);
            vm.expectRevert();
            bondEscrow.reserveBountyPayout(claimId, replicationIdTwo, secondReservation);
        } else {
            vm.prank(admin);
            bondEscrow.reserveBountyPayout(claimId, replicationIdTwo, secondReservation);
            assertLe(
                bondEscrow.reservedBountyBalances(claimId),
                bondEscrow.bountyBalances(claimId)
            );
        }
    }

    function _pickAllowedStatus(
        ProtocolTypes.ClaimStatus currentStatus,
        uint8 choice
    ) internal pure returns (ProtocolTypes.ClaimStatus) {
        if (currentStatus == ProtocolTypes.ClaimStatus.Published) {
            ProtocolTypes.ClaimStatus[3] memory options = [
                ProtocolTypes.ClaimStatus.UnderReplication,
                ProtocolTypes.ClaimStatus.Qualified,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            return options[choice % options.length];
        }

        if (currentStatus == ProtocolTypes.ClaimStatus.UnderReplication) {
            ProtocolTypes.ClaimStatus[5] memory options = [
                ProtocolTypes.ClaimStatus.ProvisionallySupported,
                ProtocolTypes.ClaimStatus.Qualified,
                ProtocolTypes.ClaimStatus.Refuted,
                ProtocolTypes.ClaimStatus.Fraudulent,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            return options[choice % options.length];
        }

        if (currentStatus == ProtocolTypes.ClaimStatus.ProvisionallySupported) {
            ProtocolTypes.ClaimStatus[4] memory options = [
                ProtocolTypes.ClaimStatus.Qualified,
                ProtocolTypes.ClaimStatus.Refuted,
                ProtocolTypes.ClaimStatus.Fraudulent,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            return options[choice % options.length];
        }

        if (currentStatus == ProtocolTypes.ClaimStatus.Qualified) {
            ProtocolTypes.ClaimStatus[3] memory options = [
                ProtocolTypes.ClaimStatus.Refuted,
                ProtocolTypes.ClaimStatus.Fraudulent,
                ProtocolTypes.ClaimStatus.Deprecated
            ];
            return options[choice % options.length];
        }

        return ProtocolTypes.ClaimStatus.Deprecated;
    }

    function _isAllowedTransition(
        ProtocolTypes.ClaimStatus from,
        ProtocolTypes.ClaimStatus to
    ) internal pure returns (bool) {
        if (from == ProtocolTypes.ClaimStatus.Draft) {
            return
                to == ProtocolTypes.ClaimStatus.Published ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }
        if (from == ProtocolTypes.ClaimStatus.Published) {
            return
                to == ProtocolTypes.ClaimStatus.UnderReplication ||
                to == ProtocolTypes.ClaimStatus.Qualified ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }
        if (from == ProtocolTypes.ClaimStatus.UnderReplication) {
            return
                to == ProtocolTypes.ClaimStatus.ProvisionallySupported ||
                to == ProtocolTypes.ClaimStatus.Qualified ||
                to == ProtocolTypes.ClaimStatus.Refuted ||
                to == ProtocolTypes.ClaimStatus.Fraudulent ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }
        if (from == ProtocolTypes.ClaimStatus.ProvisionallySupported) {
            return
                to == ProtocolTypes.ClaimStatus.Qualified ||
                to == ProtocolTypes.ClaimStatus.Refuted ||
                to == ProtocolTypes.ClaimStatus.Fraudulent ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }
        if (from == ProtocolTypes.ClaimStatus.Qualified) {
            return
                to == ProtocolTypes.ClaimStatus.Refuted ||
                to == ProtocolTypes.ClaimStatus.Fraudulent ||
                to == ProtocolTypes.ClaimStatus.Deprecated;
        }
        if (
            from == ProtocolTypes.ClaimStatus.Refuted ||
            from == ProtocolTypes.ClaimStatus.Fraudulent
        ) {
            return to == ProtocolTypes.ClaimStatus.Deprecated;
        }
        return false;
    }
}
