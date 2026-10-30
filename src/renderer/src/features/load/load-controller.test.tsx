import type {
  AutoRecoveryPreference,
  LoadLanePreference,
  LoadSnapshot,
  RunningWork,
  StoppedWork,
} from "@openbot/contracts/ipc";
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
    running: [],
    stopped: [],
    recovery: { enabled: false, intervalMinutes: 30, reassign: false, recent: [] },
  };
}

type Port = ReturnType<Parameters<typeof createLoadController>[0]>;

/** A port whose actions all answer with the same snapshot, unless a test gives its own. */
function fullPort(overrides: Partial<Port> = {}): Port {
  const idle = async () => snapshot();
  return {
    getLoad: idle,
    setLoadLane: idle,
    runChannelNow: idle,
    stopWork: idle,
    resumeStoppedWork: idle,
    reassignStoppedWork: idle,
    setAutoRecovery: idle,
    ...overrides,
  };
}

function mount(port: () => Port, enabled = () => true) {
  let controller: ReturnType<typeof createLoadController> | undefined;
  render(() => {
    controller = createLoadController(port, enabled);
    return null;
  });
  if (!controller) throw new Error("The controller was not created.");
  return controller;
}

const run: RunningWork = {
  turnId: "t1",
  agentId: "writer",
  agentName: "Writer",
  channelId: "c1",
  channelName: "cadastro",
  taskId: "task1",
  title: "Fix the form",
  startedAt: "2026-10-30T20:00:00.000Z",
};

const stopped: StoppedWork = {
  channelId: "c1",
  channelName: "cadastro",
  taskId: "task1",
  title: "Fix the form",
  reason: "The provider could not start this assignment.",
  agentName: "Writer",
  state: "failed",
  candidates: [{ agentId: "qa", name: "QA", sameModel: true }],
  auto: null,
};

describe("the load controller", () => {
  it("reads the load when it starts", async () => {
    const controller = mount(() => fullPort({ getLoad: async () => snapshot({}, 3) }));
    await vi.waitFor(() => expect(controller.snapshot()?.activeAgents).toBe(3));
  });

  it("does not read for a window that is not on this computer", async () => {
    const getLoad = vi.fn(async () => snapshot());
    const controller = mount(
      () => fullPort({ getLoad }),
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
    const controller = mount(() => fullPort({ getLoad }));
    await vi.waitFor(() => expect(controller.snapshot()?.activeAgents).toBe(2));
    fail = true;
    await controller.refresh();
    expect(controller.snapshot()?.activeAgents).toBe(2);
  });

  it("shows the lane the host answers after the user changes it", async () => {
    const setLoadLane = vi.fn(async (preference: LoadLanePreference) => snapshot({ ...preference, queued: ["b"] }));
    const controller = mount(() => fullPort({ setLoadLane }));
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
    const controller = mount(() => fullPort({ getLoad, setLoadLane }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    const slowRead = controller.refresh();
    await controller.setLane({ enabled: true, order: [] });
    releaseRead(snapshot({ enabled: false }));
    await slowRead;

    expect(controller.snapshot()?.lane.enabled).toBe(true);
  });

  it("starts a channel now and shows the answer", async () => {
    const runChannelNow = vi.fn(async () => snapshot({ enabled: true, running: ["a", "b"] }));
    const controller = mount(() => fullPort({ runChannelNow }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    await controller.runNow("b");

    expect(runChannelNow).toHaveBeenCalledWith({ channelId: "b" });
    expect(controller.snapshot()?.lane.running).toEqual(["a", "b"]);
  });
});

describe("the actions on work", () => {
  it("stops a run, naming its turn, channel and task", async () => {
    const stopWork = vi.fn(async () => snapshot());
    const controller = mount(() => fullPort({ stopWork }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    await controller.stop(run);

    expect(stopWork).toHaveBeenCalledWith({ turnId: "t1", agentId: "writer", channelId: "c1", taskId: "task1" });
  });

  it("starts all the stopped work, or one task, again", async () => {
    const resumeStoppedWork = vi.fn(async () => snapshot());
    const controller = mount(() => fullPort({ resumeStoppedWork }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    await controller.resumeAll();
    await controller.resume(stopped);

    expect(resumeStoppedWork).toHaveBeenNthCalledWith(1, { all: true });
    expect(resumeStoppedWork).toHaveBeenNthCalledWith(2, { items: [{ channelId: "c1", taskId: "task1" }] });
  });

  it("gives a task to another agent", async () => {
    const reassignStoppedWork = vi.fn(async () => snapshot());
    const controller = mount(() => fullPort({ reassignStoppedWork }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    await controller.reassign(stopped, "qa");

    expect(reassignStoppedWork).toHaveBeenCalledWith({ channelId: "c1", taskId: "task1", recipientAgentId: "qa" });
  });

  it("shows the answer of the host: the stopped work that is left", async () => {
    const resumeStoppedWork = vi.fn(async () => ({ ...snapshot(), stopped: [] }));
    const controller = mount(() =>
      fullPort({ getLoad: async () => ({ ...snapshot(), stopped: [stopped] }), resumeStoppedWork }),
    );
    await vi.waitFor(() => expect(controller.snapshot()?.stopped).toHaveLength(1));

    await controller.resumeAll();

    expect(controller.snapshot()?.stopped).toEqual([]);
  });

  it("keeps the last reading when an action fails", async () => {
    const stopWork = vi.fn(async () => {
      throw new Error("refused");
    });
    const controller = mount(() => fullPort({ getLoad: async () => snapshot({}, 4), stopWork }));
    await vi.waitFor(() => expect(controller.snapshot()?.activeAgents).toBe(4));

    await expect(controller.stop(run)).resolves.toBeUndefined();

    expect(controller.snapshot()?.activeAgents).toBe(4);
  });

  it("shows the recovery switch at once, and the answer of the host after it", async () => {
    const setAutoRecovery = vi.fn(async (preference: AutoRecoveryPreference) => ({
      ...snapshot(),
      recovery: { ...preference, recent: [] },
    }));
    const controller = mount(() => fullPort({ setAutoRecovery }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());

    await controller.setRecovery({ enabled: true, intervalMinutes: 45, reassign: true });

    expect(setAutoRecovery).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 45, reassign: true });
    expect(controller.snapshot()?.recovery).toMatchObject({ enabled: true, intervalMinutes: 45, reassign: true });
  });

  it("reads again when the host refuses the recovery change", async () => {
    const getLoad = vi.fn(async () => snapshot());
    const setAutoRecovery = vi.fn(async () => snapshot());
    const controller = mount(() => fullPort({ getLoad, setAutoRecovery }));
    await vi.waitFor(() => expect(controller.snapshot()).not.toBeNull());
    getLoad.mockClear();

    await controller.setRecovery({ enabled: true, intervalMinutes: 30, reassign: false });

    expect(getLoad).toHaveBeenCalled();
    expect(controller.snapshot()?.recovery.enabled).toBe(false);
  });
});
