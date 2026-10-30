import type { ChannelTask, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { parseResumeInterruptedWorkInput } from "./ipc/app-inputs";
import {
  ResumeOffer,
  type ResumeOfferActions,
  type ResumeOfferReader,
  ResumeWorkFailed,
  type StartedDelivery,
  startedDeliveries,
} from "./resume-offer";

type AssignmentState = "queued" | "starting" | "running" | "completed" | "failed" | "interrupted";

function task(id: string, overrides: Partial<ChannelTask> = {}): ChannelTask {
  return {
    id,
    channelId: "c1",
    parentTaskId: null,
    rootTaskId: id,
    ownerAgentId: "a1",
    requestMessageId: `request-${id}`,
    instruction: "",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: "paused",
    revision: 1,
    assignmentCount: 1,
    error: "The previous turn has no confirmed result. Check its work before you resume.",
    ...overrides,
  };
}

/** A database after a restart, as the boot recovery leaves it. Each field can change during a test. */
function world() {
  const deliveries = new Map<string, QueueDeliveryStatus>();
  const assignments = new Map<string, { channelId: string; taskId: string; state: AssignmentState }>();
  const agents = [
    { id: "a1", name: "Nova" },
    { id: "a2", name: "Atlas" },
  ];
  const channels = new Map<string, { name: string; archived: boolean; tasks: ChannelTask[] }>();
  const reader: ResumeOfferReader = {
    deliveryStatus: (id) => deliveries.get(id) ?? null,
    assignment: (id) => assignments.get(id) ?? null,
    agents: () => agents,
    channel: (id) => channels.get(id) ?? null,
  };
  return { deliveries, assignments, agents, channels, reader };
}

function recordingActions(failing: ReadonlySet<string> = new Set()) {
  const continueAgent = vi.fn((agentId: string, _clientMessageId: string) =>
    failing.has(agentId) ? Effect.fail(new ResumeWorkFailed({ cause: new Error("refused") })) : Effect.void,
  );
  const resumeChannelTask = vi.fn((channelId: string, _taskId: string, _operationId: string) =>
    failing.has(channelId) ? Effect.fail(new ResumeWorkFailed({ cause: new Error("refused") })) : Effect.void,
  );
  const actions: ResumeOfferActions = { continueAgent, resumeChannelTask };
  return { actions, continueAgent, resumeChannelTask };
}

const chat = (id: string, agentId: string): StartedDelivery => ({ id, agentId, place: "chat" });
const inChannel = (id: string, agentId: string): StartedDelivery => ({ id, agentId, place: "channel" });

/** One agent chat and one channel task that the restart stopped. */
function stoppedWork() {
  const state = world();
  state.deliveries.set("d1", "interrupted");
  state.deliveries.set("d2", "interrupted");
  state.assignments.set("d2", { channelId: "c1", taskId: "t1", state: "interrupted" });
  state.channels.set("c1", { name: "Launch", archived: false, tasks: [task("t1")] });
  return state;
}

function offerFor(state: ReturnType<typeof world>, started: StartedDelivery[], actions = recordingActions().actions) {
  return new ResumeOffer({ started, reader: state.reader, actions, sessionId: "s1" });
}

const read = (offer: ResumeOffer) => Effect.runPromise(offer.current());

describe("the work that a restart stopped", () => {
  it("keeps only the work of an agent's own chat and of a channel", () => {
    const sender = { kind: "user" };
    const started = startedDeliveries(
      [
        { delivery: { id: "d1", recipientAgentId: "a1", sender } },
        { delivery: { id: "d2", recipientAgentId: "a1", sender }, channelId: "c1" },
        { delivery: { id: "d3", recipientAgentId: "a1", sender } },
        { delivery: { id: "d4", recipientAgentId: "a1", sender } },
        { delivery: { id: "d5", recipientAgentId: "a1", sender: { kind: "routine" } } },
        { delivery: { id: "d6", recipientAgentId: "a2", sender: { kind: "agent" } } },
      ],
      { taskId: (id) => (id === "d3" ? "task-1" : null), external: (id) => id === "d4" },
    );
    expect(started).toEqual([
      { id: "d1", agentId: "a1", place: "chat" },
      { id: "d2", agentId: "a1", place: "channel" },
      { id: "d3", agentId: "a1", place: "other" },
      { id: "d4", agentId: "a1", place: "other" },
      { id: "d5", agentId: "a1", place: "other" },
      { id: "d6", agentId: "a2", place: "other" },
    ]);
  });

  it("waits until the recovery settles each started delivery and channel task", async () => {
    const state = world();
    state.deliveries.set("d1", "running");
    state.deliveries.set("d2", "starting");
    state.assignments.set("d2", { channelId: "c1", taskId: "t1", state: "running" });
    state.channels.set("c1", {
      name: "Launch",
      archived: false,
      tasks: [task("t1", { state: "running", error: null })],
    });
    const offer = offerFor(state, [chat("d1", "a1"), inChannel("d2", "a2")]);
    expect(offer.pending).toBe(true);

    // The delivery is settled, but `ChannelService.recover` has not stopped the task yet.
    state.deliveries.set("d1", "interrupted");
    state.deliveries.set("d2", "interrupted");
    offer.refresh();
    expect(offer.pending).toBe(true);

    state.assignments.set("d2", { channelId: "c1", taskId: "t1", state: "interrupted" });
    state.channels.set("c1", { name: "Launch", archived: false, tasks: [task("t1")] });
    offer.refresh();
    expect(offer.pending).toBe(false);
    expect(await read(offer)).toEqual({
      channels: [{ id: "c1", name: "Launch", stoppedTasks: 1 }],
      agents: [{ id: "a1", name: "Nova" }],
    });
  });

  it("offers agents only", async () => {
    const state = world();
    state.deliveries.set("d1", "interrupted");
    state.deliveries.set("d2", "interrupted");
    // Two deliveries that ran in one turn are one entry.
    expect(await read(offerFor(state, [chat("d1", "a1"), chat("d2", "a1")]))).toEqual({
      channels: [],
      agents: [{ id: "a1", name: "Nova" }],
    });
  });

  it("offers channels only, with one entry for each stopped run", async () => {
    const state = world();
    for (const id of ["d1", "d2", "d3"]) state.deliveries.set(id, "interrupted");
    state.assignments.set("d1", { channelId: "c1", taskId: "t1", state: "interrupted" });
    state.assignments.set("d2", { channelId: "c1", taskId: "t2", state: "interrupted" });
    state.assignments.set("d3", { channelId: "c1", taskId: "t3", state: "interrupted" });
    state.channels.set("c1", {
      name: "Launch",
      archived: false,
      tasks: [task("t1"), task("t2", { parentTaskId: "t1", rootTaskId: "t1" }), task("t3")],
    });
    expect(await read(offerFor(state, [inChannel("d1", "a1"), inChannel("d2", "a2"), inChannel("d3", "a1")]))).toEqual({
      channels: [{ id: "c1", name: "Launch", stoppedTasks: 2 }],
      agents: [],
    });
  });

  it("offers channels and agents together", async () => {
    const state = stoppedWork();
    expect(await read(offerFor(state, [chat("d1", "a1"), inChannel("d2", "a2")]))).toEqual({
      channels: [{ id: "c1", name: "Launch", stoppedTasks: 1 }],
      agents: [{ id: "a1", name: "Nova" }],
    });
  });

  it("offers nothing when no work had started", async () => {
    const offer = offerFor(world(), []);
    expect(offer.pending).toBe(false);
    expect(await read(offer)).toBeNull();
  });

  it("offers nothing for work that the provider says is complete", async () => {
    const state = world();
    state.deliveries.set("d1", "completed");
    state.deliveries.set("d2", "completed");
    state.assignments.set("d2", { channelId: "c1", taskId: "t1", state: "completed" });
    state.channels.set("c1", { name: "Launch", archived: false, tasks: [task("t1", { state: "completed" })] });
    expect(await read(offerFor(state, [chat("d1", "a1"), inChannel("d2", "a1")]))).toBeNull();
  });

  it("drops a deleted or hidden agent, and a deleted or archived channel", async () => {
    const state = world();
    for (const id of ["d1", "d2", "d3", "d4"]) state.deliveries.set(id, "interrupted");
    state.assignments.set("d3", { channelId: "gone", taskId: "t1", state: "interrupted" });
    state.assignments.set("d4", { channelId: "c2", taskId: "t1", state: "interrupted" });
    state.channels.set("c2", { name: "Archive", archived: true, tasks: [task("t1")] });
    // `agents()` lists only the agents that the user can see, so `a9` stands for a deleted or hidden one.
    const offer = offerFor(state, [chat("d1", "a9"), chat("d2", "a2"), inChannel("d3", "a1"), inChannel("d4", "a1")]);
    expect(await read(offer)).toEqual({ channels: [], agents: [{ id: "a2", name: "Atlas" }] });
  });

  it("ignores work outside an agent's own chat and outside channels", async () => {
    const state = world();
    state.deliveries.set("d1", "interrupted");
    expect(await read(offerFor(state, [{ id: "d1", agentId: "a1", place: "other" }]))).toBeNull();
  });
});

describe("resuming the work that a restart stopped", () => {
  it("sends one continue request for each agent and one resume for each stopped run", async () => {
    const state = stoppedWork();
    const recorded = recordingActions();
    const offer = offerFor(state, [chat("d1", "a1"), inChannel("d2", "a2")], recorded.actions);

    expect(await Effect.runPromise(offer.resume({ all: true }))).toEqual({ offer: null, failed: 0 });

    expect(recorded.continueAgent).toHaveBeenCalledTimes(1);
    expect(recorded.continueAgent.mock.calls[0]?.[0]).toBe("a1");
    expect(recorded.resumeChannelTask).toHaveBeenCalledTimes(1);
    expect(recorded.resumeChannelTask.mock.calls[0]?.slice(0, 2)).toEqual(["c1", "t1"]);
    expect(await read(offer)).toBeNull();
  });

  it("resumes only the selected channels", async () => {
    const recorded = recordingActions();
    const offer = offerFor(stoppedWork(), [chat("d1", "a1"), inChannel("d2", "a2")], recorded.actions);

    expect(await Effect.runPromise(offer.resume({ channelIds: ["c1"], agentIds: [] }))).toEqual({
      offer: null,
      failed: 0,
    });
    expect(recorded.resumeChannelTask).toHaveBeenCalledTimes(1);
    expect(recorded.continueAgent).not.toHaveBeenCalled();
  });

  it("resumes only the selected agents", async () => {
    const recorded = recordingActions();
    const offer = offerFor(stoppedWork(), [chat("d1", "a1"), inChannel("d2", "a2")], recorded.actions);

    await Effect.runPromise(offer.resume({ channelIds: [], agentIds: ["a1"] }));
    expect(recorded.continueAgent).toHaveBeenCalledTimes(1);
    expect(recorded.resumeChannelTask).not.toHaveBeenCalled();
  });

  it("ignores an id that the offer does not hold", async () => {
    const recorded = recordingActions();
    const offer = offerFor(stoppedWork(), [chat("d1", "a1"), inChannel("d2", "a2")], recorded.actions);

    await Effect.runPromise(offer.resume({ channelIds: ["c9"], agentIds: ["a2"] }));
    expect(recorded.continueAgent).not.toHaveBeenCalled();
    expect(recorded.resumeChannelTask).not.toHaveBeenCalled();
  });

  it("sends nothing twice when the user clicks twice", async () => {
    const recorded = recordingActions();
    const offer = offerFor(stoppedWork(), [chat("d1", "a1"), inChannel("d2", "a2")], recorded.actions);

    await Effect.runPromise(
      Effect.all([offer.resume({ all: true }), offer.resume({ all: true })], { concurrency: "unbounded" }),
    );
    expect(recorded.continueAgent).toHaveBeenCalledTimes(1);
    expect(recorded.resumeChannelTask).toHaveBeenCalledTimes(1);
  });

  it("keeps the work whose request failed, so the user can try again", async () => {
    const recorded = recordingActions(new Set(["a1"]));
    const offer = offerFor(stoppedWork(), [chat("d1", "a1"), inChannel("d2", "a2")], recorded.actions);

    expect(await Effect.runPromise(offer.resume({ all: true }))).toEqual({
      offer: { channels: [], agents: [{ id: "a1", name: "Nova" }] },
      failed: 1,
    });
    // The retry uses the same request id, so a request that did arrive is not stored twice.
    await Effect.runPromise(offer.resume({ all: true }));
    expect(recorded.continueAgent.mock.calls[1]?.[1]).toBe(recorded.continueAgent.mock.calls[0]?.[1]);
  });

  it("does not resume a task that started again before the click", async () => {
    const state = stoppedWork();
    const recorded = recordingActions();
    const offer = offerFor(state, [inChannel("d2", "a2")], recorded.actions);
    await read(offer);
    // The user pressed Continue in the channel before the modal: the task runs again.
    state.channels.set("c1", {
      name: "Launch",
      archived: false,
      tasks: [task("t1", { state: "running", error: null })],
    });

    expect(await Effect.runPromise(offer.resume({ all: true }))).toEqual({ offer: null, failed: 0 });
    expect(recorded.resumeChannelTask).not.toHaveBeenCalled();
  });

  it("sends nothing after Not now", async () => {
    const recorded = recordingActions();
    const offer = offerFor(stoppedWork(), [chat("d1", "a1"), inChannel("d2", "a2")], recorded.actions);
    offer.dismiss();

    expect(await read(offer)).toBeNull();
    expect(await Effect.runPromise(offer.resume({ all: true }))).toEqual({ offer: null, failed: 0 });
    expect(recorded.continueAgent).not.toHaveBeenCalled();
    expect(recorded.resumeChannelTask).not.toHaveBeenCalled();
  });
});

describe("the resume choice from the window", () => {
  it("accepts all, or bounded lists of identifiers", () => {
    expect(parseResumeInterruptedWorkInput({ all: true })).toEqual({ all: true });
    expect(parseResumeInterruptedWorkInput({ channelIds: ["c1", "c1"], agentIds: [] })).toEqual({
      channelIds: ["c1"],
      agentIds: [],
    });
  });

  it.each([
    null,
    { all: false },
    { all: true, channelIds: [] },
    { channelIds: ["c1"] },
    { channelIds: [""], agentIds: [] },
    { channelIds: [1], agentIds: [] },
    { channelIds: Array.from({ length: 201 }, (_, index) => `c${index}`), agentIds: [] },
  ])("refuses %j", (input) => {
    expect(() => parseResumeInterruptedWorkInput(input)).toThrow();
  });
});
