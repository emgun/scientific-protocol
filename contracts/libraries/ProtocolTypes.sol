// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ProtocolTypes {
    enum ClaimStatus {
        Draft,
        Published,
        UnderReplication,
        ProvisionallySupported,
        Qualified,
        Refuted,
        Fraudulent,
        Deprecated
    }

    enum ArtifactType {
        Dataset,
        CodeArchive,
        ContainerDigest,
        ModelWeights,
        NotebookBundle,
        Manuscript,
        Supplement,
        Other
    }

    enum ReplicationOutcome {
        Pending,
        Supports,
        PartiallySupports,
        Inconclusive,
        FailsToSupport,
        InvalidSubmission,
        FraudSignal
    }

    enum ResolutionStatus {
        Pending,
        Supported,
        Qualified,
        Inconclusive,
        Refuted,
        FraudSignal,
        Escalated
    }

    enum ResolutionModuleKind {
        None,
        Computational,
        Benchmark,
        WetLab
    }

    enum ResolverType {
        Unknown,
        HumanResolver,
        AgentWorker,
        ComputationOracle,
        BenchmarkOracle,
        WetLabCouncil,
        AppealCourt
    }

    enum ForecastDirection {
        Supports,
        Questions,
        Refutes
    }

    enum ChallengeStatus {
        Open,
        Sustained,
        Dismissed,
        Escalated,
        Withdrawn
    }

    enum AppealReason {
        DisputedClassification,
        FraudAllegation,
        ResolverMisconduct,
        ModuleBoundary
    }

    enum AppealStatus {
        Filed,
        Accepted,
        Rejected,
        Upheld,
        Overturned,
        Closed
    }

    enum CheckpointSubjectType {
        Actor,
        Claim,
        ActorClaimPair,
        Agent,
        Module
    }

    struct ClaimSummary {
        bytes32 statementHash;
        bytes32 methodologyHash;
        bytes32 scopeHash;
        bytes32 metadataHash;
        bytes32 predictionHooksHash;
        uint64 domainId;
        address author;
    }

    struct ClaimRecord {
        uint256 claimId;
        ClaimSummary summary;
        ClaimStatus status;
        uint256 revisionOfClaimId;
        uint256 createdAt;
        uint256 requiredAuthorBond;
        address resolutionModule;
    }

    struct ArtifactCommitment {
        uint256 artifactId;
        uint256 claimId;
        ArtifactType artifactType;
        bytes32 contentDigest;
        string uri;
        bytes32 metadataHash;
        address submitter;
        uint256 createdAt;
    }

    struct ResolutionResult {
        ResolutionStatus status;
        uint16 confidenceBps;
        bytes32 resolutionHash;
        ResolverType resolverType;
        bytes32 evidenceHash;
        string evidenceURI;
    }

    struct ReplicationRecord {
        uint256 replicationId;
        uint256 claimId;
        address replicator;
        uint256 agentId;
        bytes32 environmentHash;
        bytes32 resultHash;
        bytes32 evidenceHash;
        ReplicationOutcome outcome;
        ResolutionStatus resolutionStatus;
        bytes32 resolutionHash;
        bytes32 resolutionEvidenceHash;
        string resolutionEvidenceURI;
        ResolverType resolverType;
        uint16 confidenceBps;
        uint256 submittedAt;
        uint256 resolvedAt;
        address resolver;
    }
}
