// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AccessController} from "../../contracts/AccessController.sol";
import {AgentRegistry} from "../../contracts/AgentRegistry.sol";
import {AppealsRegistry} from "../../contracts/AppealsRegistry.sol";
import {ArtifactRegistry} from "../../contracts/ArtifactRegistry.sol";
import {BondEscrow} from "../../contracts/BondEscrow.sol";
import {ClaimRegistry} from "../../contracts/ClaimRegistry.sol";
import {ComputationalResolutionModule} from "../../contracts/modules/ComputationalResolutionModule.sol";
import {BenchmarkResolutionModule} from "../../contracts/modules/BenchmarkResolutionModule.sol";
import {WetLabResolutionModule} from "../../contracts/modules/WetLabResolutionModule.sol";
import {EpistemicMarket} from "../../contracts/EpistemicMarket.sol";
import {ProtocolParameters} from "../../contracts/ProtocolParameters.sol";
import {ProtocolRoles} from "../../contracts/libraries/ProtocolRoles.sol";
import {ProtocolTypes} from "../../contracts/libraries/ProtocolTypes.sol";
import {ReplicationRegistry} from "../../contracts/ReplicationRegistry.sol";
import {ReputationCheckpointRegistry} from "../../contracts/ReputationCheckpointRegistry.sol";
import {ResolutionModuleRegistry} from "../../contracts/ResolutionModuleRegistry.sol";

abstract contract ProtocolDeployer is Test {
    AccessController internal accessController;
    AgentRegistry internal agentRegistry;
    AppealsRegistry internal appealsRegistry;
    ProtocolParameters internal protocolParameters;
    ArtifactRegistry internal artifactRegistry;
    BenchmarkResolutionModule internal benchmarkModule;
    BondEscrow internal bondEscrow;
    ClaimRegistry internal claimRegistry;
    ComputationalResolutionModule internal computationalModule;
    EpistemicMarket internal epistemicMarket;
    ReplicationRegistry internal replicationRegistry;
    ReputationCheckpointRegistry internal checkpointRegistry;
    ResolutionModuleRegistry internal moduleRegistry;
    WetLabResolutionModule internal wetLabModule;

    address internal admin = makeAddr("admin");
    address internal author = makeAddr("author");
    address internal replicator = makeAddr("replicator");
    address internal checkpointPublisher = makeAddr("checkpointPublisher");
    address internal agentOperator = makeAddr("agentOperator");
    address internal other = makeAddr("other");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant DOMAIN_COMPUTATIONAL = 1;
    uint256 internal constant DOMAIN_WET_LAB = 2;
    uint256 internal constant DOMAIN_BENCHMARK = 3;

    function deployProtocol() internal {
        vm.startPrank(admin);
        accessController = new AccessController(admin);
        _grantAllCoreRoles(admin);
        accessController.grantRole(ProtocolRoles.CHECKPOINT_PUBLISHER_ROLE, checkpointPublisher);

        protocolParameters = new ProtocolParameters(address(accessController));
        moduleRegistry = new ResolutionModuleRegistry(address(accessController));
        computationalModule = new ComputationalResolutionModule();
        benchmarkModule = new BenchmarkResolutionModule();
        wetLabModule = new WetLabResolutionModule();

        moduleRegistry.registerModule(address(computationalModule), "ipfs://module/computational");
        moduleRegistry.registerModule(address(benchmarkModule), "ipfs://module/benchmark");
        moduleRegistry.registerModule(address(wetLabModule), "ipfs://module/wetlab");

        moduleRegistry.setDomainModule(uint64(DOMAIN_COMPUTATIONAL), address(computationalModule));
        moduleRegistry.setDomainModule(uint64(DOMAIN_WET_LAB), address(wetLabModule));
        moduleRegistry.setDomainModule(uint64(DOMAIN_BENCHMARK), address(benchmarkModule));

        claimRegistry = new ClaimRegistry(
            address(accessController),
            address(moduleRegistry),
            address(protocolParameters)
        );
        artifactRegistry = new ArtifactRegistry(address(claimRegistry));
        agentRegistry = new AgentRegistry(address(accessController));
        replicationRegistry = new ReplicationRegistry(
            address(accessController),
            address(claimRegistry),
            address(agentRegistry)
        );
        bondEscrow = new BondEscrow(
            address(accessController),
            address(claimRegistry),
            address(replicationRegistry)
        );
        claimRegistry.configureProtocolDependencies(
            address(bondEscrow),
            address(replicationRegistry)
        );
        checkpointRegistry = new ReputationCheckpointRegistry(
            address(accessController),
            address(claimRegistry),
            address(agentRegistry),
            address(moduleRegistry)
        );
        epistemicMarket = new EpistemicMarket(
            address(accessController),
            address(claimRegistry),
            address(agentRegistry),
            address(replicationRegistry)
        );
        appealsRegistry = new AppealsRegistry(
            address(accessController),
            address(claimRegistry),
            address(replicationRegistry),
            address(epistemicMarket),
            treasury
        );
        vm.stopPrank();

        vm.deal(admin, 100 ether);
        vm.deal(author, 100 ether);
        vm.deal(replicator, 100 ether);
        vm.deal(agentOperator, 100 ether);
        vm.deal(other, 100 ether);
        vm.deal(checkpointPublisher, 100 ether);
    }

    function makeClaimSummary(
        address claimAuthor,
        uint64 domainId
    ) internal pure returns (ProtocolTypes.ClaimSummary memory) {
        return
            ProtocolTypes.ClaimSummary({
                statementHash: keccak256(abi.encodePacked("statement", claimAuthor, domainId)),
                methodologyHash: keccak256(abi.encodePacked("methodology", claimAuthor, domainId)),
                scopeHash: keccak256(abi.encodePacked("scope", claimAuthor, domainId)),
                metadataHash: keccak256(abi.encodePacked("metadata", claimAuthor, domainId)),
                predictionHooksHash: keccak256(abi.encodePacked("hooks", claimAuthor, domainId)),
                domainId: domainId,
                author: claimAuthor
            });
    }

    function createPublishedClaim(
        uint64 domainId,
        uint256 authorBondAmount
    ) internal returns (uint256 claimId) {
        vm.prank(author);
        claimId = claimRegistry.createClaim(
            makeClaimSummary(author, domainId),
            authorBondAmount,
            address(0)
        );

        if (authorBondAmount != 0) {
            vm.prank(author);
            bondEscrow.depositAuthorBond{value: authorBondAmount}(claimId);
        }

        vm.prank(admin);
        claimRegistry.setClaimStatus(claimId, ProtocolTypes.ClaimStatus.Published);
    }

    function _grantAllCoreRoles(address account) private {
        accessController.grantRole(ProtocolRoles.PARAMETER_ADMIN_ROLE, account);
        accessController.grantRole(ProtocolRoles.RESOLVER_ROLE, account);
        accessController.grantRole(ProtocolRoles.CHECKPOINT_PUBLISHER_ROLE, account);
        accessController.grantRole(ProtocolRoles.MODULE_ADMIN_ROLE, account);
        accessController.grantRole(ProtocolRoles.ESCROW_ADMIN_ROLE, account);
        accessController.grantRole(ProtocolRoles.AGENT_BUDGET_MANAGER_ROLE, account);
        accessController.grantRole(ProtocolRoles.MARKET_SETTLER_ROLE, account);
        accessController.grantRole(ProtocolRoles.COURT_ROLE, account);
    }
}
