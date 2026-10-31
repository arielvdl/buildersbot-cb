// @vitest-environment node
import type { QueueDelivery } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { TurnSlots } from "./turn-slots";

/** A lane key as the drain makes it: the agent, then the task after a NUL. */
const lane = (agentId: string, taskId?: string) => (taskId ? `${agentId}\u0000${taskId}` : agentId);

function slots(input: {
  lanes: string[];
  running: string[];
  waiting?: string[];
  turnLimit?: number | null;
  agentLimit?: number | null;
  createdAt?: Record<string, string>;
}) {
  const head = (key: string): QueueDelivery => ({
    id: `delivery-${key}`,
    messageId: `message-${key}`,
    recipientAgentId: key.split("\u0000")[0] ?? key,
    sender: { kind: "user" },
    text: "",
    attachments: [],
    replyToMessageId: null,
    status: "queued",
    position: 1,
    turnId: null,
    error: null,
    createdAt: input.createdAt?.[key] ?? "2026-10-31T10:00:00.000Z",
  });
  return new TurnSlots({
    limit: () => input.turnLimit ?? null,
    agentLimit: () => input.agentLimit ?? null,
    agentOf: (key) => key.split("\u0000")[0] ?? key,
    lanes: () => input.lanes,
    isRunning: (key) => input.running.includes(key),
    isWaiting: (key) => (input.waiting ?? []).includes(key),
    head,
  });
}

describe("the cap on the agents that run", () => {
  it("lets every lane start while no cap is set", () => {
    const turnSlots = slots({ lanes: [lane("a"), lane("b"), lane("c")], running: [lane("a"), lane("b")] });
    expect(turnSlots.mayStart(lane("c"))).toBe(true);
  });

  it("holds a new agent when the cap is reached, and lets it start when a place frees", () => {
    const lanes = [lane("a"), lane("b"), lane("c")];
    expect(slots({ lanes, running: [lane("a"), lane("b")], agentLimit: 2 }).mayStart(lane("c"))).toBe(false);
    expect(slots({ lanes, running: [lane("a")], agentLimit: 2 }).mayStart(lane("c"))).toBe(true);
  });

  it("counts an agent one time, so an agent that runs can start another of its lanes", () => {
    const lanes = [lane("a"), lane("a", "task-1"), lane("b")];
    const turnSlots = slots({ lanes, running: [lane("a"), lane("b")], agentLimit: 2 });
    expect(turnSlots.mayStart(lane("a", "task-1"))).toBe(true);
  });

  it("holds by the cap that is reached first: the person's agents or the turns of the memory", () => {
    const lanes = [lane("a"), lane("a", "task-1"), lane("b"), lane("c")];
    // Two turns of one agent fill a memory limit of two, under an agent cap of ten.
    expect(
      slots({ lanes, running: [lane("a"), lane("a", "task-1")], turnLimit: 2, agentLimit: 10 }).mayStart(lane("b")),
    ).toBe(false);
    // One agent fills an agent cap of one, under a memory limit of 64.
    expect(slots({ lanes, running: [lane("a")], turnLimit: 64, agentLimit: 1 }).mayStart(lane("b"))).toBe(false);
    expect(slots({ lanes, running: [], turnLimit: 64, agentLimit: 1 }).mayStart(lane("b"))).toBe(true);
  });

  it("gives the one free place to the agent that waited first", () => {
    const lanes = [lane("a"), lane("b"), lane("c")];
    const createdAt = { [lane("b")]: "2026-10-31T09:00:00.000Z", [lane("c")]: "2026-10-31T10:00:00.000Z" };
    const turnSlots = slots({ lanes, running: [lane("a")], waiting: [lane("b"), lane("c")], agentLimit: 2, createdAt });
    expect(turnSlots.mayStart(lane("b"))).toBe(true);
    expect(turnSlots.mayStart(lane("c"))).toBe(false);
  });
});
