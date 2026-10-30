import type { LoadSnapshot } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  formatGigabytes,
  loadLaneRows,
  loadMemoryPercent,
  loadTone,
  withChannelFirst,
} from "../../../../../packages/ui/src/features/window/load-view";

function snapshot(overrides: Partial<LoadSnapshot> = {}): LoadSnapshot {
  return {
    sampledAt: "2026-10-30T20:00:00.000Z",
    memory: { usedMb: 8192, agentsMb: 6000, totalMb: 32768 },
    activeAgents: 2,
    providerProcesses: 40,
    lane: { enabled: true, order: ["b", "a"], running: ["a"], queued: ["b", "c"] },
    ...overrides,
  };
}

describe("the load ring", () => {
  it("reads the share of memory in use", () => {
    expect(loadMemoryPercent(snapshot())).toBe(25);
  });

  it("has no share before the first sample, and keeps it between 0 and 100", () => {
    expect(loadMemoryPercent(snapshot({ memory: { usedMb: null, agentsMb: null, totalMb: 32768 } }))).toBeNull();
    expect(loadMemoryPercent(snapshot({ memory: { usedMb: 99999, agentsMb: 0, totalMb: 32768 } }))).toBe(100);
    expect(loadMemoryPercent(snapshot({ memory: { usedMb: 10, agentsMb: 0, totalMb: 0 } }))).toBeNull();
  });

  it("turns amber at 60% and red at 80%", () => {
    expect(loadTone(null)).toBe("ok");
    expect(loadTone(59)).toBe("ok");
    expect(loadTone(60)).toBe("warning");
    expect(loadTone(79)).toBe("warning");
    expect(loadTone(80)).toBe("critical");
  });

  it("writes memory short", () => {
    expect(formatGigabytes(512)).toBe("0.5 GB");
    expect(formatGigabytes(7625)).toBe("7.4 GB");
    expect(formatGigabytes(32768)).toBe("32 GB");
  });
});

describe("the channel lane in the panel", () => {
  it("lists the channels that run before the ones that wait, with a place for each waiting one", () => {
    expect(loadLaneRows(snapshot())).toEqual([
      { id: "a", status: "running" },
      { id: "b", status: "queued", position: 1 },
      { id: "c", status: "queued", position: 2 },
    ]);
  });

  it("puts a channel first without losing the rest of the order", () => {
    expect(withChannelFirst(snapshot(), "c")).toEqual({ enabled: true, order: ["c", "b", "a"] });
    expect(withChannelFirst(snapshot(), "a")).toEqual({ enabled: true, order: ["a", "b"] });
  });
});
