// @vitest-environment node
import { describe, expect, it } from "vitest";
import { OpenWorkSteps } from "./open-work-steps";

const running = (...turnIds: string[]) => {
  const turns = new Set(turnIds);
  return (turnId: string) => turns.has(turnId);
};

describe("the open work steps of running turns", () => {
  it("holds a command from its start to its end", () => {
    const steps = new OpenWorkSteps();
    steps.observe("started", "alpha", "turn-1", { id: "cmd-1", type: "commandExecution" });
    expect(steps.has("alpha", running("turn-1"))).toBe(true);
    expect(steps.has("beta", running("turn-1"))).toBe(false);
    steps.observe("completed", "alpha", "turn-1", { id: "cmd-1", type: "commandExecution" });
    expect(steps.has("alpha", running("turn-1"))).toBe(false);
  });

  it("does not count text: a message or a reasoning that stops is a stall", () => {
    const steps = new OpenWorkSteps();
    for (const type of ["agentMessage", "reasoning", "userMessage", undefined])
      steps.observe("started", "alpha", "turn-1", { id: `item-${String(type)}`, type });
    expect(steps.has("alpha", running("turn-1"))).toBe(false);
  });

  it("ends the steps of a turn that ended, also the ones that the provider did not close", () => {
    const steps = new OpenWorkSteps();
    steps.observe("started", "alpha", "turn-1", { id: "cmd-1", type: "commandExecution" });
    steps.observe("started", "alpha", "turn-2", { id: "tool-2", type: "mcpToolCall" });
    steps.endTurn("turn-1");
    expect(steps.has("alpha", running("turn-1"))).toBe(false);
    expect(steps.has("alpha", running("turn-2"))).toBe(true);
    steps.forgetAgent("alpha");
    expect(steps.has("alpha", running("turn-2"))).toBe(false);
  });

  it("does not count a step of a turn that no longer runs", () => {
    const steps = new OpenWorkSteps();
    steps.observe("started", "alpha", "turn-1", { id: "cmd-1", type: "commandExecution" });
    expect(steps.has("alpha", running())).toBe(false);
  });
});
