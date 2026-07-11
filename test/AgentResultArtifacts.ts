import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expect } from "chai";
import {
  parseAgentResultArtifact,
  resolveAgentResultArtifact,
} from "../src/api/agent-result-artifacts.js";
import { createInlineJsonArtifact } from "../src/shared/persisted-artifacts.js";

describe("agent result artifacts", () => {
  it("accepts a self-contained artifact without invoking operated storage", async () => {
    const artifact = createInlineJsonArtifact("agent-review-submission-result", {
      summary: "Independent result",
    });

    expect(parseAgentResultArtifact(artifact, artifact.kind)).to.deep.equal(artifact);
    expect(
      await resolveAgentResultArtifact({
        fallbackPayload: { shouldNotPersist: true },
        kind: artifact.kind,
        suppliedArtifact: artifact,
      }),
    ).to.deep.equal(artifact);
  });

  it("rejects tampered and mismatched artifact descriptors", async () => {
    const artifact = createInlineJsonArtifact("agent-review-submission-result", {
      summary: "Independent result",
    });

    await assert.rejects(
      resolveAgentResultArtifact({
        fallbackPayload: {},
        kind: artifact.kind,
        suppliedArtifact: {
          ...artifact,
          storagePath: `data:application/json;base64,${Buffer.from("tampered\n").toString("base64")}`,
        },
      }),
      /agent_result_artifact_hash_mismatch/,
    );
    expect(() => parseAgentResultArtifact(artifact, "replication-result")).to.throw(
      "invalid_agent_result_artifact",
    );
  });
});
