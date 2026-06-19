import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expect } from "chai";
import { createDemoClaim } from "../src/demo/actions.js";
import { resolveIntegerInput } from "../src/shared/numbers.js";

describe("production submission", () => {
  it("validates integer claim fields before chain setup", () => {
    expect(resolveIntegerInput(undefined, 1, "domainId")).to.equal(1);
    expect(resolveIntegerInput(0, 1, "domainId")).to.equal(0);
    expect(resolveIntegerInput(5, 1, "artifactType", { min: 1 })).to.equal(5);
    expect(() => resolveIntegerInput(0, 1, "artifactType", { min: 1 })).to.throw(
      "artifactType must be an integer greater than or equal to 1",
    );
    expect(() => resolveIntegerInput(Number.NaN, 1, "domainId")).to.throw(
      "domainId must be an integer greater than or equal to 0",
    );
  });
});

describe("demo submission", () => {
  it("validates integer claim fields before loading deployment contracts", async () => {
    await assert.rejects(
      createDemoClaim({
        artifactType: 0,
        artifactUri: "ipfs://artifact",
        statement: "Sandbox claim",
      }),
      /artifactType must be an integer greater than or equal to 1/,
    );
  });
});
