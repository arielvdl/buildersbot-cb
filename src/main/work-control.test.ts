// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelService } from "../backend/channel-service";
import { MailboxStore } from "../backend/mailbox-store";
import { BuildersBotDatabase } from "../backend/openbot-database";
import { CHANNEL_START_FAILED } from "./task-watch";
import { topActiveTask, WorkControl } from "./work-control";
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
  const channels = new ChannelService(database, mailbox, {
    agents: () => members,
    generate: () => Effect.succeed("{}"),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: () => false,
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
    ...(options.taskWatch
      ? {
          taskWatch: {
            preference: () => options.taskWatch ?? { enabled: false, quietMinutes: 15 },
            signals: () => ({ lastEventAt: null, waitsOnPerson: false }),
            memoryLevel: () => "ok" as const,
            judge: null,
          },
        }
      : {}),
  });
  const taskId = channels.store.tasks("c1")[0]?.id ?? "";
  return { control, channels, clock, failures, taskId, fail, turns, slotWaiting, agentLimit };
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

  it("never touches a task that the person stopped, also after the automatic recovery started it again", async () => {
    const { control, clock, channels, taskId } = await setup({
      preference: { enabled: true, intervalMinutes: 30, reassign: false },
      taskWatch: { enabled: true, quietMinutes: 5 },
    });
    const command = (type: "resume" | "stop", operationId: string) =>
      Effect.runPromise(
        channels.command({ type, operationId, channelId: "c1", taskId, recipientAgentId: null }, actor),
      );
    await command("resume", "continue:1");
    await command("stop", "stop:1");
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
  });
});
