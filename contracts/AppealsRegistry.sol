// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessManaged} from "./utils/AccessManaged.sol";
import {SimpleReentrancyGuard} from "./utils/SimpleReentrancyGuard.sol";
import {ProtocolRoles} from "./libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "./libraries/ProtocolTypes.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IEpistemicMarket} from "./interfaces/IEpistemicMarket.sol";
import {IReplicationRegistry} from "./interfaces/IReplicationRegistry.sol";

contract AppealsRegistry is AccessManaged, SimpleReentrancyGuard {
    error AppealsRegistryUnknownClaim(uint256 claimId);
    error AppealsRegistryUnknownReplication(uint256 claimId, uint256 replicationId);
    error AppealsRegistryUnknownChallenge(uint256 claimId, uint256 challengeId);
    error AppealsRegistryUnknownAppeal(uint256 appealId);
    error AppealsRegistryInvalidAmount(uint256 amount);
    error AppealsRegistryInvalidStatus(ProtocolTypes.AppealStatus status);
    error AppealsRegistryAlreadyAdjudicated(uint256 appealId);
    error AppealsRegistryInvalidRecipient(address recipient);
    error AppealsRegistryInsufficientRefundBalance(
        address account,
        uint256 requested,
        uint256 available
    );
    error AppealsRegistryTransferFailed(address recipient, uint256 amount);

    struct AppealRecord {
        uint256 appealId;
        uint256 claimId;
        uint256 replicationId;
        uint256 challengeId;
        address appellant;
        ProtocolTypes.AppealReason reason;
        bytes32 filingHash;
        string uri;
        ProtocolTypes.AppealStatus status;
        bytes32 adjudicationHash;
        string adjudicationURI;
        uint256 bondAmount;
        uint256 createdAt;
        uint256 adjudicatedAt;
    }

    event AppealFiled(
        uint256 indexed appealId,
        uint256 indexed claimId,
        address indexed appellant,
        ProtocolTypes.AppealReason reason,
        uint256 replicationId,
        uint256 challengeId,
        uint256 bondAmount
    );
    event AppealAdjudicated(
        uint256 indexed appealId,
        ProtocolTypes.AppealStatus status,
        bytes32 adjudicationHash,
        string adjudicationURI,
        uint256 refundedAmount,
        uint256 forfeitedAmount,
        address indexed actor
    );
    event AppealBondWithdrawn(address indexed account, address indexed recipient, uint256 amount);

    uint256 public nextAppealId = 1;

    IClaimRegistry public immutable claimRegistry;
    IReplicationRegistry public immutable replicationRegistry;
    IEpistemicMarket public immutable epistemicMarket;

    /// @notice Recipient of forfeited appeal bonds (expected to be the protocol treasury).
    address public immutable forfeitRecipient;

    mapping(uint256 appealId => AppealRecord appeal) private _appeals;

    /// @notice Refunded appeal bonds awaiting pull-based withdrawal by the appellant.
    mapping(address account => uint256 amount) public refundableBondBalances;

    constructor(
        address accessController_,
        address claimRegistry_,
        address replicationRegistry_,
        address epistemicMarket_,
        address forfeitRecipient_
    ) AccessManaged(accessController_) {
        if (forfeitRecipient_ == address(0)) {
            revert AppealsRegistryInvalidRecipient(forfeitRecipient_);
        }
        claimRegistry = IClaimRegistry(claimRegistry_);
        replicationRegistry = IReplicationRegistry(replicationRegistry_);
        epistemicMarket = IEpistemicMarket(epistemicMarket_);
        forfeitRecipient = forfeitRecipient_;
    }

    /// @notice Files an append-only appeal without rewriting prior claim or replication history.
    function fileAppeal(
        uint256 claimId,
        uint256 replicationId,
        uint256 challengeId,
        ProtocolTypes.AppealReason reason,
        bytes32 filingHash,
        string calldata uri
    ) external payable returns (uint256 appealId) {
        if (!claimRegistry.claimExists(claimId)) {
            revert AppealsRegistryUnknownClaim(claimId);
        }
        if (
            replicationId != 0 &&
            replicationRegistry.getReplicationClaimId(replicationId) != claimId
        ) {
            revert AppealsRegistryUnknownReplication(claimId, replicationId);
        }
        if (challengeId != 0 && epistemicMarket.getChallengeClaimId(challengeId) != claimId) {
            revert AppealsRegistryUnknownChallenge(claimId, challengeId);
        }
        if (msg.value == 0) {
            revert AppealsRegistryInvalidAmount(msg.value);
        }

        appealId = nextAppealId++;
        _appeals[appealId] = AppealRecord({
            appealId: appealId,
            claimId: claimId,
            replicationId: replicationId,
            challengeId: challengeId,
            appellant: msg.sender,
            reason: reason,
            filingHash: filingHash,
            uri: uri,
            status: ProtocolTypes.AppealStatus.Filed,
            adjudicationHash: bytes32(0),
            adjudicationURI: "",
            bondAmount: msg.value,
            createdAt: block.timestamp,
            adjudicatedAt: 0
        });

        emit AppealFiled(
            appealId,
            claimId,
            msg.sender,
            reason,
            replicationId,
            challengeId,
            msg.value
        );
    }

    /// @notice Records a court decision while preserving full appeal history.
    /// @dev Bond economics: `Rejected` and `Upheld` mean the appellant lost, so the bond is
    /// forfeited to `forfeitRecipient`. `Accepted`, `Overturned`, and `Closed` credit the bond
    /// back to the appellant for pull-based withdrawal, so a reverting appellant contract can
    /// never block adjudication.
    function adjudicateAppeal(
        uint256 appealId,
        ProtocolTypes.AppealStatus status,
        bytes32 adjudicationHash,
        string calldata adjudicationURI
    ) external onlyRole(ProtocolRoles.COURT_ROLE) nonReentrant {
        AppealRecord storage appeal = _appeals[appealId];
        if (appeal.appealId == 0) {
            revert AppealsRegistryUnknownAppeal(appealId);
        }
        if (appeal.adjudicatedAt != 0) {
            revert AppealsRegistryAlreadyAdjudicated(appealId);
        }
        if (status == ProtocolTypes.AppealStatus.Filed) {
            revert AppealsRegistryInvalidStatus(status);
        }

        appeal.status = status;
        appeal.adjudicationHash = adjudicationHash;
        appeal.adjudicationURI = adjudicationURI;
        appeal.adjudicatedAt = block.timestamp;

        bool forfeited =
            status == ProtocolTypes.AppealStatus.Rejected ||
                status == ProtocolTypes.AppealStatus.Upheld;
        uint256 refundedAmount;
        uint256 forfeitedAmount;
        if (forfeited) {
            forfeitedAmount = appeal.bondAmount;
            _safeTransferValue(forfeitRecipient, forfeitedAmount);
        } else {
            refundedAmount = appeal.bondAmount;
            refundableBondBalances[appeal.appellant] += refundedAmount;
        }

        emit AppealAdjudicated(
            appealId,
            status,
            adjudicationHash,
            adjudicationURI,
            refundedAmount,
            forfeitedAmount,
            msg.sender
        );
    }

    /// @notice Withdraws previously refunded appeal bonds using a pull-based flow.
    function withdrawRefundedBond(uint256 amount, address recipient) external nonReentrant {
        if (amount == 0) {
            revert AppealsRegistryInvalidAmount(amount);
        }
        if (recipient == address(0)) {
            revert AppealsRegistryInvalidRecipient(recipient);
        }

        uint256 available = refundableBondBalances[msg.sender];
        if (available < amount) {
            revert AppealsRegistryInsufficientRefundBalance(msg.sender, amount, available);
        }

        refundableBondBalances[msg.sender] = available - amount;
        _safeTransferValue(recipient, amount);
        emit AppealBondWithdrawn(msg.sender, recipient, amount);
    }

    function getAppeal(uint256 appealId) external view returns (AppealRecord memory) {
        return _appeals[appealId];
    }

    function _safeTransferValue(address recipient, uint256 amount) internal {
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert AppealsRegistryTransferFailed(recipient, amount);
        }
    }
}
