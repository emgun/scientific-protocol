// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {ProtocolDeployer} from "./utils/ProtocolDeployer.sol";
import {AppealsRegistry} from "../contracts/AppealsRegistry.sol";
import {ClaimRegistry} from "../contracts/ClaimRegistry.sol";
import {EpistemicMarket} from "../contracts/EpistemicMarket.sol";
import {ProtocolTypes} from "../contracts/libraries/ProtocolTypes.sol";

contract MarketHandler is Test {
    EpistemicMarket internal immutable market;
    ClaimRegistry internal immutable claimRegistry;
    address internal immutable admin;
    uint256 public immutable claimId;
    uint256 internal immutable replicationId;
    uint256 internal resolutionDecisionId;

    mapping(uint256 forecastId => bytes32 salt) internal salts;
    mapping(uint256 forecastId => ProtocolTypes.ForecastDirection direction) internal directions;
    mapping(uint256 forecastId => uint16 confidenceBps) internal confidences;

    constructor(
        address market_,
        address claimRegistry_,
        address admin_,
        uint256 claimId_,
        uint256 replicationId_
    ) {
        market = EpistemicMarket(market_);
        claimRegistry = ClaimRegistry(claimRegistry_);
        admin = admin_;
        claimId = claimId_;
        replicationId = replicationId_;
    }

    receive() external payable {}

    function fundPool(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 0.01 ether, 1 ether);
        market.fundRewardPool{value: amount}();
    }

    function commitForecast(uint256 seed) external {
        ProtocolTypes.ClaimStatus status = claimRegistry.getClaim(claimId).status;
        if (
            status == ProtocolTypes.ClaimStatus.Refuted ||
            status == ProtocolTypes.ClaimStatus.Fraudulent ||
            status == ProtocolTypes.ClaimStatus.Deprecated
        ) {
            return;
        }
        uint256 stake = bound(seed, 0.01 ether, 1 ether);
        uint256 forecastId = market.nextForecastId();
        bytes32 salt = keccak256(abi.encodePacked("salt", forecastId));
        ProtocolTypes.ForecastDirection direction = ProtocolTypes.ForecastDirection(seed % 3);
        uint16 confidenceBps = uint16(bound(seed, 1, 10_000));

        salts[forecastId] = salt;
        directions[forecastId] = direction;
        confidences[forecastId] = confidenceBps;

        market.commitForecast{value: stake}(
            claimId,
            keccak256(abi.encode(direction, confidenceBps, salt)),
            uint64(block.timestamp + bound(seed, 1 hours, 7 days)),
            0
        );
    }

    function finalizeDecision() external {
        if (resolutionDecisionId != 0) {
            return;
        }
        vm.prank(admin);
        resolutionDecisionId = claimRegistry.finalizeClaimResolution(claimId, replicationId);
    }

    function revealForecast(uint256 forecastSeed) external {
        uint256 forecastId = _pickForecast(forecastSeed);
        if (forecastId == 0) {
            return;
        }
        EpistemicMarket.ForecastCommitment memory forecast = market.getForecast(forecastId);
        if (forecast.revealed || forecast.settled || block.timestamp > forecast.revealDeadline) {
            return;
        }
        market.revealForecast(
            forecastId,
            directions[forecastId],
            confidences[forecastId],
            salts[forecastId]
        );
    }

    function settleForecast(uint256 forecastSeed) external {
        uint256 forecastId = _pickForecast(forecastSeed);
        if (forecastId == 0 || resolutionDecisionId == 0) {
            return;
        }
        EpistemicMarket.ForecastCommitment memory forecast = market.getForecast(forecastId);
        if (forecast.settled) {
            return;
        }
        if (resolutionDecisionId <= forecast.effectiveDecisionIdAtCommit) {
            return;
        }
        if (!forecast.revealed && block.timestamp <= forecast.revealDeadline) {
            return;
        }
        vm.prank(admin);
        market.settleForecast(forecastId, resolutionDecisionId);
    }

    function forfeitUnrevealedForecast(uint256 forecastSeed) external {
        uint256 forecastId = _pickForecast(forecastSeed);
        if (forecastId == 0) {
            return;
        }
        EpistemicMarket.ForecastCommitment memory forecast = market.getForecast(forecastId);
        if (forecast.settled || forecast.revealed || block.timestamp <= forecast.revealDeadline) {
            return;
        }
        market.forfeitUnrevealedForecast(forecastId);
    }

    function reclaimForecast(uint256 forecastSeed) external {
        uint256 forecastId = _pickForecast(forecastSeed);
        if (forecastId == 0) {
            return;
        }
        EpistemicMarket.ForecastCommitment memory forecast = market.getForecast(forecastId);
        if (
            forecast.settled ||
            !forecast.revealed ||
            block.timestamp <= uint256(forecast.revealDeadline) + market.FORECAST_RECLAIM_DELAY()
        ) {
            return;
        }
        market.reclaimForecast(forecastId);
    }

    function openChallenge(uint256 amountSeed) external {
        uint256 bond = bound(amountSeed, 0.01 ether, 1 ether);
        market.openChallenge{value: bond}(claimId, 0, keccak256("evidence"), "ipfs://evidence", 0);
    }

    function withdrawChallenge(uint256 challengeSeed) external {
        uint256 challengeId = _pickChallenge(challengeSeed);
        if (challengeId == 0) {
            return;
        }
        EpistemicMarket.ChallengeBond memory challenge = market.getChallenge(challengeId);
        if (
            challenge.status != ProtocolTypes.ChallengeStatus.Open ||
            block.timestamp < challenge.createdAt + market.MIN_CHALLENGE_DURATION()
        ) {
            return;
        }
        market.withdrawChallenge(challengeId);
    }

    function resolveChallenge(uint256 challengeSeed, uint256 statusSeed) external {
        uint256 challengeId = _pickChallenge(challengeSeed);
        if (challengeId == 0) {
            return;
        }
        EpistemicMarket.ChallengeBond memory challenge = market.getChallenge(challengeId);
        if (challenge.status != ProtocolTypes.ChallengeStatus.Open) {
            return;
        }
        ProtocolTypes.ChallengeStatus[3] memory outcomes = [
            ProtocolTypes.ChallengeStatus.Sustained,
            ProtocolTypes.ChallengeStatus.Dismissed,
            ProtocolTypes.ChallengeStatus.Escalated
        ];
        vm.prank(admin);
        market.resolveChallenge(
            challengeId,
            outcomes[statusSeed % outcomes.length],
            keccak256("resolution")
        );
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1 hours, 40 days));
    }

    function outstandingObligations() external view returns (uint256 total) {
        uint256 nextForecastId = market.nextForecastId();
        for (uint256 forecastId = 1; forecastId < nextForecastId; forecastId++) {
            EpistemicMarket.ForecastCommitment memory forecast = market.getForecast(forecastId);
            if (!forecast.settled) {
                total += forecast.stakeAmount;
            }
        }
        uint256 nextChallengeId = market.nextChallengeId();
        for (uint256 challengeId = 1; challengeId < nextChallengeId; challengeId++) {
            EpistemicMarket.ChallengeBond memory challenge = market.getChallenge(challengeId);
            if (challenge.status == ProtocolTypes.ChallengeStatus.Open) {
                total += challenge.bondAmount;
            }
        }
    }

    function _pickForecast(uint256 seed) internal view returns (uint256) {
        uint256 nextForecastId = market.nextForecastId();
        if (nextForecastId <= 1) {
            return 0;
        }
        return bound(seed, 1, nextForecastId - 1);
    }

    function _pickChallenge(uint256 seed) internal view returns (uint256) {
        uint256 nextChallengeId = market.nextChallengeId();
        if (nextChallengeId <= 1) {
            return 0;
        }
        return bound(seed, 1, nextChallengeId - 1);
    }
}

contract MarketInvariantTest is StdInvariant, ProtocolDeployer {
    MarketHandler internal handler;
    function setUp() public {
        deployProtocol();
        uint256 claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), 1 ether);

        vm.prank(admin);
        claimRegistry.setClaimStatus(claimId, ProtocolTypes.ClaimStatus.UnderReplication);
        vm.prank(replicator);
        uint256 replicationId = replicationRegistry.submitReplication(
            claimId,
            keccak256("market-env"),
            keccak256("market-result"),
            keccak256("market-evidence"),
            0
        );
        vm.prank(admin);
        replicationRegistry.resolveReplicationOutcome(
            replicationId,
            ProtocolTypes.ResolutionResult({
                status: ProtocolTypes.ResolutionStatus.Supported,
                confidenceBps: 9_000,
                resolutionHash: keccak256("market-resolution"),
                resolverType: ProtocolTypes.ResolverType.ComputationOracle,
                evidenceHash: keccak256("market-resolution-evidence"),
                evidenceURI: "ipfs://market-resolution"
            })
        );
        handler = new MarketHandler(
            address(epistemicMarket),
            address(claimRegistry),
            admin,
            claimId,
            replicationId
        );
        vm.deal(address(handler), 1_000 ether);
        targetContract(address(handler));
    }

    /// @dev The market must always hold enough ETH to cover the reward pool plus every
    /// unsettled forecast stake and open challenge bond.
    function invariant_MarketBalanceCoversObligations() public view {
        assertEq(
            address(epistemicMarket).balance,
            epistemicMarket.rewardPoolBalance() + handler.outstandingObligations()
        );
    }

    /// @dev The decision consumed by the market must remain an exact append-only copy of the
    /// resolved replication, never a second independently writable outcome.
    function invariant_MarketDecisionMatchesResolvedReplication() public view {
        uint256 canonicalDecisionId = claimRegistry.getEffectiveResolutionDecisionId(
            handler.claimId()
        );
        if (canonicalDecisionId == 0) {
            return;
        }
        ProtocolTypes.ResolutionDecision memory decision = claimRegistry.getResolutionDecision(
            canonicalDecisionId
        );
        ProtocolTypes.ReplicationRecord memory replication = replicationRegistry.getReplication(
            decision.replicationId
        );
        assertEq(decision.claimId, replication.claimId);
        assertEq(uint256(decision.status), uint256(replication.resolutionStatus));
        assertEq(decision.confidenceBps, replication.confidenceBps);
        assertEq(decision.resolutionHash, replication.resolutionHash);
        assertEq(decision.evidenceHash, replication.resolutionEvidenceHash);
        assertEq(uint256(decision.resolverType), uint256(replication.resolverType));
        assertEq(
            claimRegistry.getLatestResolutionDecisionId(decision.claimId),
            canonicalDecisionId
        );
    }
    /// @dev Every accepted forecast snapshots an earlier decision than the one used at settlement.
    function invariant_NoForecastSettlesAgainstItsCommitSnapshot() public view {
        uint256 nextForecastId = epistemicMarket.nextForecastId();
        for (uint256 forecastId = 1; forecastId < nextForecastId; forecastId++) {
            EpistemicMarket.ForecastCommitment memory forecast = epistemicMarket.getForecast(
                forecastId
            );
            if (forecast.settled && forecast.resolutionDecisionId != 0) {
                assertGt(forecast.resolutionDecisionId, forecast.effectiveDecisionIdAtCommit);
            }
        }
    }
}

contract AppealsHandler is Test {
    AppealsRegistry internal immutable appeals;
    address internal immutable admin;
    uint256 internal immutable claimId;

    constructor(address appeals_, address admin_, uint256 claimId_) {
        appeals = AppealsRegistry(payable(appeals_));
        admin = admin_;
        claimId = claimId_;
    }

    receive() external payable {}

    function fileAppeal(uint256 amountSeed) external {
        uint256 bond = bound(amountSeed, 0.01 ether, 1 ether);
        appeals.fileAppeal{value: bond}(
            claimId,
            0,
            0,
            ProtocolTypes.AppealReason.DisputedClassification,
            keccak256("filing"),
            "ipfs://appeal"
        );
    }

    function adjudicateAppeal(uint256 appealSeed, uint256 statusSeed) external {
        uint256 nextAppealId = appeals.nextAppealId();
        if (nextAppealId <= 1) {
            return;
        }
        uint256 appealId = bound(appealSeed, 1, nextAppealId - 1);
        if (appeals.getAppeal(appealId).adjudicatedAt != 0) {
            return;
        }
        ProtocolTypes.AppealStatus[5] memory outcomes = [
            ProtocolTypes.AppealStatus.Accepted,
            ProtocolTypes.AppealStatus.Rejected,
            ProtocolTypes.AppealStatus.Upheld,
            ProtocolTypes.AppealStatus.Overturned,
            ProtocolTypes.AppealStatus.Closed
        ];
        vm.prank(admin);
        appeals.adjudicateAppeal(
            appealId,
            outcomes[statusSeed % outcomes.length],
            keccak256("ruling"),
            "ipfs://ruling"
        );
    }

    function withdrawRefundedBond(uint256 amountSeed) external {
        uint256 available = appeals.refundableBondBalances(address(this));
        if (available == 0) {
            return;
        }
        appeals.withdrawRefundedBond(bound(amountSeed, 1, available), address(this));
    }

    function outstandingObligations() external view returns (uint256 total) {
        uint256 nextAppealId = appeals.nextAppealId();
        for (uint256 appealId = 1; appealId < nextAppealId; appealId++) {
            AppealsRegistry.AppealRecord memory appeal = appeals.getAppeal(appealId);
            if (appeal.adjudicatedAt == 0) {
                total += appeal.bondAmount;
            }
        }
        total += appeals.refundableBondBalances(address(this));
    }
}

contract AppealsInvariantTest is StdInvariant, ProtocolDeployer {
    AppealsHandler internal handler;

    function setUp() public {
        deployProtocol();
        uint256 claimId = createPublishedClaim(uint64(DOMAIN_COMPUTATIONAL), 1 ether);

        handler = new AppealsHandler(address(appealsRegistry), admin, claimId);
        vm.deal(address(handler), 1_000 ether);
        targetContract(address(handler));
    }

    /// @dev The registry must always hold enough ETH to cover every pending appeal bond plus
    /// refunded balances awaiting withdrawal; forfeited bonds leave for the treasury immediately.
    function invariant_AppealsBalanceCoversObligations() public view {
        assertEq(address(appealsRegistry).balance, handler.outstandingObligations());
    }
}
