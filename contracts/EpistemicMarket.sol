// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessManaged} from "./utils/AccessManaged.sol";
import {SimpleReentrancyGuard} from "./utils/SimpleReentrancyGuard.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IEpistemicMarket} from "./interfaces/IEpistemicMarket.sol";
import {IReplicationRegistry} from "./interfaces/IReplicationRegistry.sol";

contract EpistemicMarket is AccessManaged, SimpleReentrancyGuard, IEpistemicMarket {
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
    error EpistemicMarketInvalidConfidence(uint16 confidenceBps);

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
        uint64 revealDeadline
    );
    event ForecastRevealed(
        uint256 indexed forecastId,
        ProtocolTypes.ForecastDirection direction,
        uint16 confidenceBps,
        address indexed actor
    );
    event ForecastSettled(
        uint256 indexed forecastId,
        ProtocolTypes.ResolutionStatus finalStatus,
        bool matched,
        uint256 payoutAmount,
        address indexed actor
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

    /// @notice Minimum time a challenge bond stays committed before the challenger can withdraw it.
    /// @dev Prevents a challenger from rescuing a bond by withdrawing just ahead of a dismissal.
    uint256 public constant MIN_CHALLENGE_DURATION = 1 days;

    /// @notice Delay after the reveal deadline before a revealed-but-unsettled forecast stake can be reclaimed.
    /// @dev Safety hatch for settler inactivity; long enough that it cannot be used to dodge a normal settlement.
    uint256 public constant FORECAST_RECLAIM_DELAY = 30 days;

    uint256 public nextForecastId = 1;
    uint256 public nextChallengeId = 1;
    uint256 public rewardPoolBalance;

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
    function fundRewardPool() external payable {
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
    ) external payable returns (uint256 forecastId) {
        if (!claimRegistry.claimExists(claimId)) {
            revert EpistemicMarketUnknownClaim(claimId);
        }
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
            confidenceBps: 0
        });

        emit ForecastCommitted(
            forecastId,
            claimId,
            msg.sender,
            agentId,
            commitmentHash,
            msg.value,
            revealDeadline
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

    /// @notice Settles a forecast after claim evidence has reached a resolver-determined status.
    /// @dev Trust assumption: the settler role solely determines `finalStatus`; the contract does
    /// not re-derive it from claim state. The role is expected to be held by the timelocked
    /// operator pipeline, not an EOA with discretionary power.
    /// An unrevealed forecast can only be settled after its reveal window closes, and it always
    /// forfeits its stake to the reward pool. Refunding unrevealed stakes would let a forecaster
    /// commit opposite forecasts and reveal only the winner for a free option.
    function settleForecast(
        uint256 forecastId,
        ProtocolTypes.ResolutionStatus finalStatus
    ) external onlyRole(ProtocolRoles.MARKET_SETTLER_ROLE) nonReentrant {
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

        forecast.settled = true;
        bool matched = forecast.revealed && _forecastMatches(forecast.direction, finalStatus);
        uint256 payoutAmount;

        if (matched) {
            uint256 bonus =
                rewardPoolBalance >= forecast.stakeAmount
                    ? forecast.stakeAmount
                    : rewardPoolBalance;
            rewardPoolBalance -= bonus;
            payoutAmount = forecast.stakeAmount + bonus;
            _safeTransferValue(forecast.forecaster, payoutAmount);
        } else {
            rewardPoolBalance += forecast.stakeAmount;
        }

        emit ForecastSettled(forecastId, finalStatus, matched, payoutAmount, msg.sender);
    }

    /// @notice Reclaims the stake of a revealed forecast that the settler never settled.
    /// @dev Safety hatch against settler inactivity. Only available long after the reveal
    /// deadline, refunds the stake without any bonus, and emits `ForecastSettled` with a
    /// `Pending` status so read models observe the terminal state.
    function reclaimForecast(uint256 forecastId) external nonReentrant {
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
        _safeTransferValue(forecast.forecaster, forecast.stakeAmount);
        emit ForecastSettled(
            forecastId,
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
    ) external payable returns (uint256 challengeId) {
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

    /// @notice Withdraws an unresolved challenge and refunds the posted bond.
    /// @dev The bond stays committed for `MIN_CHALLENGE_DURATION` so the resolver has a
    /// guaranteed window to dismiss a frivolous challenge before the bond can be rescued.
    function withdrawChallenge(uint256 challengeId) external nonReentrant {
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
        _safeTransferValue(challenge.challenger, challenge.bondAmount);
        emit ChallengeWithdrawn(challengeId, challenge.challenger, challenge.bondAmount);
    }

    /// @notice Resolves a challenge bond without mutating any prior claim or replication history.
    function resolveChallenge(
        uint256 challengeId,
        ProtocolTypes.ChallengeStatus status,
        bytes32 resolutionHash
    ) external onlyRole(ProtocolRoles.RESOLVER_ROLE) nonReentrant {
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
            _safeTransferValue(challenge.challenger, payoutAmount);
        } else if (status == ProtocolTypes.ChallengeStatus.Dismissed) {
            rewardPoolBalance += challenge.bondAmount;
        } else if (status == ProtocolTypes.ChallengeStatus.Escalated) {
            payoutAmount = challenge.bondAmount;
            _safeTransferValue(challenge.challenger, payoutAmount);
        }

        emit ChallengeResolved(challengeId, status, resolutionHash, payoutAmount, msg.sender);
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
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert EpistemicMarketTransferFailed(recipient, amount);
        }
    }
}
