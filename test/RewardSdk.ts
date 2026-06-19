import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "ethers";
import {
  claimRewardWorkKindCode,
  fundClaimRewardPoolWithContract,
  parseClaimRewardWorkKind,
  resolveRewardAmountWei,
  withdrawAccruedRewardsWithContract,
} from "../src/sdk/rewards.js";

describe("RewardSdk", () => {
  it("maps reward work kinds to claim reward vault codes", () => {
    assert.equal(claimRewardWorkKindCode("review"), 0);
    assert.equal(claimRewardWorkKindCode("replication"), 1);
    assert.equal(claimRewardWorkKindCode("maintenance"), 2);
    assert.equal(claimRewardWorkKindCode("challenge"), 3);
    assert.equal(claimRewardWorkKindCode("synthesis"), 4);
    assert.equal(claimRewardWorkKindCode("forecast"), 5);
    assert.throws(
      () => claimRewardWorkKindCode("unknown" as never),
      /unsupported reward work kind: unknown/,
    );
    assert.equal(parseClaimRewardWorkKind("review"), "review");
    assert.throws(
      () => parseClaimRewardWorkKind("unknown"),
      /unsupported reward work kind: unknown/,
    );
  });

  it("resolves reward amounts from eth or wei input", () => {
    assert.equal(resolveRewardAmountWei({ amountEth: "0.125" }), parseEther("0.125"));
    assert.equal(resolveRewardAmountWei({ amountWei: "42" }), 42n);
    assert.throws(
      () => resolveRewardAmountWei({ amountWei: "1.5" }),
      /amountWei must be an integer wei amount/,
    );
    assert.throws(
      () => resolveRewardAmountWei({ amountEth: "not-eth" }),
      /amountEth must be a decimal ETH amount/,
    );
    assert.throws(
      () => resolveRewardAmountWei({ amountWei: "0" }),
      /reward amount must be greater than zero/,
    );
  });

  it("builds funding calls against the claim reward vault", async () => {
    let capturedClaimId: bigint | null = null;
    let capturedWorkKind: number | null = null;
    let capturedValue: bigint | null = null;
    const contract = {
      async fundClaimRewards(
        claimId: bigint,
        workKind: number,
        overrides: {
          value: bigint;
        },
      ) {
        capturedClaimId = claimId;
        capturedWorkKind = workKind;
        capturedValue = overrides.value;
        return {
          hash: "0xfund",
        };
      },
    };

    const result = await fundClaimRewardPoolWithContract(contract, {
      amountWei: parseEther("0.05"),
      claimId: "7",
      workKind: "review",
    });

    assert.deepEqual(result, { hash: "0xfund" });
    assert.equal(capturedClaimId, 7n);
    assert.equal(capturedWorkKind, 0);
    assert.equal(capturedValue, parseEther("0.05"));
  });

  it("builds withdrawal calls against the claim reward vault", async () => {
    let capturedAmount: bigint | null = null;
    let capturedRecipient: string | null = null;
    const contract = {
      async withdrawAccruedRewards(amount: bigint, recipient: string) {
        capturedAmount = amount;
        capturedRecipient = recipient;
        return {
          hash: "0xwithdraw",
        };
      },
    };

    const result = await withdrawAccruedRewardsWithContract(contract, {
      amountWei: 42n,
      recipient: "0x0000000000000000000000000000000000000009",
    });

    assert.deepEqual(result, { hash: "0xwithdraw" });
    assert.equal(capturedAmount, 42n);
    assert.equal(capturedRecipient, "0x0000000000000000000000000000000000000009");
  });
});
