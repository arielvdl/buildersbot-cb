// @vitest-environment node
// Stopped work of a channel routine that stayed stopped for ever. The owner's load panel listed 253
// stopped runs: 247 were the hourly request of one routine, posted again as a new task at each start
// of the app (the receipt of the request was pruned with the older channel events), and a deleted
// routine left each stopped task it had posted. These tests drive the real channel service and
// routine scheduler on a database of their own.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, ChannelTask } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelRoutineScheduler } from "./channel-routine-scheduler";
import { ChannelService } from "./channel-service";
import { MailboxStore } from "./mailbox-store";
import { BuildersBotDatabase } from "./openbot-database";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const actor = { id: "local", name: "You" };
const agent = (id: string): AgentSummary => ({
  id,
  name: id.toUpperCase(),
  title: id,
  description: "Works in a channel.",
  notifications: true,
  provider: "codex",
  model: "m1",
  reasoningEffort: "low",
  threadId: null,
  workspacePath: "/tmp",
  preview: "",
  updatedAt: null,
  avatarSeed: id,
  avatarHue: null,
  avatarUrl: null,
});

/** Waits for a state of the channel that the pump writes after a request. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The channel did not reach the expected state.");
}

/**
 * A channel of two members with no lead: the lead routes a request that names no member, so each
 * request of a routine stops at once with a reason, as the routine of the owner's channel did.
 */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "routine-stopped-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const mailbox = new MailboxStore(root, root, database);
  await Effect.runPromise(mailbox.initialize());
  const members = [agent("alpha"), agent("beta")];
  const changed: string[] = [];
  let scheduler: ChannelRoutineScheduler | null = null;
  const channels = new ChannelService(database, mailbox, {
    agents: () => members,
    generate: () => Effect.succeed("{}"),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: () => false,
    lane: () => ({ enabled: false, order: [] }),
    awaitDrain: () => Effect.void,
    changed: (channelId) => {
      changed.push(channelId);
      scheduler?.reconcile(channelId);
    },
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
          name: "slop rotina",
          title: "",
          instructions: "",
          members: members.map((member) => ({ agentId: member.id })),
          leadAgentId: null,
        },
      },
      actor,
    ),
  );
  scheduler = new ChannelRoutineScheduler({
    channels,
    hooks: {
      changed: () => {},
      emitError: () => {},
      excludedChannels: () => new Set(),
      usageLimited: () => false,
    },
  });
  const routine = scheduler.create({
    channelId: "c1",
    name: "slop.cash hourly",
    instruction: "Review the campaign.",
    active: true,
    timezone: "UTC",
    schedule: { kind: "hourly", minute: 7 },
  });
  const stopped = (): ChannelTask[] =>
    channels.store.tasks("c1").filter((task) => (task.state === "paused" || task.state === "failed") && task.error);
  return { database, channels, scheduler, routine, stopped };
}

describe("the stopped work of a channel routine", () => {
  it("leaves with the routine when the routine is deleted", async () => {
    const { channels, scheduler, routine, stopped } = await setup();
    const run = await Effect.runPromise(scheduler.test({ channelId: "c1", routineId: routine.id }));
    await until(() => stopped().length === 1);
    expect(stopped()[0]?.requestMessageId).toBe(run.requestMessageId);

    scheduler.delete({ channelId: "c1", routineId: routine.id });

    // Before the fix the task stayed paused for ever, so the load page listed it after the delete.
    expect(stopped()).toEqual([]);
    const task = channels.store.tasks("c1").find((entry) => entry.requestMessageId === run.requestMessageId);
    expect(task?.state).toBe("cancelled");
  });

  it("posts a request again only when it did not reach the channel, also with its receipt pruned", async () => {
    const { database, channels, scheduler, routine, stopped } = await setup();
    const run = await Effect.runPromise(scheduler.test({ channelId: "c1", routineId: routine.id }));
    await until(() => stopped().length === 1);
    // What `pruneChannelEvents` does to an older request: its receipt goes with its event.
    database.connection
      .prepare("DELETE FROM orchestration_command_receipts WHERE command_id LIKE ?")
      .run(`channels:routine:${routine.id}:%`);
    // The run stays open while the receipt is gone, as the 22 runs of the owner's routine did.
    database.connection
      .prepare("UPDATE projection_channel_routine_runs SET status = 'queued' WHERE run_id = ?")
      .run(run.id);

    // Each start of the app resumes the open runs. Before the fix each start made one more task.
    for (let start = 0; start < 3; start += 1) await Effect.runPromise(scheduler.resumePendingRuns());

    const tasks = channels.store.tasks("c1").filter((task) => task.requestMessageId === run.requestMessageId);
    expect(tasks).toHaveLength(1);
    // The run reads its status from its tasks again, so it no longer waits as queued.
    scheduler.reconcile("c1");
    expect(scheduler.listRuns({ channelId: "c1", routineId: routine.id })[0]?.status).toBe("needs-attention");
  });

  it("closes a stopped run on request, and opens it again as it was", async () => {
    const { channels, scheduler, routine, stopped } = await setup();
    await Effect.runPromise(scheduler.test({ channelId: "c1", routineId: routine.id }));
    await until(() => stopped().length === 1);
    const [task] = stopped();
    if (!task) throw new Error("No stopped task.");

    const closed = await Effect.runPromise(channels.closeStopped("c1", [task.id, "missing"]));
    expect(closed.closed).toEqual([task.id]);
    expect(closed.refused).toEqual([{ taskId: "missing", reason: "gone" }]);
    expect(stopped()).toEqual([]);
    // A run whose tasks were all closed is cancelled, not succeeded.
    scheduler.reconcile("c1");
    expect(scheduler.listRuns({ channelId: "c1", routineId: routine.id })[0]?.status).toBe("cancelled");

    expect(await Effect.runPromise(channels.reopenClosed("c1", closed.previous))).toBe(1);
    expect(stopped().map((entry) => [entry.id, entry.state, entry.error])).toEqual([[task.id, task.state, task.error]]);
  });
});
