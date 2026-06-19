export type WriteProtocolConfigView = {
  accessControllerAddress: string;
  artifactRegistryAddress: string;
  bondEscrowAddress: string;
  chainId: number;
  claimRegistryAddress: string;
  claimRewardVaultAddress: string;
  network: string;
  operatorLifecycleAuth: {
    bearerTokenFallbackEnabled: boolean;
    canonicalMode: "wallet_signature";
    checkpointPublisherRole: "CHECKPOINT_PUBLISHER_ROLE";
    replicationSubmitterAuthorizedAddresses: string[];
    resolverRole: "RESOLVER_ROLE";
  };
  rpcUrl?: string;
};
