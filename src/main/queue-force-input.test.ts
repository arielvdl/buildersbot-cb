// @vitest-environment node
// The force of a queued message at each boundary it crosses: the renderer's IPC payload, the frozen
// queue-force-v1 wire codec of a joined server, and the answer that main and the preload decode.
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { optionalRouteCodec } from "@openbot/contracts/team-protocol/optional-routes";
import { QUEUE_FORCE_ROUTES } from "@openbot/contracts/team-protocol/queue-force-v1";
import { describe, expect, it } from "vitest";
import { decodeForceResult } from "../preload/conversation-decoding";
import { parseForceQueuedMessage } from "./ipc/agent-inputs";
import { decodeForceQueuedMessageResult } from "./remote-agent-decoding";

const LONG_ID = "x".repeat(INPUT_LIMITS.identifier + 1);

function codec() {
  const found = optionalRouteCodec(QUEUE_FORCE_ROUTES.force);
  if (!found) throw new Error("queue-force-v1 has no codec.");
  return found;
}

describe("the force request from the renderer", () => {
  it("reads the turn the person saw, or null when the chat showed none", () => {
    expect(parseForceQueuedMessage({ agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: "turn-1" })).toEqual(
      {
        agentId: "agent-1",
        deliveryId: "delivery-1",
        expectedTurnId: "turn-1",
      },
    );
    expect(parseForceQueuedMessage({ agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: null })).toEqual({
      agentId: "agent-1",
      deliveryId: "delivery-1",
      expectedTurnId: null,
    });
  });

  it("refuses every other shape before it reaches the agent service", () => {
    for (const value of [
      null,
      "delivery-1",
      [],
      { deliveryId: "delivery-1", expectedTurnId: null },
      { agentId: "agent-1", expectedTurnId: null },
      { agentId: "agent-1", deliveryId: "", expectedTurnId: null },
      { agentId: "agent-1", deliveryId: "   ", expectedTurnId: null },
      { agentId: "agent-1", deliveryId: "delivery-1" },
      { agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: 7 },
      { agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: "" },
      { agentId: LONG_ID, deliveryId: "delivery-1", expectedTurnId: null },
      { agentId: "agent-1", deliveryId: LONG_ID, expectedTurnId: null },
      { agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: LONG_ID },
    ]) {
      expect(() => parseForceQueuedMessage(value), JSON.stringify(value)).toThrow();
    }
  });

  it("keeps only the known fields", () => {
    expect(
      parseForceQueuedMessage({ agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: null, extra: "x" }),
    ).toEqual({ agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: null });
  });
});

describe("the queue-force-v1 wire codec", () => {
  it("passes a valid request and refuses a malformed one", () => {
    expect(codec().request({ agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: null })).toEqual({
      agentId: "agent-1",
      deliveryId: "delivery-1",
      expectedTurnId: null,
    });
    for (const value of [
      {},
      { agentId: "agent-1", deliveryId: "delivery-1" },
      { agentId: "agent-1", deliveryId: "delivery-1", expectedTurnId: 1 },
      { agentId: "", deliveryId: "delivery-1", expectedTurnId: null },
      { agentId: "agent-1", deliveryId: LONG_ID, expectedTurnId: null },
    ]) {
      expect(() => codec().request(value), JSON.stringify(value)).toThrow();
    }
  });

  it("passes each outcome and a refusal, and refuses an unknown outcome", () => {
    for (const outcome of ["interrupted", "started", "next"])
      expect(codec().response(200, { outcome, extra: "dropped" })).toEqual({ outcome });
    expect(codec().response(409, { error: "Could not stop the agent." })).toEqual({
      error: "Could not stop the agent.",
    });
    expect(() => codec().response(200, { outcome: "stopped" })).toThrow();
    expect(() => codec().response(200, {})).toThrow();
  });
});

describe("the force answer that main and the preload read", () => {
  it("keeps the outcome only", () => {
    expect(decodeForceQueuedMessageResult({ outcome: "next", extra: true })).toEqual({ outcome: "next" });
    expect(decodeForceResult({ outcome: "interrupted", extra: true })).toEqual({ outcome: "interrupted" });
  });

  it("refuses any other value", () => {
    for (const value of [null, {}, { outcome: "done" }, "started"]) {
      expect(() => decodeForceQueuedMessageResult(value)).toThrow();
      expect(() => decodeForceResult(value)).toThrow();
    }
  });
});
