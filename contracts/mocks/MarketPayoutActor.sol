// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTypes} from "../libraries/ProtocolTypes.sol";

interface IMarketPayoutEscrow {
    function commitForecast(
        uint256 claimId,
        bytes32 commitmentHash,
        uint64 revealDeadline,
        uint256 agentId
    ) external payable returns (uint256 forecastId);

    function revealForecast(
        uint256 forecastId,
        ProtocolTypes.ForecastDirection direction,
        uint16 confidenceBps,
        bytes32 salt
    ) external;

    function reclaimForecast(uint256 forecastId) external;

    function openChallenge(
        uint256 claimId,
        uint256 replicationId,
        bytes32 evidenceHash,
        string calldata evidenceURI,
        uint256 agentId
    ) external payable returns (uint256 challengeId);

    function withdrawChallenge(uint256 challengeId) external;
    function withdrawPayout(uint256 amount, address payable recipient) external;
}

/// @notice Test helper for rejecting market beneficiaries and withdrawal reentrancy.
contract MarketPayoutActor {
    IMarketPayoutEscrow public immutable market;
    bool public rejectValue;
    bool public attemptReentry;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address market_) {
        market = IMarketPayoutEscrow(market_);
    }

    function setReceiveBehavior(bool rejectValue_, bool attemptReentry_) external {
        rejectValue = rejectValue_;
        attemptReentry = attemptReentry_;
    }

    function commitForecast(
        uint256 claimId,
        bytes32 commitmentHash,
        uint64 revealDeadline
    ) external payable returns (uint256 forecastId) {
        return market.commitForecast{value: msg.value}(claimId, commitmentHash, revealDeadline, 0);
    }

    function revealForecast(
        uint256 forecastId,
        ProtocolTypes.ForecastDirection direction,
        uint16 confidenceBps,
        bytes32 salt
    ) external {
        market.revealForecast(forecastId, direction, confidenceBps, salt);
    }

    function reclaimForecast(uint256 forecastId) external {
        market.reclaimForecast(forecastId);
    }

    function openChallenge(uint256 claimId) external payable returns (uint256 challengeId) {
        return
            market.openChallenge{value: msg.value}(
                claimId,
                0,
                keccak256("market-payout-test"),
                "ipfs://market-payout-test",
                0
            );
    }

    function withdrawChallenge(uint256 challengeId) external {
        market.withdrawChallenge(challengeId);
    }

    function withdrawPayout(uint256 amount, address payable recipient) external {
        market.withdrawPayout(amount, recipient);
    }

    receive() external payable {
        if (rejectValue) revert("reject value");
        if (attemptReentry) {
            reentryAttempted = true;
            try market.withdrawPayout(msg.value, payable(address(this))) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}
