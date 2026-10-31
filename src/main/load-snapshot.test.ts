// @vitest-environment node
import { isLoadSnapshot } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { buildLoadSnapshot } from "./load-snapshot";

const NO_WORK = {
  running: [],
  activeAgents: 3,
  waiting: [],
  agentLimit: { enabled: false, max: 10 },
  stopped: [],
  recovery: { enabled: false, intervalMinutes: 30, reassign: false, recent: [] },
  taskWatch: { enabled: false, quietMinutes: 15, active: false, modelReady: false, recent: [] },
};

const reading = {
  sampledAt: "2026-10-30T20:00:00.000Z",
  usedMb: 7600,
  agentsMb: 6600,
  totalMb: 32768,
  providerProcesses: 90,
  pressure: null,
};

describe("the load snapshot", () => {
  it("passes the reading and the lane on, as a value the contract accepts", () => {
    const snapshot = buildLoadSnapshot(
      reading,
      { enabled: true, order: ["b"], running: ["a"], queued: ["b"] },
      new Set(["a", "b"]),
      NO_WORK,
    );
    expect(isLoadSnapshot(snapshot)).toBe(true);
    expect(snapshot.lane).toEqual({ enabled: true, order: ["b"], running: ["a"], queued: ["b"] });
    expect(snapshot.memory).toEqual({ usedMb: 7600, agentsMb: 6600, totalMb: 32768 });
    // The count comes with the running work, not with the memory sample.
    expect(snapshot.activeAgents).toBe(3);
  });

  it("drops a channel that no longer exists from the order and the lists", () => {
    const snapshot = buildLoadSnapshot(
      reading,
      { enabled: true, order: ["gone", "b"], running: ["gone"], queued: ["b", "gone"] },
      new Set(["b"]),
      NO_WORK,
    );
    expect(snapshot.lane).toEqual({ enabled: true, order: ["b"], running: [], queued: ["b"] });
  });

  it("is valid before the first memory sample", () => {
    const snapshot = buildLoadSnapshot(
      { ...reading, sampledAt: null, usedMb: null, agentsMb: null, pressure: null },
      { enabled: false, order: [], running: [], queued: [] },
      new Set(),
      NO_WORK,
    );
    expect(isLoadSnapshot(snapshot)).toBe(true);
  });
});
