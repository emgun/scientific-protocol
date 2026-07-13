import { describe, it } from "node:test";
import { expect } from "chai";
import {
  REPUTATION_CHECKPOINT_CADENCE_SCORE,
  REPUTATION_POLICY_VERSION,
  replicationWorkQualityScore,
} from "../src/reputation/engine.js";

describe("reputation policy", () => {
  it("versions direction-neutral work-quality scoring", () => {
    expect(REPUTATION_POLICY_VERSION).to.equal("reputation-v2-direction-neutral-work");
    expect(replicationWorkQualityScore(1)).to.be.greaterThan(0n);
    expect(replicationWorkQualityScore(2)).to.be.greaterThan(0n);
    expect(replicationWorkQualityScore(4)).to.be.greaterThan(0n);
    expect(replicationWorkQualityScore(5)).to.be.greaterThan(0n);
    expect(replicationWorkQualityScore(4)).to.be.greaterThan(replicationWorkQualityScore(3));
    expect(replicationWorkQualityScore(5)).to.be.greaterThan(replicationWorkQualityScore(3));
  });

  it("does not award score merely for publishing another checkpoint", () => {
    expect(REPUTATION_CHECKPOINT_CADENCE_SCORE).to.equal(0n);
  });
});
