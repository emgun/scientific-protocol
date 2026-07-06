import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers";
import hardhatNodeTestRunnerPlugin from "@nomicfoundation/hardhat-node-test-runner";
import { defineConfig } from "hardhat/config";

function httpNetwork(url: string) {
  return {
    type: "http" as const,
    chainType: "l1" as const,
    url,
  };
}

export default defineConfig({
  plugins: [hardhatEthersPlugin, hardhatNodeTestRunnerPlugin],
  networks: {
    localhost: httpNetwork(process.env.SP_RPC_URL ?? "http://127.0.0.1:8545"),
    staging: httpNetwork(process.env.SP_RPC_URL ?? "http://127.0.0.1:8545"),
  },
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
  },
});
