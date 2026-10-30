import type { LoadLanePreference, LoadSnapshot } from "@openbot/contracts/ipc";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { createLoadController } from "./load-controller";

function snapshot(overrides: Partial<LoadSnapshot["lane"]> = {}, activeAgents = 1): LoadSnapshot {
  return {
    sampledAt: "2026-10-30T20:00:00.000Z",
    memory: { usedMb: 4096, agentsMb: 3000, totalMb: 16384 },
    activeAgents,
    providerProcesses: 10,
    lane: { enabled: false, order: [], running: [], queued: [], ...overrides },
  };
}

function mount(port: Parameters<typeof createLoadController>[0], enabled = () => true) {
  let controller: ReturnType<typeof createLoadController> | undefined;
  render(() => {
    controller = createLoadController(port, enabled);
    return null;
  });
  if (!controller) throw new Error("The controller was not created.");
  return controller;
}

describe("the load controller", () => {
  it("reads the load when it starts", async () => {
    const getLoad = vi.fn(async () => snapshot({}, 3));
    const controller = mount(() => ({ getLoad, setLoadLane: vi.fn(), runChannelNow: vi.fn() }));
    await vi.waitFor(() => expect(controller.snapshot()?.activeAgents).toBe(3));
  });

  it("does not read for a window that is not on this computer", async () => {
    const getLoad = vi.fn(async () => snapshot());
    const controller = mount(
      () => ({ getLoad, setLoadLane: vi.fn(), runChannelNow: vi.fn() }),
      () => false,
    );
    await controller.refresh();
    expect(getLoad).not.toHaveBeenCalled();
    expect(controller.snapshot()).toBeNull();
  });

  it("keeps the last reading when a read fails", async () => {
    let fail = false;
    const getLoad = vi.fn(async () => {
      if (fail) throw new Error("slow");
      return snapshot({}, 2);
    });
    const controller = mount(() => ({ getLoad, setLoadLane: vi.fn(), runChannelNow: vi.fn() }));
    await vi.waitFor(() => expect(controller.snapshot()?.activeAgents).toBe(2));
    fail = true;
    await controller.refresh();
    expect(controller.snapshot()?.activeAgents).toBe(2);
  });

  it("shows the lane the host answers after the user changes it", async () => {
    const setLoadLane = vi.fn(async (preference: LoadLanePreference) => snapshot({ ...preference, queued: ["b"] }));
    const controller = mount(() => ({ getLoad: async () => snapshot(), setLoadLane, runChannelNow: vi.fn() }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    await controller.setLane({ enabled: true, order: ["b"] });

    expect(setLoadLane).toHaveBeenCalledWith({ enabled: true, order: ["b"] });
    expect(controller.snapshot()?.lane).toMatchObject({ enabled: true, order: ["b"], queued: ["b"] });
  });

  it("ignores a read that answers after a newer change", async () => {
    let releaseRead: (value: LoadSnapshot) => void = () => {};
    let reads = 0;
    const getLoad = vi.fn(() => {
      reads += 1;
      // The first read is quick; the second stays open until the test lets it answer.
      return reads === 1
        ? Promise.resolve(snapshot())
        : new Promise<LoadSnapshot>((resolve) => (releaseRead = resolve));
    });
    const setLoadLane = vi.fn(async (preference: LoadLanePreference) => snapshot({ ...preference }));
    const controller = mount(() => ({ getLoad, setLoadLane, runChannelNow: vi.fn() }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    const slowRead = controller.refresh();
    await controller.setLane({ enabled: true, order: [] });
    releaseRead(snapshot({ enabled: false }));
    await slowRead;

    expect(controller.snapshot()?.lane.enabled).toBe(true);
  });

  it("starts a channel now and shows the answer", async () => {
    const runChannelNow = vi.fn(async () => snapshot({ enabled: true, running: ["a", "b"] }));
    const controller = mount(() => ({ getLoad: async () => snapshot(), setLoadLane: vi.fn(), runChannelNow }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    await controller.runNow("b");

    expect(runChannelNow).toHaveBeenCalledWith({ channelId: "b" });
    expect(controller.snapshot()?.lane.running).toEqual(["a", "b"]);
  });
});
