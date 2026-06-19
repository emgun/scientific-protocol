import { describe, it } from "node:test";
import { expect } from "chai";
import {
  computeAgentWebhookRetryDelayMs,
  filterFreshAgentRuntimeEvents,
  normalizeAgentWebhookEventTypes,
  signAgentWebhookPayload,
} from "../src/agents/webhooks.js";

describe("agent webhooks", () => {
  it("keeps the dispatch CLI import-safe", async () => {
    const module = await import("../script/dispatch-agent-webhooks.js");

    expect(module.dispatchAgentWebhooksFromEnv).to.be.a("function");
  });

  it("normalizes webhook event types and defaults to runtime events", () => {
    expect(normalizeAgentWebhookEventTypes(undefined)).to.include("work_item.claimable");
    expect(normalizeAgentWebhookEventTypes(["webhook.ping", "work_item.claimable"])).to.deep.equal([
      "webhook.ping",
      "work_item.claimable",
    ]);
  });

  it("filters runtime events strictly after the subscription cursor", () => {
    const filtered = filterFreshAgentRuntimeEvents(
      [
        {
          agentIds: ["1"],
          claimId: "1",
          eventId: "event-2",
          eventType: "work_item.updated",
          occurredAt: "2026-04-08T12:01:00.000Z",
          payload: {},
          scopeKey: "review-task:1",
          summary: "updated",
          title: "Updated",
        },
        {
          agentIds: ["1"],
          claimId: "1",
          eventId: "event-1",
          eventType: "work_item.claimable",
          occurredAt: "2026-04-08T12:00:00.000Z",
          payload: {},
          scopeKey: "review-task:1",
          summary: "claimable",
          title: "Claimable",
        },
      ],
      {
        cursorEventId: "event-1",
        cursorOccurredAt: "2026-04-08T12:00:00.000Z",
      },
    );

    expect(filtered).to.have.length(1);
    expect(filtered[0]?.eventId).to.equal("event-2");
  });

  it("signs webhook payloads and increases retry delay exponentially", () => {
    const signature = signAgentWebhookPayload({
      payloadBody: '{"ok":true}',
      secret: "ospwhsec_test",
      timestamp: "2026-04-08T12:00:00.000Z",
    });

    expect(signature).to.match(/^v1=[0-9a-f]{64}$/);
    expect(computeAgentWebhookRetryDelayMs(1)).to.equal(15_000);
    expect(computeAgentWebhookRetryDelayMs(3)).to.equal(60_000);
  });
});
