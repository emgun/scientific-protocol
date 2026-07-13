// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessManaged} from "./utils/AccessManaged.sol";
import {DepositPausable} from "./utils/DepositPausable.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IEpistemicMarket} from "./interfaces/IEpistemicMarket.sol";
import {IReplicationRegistry} from "./interfaces/IReplicationRegistry.sol";

/// @title EpistemicMarket
/// @notice Forecast and challenge records settled against canonical claim decisions.
contract EpistemicMarket is DepositPausable, ReentrancyGuard, IEpistemicMarket {
    error EpistemicMarketUnknownClaim(uint256 claimId);
    error EpistemicMarketUnknownForecast(uint256 forecastId);
    error EpistemicMarketUnknownChallenge(uint256 challengeId);
    error EpistemicMarketUnknownReplication(uint256 claimId, uint256 replicationId);
    error EpistemicMarketUnauthorizedAgent(uint256 agentId, address actor);
    error EpistemicMarketInvalidAmount(uint256 amount);
    error EpistemicMarketInvalidRevealDeadline(uint64 revealDeadline);
    error EpistemicMarketAlreadyRevealed(uint256 forecastId);
    error EpistemicMarketAlreadySettled(uint256 forecastId);
    error EpistemicMarketRevealWindowClosed(uint256 forecastId);
    error EpistemicMarketRevealWindowOpen(uint256 forecastId);
    error EpistemicMarketForecastNotReclaimable(uint256 forecastId);
    error EpistemicMarketInvalidCommitment(uint256 forecastId);
    error EpistemicMarketInvalidChallengeStatus(ProtocolTypes.ChallengeStatus status);
    error EpistemicMarketChallengeWithdrawLocked(uint256 challengeId, uint256 unlockAt);
    error EpistemicMarketTransferFailed(address recipient, uint256 amount);
    error EpistemicMarketInvalidRecipient(address recipient);
    error EpistemicMarketInsufficientPayoutCredit(
        address beneficiary,
        uint256 requested,
        uint256 available
    );
    error EpistemicMarketInvalidConfidence(uint16 confidenceBps);
    error EpistemicMarketUnknownResolutionDecision(uint256 decisionId);
    error EpistemicMarketClaimNotForecastable(uint256 claimId, ProtocolTypes.ClaimStatus status);
    error EpistemicMarketDecisionNotNewer(
        uint256 forecastId,
        uint256 committedDecisionId,
        uint256 settlementDecisionId
    );
    error EpistemicMarketResolutionDecisionClaimMismatch(
        uint256 decisionId,
        uint256 expectedClaimId,
        uint256 actualClaimId
    );
    error EpistemicMarketStaleResolutionDecision(
        uint256 claimId,
        uint256 requestedDecisionId,
        uint256 latestDecisionId
    );

    struct ForecastCommitment {
        uint256 forecastId;
        uint256 claimId;
        address forecaster;
        uint256 agentId;
        bytes32 commitmentHash;
        uint256 stakeAmount;
        uint64 committedAt;
        uint64 revealDeadline;
        bool revealed;
        bool settled;
        ProtocolTypes.ForecastDirection direction;
        uint16 confidenceBps;
        uint256 effectiveDecisionIdAtCommit;
        uint256 resolutionDecisionId;
    }

    struct ChallengeBond {
        uint256 challengeId;
        uint256 claimId;
        uint256 replicationId;
        address challenger;
        uint256 agentId;
        bytes32 evidenceHash;
        string evidenceURI;
        uint256 bondAmount;
        ProtocolTypes.ChallengeStatus status;
        bytes32 resolutionHash;
        uint256 createdAt;
        uint256 resolvedAt;
    }

    event RewardPoolFunded(address indexed funder, uint256 amount);
    event ForecastCommitted(
        uint256 indexed forecastId,
        uint256 indexed claimId,
        address indexed forecaster,
        uint256 agentId,
        bytes32 commitmentHash,
        uint256 stakeAmount,
        uint64 revealDeadline,
        uint256 effectiveDecisionIdAtCommit
    );
    event ForecastRevealed(
        uint256 indexed forecastId,
        ProtocolTypes.ForecastDirection direction,
        uint16 confidenceBps,
        address indexed actor
    );
    event ForecastSettled(
        uint256 indexed forecastId,
        uint256 indexed resolutionDecisionId,
        ProtocolTypes.ResolutionStatus finalStatus,
        bool matched,
        uint256 payoutAmount,
        address indexed actor
    );
    event ForecastForfeited(
        uint256 indexed forecastId,
        address indexed forecaster,
        uint256 forfeitedAmount,
        address indexed actor
    );
    event ForecastPayoutCredited(
        uint256 indexed forecastId,
        address indexed forecaster,
        uint256 amount
    );
    event ChallengeOpened(
        uint256 indexed challengeId,
        uint256 indexed claimId,
        uint256 indexed replicationId,
        address challenger,
        uint256 agentId,
        uint256 bondAmount
    );
    event ChallengeResolved(
        uint256 indexed challengeId,
        ProtocolTypes.ChallengeStatus status,
        bytes32 resolutionHash,
        uint256 payoutAmount,
        address indexed actor
    );
    event ChallengeWithdrawn(
        uint256 indexed challengeId,
        address indexed challenger,
        uint256 refundedAmount
    );
    event ChallengePayoutCredited(
        uint256 indexed challengeId,
        address indexed challenger,
        uint256 amount
    );
    event MarketPayoutWithdrawn(
        address indexed beneficiary,
        address indexed recipient,
        uint256 amount
    );

    /// @notice Minimum time a challenge bond stays committed before the challenger can withdraw it.
    /// @dev Prevents a challenger from rescuing a bond by withdrawing just ahead of a dismissal.
    uint256 public constant MIN_CHALLENGE_DURATION = 1 days;

    /// @notice Delay after the reveal deadline before a revealed-but-unsettled forecast stake can be reclaimed.
    /// @dev Safety hatch for settler inactivity; long enough that it cannot be used to dodge a normal settlement.
    uint256 public constant FORECAST_RECLAIM_DELAY = 30 days;

    uint256 public nextForecastId = 1;
    uint256 public nextChallengeId = 1;
    uint256 public rewardPoolBalance;
    uint256 public totalWithdrawablePayouts;
    mapping(address beneficiary => uint256 amount) public withdrawablePayouts;

    IClaimRegistry public immutable claimRegistry;
    IAgentRegistry public immutable agentRegistry;
    IReplicationRegistry public immutable replicationRegistry;

    mapping(uint256 forecastId => ForecastCommitment forecast) private _forecasts;
    mapping(uint256 challengeId => ChallengeBond challenge) private _challenges;

    constructor(
        address accessController_,
        address claimRegistry_,
        address agentRegistry_,
        address replicationRegistry_
    ) AccessManaged(accessController_) {
        claimRegistry = IClaimRegistry(claimRegistry_);
        agentRegistry = IAgentRegistry(agentRegistry_);
        replicationRegistry = IReplicationRegistry(replicationRegistry_);
    }

    /// @notice Funds the shared bonus pool used to reward calibrated forecasts and sustained challenges.
    /// @dev The pool is deliberately one-way: value leaves only through matched-forecast bonuses
    /// and sustained-challenge bonuses. There is no governance drain path, so funders know
    /// forfeited stakes and dismissed bonds can only ever subsidize future correct participation.
    function fundRewardPool() external payable whenDepositsNotPaused {
        if (msg.value == 0) {
            revert EpistemicMarketInvalidAmount(msg.value);
        }

        rewardPoolBalance += msg.value;
        emit RewardPoolFunded(msg.sender, msg.value);
    }

    /// @notice Commits a forecast hash against an existing claim.
    function commitForecast(
        uint256 claimId,
        bytes32 commitmentHash,
        uint64 revealDeadline,
        uint256 agentId
    ) external payable whenDepositsNotPaused returns (uint256 forecastId) {
        if (!claimRegistry.claimExists(claimId)) {
            revert EpistemicMarketUnknownClaim(claimId);
        }
        ProtocolTypes.ClaimStatus claimStatus = claimRegistry.getClaim(claimId).status;
        if (
            claimStatus == ProtocolTypes.ClaimStatus.Refuted ||
            claimStatus == ProtocolTypes.ClaimStatus.Fraudulent ||
            claimStatus == ProtocolTypes.ClaimStatus.Deprecated
        ) {
            revert EpistemicMarketClaimNotForecastable(claimId, claimStatus);
        }
        uint256 effectiveDecisionIdAtCommit = claimRegistry.getEffectiveResolutionDecisionId(
            claimId
        );
        if (msg.value == 0) {
            revert EpistemicMarketInvalidAmount(msg.value);
        }
        if (revealDeadline <= block.timestamp) {
            revert EpistemicMarketInvalidRevealDeadline(revealDeadline);
        }
        if (agentId != 0 && !agentRegistry.isAuthorizedController(agentId, msg.sender)) {
            revert EpistemicMarketUnauthorizedAgent(agentId, msg.sender);
        }

        forecastId = nextForecastId++;
        _forecasts[forecastId] = ForecastCommitment({
            forecastId: forecastId,
            claimId: claimId,
            forecaster: msg.sender,
            agentId: agentId,
            commitmentHash: commitmentHash,
            stakeAmount: msg.value,
            committedAt: uint64(block.timestamp),
            revealDeadline: revealDeadline,
            revealed: false,
            settled: false,
            direction: ProtocolTypes.ForecastDirection.Questions,
            confidenceBps: 0,
            effectiveDecisionIdAtCommit: effectiveDecisionIdAtCommit,
            resolutionDecisionId: 0
        });

        emit ForecastCommitted(
            forecastId,
            claimId,
            msg.sender,
            agentId,
            commitmentHash,
            msg.value,
            revealDeadline,
            effectiveDecisionIdAtCommit
        );
    }

    /// @notice Reveals a previously committed forecast.
    /// @dev `confidenceBps` is informational for offchain calibration scoring; settlement payouts
    /// are intentionally binary and do not weight by confidence.
    function revealForecast(
        uint256 forecastId,
        ProtocolTypes.ForecastDirection direction,
        uint16 confidenceBps,
        bytes32 salt
    ) external {
        ForecastCommitment storage forecast = _forecasts[forecastId];
        if (forecast.forecastId == 0) {
            revert EpistemicMarketUnknownForecast(forecastId);
        }
        if (!_isAuthorizedForecastActor(forecast, msg.sender)) {
            revert EpistemicMarketUnauthorizedAgent(forecast.agentId, msg.sender);
        }
        if (forecast.revealed) {
            revert EpistemicMarketAlreadyRevealed(forecastId);
        }
        if (block.timestamp > forecast.revealDeadline) {
            revert EpistemicMarketRevealWindowClosed(forecastId);
        }
        if (confidenceBps > 10_000) {
            revert EpistemicMarketInvalidConfidence(confidenceBps);
        }

        bytes32 computedHash = keccak256(abi.encode(direction, confidenceBps, salt));
        if (computedHash != forecast.commitmentHash) {
            revert EpistemicMarketInvalidCommitment(forecastId);
        }

        forecast.revealed = true;
        forecast.direction = direction;
        forecast.confidenceBps = confidenceBps;
        emit ForecastRevealed(forecastId, direction, confidenceBps, msg.sender);
    }

    /// @notice Settles a forecast against the decision that established claim resolution state.
    /// @dev The market settler chooses when to settle but cannot supply independent outcome,
    /// fraud, or confidence state.
    /// An unrevealed forecast can only be settled after its reveal window closes, and it always
    /// forfeits its stake to the reward pool. Refunding unrevealed stakes would let a forecaster
    /// commit opposite forecasts and reveal only the winner for a free option.
    function settleForecast(
        uint256 forecastId,
        uint256 resolutionDecisionId
    ) external onlyRole(ProtocolRoles.MARKET_SETTLER_ROLE) {
        ForecastCommitment storage forecast = _forecasts[forecastId];
        if (forecast.forecastId == 0) {
            revert EpistemicMarketUnknownForecast(forecastId);
        }
        if (forecast.settled) {
            revert EpistemicMarketAlreadySettled(forecastId);
        }
        if (!forecast.revealed && block.timestamp <= forecast.revealDeadline) {
            revert EpistemicMarketRevealWindowOpen(forecastId);
        }
        uint256 effectiveDecisionId = claimRegistry.getEffectiveResolutionDecisionId(
            forecast.claimId
        );
        if (effectiveDecisionId == 0) {
            revert EpistemicMarketUnknownResolutionDecision(resolutionDecisionId);
        }
        if (resolutionDecisionId != effectiveDecisionId) {
            revert EpistemicMarketStaleResolutionDecision(
                forecast.claimId,
                resolutionDecisionId,
                effectiveDecisionId
            );
        }
        if (resolutionDecisionId <= forecast.effectiveDecisionIdAtCommit) {
            revert EpistemicMarketDecisionNotNewer(
                forecastId,
                forecast.effectiveDecisionIdAtCommit,
                resolutionDecisionId
            );
        }
        ProtocolTypes.ResolutionDecision memory decision = claimRegistry.getResolutionDecision(
            resolutionDecisionId
        );
        if (decision.claimId != forecast.claimId) {
            revert EpistemicMarketResolutionDecisionClaimMismatch(
                resolutionDecisionId,
                forecast.claimId,
                decision.claimId
            );
        }

        forecast.settled = true;
        forecast.resolutionDecisionId = resolutionDecisionId;
        ProtocolTypes.ResolutionStatus finalStatus = decision.status;
        bool matched = forecast.revealed && _forecastMatches(forecast.direction, finalStatus);
        uint256 payoutAmount;

        if (matched) {
            uint256 bonus =
                rewardPoolBalance >= forecast.stakeAmount
                    ? forecast.stakeAmount
                    : rewardPoolBalance;
            rewardPoolBalance -= bonus;
            payoutAmount = forecast.stakeAmount + bonus;
            _creditPayout(forecast.forecaster, payoutAmount);
            emit ForecastPayoutCredited(forecastId, forecast.forecaster, payoutAmount);
        } else {
            rewardPoolBalance += forecast.stakeAmount;
        }

        emit ForecastSettled(
            forecastId,
            resolutionDecisionId,
            finalStatus,
            matched,
            payoutAmount,
            msg.sender
        );
    }

    /// @notice Permissionlessly finalizes an unrevealed forecast after its reveal deadline.
    /// @dev The full stake is moved into the reward pool. This terminal path deliberately does
    /// not require a claim decision: a forecaster must reveal on time regardless of whether the
    /// underlying claim has resolved, otherwise selective reveal would create a free option.
    function forfeitUnrevealedForecast(uint256 forecastId) external {
        ForecastCommitment storage forecast = _forecasts[forecastId];
        if (forecast.forecastId == 0) {
            revert EpistemicMarketUnknownForecast(forecastId);
        }
        if (forecast.settled) {
            revert EpistemicMarketAlreadySettled(forecastId);
        }
        if (forecast.revealed) {
            revert EpistemicMarketAlreadyRevealed(forecastId);
        }
        if (block.timestamp <= forecast.revealDeadline) {
            revert EpistemicMarketRevealWindowOpen(forecastId);
        }

        forecast.settled = true;
        rewardPoolBalance += forecast.stakeAmount;

        emit ForecastForfeited(forecastId, forecast.forecaster, forecast.stakeAmount, msg.sender);
        emit ForecastSettled(
            forecastId,
            0,
            ProtocolTypes.ResolutionStatus.Pending,
            false,
            0,
            msg.sender
        );
    }

    /// @notice Credits the stake of a revealed forecast that the settler never settled.
    /// @dev Safety hatch against settler inactivity. Only available long after the reveal
    /// deadline, credits the stake without any bonus, and emits `ForecastSettled` with a
    /// `Pending` status so read models observe the terminal state.
    function reclaimForecast(uint256 forecastId) external {
        ForecastCommitment storage forecast = _forecasts[forecastId];
        if (forecast.forecastId == 0) {
            revert EpistemicMarketUnknownForecast(forecastId);
        }
        if (!_isAuthorizedForecastActor(forecast, msg.sender)) {
            revert EpistemicMarketUnauthorizedAgent(forecast.agentId, msg.sender);
        }
        if (forecast.settled) {
            revert EpistemicMarketAlreadySettled(forecastId);
        }
        if (
            !forecast.revealed ||
            block.timestamp <= uint256(forecast.revealDeadline) + FORECAST_RECLAIM_DELAY
        ) {
            revert EpistemicMarketForecastNotReclaimable(forecastId);
        }

        forecast.settled = true;
        _creditPayout(forecast.forecaster, forecast.stakeAmount);
        emit ForecastPayoutCredited(forecastId, forecast.forecaster, forecast.stakeAmount);
        emit ForecastSettled(
            forecastId,
            0,
            ProtocolTypes.ResolutionStatus.Pending,
            false,
            forecast.stakeAmount,
            msg.sender
        );
    }

    /// @notice Opens a challenge bond tied to a claim or a specific replication.
    function openChallenge(
        uint256 claimId,
        uint256 replicationId,
        bytes32 evidenceHash,
        string calldata evidenceURI,
        uint256 agentId
    ) external payable whenDepositsNotPaused returns (uint256 challengeId) {
        if (!claimRegistry.claimExists(claimId)) {
            revert EpistemicMarketUnknownClaim(claimId);
        }
        if (
            replicationId != 0 &&
            replicationRegistry.getReplicationClaimId(replicationId) != claimId
        ) {
            revert EpistemicMarketUnknownReplication(claimId, replicationId);
        }
        if (msg.value == 0) {
            revert EpistemicMarketInvalidAmount(msg.value);
        }
        if (agentId != 0 && !agentRegistry.isAuthorizedController(agentId, msg.sender)) {
            revert EpistemicMarketUnauthorizedAgent(agentId, msg.sender);
        }

        challengeId = nextChallengeId++;
        _challenges[challengeId] = ChallengeBond({
            challengeId: challengeId,
            claimId: claimId,
            replicationId: replicationId,
            challenger: msg.sender,
            agentId: agentId,
            evidenceHash: evidenceHash,
            evidenceURI: evidenceURI,
            bondAmount: msg.value,
            status: ProtocolTypes.ChallengeStatus.Open,
            resolutionHash: bytes32(0),
            createdAt: block.timestamp,
            resolvedAt: 0
        });

        emit ChallengeOpened(challengeId, claimId, replicationId, msg.sender, agentId, msg.value);
    }

    /// @notice Withdraws an unresolved challenge and credits the posted bond to its challenger.
    /// @dev The bond stays committed for `MIN_CHALLENGE_DURATION` so the resolver has a
    /// guaranteed window to dismiss a frivolous challenge before the bond can be rescued.
    function withdrawChallenge(uint256 challengeId) external {
        ChallengeBond storage challenge = _challenges[challengeId];
        if (challenge.challengeId == 0) {
            revert EpistemicMarketUnknownChallenge(challengeId);
        }
        if (!_isAuthorizedChallengeActor(challenge, msg.sender)) {
            revert EpistemicMarketUnauthorizedAgent(challenge.agentId, msg.sender);
        }
        if (challenge.status != ProtocolTypes.ChallengeStatus.Open) {
            revert EpistemicMarketInvalidChallengeStatus(challenge.status);
        }
        uint256 withdrawUnlockAt = challenge.createdAt + MIN_CHALLENGE_DURATION;
        if (block.timestamp < withdrawUnlockAt) {
            revert EpistemicMarketChallengeWithdrawLocked(challengeId, withdrawUnlockAt);
        }

        challenge.status = ProtocolTypes.ChallengeStatus.Withdrawn;
        challenge.resolvedAt = block.timestamp;
        _creditPayout(challenge.challenger, challenge.bondAmount);
        emit ChallengePayoutCredited(challengeId, challenge.challenger, challenge.bondAmount);
        emit ChallengeWithdrawn(challengeId, challenge.challenger, challenge.bondAmount);
    }

    /// @notice Resolves a challenge bond without mutating any prior claim or replication history.
    function resolveChallenge(
        uint256 challengeId,
        ProtocolTypes.ChallengeStatus status,
        bytes32 resolutionHash
    ) external onlyRole(ProtocolRoles.RESOLVER_ROLE) {
        ChallengeBond storage challenge = _challenges[challengeId];
        if (challenge.challengeId == 0) {
            revert EpistemicMarketUnknownChallenge(challengeId);
        }
        if (challenge.status != ProtocolTypes.ChallengeStatus.Open) {
            revert EpistemicMarketInvalidChallengeStatus(challenge.status);
        }
        if (
            status == ProtocolTypes.ChallengeStatus.Open ||
            status == ProtocolTypes.ChallengeStatus.Withdrawn
        ) {
            revert EpistemicMarketInvalidChallengeStatus(status);
        }

        challenge.status = status;
        challenge.resolutionHash = resolutionHash;
        challenge.resolvedAt = block.timestamp;

        uint256 payoutAmount;
        if (status == ProtocolTypes.ChallengeStatus.Sustained) {
            uint256 bonus =
                rewardPoolBalance >= challenge.bondAmount
                    ? challenge.bondAmount
                    : rewardPoolBalance;
            rewardPoolBalance -= bonus;
            payoutAmount = challenge.bondAmount + bonus;
            _creditPayout(challenge.challenger, payoutAmount);
            emit ChallengePayoutCredited(challengeId, challenge.challenger, payoutAmount);
        } else if (status == ProtocolTypes.ChallengeStatus.Dismissed) {
            rewardPoolBalance += challenge.bondAmount;
        } else if (status == ProtocolTypes.ChallengeStatus.Escalated) {
            payoutAmount = challenge.bondAmount;
            _creditPayout(challenge.challenger, payoutAmount);
            emit ChallengePayoutCredited(challengeId, challenge.challenger, payoutAmount);
        }

        emit ChallengeResolved(challengeId, status, resolutionHash, payoutAmount, msg.sender);
    }

    /// @notice Withdraws the caller's forecast and challenge payout credits.
    /// @dev Uses checks-effects-interactions and a reentrancy guard. Terminal market transitions
    /// only create credits, so they cannot be blocked by a beneficiary that rejects ETH.
    function withdrawPayout(uint256 amount, address payable recipient) external nonReentrant {
        if (amount == 0) {
            revert EpistemicMarketInvalidAmount(amount);
        }
        if (recipient == address(0)) {
            revert EpistemicMarketInvalidRecipient(recipient);
        }
        uint256 available = withdrawablePayouts[msg.sender];
        if (available < amount) {
            revert EpistemicMarketInsufficientPayoutCredit(msg.sender, amount, available);
        }

        withdrawablePayouts[msg.sender] = available - amount;
        totalWithdrawablePayouts -= amount;
        _safeTransferValue(recipient, amount);
        emit MarketPayoutWithdrawn(msg.sender, recipient, amount);
    }

    function getForecast(uint256 forecastId) external view returns (ForecastCommitment memory) {
        return _forecasts[forecastId];
    }

    function getChallenge(uint256 challengeId) external view returns (ChallengeBond memory) {
        return _challenges[challengeId];
    }

    function challengeExists(uint256 challengeId) external view override returns (bool) {
        return _challenges[challengeId].challengeId != 0;
    }

    function getChallengeClaimId(uint256 challengeId) external view override returns (uint256) {
        return _challenges[challengeId].claimId;
    }

    function _forecastMatches(
        ProtocolTypes.ForecastDirection direction,
        ProtocolTypes.ResolutionStatus finalStatus
    ) internal pure returns (bool) {
        if (direction == ProtocolTypes.ForecastDirection.Supports) {
            return
                finalStatus == ProtocolTypes.ResolutionStatus.Supported ||
                finalStatus == ProtocolTypes.ResolutionStatus.Qualified;
        }
        if (direction == ProtocolTypes.ForecastDirection.Questions) {
            return
                finalStatus == ProtocolTypes.ResolutionStatus.Inconclusive ||
                finalStatus == ProtocolTypes.ResolutionStatus.Escalated;
        }
        return
            finalStatus == ProtocolTypes.ResolutionStatus.Refuted ||
            finalStatus == ProtocolTypes.ResolutionStatus.FraudSignal;
    }

    function _isAuthorizedForecastActor(
        ForecastCommitment storage forecast,
        address actor
    ) internal view returns (bool) {
        if (forecast.agentId == 0) {
            return actor == forecast.forecaster;
        }
        return agentRegistry.isAuthorizedController(forecast.agentId, actor);
    }

    function _isAuthorizedChallengeActor(
        ChallengeBond storage challenge,
        address actor
    ) internal view returns (bool) {
        if (challenge.agentId == 0) {
            return actor == challenge.challenger;
        }
        return agentRegistry.isAuthorizedController(challenge.agentId, actor);
    }

    function _safeTransferValue(address recipient, uint256 amount) internal {
        // The beneficiary explicitly chooses the recipient while withdrawing its own credit.
        // slither-disable-next-line arbitrary-send-eth
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert EpistemicMarketTransferFailed(recipient, amount);
        }
    }

    function _creditPayout(address beneficiary, uint256 amount) internal {
        withdrawablePayouts[beneficiary] += amount;
        totalWithdrawablePayouts += amount;
    }
}
