// Checks what the task reviewer ("Fiscal") and "Resume by itself" decide about stopped and parked work,
// on the real channel service, database and `WorkControl` of the app, with a clock that the check moves.
// The provider is a silent fake: it sends no event, as a Codex turn that hangs. Nothing starts a real
// agent, account or network.
//
// On 1 November 2026 the owner saw a stopped card for more than 15 minutes and asked whether the reviewer
// works. The installed app showed that the timer looks every minute, but:
//   - the reviewer waited 30 minutes (the interval of "Resume by itself") before it tried a failed start
//     again, although its own threshold was 5 minutes;
//   - "Resume by itself" read only the first 50 stopped rows, and resumed requests that the lead could not
//     route ("routing context limit"), which stop again in the same way, three each minute;
//   - their lines went to stdout only, so no file showed that they looked.
//
// Cases:
//   1. A run with no sign of life for 2 × N: the reviewer resumes it at 2 × N, not before.
//   2. A stopped request that the lead could not route, with no agent: no resume, "needs you" at once.
//   3. A stopped task whose agent cannot take it, with another agent of the same model: it goes to that
//      agent after the interval, with no resume first.
//   4. A start that fails twice: the reviewer resumes it at N, then gives it to another agent at 2 × N.
//   5. Low memory: a parked request waits (held: memory); a failed start is still tried.
//   6. 60 stopped rows that a resume cannot fix, then a stopped task in a later channel: it is resumed.
//   7. The last actions of the reviewer stay in their file, and the log names actions, never the text.
//   8. A start that keeps failing: the reviewer follows the task to the agents it gave it to, by turns
//      (resume, reassign, …) at N, 2 × N, 4 × N, then each interval, and stops after 6 actions: "needs you".
//   9. While the app tries a start again (`retrying`), the reviewer and "Resume by itself" leave it alone,
//      and its clock stops; after the tries end, the reviewer acts at N.
// `bun scripts/task-reviewer-decisions-e2e.ts`. Writes .openbot-build/task-reviewer-decisions-e2e/report.json
// and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSummary, ChannelTask, LoadSnapshot } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { ChannelService } from "../src/backend/channel-service";
import { MailboxStore } from "../src/backend/mailbox-store";
import { BuildersBotDatabase } from "../src/backend/openbot-database";
import { CHANNEL_START_FAILED } from "../src/main/task-watch";
import { createTaskWatchHistoryStore } from "../src/main/task-watch-preference-store";
import { WorkControl } from "../src/main/work-control";
import type { RunningTurnRecord } from "../src/main/work-overview";

const OUT = resolve(import.meta.dirname, "../.openbot-build/task-reviewer-decisions-e2e");
const MIN = 60_000;
/** The text of each request. The log and the history file must never hold it. */
const SECRET = "SECRET-REQUEST-TEXT";
const ROUTING_TOO_LONG = sourceText("error.backend.channelRoutingTooLong");
const ASSIGNEE_REASSIGN = sourceText("error.backend.channelAssigneeReassign");
const STOPPED = sourceText("error.backend.channelTaskStopped");
const actor = { id: "local", name: "You" };

/** `--only=<case>` runs one case, such as against an older build to see which case catches its fault. */
const only = Number(process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length) ?? 0);
const want = (number: number) => only === 0 || only === number;
const logLines: string[] = [];
const removeTee = teeLogLines(["task-watch", "auto-recovery"], (line) => logLines.push(line));
const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];
const report: { case: string; ok: true; facts: unknown }[] = [];
const pass = <Facts>(name: string, facts: Facts) => {
  report.push({ case: name, ok: true, facts });
  process.stdout.write(`ok - ${name}\n`);
};

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

const settle = () => new Promise((done) => setTimeout(done, 60));

/** One app: a channel with four agents (alpha and beta share a model), and the work control on a moved clock. */
async function app(options: {
  recovery: { enabled: boolean; intervalMinutes: number; reassign: boolean };
  watch: { enabled: boolean; quietMinutes: number };
  historyFile?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "task-reviewer-e2e-"));
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
  const busyAgents = new Set<string>();
  const channels = new ChannelService(database, mailbox, {
    agents: () => members,
    generate: () => Effect.succeed("{}"),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: (agentId) => busyAgents.has(agentId),
    usageLimited: () => false,
    lane: () => ({ enabled: false, order: [] }),
    awaitDrain: () => Effect.void,
    changed: () => {},
    error: () => {},
  });
  const saveChannel = (channelId: string, name: string) =>
    Effect.runPromise(
      channels.command(
        {
          type: "save",
          operationId: `save:${channelId}`,
          channelId,
          update: false,
          draft: {
            name,
            title: "",
            instructions: "",
            members: members.map((member) => ({ agentId: member.id })),
            leadAgentId: null,
          },
        },
        actor,
      ),
    );
  await saveChannel("c1", "cadastro");
  const clock = { now: Date.parse("2026-11-01T16:00:00.000Z") };
  const turns: RunningTurnRecord[] = [];
  const memory: { level: "ok" | "low" | "critical" } = { level: "ok" };
  const history = options.historyFile ? createTaskWatchHistoryStore(options.historyFile) : null;
  if (history) await Effect.runPromise(history.load());
  const writes: Promise<unknown>[] = [];
  const failures: string[] = [];
  const control = new WorkControl({
    service: {
      listAgents: () => members,
      channels,
      interrupt: () => Effect.void,
      runningTurns: () => turns,
      slotWaitingAgents: () => [],
    },
    agentLimit: () => ({ enabled: false, max: 10 }),
    channelActor: () => actor,
    preference: () => options.recovery,
    onFailure: (action) => failures.push(action),
    now: () => clock.now,
    taskWatch: {
      preference: () => options.watch,
      // The silent fake provider: no event, nobody waits for the person, no open work step.
      signals: () => ({ lastEventAt: null, waitsOnPerson: false, stepOpen: false }),
      memoryLevel: () => memory.level,
      judge: null,
      ...(history
        ? {
            history: {
              read: () => history.get().events,
              write: (events) => {
                writes.push(Effect.runPromise(history.set({ events: [...events] })));
              },
            },
          }
        : {}),
    },
  });
  const tasks = (channelId = "c1") => channels.store.tasks(channelId);
  const taskOf = (taskId: string, channelId = "c1") => tasks(channelId).find((task) => task.id === taskId);
  /** Sends a request to `recipient` and answers its task. */
  const send = async (recipient: string, channelId = "c1") => {
    const before = new Set(tasks(channelId).map((task) => task.id));
    await Effect.runPromise(
      channels.command(
        {
          type: "send",
          operationId: `send:${channelId}:${before.size}:${recipient}`,
          channelId,
          text: `${SECRET} ${before.size}`,
          recipientAgentId: recipient,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    await settle();
    const task = tasks(channelId).find((entry) => !before.has(entry.id));
    assert.ok(task, "The channel made no task.");
    return task;
  };
  /** Writes tasks and the assignments of one channel as the drain and the turns would. */
  const write = (channelId: string, change: { tasks: ChannelTask[]; state?: "failed" | "running" }) => {
    const ids = new Set(change.tasks.map((task) => task.id));
    const state = change.state;
    channels.store.update(channels.store.get(channelId), {
      tasks: change.tasks,
      assignments: state
        ? channels.store
            .assignments(channelId)
            .filter((entry) => ids.has(entry.taskId))
            .map((entry) => ({ ...entry, state, turnId: `turn-${entry.taskId}` }))
        : [],
    });
  };
  const stop = (task: ChannelTask, error: string, patch: Partial<ChannelTask> = {}, channelId = "c1") =>
    write(channelId, {
      tasks: [{ ...task, ...patch, state: error === STOPPED ? "paused" : "failed", error }],
      state: "failed",
    });
  const look = async (minutes: number) => {
    clock.now += minutes * MIN;
    await control.tick();
    await Promise.all(writes.splice(0));
  };
  const snapshot = (): Pick<LoadSnapshot, "stopped" | "recovery" | "taskWatch"> => control.overview();
  return {
    control,
    channels,
    clock,
    turns,
    memory,
    busyAgents,
    failures,
    saveChannel,
    send,
    write,
    stop,
    look,
    taskOf,
    tasks,
    snapshot,
  };
}

try {
  mkdirSync(OUT, { recursive: true });

  // 1. A run with no sign of life.
  if (want(1)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: true },
      watch: { enabled: true, quietMinutes: 5 },
    });
    const task = await a.send("alpha");
    a.write("c1", { tasks: [{ ...task, state: "running" }], state: "running" });
    const topicId = task.topicId ?? "";
    const threadId = a.channels.store.context("c1", topicId, "alpha").threadId;
    a.turns.push({
      turnId: `turn-${task.id}`,
      agentId: "alpha",
      threadId,
      startedAt: new Date(a.clock.now).toISOString(),
    });
    await a.look(0);
    const first = a.snapshot().taskWatch.waits?.[0];
    assert.deepEqual(
      { kind: first?.kind, state: first?.state, minutes: first?.minutes },
      { kind: "running", state: "watching", minutes: 10 },
    );
    const revision = a.taskOf(task.id)?.revision;
    await a.look(9);
    assert.equal(a.taskOf(task.id)?.revision, revision, "The reviewer acted on a run before 2 × N.");
    await a.look(1);
    assert.equal(a.taskOf(task.id)?.state, "queued", "The reviewer did not resume the silent run at 2 × N.");
    const event = a.snapshot().taskWatch.recent[0];
    assert.equal(event?.action, "resumed");
    assert.equal(event?.reason, "no-sign");
    pass("A run with no sign for 2 × N is resumed at 2 × N, not before", {
      quietMinutes: 5,
      waitBefore: first,
      event,
    });
  }

  // 2. A request that the lead could not route, with no agent.
  if (want(2)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: true },
      watch: { enabled: true, quietMinutes: 5 },
    });
    const task = await a.send("alpha");
    a.stop(task, ROUTING_TOO_LONG, { ownerAgentId: null });
    const revision = a.taskOf(task.id)?.revision;
    await a.look(0);
    const plan = a.snapshot().stopped[0]?.plan;
    assert.equal(plan?.state, "needs-you", "A request that a resume cannot fix waits for tries.");
    await a.look(60);
    assert.equal(a.taskOf(task.id)?.revision, revision, "Resume by itself resumed a request that it cannot fix.");
    assert.deepEqual(a.snapshot().recovery.recent, []);
    pass("A stopped request that the lead could not route gets no resume and says it needs the person", {
      reason: ROUTING_TOO_LONG,
      plan,
    });
  }

  // 3. A task whose agent cannot take it, with another agent of the same model.
  if (want(3)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: true },
      watch: { enabled: true, quietMinutes: 5 },
    });
    const task = await a.send("alpha");
    a.stop(task, ASSIGNEE_REASSIGN);
    await a.look(0);
    const plan = a.snapshot().stopped[0]?.plan;
    assert.deepEqual(
      { state: plan?.state, action: plan?.action, minutes: plan?.minutes },
      {
        state: "due",
        action: "reassign",
        minutes: 30,
      },
    );
    await a.look(29);
    assert.equal(a.taskOf(task.id)?.ownerAgentId, "alpha");
    await a.look(1);
    assert.equal(a.taskOf(task.id)?.ownerAgentId, "beta", "The task did not go to the agent with the same model.");
    assert.equal(a.snapshot().recovery.recent[0]?.action, "reassigned");
    pass("A task that its agent cannot take goes to an agent of the same model after the interval, with no resume", {
      reason: ASSIGNEE_REASSIGN,
      plan,
      event: a.snapshot().recovery.recent[0],
    });
  }

  // 4 and 7. A start that fails twice, with the file of the last actions.
  const historyRoot = await mkdtemp(join(tmpdir(), "task-reviewer-history-"));
  roots.push(historyRoot);
  const historyFile = join(historyRoot, "openbot-task-watch-history-v1.json");
  if (want(4) || want(7)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: true },
      watch: { enabled: true, quietMinutes: 5 },
      historyFile,
    });
    const task = await a.send("alpha");
    a.stop(task, CHANNEL_START_FAILED);
    await a.look(0);
    const plan = a.snapshot().stopped[0]?.plan;
    assert.deepEqual(
      { by: plan?.by, state: plan?.state, action: plan?.action, minutes: plan?.minutes },
      { by: "reviewer", state: "due", action: "resume", minutes: 5 },
    );
    await a.look(4);
    assert.equal(a.taskOf(task.id)?.state, "failed", "The reviewer tried a failed start before N.");
    await a.look(1);
    assert.notEqual(a.taskOf(task.id)?.state, "failed", "The reviewer did not try the failed start at N.");
    const again = a.taskOf(task.id);
    assert.ok(again);
    a.stop(again, CHANNEL_START_FAILED);
    await a.look(10);
    assert.equal(a.taskOf(task.id)?.ownerAgentId, "beta", "The second failed start did not go to another agent.");
    const recent = a.snapshot().taskWatch.recent.map(({ action, reason }) => ({ action, reason }));
    assert.deepEqual(recent, [
      { action: "reassigned", reason: "start-failed" },
      { action: "resumed", reason: "start-failed" },
    ]);
    assert.deepEqual(a.snapshot().recovery.recent, [], "Resume by itself took a failed start from the reviewer.");
    pass("A start that fails twice is resumed at N, then given to another agent at 2 × N", { plan, recent });
  }
  if (want(7)) {
    const text = readFileSync(historyFile, "utf8");
    assert.ok(!text.includes(SECRET), "The history file holds the text of a request.");
    // A new app reads the same file: the actions stay after a restart.
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: true },
      watch: { enabled: true, quietMinutes: 5 },
      historyFile,
    });
    const recent = a.snapshot().taskWatch.recent.map((event) => event.action);
    assert.deepEqual(recent, ["reassigned", "resumed"]);
    pass("The last actions of the reviewer stay in their file after a restart, with no request text", {
      file: "openbot-task-watch-history-v1.json",
      recent,
    });
  }

  // 8. A start that keeps failing, to its cap.
  if (want(8)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: true },
      watch: { enabled: true, quietMinutes: 5 },
    });
    const task = await a.send("alpha");
    const failAgain = () => {
      const current = a.taskOf(task.id);
      assert.ok(current);
      a.stop(current, CHANNEL_START_FAILED);
    };
    failAgain();
    await a.look(0);
    const owners: (string | null)[] = [];
    // N, 2 × N, 4 × N, then the interval: 5, 10, 20, 30, 30, 30 minutes.
    for (const wait of [5, 10, 20, 30, 30, 30]) {
      await a.look(wait - 1);
      assert.equal(a.taskOf(task.id)?.state, "failed", `The reviewer acted before ${wait} minutes.`);
      await a.look(1);
      assert.notEqual(a.taskOf(task.id)?.state, "failed", `The reviewer did not act at ${wait} minutes.`);
      owners.push(a.taskOf(task.id)?.ownerAgentId ?? null);
      failAgain();
    }
    const actions = a
      .snapshot()
      .taskWatch.recent.map((event) => event.action)
      .reverse();
    assert.deepEqual(actions, ["resumed", "reassigned", "resumed", "reassigned", "resumed", "reassigned"]);
    // A free agent of the same model first (beta, then alpha again, which the reviewer did not give it to),
    // then the same provider (gamma). Delta runs another provider.
    assert.deepEqual(owners, ["alpha", "beta", "beta", "alpha", "alpha", "gamma"]);
    await a.look(30);
    assert.equal(a.taskOf(task.id)?.state, "failed", "The reviewer took a 7th action.");
    const plan = a.snapshot().stopped.find((row) => row.taskId === task.id)?.plan;
    assert.equal(plan?.state, "needs-you", "The stopped row does not say that the person decides.");
    await a.look(120);
    assert.equal(a.taskOf(task.id)?.state, "failed", "The reviewer acted after its cap.");
    assert.deepEqual(a.snapshot().recovery.recent, [], "Resume by itself took a failed start from the reviewer.");
    pass("A start that keeps failing is followed by turns to other agents, and left to the person after 6 actions", {
      actions,
      owners,
      plan,
    });
  }

  // 9. The app tries a start again: the reviewer waits.
  if (want(9)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: true },
      watch: { enabled: true, quietMinutes: 5 },
    });
    const task = await a.send("alpha");
    const assignment = a.channels.store.assignments("c1").find((entry) => entry.taskId === task.id);
    assert.ok(assignment?.deliveryId, "The task has no assignment with a delivery.");
    const retry = {
      phase: "retrying" as const,
      attempt: 2,
      max: 3,
      nextAt: new Date(a.clock.now + 30_000).toISOString(),
    };
    assert.ok(await Effect.runPromise(a.channels.holdForStartRetry(assignment.deliveryId, retry)));
    const revision = a.taskOf(task.id)?.revision;
    await a.look(0);
    const held = a.snapshot().taskWatch.waits?.find((wait) => wait.kind === "queued");
    assert.deepEqual({ state: held?.state, hold: held?.hold }, { state: "held", hold: "retrying" });
    for (let index = 0; index < 4; index += 1) await a.look(15);
    assert.equal(a.taskOf(task.id)?.revision, revision, "The reviewer moved a task that the app tries again.");
    assert.equal(a.taskOf(task.id)?.state, "queued");
    assert.deepEqual(a.snapshot().taskWatch.recent, [], "The reviewer acted during the retry.");
    assert.deepEqual(a.snapshot().recovery.recent, [], "Resume by itself acted during the retry.");
    // The tries end with no start: the reviewer acts N later, not at once.
    await Effect.runPromise(
      a.channels.deliveryFailed(assignment.deliveryId, CHANNEL_START_FAILED, {
        cause: "provider_unavailable",
        errorKey: null,
        attempts: 4,
        fallbackTried: false,
      }),
    );
    await a.look(0);
    assert.equal(a.taskOf(task.id)?.state, "failed");
    await a.look(4);
    assert.equal(a.taskOf(task.id)?.state, "failed", "The reviewer acted at once after the tries.");
    await a.look(1);
    assert.notEqual(a.taskOf(task.id)?.state, "failed", "The reviewer did not act at N after the tries.");
    pass("The reviewer waits while the app tries a start again, then acts at N", { held });
  }

  // 5. Low memory.
  if (want(5)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: false },
      watch: { enabled: true, quietMinutes: 5 },
    });
    // A request in the queue with no assignment: the drain would start it now, but no pass runs.
    const parked = await a.send("gamma");
    a.write("c1", { tasks: [{ ...parked, state: "queued", revision: parked.revision + 1 }] });
    const failed = await a.send("alpha");
    a.stop(failed, CHANNEL_START_FAILED);
    a.memory.level = "low";
    await a.look(0);
    const held = a.snapshot().taskWatch.waits?.find((wait) => wait.kind === "queued");
    assert.deepEqual({ state: held?.state, hold: held?.hold }, { state: "held", hold: "memory" });
    const parkedRevision = a.taskOf(parked.id)?.revision;
    await a.look(10);
    assert.notEqual(a.taskOf(failed.id)?.state, "failed", "Low memory held a failed start.");
    for (let index = 0; index < 4; index += 1) await a.look(15);
    assert.equal(a.taskOf(parked.id)?.revision, parkedRevision, "The reviewer moved a request while memory was low.");
    pass("Low memory holds a parked request, and a failed start is still tried", { held });
  }

  // 6. Sixty rows that a resume cannot fix come first; a stopped task of a later channel is still resumed.
  if (want(6)) {
    const a = await app({
      recovery: { enabled: true, intervalMinutes: 30, reassign: false },
      watch: { enabled: false, quietMinutes: 15 },
    });
    const base = await a.send("alpha");
    const many: ChannelTask[] = Array.from({ length: 60 }, (_unused, index) => {
      const id = `routing-${index}`;
      return {
        ...base,
        id,
        rootTaskId: id,
        requestMessageId: `request-${index}`,
        ownerAgentId: null,
        state: "paused",
        error: ROUTING_TOO_LONG,
      };
    });
    a.write("c1", { tasks: [{ ...base, state: "paused", error: ROUTING_TOO_LONG, ownerAgentId: null }, ...many] });
    await a.saveChannel("c2", "later");
    const later = await a.send("alpha", "c2");
    a.stop(later, STOPPED, {}, "c2");
    const revision = a.taskOf(later.id, "c2")?.revision ?? 0;
    await a.look(0);
    await a.look(30);
    assert.ok(
      (a.taskOf(later.id, "c2")?.revision ?? 0) > revision,
      "Resume by itself did not reach a stopped task past the first 50 rows.",
    );
    assert.equal(a.snapshot().recovery.recent[0]?.channelName, "later");
    const untouched = a
      .tasks("c1")
      .filter((task) => task.error === ROUTING_TOO_LONG && task.revision === base.revision);
    assert.equal(untouched.length, 61, "Resume by itself resumed a request that it cannot fix.");
    pass("Rows that a resume cannot fix do not hide a stopped task of a later channel", {
      stoppedBefore: 61,
      resumedChannel: a.snapshot().recovery.recent[0]?.channelName,
    });
  }

  // 7. The log, after all the cases.
  if (only === 0) {
    const leaked = logLines.filter((line) => line.includes(SECRET));
    assert.deepEqual(leaked, [], "A log line holds the text of a request.");
    const has = (text: string) => logLines.some((line) => line.includes(text));
    for (const text of [
      "The task reviewer looks.",
      "The task reviewer waits.",
      "The task reviewer decided.",
      "Resume by itself left tasks to the person",
      "Resume by itself gave a task to another agent.",
      "Resume by itself resumed a task.",
    ])
      assert.ok(has(text), `The log has no line "${text}".`);
    pass("The log has the looks, waits and decisions, never the text of a request", {
      lines: logLines.length,
      sample: logLines.filter((line) => line.includes("[task-watch]")).slice(0, 4),
    });
  }
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ok: true, cases: report }, null, 2)}\n`);
  process.stdout.write(`Passed ${report.length} cases. Wrote ${join(OUT, "report.json")}.\n`);
} catch (error) {
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify({ ok: false, cases: report, error: String(error), log: logLines.slice(-20) }, null, 2)}\n`,
  );
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
} finally {
  removeTee();
  for (const database of databases) database.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
