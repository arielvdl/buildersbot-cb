// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, ChannelTask } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelService } from "../backend/channel-service";
import { MailboxStore } from "../backend/mailbox-store";
import { BuildersBotDatabase } from "../backend/openbot-database";
import { AUTO_OPERATION_PREFIX, CHANNEL_START_FAILED } from "./task-watch";
import { topActiveTask, WorkControl, type WorkControlOptions } from "./work-control";
import type { RunningTurnRecord } from "./work-overview";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const actor = { id: "local", name: "You" };
const agent = (id: string, provider: AgentSummary["provider"], model: string): AgentSummary => ({
  id,
  name: id.toUpperCase(),
  title: id,
  description: "Works in a channel.",
  notifications: true,
  provider,
  model,
  reasoningEffort: "low",
  threadId: null,
  workspacePath: "/tmp",
  preview: "",
  updatedAt: null,
  avatarSeed: id,
  avatarHue: null,
  avatarUrl: null,
});

async function setup(
  options: {
    preference?: { enabled: boolean; intervalMinutes: number; reassign: boolean };
    /** The task reviewer, with no provider events, nobody who waits for the person, and no model. */
    taskWatch?: { enabled: boolean; quietMinutes: number };
    /** What the stopped work page reads and changes besides the channels. */
    page?: Pick<WorkControlOptions, "requestOrigins" | "setAgentModel">;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "work-control-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const mailbox = new MailboxStore(root, root, database);
  await Effect.runPromise(mailbox.initialize());
  const members = [
    agent("alpha", "codex", "m1"),
    agent("beta", "codex", "m1"),
    agent("gamma", "codex", "m2"),
    agent("delta", "claude", "m9"),
  ];
  // What the channels ask the agent service: who has a turn or a queue, who has a spent plan, the lane.
  const busyAgents = new Set<string>();
  const limited = new Set<string>();
  const lane: { enabled: boolean; order: string[] } = { enabled: false, order: [] };
  const channels = new ChannelService(database, mailbox, {
    agents: () => members,
    generate: () => Effect.succeed("{}"),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: (agentId) => busyAgents.has(agentId),
    usageLimited: (agentId) => limited.has(agentId),
    lane: () => lane,
    awaitDrain: () => Effect.void,
    changed: () => {},
    error: () => {},
  });
  await Effect.runPromise(
    channels.command(
      {
        type: "save",
        operationId: "save:c",
        channelId: "c1",
        update: false,
        draft: {
          name: "cadastro",
          title: "",
          instructions: "",
          members: members.map((member) => ({ agentId: member.id })),
          leadAgentId: null,
        },
      },
      actor,
    ),
  );
  // A task of alpha that stopped with a reason: failed, no assignment left.
  await Effect.runPromise(
    channels.command(
      {
        type: "send",
        operationId: "send:one",
        channelId: "c1",
        text: "Fix the form",
        recipientAgentId: "alpha",
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const fail = (error: string | null = "The provider could not start this assignment.") => {
    const channel = channels.store.get("c1");
    channels.store.update(channel, {
      assignments: channels.store.assignments("c1").map((entry) => ({ ...entry, state: "failed" as const })),
      tasks: channels.store.tasks("c1").map((task) => ({ ...task, state: "failed" as const, error })),
    });
  };
  fail();
  const clock = { now: 1_000 };
  const failures: string[] = [];
  const preference = options.preference ?? { enabled: false, intervalMinutes: 30, reassign: false };
  // What `AgentService.runningTurns` gives: the turns that run, in any thread.
  const turns: RunningTurnRecord[] = [];
  // What `AgentService.slotWaitingAgents` gives: the agents whose turn waits for a free place.
  const slotWaiting: string[] = [];
  const agentLimit = { enabled: false, max: 10 };
  // What `AgentService.taskWatchSignals` and the memory of the Mac give the task reviewer.
  const signals = { events: new Map<string, number>(), attention: new Set<string>(), steps: new Set<string>() };
  const memory: { level: "ok" | "low" | "critical" } = { level: "ok" };
  const control = new WorkControl({
    service: {
      listAgents: () => members,
      channels,
      interrupt: () => Effect.void,
      runningTurns: () => turns,
      slotWaitingAgents: () => slotWaiting,
    },
    agentLimit: () => agentLimit,
    channelActor: () => actor,
    preference: () => preference,
    onFailure: (action) => failures.push(action),
    now: () => clock.now,
    ...options.page,
    ...(options.taskWatch
      ? {
          taskWatch: {
            preference: () => options.taskWatch ?? { enabled: false, quietMinutes: 15 },
            signals: (agentId: string) => ({
              lastEventAt: signals.events.get(agentId) ?? null,
              waitsOnPerson: signals.attention.has(agentId),
              stepOpen: signals.steps.has(agentId),
            }),
            memoryLevel: () => memory.level,
            judge: null,
          },
        }
      : {}),
  });
  const taskId = channels.store.tasks("c1")[0]?.id ?? "";
  return {
    control,
    channels,
    clock,
    failures,
    taskId,
    fail,
    turns,
    slotWaiting,
    agentLimit,
    busyAgents,
    limited,
    lane,
    signals,
    memory,
  };
}

/** The thread of alpha in the channel, as the channel makes it when the agent starts there. */
function alphaChannelThread(channels: ChannelService): string {
  const topicId = channels.store.tasks("c1")[0]?.topicId ?? "";
  return channels.store.context("c1", topicId, "alpha").threadId;
}

describe("the agents that run", () => {
  it("counts a channel turn, which never reaches the listeners of the service", async () => {
    const { control, channels, turns } = await setup();
    const channelThread = alphaChannelThread(channels);
    const started = { type: "turn-started" as const, agentId: "alpha", threadId: channelThread, turnId: "turn-1" };
    // The cause of the ring that read 0: `AgentService.#emit` gives a turn event to the channel first and
    // stops it there when the channel takes it, so a count fed by the `event` listeners never saw it.
    expect(channels.event(started)).toBe(true);
    turns.push({ turnId: "turn-1", agentId: "alpha", threadId: channelThread, startedAt: "2026-10-31T10:00:00.000Z" });
    const overview = control.overview();
    expect(overview.activeAgents).toBe(1);
    expect(overview.running).toMatchObject([{ turnId: "turn-1", agentName: "ALPHA", channelName: "cadastro" }]);
  });

  it("counts each agent one time, and reads the turns again on each call, so an ended turn leaves at once", async () => {
    const { control, channels, turns } = await setup();
    const channelThread = alphaChannelThread(channels);
    turns.push(
      { turnId: "a1", agentId: "alpha", threadId: channelThread, startedAt: "2026-10-31T10:00:00.000Z" },
      { turnId: "a2", agentId: "alpha", threadId: "alpha-chat", startedAt: "2026-10-31T10:01:00.000Z" },
      { turnId: "b1", agentId: "beta", threadId: "beta-chat", startedAt: "2026-10-31T10:02:00.000Z" },
    );
    expect(control.overview().activeAgents).toBe(2);
    expect(control.overview().running).toHaveLength(3);
    // A turn that ends leaves the record of the service: no `turn-completed` event has to arrive here.
    turns.splice(0, 3);
    expect(control.overview().activeAgents).toBe(0);
    expect(control.overview().running).toEqual([]);
  });

  it("lists the agents that wait for a place only while the cap is on, by name", async () => {
    const { control, slotWaiting, agentLimit } = await setup();
    slotWaiting.push("beta", "ghost");
    expect(control.overview().waiting).toEqual([]);
    agentLimit.enabled = true;
    agentLimit.max = 2;
    expect(control.overview().agentLimit).toEqual({ enabled: true, max: 2 });
    expect(control.overview().waiting).toEqual([
      { agentId: "beta", agentName: "BETA" },
      { agentId: "ghost", agentName: "ghost" },
    ]);
  });
});

describe("the stopped work", () => {
  it("lists a task that stopped with its channel, tab, request and reason, and the agents that can take it", async () => {
    const { control, taskId } = await setup();
    const [row] = control.overview().stopped;
    expect(row).toMatchObject({
      channelId: "c1",
      channelName: "cadastro",
      // The message went to no tab, so the task is in the first tab, which keeps its name.
      topicName: "Main",
      taskId,
      title: "Fix the form",
      reason: "The provider could not start this assignment.",
      agentName: "ALPHA",
      state: "failed",
      auto: null,
    });
    // The same model first, then the same provider, then another provider; never the owner.
    expect(row?.candidates.map((candidate) => candidate.name)).toEqual(["BETA", "GAMMA", "DELTA"]);
    expect(row?.candidates[0]?.sameModel).toBe(true);
  });

  it("starts a task again, and clears its stop", async () => {
    const { control, channels, taskId } = await setup();
    expect(await control.resumeStopped({ all: true })).toBe(1);
    const task = channels.store.tasks("c1").find((entry) => entry.id === taskId);
    expect(task?.error).toBeNull();
    expect(task?.state).not.toBe("failed");
    expect(control.overview().stopped).toEqual([]);
  });

  it("ignores an id that is not stopped now, so a forged request starts nothing", async () => {
    const { control, channels } = await setup();
    const before = JSON.stringify(channels.store.tasks("c1"));
    expect(await control.resumeStopped({ items: [{ channelId: "c1", taskId: "forged" }] })).toBe(0);
    expect(await control.resumeStopped({ items: [{ channelId: "nope", taskId: "forged" }] })).toBe(0);
    expect(JSON.stringify(channels.store.tasks("c1"))).toBe(before);
  });

  it("gives a task to an agent that the panel offered, and to no other", async () => {
    const { control, channels, taskId } = await setup();
    expect(await control.reassignStopped({ channelId: "c1", taskId, recipientAgentId: "alpha" })).toBe(false);
    expect(await control.reassignStopped({ channelId: "c1", taskId, recipientAgentId: "ghost" })).toBe(false);
    expect(await control.reassignStopped({ channelId: "c1", taskId, recipientAgentId: "beta" })).toBe(true);
    expect(channels.store.tasks("c1").find((entry) => entry.id === taskId)?.ownerAgentId).toBe("beta");
  });

  it("does not list a task that was stopped on purpose, with no reason", async () => {
    const { control, fail } = await setup();
    fail(null);
    expect(control.overview().stopped).toEqual([]);
  });
});

/**
 * Stopped runs written straight into the channel, as many as the owner's profile had: each is a root
 * task of its own request unless `request` repeats one.
 */
function addStopped(
  channels: ChannelService,
  rows: { id: string; owner: string | null; request?: string; state?: ChannelTask["state"]; topicId?: string }[],
): void {
  const base = channels.store.tasks("c1")[0];
  if (!base) throw new Error("The channel has no task to copy.");
  channels.store.update(channels.store.get("c1"), {
    tasks: rows.map(
      (row): ChannelTask => ({
        ...base,
        id: row.id,
        rootTaskId: row.id,
        parentTaskId: null,
        ownerAgentId: row.owner,
        requestMessageId: row.request ?? `request-${row.id}`,
        instruction: `Request ${row.id}`,
        state: row.state ?? "paused",
        error: row.state === "completed" ? null : "This request exceeds the routing context limit.",
        topicId: row.topicId ?? base.topicId,
        revision: 0,
      }),
    ),
  });
}

describe("the stopped work page", () => {
  it("lists every stopped run, past the limit of the panel, with what posted it and what is gone", async () => {
    const { control, channels } = await setup({
      page: {
        requestOrigins: (_channelId, requests) =>
          new Map(
            requests
              .filter((request) => request.startsWith("routine-"))
              .map((request) => [request, { routineName: "slop.cash hourly", exists: request !== "routine-deleted" }]),
          ),
      },
    });
    addStopped(channels, [
      ...Array.from({ length: 60 }, (_, index) => ({ id: `bulk-${index}`, owner: "beta" })),
      // The same routine request, posted again at three starts; one copy completed.
      { id: "dup-done", owner: "beta", request: "routine-hourly", state: "completed" },
      { id: "dup-a", owner: null, request: "routine-hourly" },
      { id: "dup-b", owner: null, request: "routine-hourly" },
      // The same request posted twice, and both stopped: the older one stays, the newer one repeats it.
      { id: "twice-a", owner: null, request: "routine-twice" },
      { id: "twice-b", owner: null, request: "routine-twice" },
      { id: "of-deleted", owner: null, request: "routine-deleted" },
      { id: "of-ghost", owner: "ghost" },
      { id: "of-gone-tab", owner: "beta", topicId: "deleted-tab" },
    ]);
    const list = control.listStopped();
    const overview = control.overview();
    // The panel takes 50 rows and still counts them all: the old ring said 50 for 253.
    expect(overview.stopped).toHaveLength(50);
    expect(overview.stoppedTotal).toBe(68);
    expect(list.total).toBe(68);
    expect(list.items).toHaveLength(68);
    const byId = new Map(list.items.map((item) => [item.taskId, item]));
    expect(byId.get("dup-a")).toMatchObject({
      origin: "routine",
      routineName: "slop.cash hourly",
      orphan: "duplicate",
    });
    expect(byId.get("dup-b")?.orphan).toBe("duplicate");
    expect(byId.get("twice-a")?.orphan).toBeNull();
    expect(byId.get("twice-b")?.orphan).toBe("duplicate");
    expect(byId.get("of-deleted")?.orphan).toBe("routine-deleted");
    expect(byId.get("of-ghost")?.orphan).toBe("agent-deleted");
    expect(byId.get("of-gone-tab")?.orphan).toBe("topic-deleted");
    expect(byId.get("bulk-0")).toMatchObject({ origin: "request", orphan: null, agentId: "beta", agentName: "BETA" });
    expect(list.channels).toEqual([{ id: "c1", memberIds: ["alpha", "beta", "gamma", "delta"] }]);
  });

  it("removes many runs in one write, reports the ones it could not remove, and undoes the removal", async () => {
    const { control, channels, taskId } = await setup();
    addStopped(channels, [
      { id: "r1", owner: "beta" },
      { id: "r2", owner: null },
    ]);
    const before = new Map(channels.store.tasks("c1").map((task) => [task.id, task]));
    const result = await control.bulkStopped({
      action: "remove",
      items: [
        { channelId: "c1", taskId: "r1" },
        { channelId: "c1", taskId: "r2" },
        { channelId: "c1", taskId },
        { channelId: "c1", taskId: "forged" },
      ],
    });
    expect(result.done).toBe(3);
    expect(result.failed).toEqual([{ channelId: "c1", taskId: "forged", reason: "gone" }]);
    expect(result.list.total).toBe(0);
    expect(result.undoId).not.toBeNull();
    expect(channels.store.tasks("c1").filter((task) => task.state === "cancelled")).toHaveLength(3);

    const undone = await control.bulkStopped({ action: "undo", undoId: result.undoId ?? "" });
    expect(undone.done).toBe(3);
    expect(undone.list.total).toBe(3);
    for (const id of ["r1", "r2", taskId]) {
      const task = channels.store.tasks("c1").find((entry) => entry.id === id);
      expect([task?.state, task?.error]).toEqual([before.get(id)?.state, before.get(id)?.error]);
    }
    // An undo works once.
    expect((await control.bulkStopped({ action: "undo", undoId: result.undoId ?? "" })).done).toBe(0);
  });

  it("does not remove a run that has a task that runs", async () => {
    const { control, channels, taskId } = await setup();
    const base = channels.store.tasks("c1")[0];
    if (!base) throw new Error("No task.");
    channels.store.update(channels.store.get("c1"), {
      tasks: [{ ...base, id: "child", parentTaskId: taskId, rootTaskId: taskId, state: "running", error: null }],
    });
    const result = await control.bulkStopped({ action: "remove", items: [{ channelId: "c1", taskId }] });
    expect(result).toMatchObject({ done: 0, failed: [{ taskId, reason: "running" }], undoId: null });
    expect(channels.store.tasks("c1").find((task) => task.id === taskId)?.state).toBe("failed");
  });

  it("gives many runs to one agent, and refuses the rows that agent cannot take", async () => {
    const { control, channels, taskId } = await setup();
    addStopped(channels, [
      { id: "g1", owner: "gamma" },
      { id: "b1", owner: "beta" },
    ]);
    const result = await control.bulkStopped({
      action: "reassign",
      recipientAgentId: "beta",
      items: [
        { channelId: "c1", taskId },
        { channelId: "c1", taskId: "g1" },
        { channelId: "c1", taskId: "b1" },
      ],
    });
    expect(result.done).toBe(2);
    expect(result.failed).toEqual([{ channelId: "c1", taskId: "b1", reason: "not-member" }]);
    const owners = new Map(channels.store.tasks("c1").map((task) => [task.id, task.ownerAgentId]));
    expect([owners.get(taskId), owners.get("g1")]).toEqual(["beta", "beta"]);
    const ghost = await control.bulkStopped({
      action: "reassign",
      recipientAgentId: "ghost",
      items: [{ channelId: "c1", taskId: "b1" }],
    });
    expect(ghost.failed).toEqual([{ channelId: "c1", taskId: "b1", reason: "not-member" }]);
  });

  it("changes the model of each agent that had a row once, and reports the rows with no agent", async () => {
    const changed: string[] = [];
    const { control, channels, taskId } = await setup({
      page: {
        setAgentModel: async (agentId, provider, model) => {
          if (agentId === "gamma") throw new Error("The provider refused the model.");
          changed.push(`${agentId}:${provider}:${model}`);
        },
      },
    });
    addStopped(channels, [
      { id: "a2", owner: "alpha" },
      { id: "g1", owner: "gamma" },
      { id: "none", owner: null },
    ]);
    const result = await control.bulkStopped({
      action: "model",
      provider: "claude",
      model: "claude-opus-5-5",
      items: ["a2", "g1", "none", taskId].map((id) => ({ channelId: "c1", taskId: id })),
    });
    expect(changed).toEqual(["alpha:claude:claude-opus-5-5"]);
    expect(result.done).toBe(2);
    expect(result.agents).toEqual(["ALPHA"]);
    expect(result.failed).toEqual([
      { channelId: "c1", taskId: "none", reason: "no-agent" },
      { channelId: "c1", taskId: "g1", reason: "failed" },
    ]);
  });
});

describe("stopping a run", () => {
  it("stops the run of a channel through the channel", async () => {
    const { control, channels, taskId } = await setup();
    const channel = channels.store.get("c1");
    channels.store.update(channel, {
      tasks: channels.store.tasks("c1").map((task) => ({ ...task, state: "running" as const, error: null })),
    });
    expect(await control.stopWork({ turnId: "t", agentId: "alpha", channelId: "c1", taskId })).toBe(true);
    expect(channels.store.tasks("c1").find((entry) => entry.id === taskId)?.state).toBe("paused");
  });

  it("answers false for a task that does not run", async () => {
    const { control, taskId } = await setup();
    expect(await control.stopWork({ turnId: "t", agentId: "alpha", channelId: "c1", taskId })).toBe(false);
  });

  it("finds the top of a run, not a child", () => {
    const base = {
      channelId: "c",
      topicId: "t",
      ownerAgentId: null,
      requestMessageId: "m",
      instruction: "x",
      attachmentDraftIds: [],
      expectedResult: "",
      sourceMessageIds: [],
      dependencies: [],
      resources: [],
      revision: 0,
      assignmentCount: 0,
      error: null,
    };
    const root = { ...base, id: "root", parentTaskId: null, rootTaskId: "root", state: "running" as const };
    const child = { ...base, id: "child", parentTaskId: "root", rootTaskId: "root", state: "running" as const };
    const done = { ...base, id: "done", parentTaskId: "root", rootTaskId: "root", state: "completed" as const };
    expect(topActiveTask([root, child], "child")).toBe("root");
    expect(topActiveTask([root, child, done], "done")).toBeNull();
    expect(topActiveTask([{ ...root, state: "failed" as const }, child], "child")).toBe("child");
  });
});

describe("the automatic recovery in the app", () => {
  it("starts a stopped task again after the interval, and not before", async () => {
    const { control, clock, channels, taskId } = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: false },
    });
    await control.tick();
    clock.now += 29 * 60_000;
    await control.tick();
    expect(channels.store.tasks("c1").find((entry) => entry.id === taskId)?.state).toBe("failed");
    clock.now += 2 * 60_000;
    await control.tick();
    expect(channels.store.tasks("c1").find((entry) => entry.id === taskId)?.state).not.toBe("failed");
    expect(control.overview().recovery.recent[0]).toMatchObject({ action: "resumed", channelName: "cadastro" });
  });

  it("shows on the row that it waits its turn", async () => {
    const { control } = await setup({ preference: { enabled: true, intervalMinutes: 30, reassign: false } });
    await control.tick();
    expect(control.overview().stopped[0]?.auto).toBe("waiting");
  });
});

describe("the task reviewer in the app", () => {
  const MIN = 60_000;
  const task = (channels: ChannelService, taskId: string) =>
    channels.store.tasks("c1").find((entry) => entry.id === taskId);

  it("takes the failed starts from the automatic recovery, and gives one that fails again to another agent", async () => {
    const { control, clock, channels, taskId, fail } = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: true },
      taskWatch: { enabled: true, quietMinutes: 15 },
    });
    fail(CHANNEL_START_FAILED);
    await control.tick();
    clock.now += 30 * MIN;
    await control.tick();
    expect(task(channels, taskId)?.state).not.toBe("failed");
    expect(control.overview().taskWatch.recent[0]).toMatchObject({ action: "resumed", reason: "start-failed" });
    expect(control.overview().recovery.recent).toEqual([]);
    // The provider fails to start it again: the next try goes to beta, which has the same model.
    fail(CHANNEL_START_FAILED);
    clock.now += 30 * MIN;
    await control.tick();
    expect(task(channels, taskId)?.ownerAgentId).toBe("beta");
    expect(control.overview().taskWatch.recent[0]).toMatchObject({ action: "reassigned", agentName: "BETA" });
  });

  it("leaves the failed starts to the automatic recovery while it is off", async () => {
    const { control, clock, channels, taskId, fail } = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: true },
      taskWatch: { enabled: false, quietMinutes: 15 },
    });
    fail(CHANNEL_START_FAILED);
    await control.tick();
    clock.now += 30 * MIN;
    await control.tick();
    expect(task(channels, taskId)?.state).not.toBe("failed");
    expect(control.overview().recovery.recent[0]).toMatchObject({ action: "resumed" });
    expect(control.overview().taskWatch).toMatchObject({ active: false, recent: [] });
  });

  it("puts a request that waits too long with a free place in the queue again", async () => {
    const { control, clock, channels, taskId } = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: false },
      taskWatch: { enabled: true, quietMinutes: 5 },
    });
    await Effect.runPromise(
      channels.command(
        { type: "resume", operationId: "continue:1", channelId: "c1", taskId, recipientAgentId: null },
        actor,
      ),
    );
    const revision = task(channels, taskId)?.revision ?? 0;
    await control.tick();
    clock.now += 10 * MIN;
    await control.tick();
    expect(task(channels, taskId)?.revision).toBeGreaterThan(revision);
    expect(control.overview().taskWatch.recent[0]).toMatchObject({ action: "resumed", minutes: 10 });
  });

  it.each([
    ["the Stop of the channel", "stop:1"],
    ["a client that names its stop like a stop of the app", `${AUTO_OPERATION_PREFIX}forged`],
  ])(
    "never touches a task that the person stopped with %s, also after the automatic recovery started it again",
    async (_name, stopId) => {
      const { control, clock, channels, taskId } = await setup({
        preference: { enabled: true, intervalMinutes: 30, reassign: false },
        taskWatch: { enabled: true, quietMinutes: 5 },
      });
      const command = (type: "resume" | "stop", operationId: string) =>
        Effect.runPromise(
          channels.command({ type, operationId, channelId: "c1", taskId, recipientAgentId: null }, actor),
        );
      await command("resume", "continue:1");
      await command("stop", stopId);
      expect(task(channels, taskId)?.state).toBe("paused");
      await control.tick();
      clock.now += 30 * MIN;
      await control.tick();
      // The automatic recovery started it again; the reviewer still knows that the person stopped it.
      expect(control.overview().recovery.recent[0]).toMatchObject({ action: "resumed" });
      const revision = task(channels, taskId)?.revision;
      for (let look = 0; look < 12; look += 1) {
        clock.now += 15 * MIN;
        await control.tick();
      }
      expect(task(channels, taskId)?.revision).toBe(revision);
      expect(control.overview().taskWatch.recent).toEqual([]);
    },
  );
});

describe("the holds of the task reviewer, read from the real channels", () => {
  const MIN = 60_000;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  type Context = Awaited<ReturnType<typeof setup>>;
  const watched = () =>
    setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: false },
      taskWatch: { enabled: true, quietMinutes: 15 },
    });
  const taskOf = (context: Context, taskId: string, channelId = "c1") =>
    context.channels.store.tasks(channelId).find((entry) => entry.id === taskId);
  const send = async (context: Context, recipientAgentId: string, text: string, channelId = "c1") => {
    const before = new Set(context.channels.store.tasks(channelId).map((task) => task.id));
    await Effect.runPromise(
      context.channels.command(
        {
          type: "send",
          operationId: `send:${channelId}:${recipientAgentId}:${text}`,
          channelId,
          text,
          recipientAgentId,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    await settle();
    const task = context.channels.store.tasks(channelId).find((entry) => !before.has(entry.id));
    if (!task) throw new Error("The channel made no task.");
    return task;
  };
  /** Puts the stopped task of alpha in the queue with no assignment: the drain would start it now, but no pass runs. */
  const park = async (context: Context) => {
    context.busyAgents.add("alpha");
    await Effect.runPromise(
      context.channels.command(
        {
          type: "resume",
          operationId: "continue:park",
          channelId: "c1",
          taskId: context.taskId,
          recipientAgentId: null,
        },
        actor,
      ),
    );
    await settle();
    context.busyAgents.delete("alpha");
    expect(taskOf(context, context.taskId)?.state).toBe("queued");
    const active = ["queued", "starting", "running"];
    expect(
      context.channels.store
        .assignments("c1")
        .some((entry) => entry.taskId === context.taskId && active.includes(entry.state)),
    ).toBe(false);
  };
  /** Sets a task and its assignment to running, as the turn of its owner does. */
  const runTask = (context: Context, taskId: string, resources: string[] = [], channelId = "c1") => {
    const { store } = context.channels;
    const task = store.tasks(channelId).find((entry) => entry.id === taskId);
    if (!task) throw new Error("The task is missing.");
    store.update(store.get(channelId), {
      tasks: [{ ...task, state: "running" as const, resources }],
      assignments: store
        .assignments(channelId)
        .filter((entry) => entry.taskId === taskId)
        .map((entry) => ({ ...entry, state: "running" as const, turnId: `turn-${taskId}`, resources })),
    });
  };
  const finish = (context: Context, taskId: string, channelId = "c1") => {
    const { store } = context.channels;
    const task = store.tasks(channelId).find((entry) => entry.id === taskId);
    if (!task) throw new Error("The task is missing.");
    store.update(store.get(channelId), {
      tasks: [{ ...task, state: "completed" as const }],
      assignments: store
        .assignments(channelId)
        .filter((entry) => entry.taskId === taskId)
        .map((entry) => ({ ...entry, state: "completed" as const })),
    });
  };
  /** One look `minutes` after the last one. The healthy agents send an event just before it. */
  const look = async (context: Context, minutes: number, healthy: readonly string[] = []) => {
    context.clock.now += minutes * MIN;
    for (const agentId of healthy) context.signals.events.set(agentId, context.clock.now);
    await context.control.tick();
  };
  /**
   * The request waits for an hour and a half while `hold` holds it, and the reviewer does nothing.
   * Freed, it is a parked request: the clock counts from the last look that found the hold, so the
   * reviewer starts it again two thresholds later, and not before.
   */
  const heldThenFreed = async (
    context: Context,
    hold: () => void,
    free: () => void,
    taskId = context.taskId,
    healthy: readonly string[] = [],
  ) => {
    hold();
    const revision = taskOf(context, taskId)?.revision;
    for (let index = 0; index < 6; index += 1) await look(context, 15, healthy);
    expect(taskOf(context, taskId)?.revision).toBe(revision);
    expect(context.control.overview().taskWatch.recent).toEqual([]);
    free();
    await look(context, 15, healthy);
    expect(taskOf(context, taskId)?.revision).toBe(revision);
    expect(context.control.overview().taskWatch.recent.map((event) => event.action)).toEqual(["waited"]);
    await look(context, 15, healthy);
    expect(taskOf(context, taskId)?.revision).toBeGreaterThan(revision ?? 0);
    expect(context.control.overview().taskWatch.recent[0]).toMatchObject({
      action: "resumed",
      reason: "queued",
      minutes: 30,
    });
  };

  it("starts a parked request again, which the drain would start now", async () => {
    const context = await watched();
    await park(context);
    expect(context.channels.queuedHolds().get(context.taskId)).toBeNull();
    const revision = taskOf(context, context.taskId)?.revision ?? 0;
    await context.control.tick();
    await look(context, 15);
    expect(context.control.overview().taskWatch.recent.map((event) => event.action)).toEqual(["waited"]);
    await look(context, 15);
    expect(taskOf(context, context.taskId)?.revision).toBeGreaterThan(revision);
    expect(context.control.overview().taskWatch.recent[0]).toMatchObject({ action: "resumed", minutes: 30 });
  });

  it("leaves a request alone while the cap on agents is reached", async () => {
    const context = await watched();
    await park(context);
    await heldThenFreed(
      context,
      () => {
        context.agentLimit.enabled = true;
        context.agentLimit.max = 1;
        context.turns.push({
          turnId: "g1",
          agentId: "gamma",
          threadId: "gamma-chat",
          startedAt: "2026-10-31T10:00:00.000Z",
        });
      },
      () => {
        context.turns.length = 0;
      },
    );
  });

  it("leaves a request alone while its agent waits for a free place", async () => {
    const context = await watched();
    await park(context);
    await heldThenFreed(
      context,
      () => context.slotWaiting.push("alpha"),
      () => {
        context.slotWaiting.length = 0;
      },
    );
  });

  it("leaves a request alone while its agent waits for the person", async () => {
    const context = await watched();
    await park(context);
    await heldThenFreed(
      context,
      () => context.signals.attention.add("alpha"),
      () => context.signals.attention.clear(),
    );
  });

  it("leaves a request alone while memory is low, and a run while it is critical", async () => {
    const context = await watched();
    await park(context);
    await heldThenFreed(
      context,
      () => {
        context.memory.level = "low";
      },
      () => {
        context.memory.level = "ok";
      },
    );
    const run = await send(context, "beta", "Check the logs");
    runTask(context, run.id);
    context.memory.level = "critical";
    const before = context.control.overview().taskWatch.recent.length;
    // The run of beta sends no event for an hour and a half.
    for (let index = 0; index < 6; index += 1) await look(context, 15);
    expect(taskOf(context, run.id)?.state).toBe("running");
    expect(context.control.overview().taskWatch.recent).toHaveLength(before);
  });

  it("leaves a request alone while a task below it works", async () => {
    const context = await watched();
    await park(context);
    const request = taskOf(context, context.taskId);
    if (!request) throw new Error("The request is missing.");
    const { store } = context.channels;
    const child = { ...request, id: "child-1", parentTaskId: request.id, state: "running" as const };
    await heldThenFreed(
      context,
      () => store.update(store.get("c1"), { tasks: [child] }),
      () => store.update(store.get("c1"), { tasks: [{ ...child, state: "completed" as const }] }),
    );
  });

  it("leaves a request alone while its agent has a spent plan", async () => {
    const context = await watched();
    await park(context);
    await heldThenFreed(
      context,
      () => context.limited.add("alpha"),
      () => context.limited.clear(),
    );
  });

  it("leaves a request alone while its agent runs another turn or has a queue", async () => {
    const context = await watched();
    await park(context);
    await heldThenFreed(
      context,
      () =>
        context.turns.push({
          turnId: "a1",
          agentId: "alpha",
          threadId: "alpha-chat",
          startedAt: "2026-10-31T10:00:00.000Z",
        }),
      () => {
        context.turns.length = 0;
      },
    );
    const second = await watched();
    await park(second);
    await heldThenFreed(
      second,
      () => second.busyAgents.add("alpha"),
      () => second.busyAgents.clear(),
    );
  });

  it("leaves a request alone while the lane runs another channel, not when its channel is next", async () => {
    const context = await watched();
    await Effect.runPromise(
      context.channels.command(
        {
          type: "save",
          operationId: "save:c2",
          channelId: "c2",
          update: false,
          draft: { name: "vendas", title: "", instructions: "", members: [{ agentId: "beta" }], leadAgentId: null },
        },
        actor,
      ),
    );
    const other = await send(context, "beta", "Count the sales", "c2");
    runTask(context, other.id, [], "c2");
    await park(context);
    await heldThenFreed(
      context,
      () => {
        context.lane.enabled = true;
      },
      () => finish(context, other.id, "c2"),
      context.taskId,
      ["beta"],
    );
  });

  it("leaves a request alone while its dependency runs well, and never gives it to the agent that runs it", async () => {
    const context = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: true },
      taskWatch: { enabled: true, quietMinutes: 15 },
    });
    const build = await send(context, "alpha", "Build the release");
    runTask(context, build.id);
    context.busyAgents.add("beta");
    const notes = await send(context, "beta", "Write the notes after the build");
    context.busyAgents.delete("beta");
    const { store } = context.channels;
    store.update(store.get("c1"), { tasks: [{ ...notes, dependencies: [build.id] }] });
    expect(context.channels.queuedHolds().get(notes.id)).toBe("waits");
    for (let index = 0; index < 8; index += 1) await look(context, 31, ["alpha"]);
    expect(context.control.overview().taskWatch.recent).toEqual([]);
    expect(taskOf(context, notes.id)?.ownerAgentId).toBe("beta");
    expect(taskOf(context, notes.id)?.revision).toBe(notes.revision);
  });

  it("leaves a request alone while two runs fill its tab", async () => {
    const context = await watched();
    const first = await send(context, "beta", "Fix the header");
    const second = await send(context, "gamma", "Fix the footer");
    runTask(context, first.id);
    runTask(context, second.id);
    await park(context);
    expect(context.channels.queuedHolds().get(context.taskId)).toBe("waits");
    await heldThenFreed(
      context,
      () => {},
      () => finish(context, first.id),
      context.taskId,
      ["beta", "gamma"],
    );
  });

  it("leaves a request alone while another run holds its browser", async () => {
    const context = await watched();
    const browsing = await send(context, "beta", "Read the dashboard");
    runTask(context, browsing.id, ["browser"]);
    await park(context);
    const { store } = context.channels;
    const request = taskOf(context, context.taskId);
    if (!request) throw new Error("The request is missing.");
    store.update(store.get("c1"), { tasks: [{ ...request, resources: ["browser"] }] });
    expect(context.channels.queuedHolds().get(context.taskId)).toBe("waits");
    await heldThenFreed(
      context,
      () => {},
      () => finish(context, browsing.id),
      context.taskId,
      ["beta"],
    );
  });

  it("does not start a request again the moment the cap lets its turn start", async () => {
    const context = await watched();
    // The drain gave the request its assignment; the turn waits for a free place.
    await Effect.runPromise(
      context.channels.command(
        {
          type: "resume",
          operationId: "continue:slot",
          channelId: "c1",
          taskId: context.taskId,
          recipientAgentId: null,
        },
        actor,
      ),
    );
    await settle();
    expect(context.channels.queuedHolds().get(context.taskId)).toBe("starting");
    context.slotWaiting.push("alpha");
    for (let index = 0; index < 6; index += 1) await look(context, 10);
    context.slotWaiting.length = 0;
    await look(context, 10);
    await look(context, 10);
    expect(context.control.overview().taskWatch.recent).toEqual([]);
    // A start that stays under way for two thresholds is stalled, with no slow band before.
    await look(context, 10);
    expect(context.control.overview().taskWatch.recent[0]).toMatchObject({ action: "resumed", minutes: 30 });
  });

  it("gives a failed start only to a free agent, and else tries the same agent again", async () => {
    const context = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: true },
      taskWatch: { enabled: true, quietMinutes: 15 },
    });
    context.fail(CHANNEL_START_FAILED);
    await context.control.tick();
    await look(context, 30);
    expect(context.control.overview().taskWatch.recent[0]).toMatchObject({ action: "resumed" });
    // Beta, of the same model, runs a long build: gamma, of the same provider, takes the task.
    context.fail(CHANNEL_START_FAILED);
    context.turns.push({ turnId: "b1", agentId: "beta", threadId: "beta-chat", startedAt: "2026-10-31T10:00:00.000Z" });
    await look(context, 30);
    expect(taskOf(context, context.taskId)?.ownerAgentId).toBe("gamma");
    expect(context.control.overview().taskWatch.recent[0]).toMatchObject({ action: "reassigned", agentName: "GAMMA" });
  });

  it("tries a failed start again on its agent when no free agent of the same provider can take it", async () => {
    const context = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: true },
      taskWatch: { enabled: true, quietMinutes: 15 },
    });
    context.fail(CHANNEL_START_FAILED);
    await context.control.tick();
    await look(context, 30);
    context.fail(CHANNEL_START_FAILED);
    context.busyAgents.add("beta");
    context.busyAgents.add("gamma");
    await look(context, 30);
    expect(taskOf(context, context.taskId)?.ownerAgentId).toBe("alpha");
    expect(context.control.overview().taskWatch.recent.map((event) => event.action)).toEqual(["resumed", "resumed"]);
  });

  it("forgets the tries of a task that completed", async () => {
    const context = await watched();
    context.fail(CHANNEL_START_FAILED);
    await context.control.tick();
    expect(context.control.overview().stopped[0]?.auto).toBe("waiting");
    finish(context, context.taskId);
    await look(context, 1);
    context.fail("The provider stopped.");
    expect(context.control.overview().stopped[0]?.auto).toBeNull();
  });
});
