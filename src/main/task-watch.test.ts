// @vitest-environment node
import type { AutoRecoveryPreference, ChannelCommand, TaskWatchPreference } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { decideRecovery, type LedgerRecord, MAX_REASSIGNS, MAX_RESUMES, RecoveryLedger } from "./auto-recovery";
import {
  AUTO_OPERATION_PREFIX,
  classifyQuiet,
  DeliberateStops,
  OPEN_STEP_STALL_FACTOR,
  runningQuiet,
  startFailedWaitMs,
  TASK_WATCH_MODEL_CALLS_PER_HOUR,
  TASK_WATCH_START_ACTIONS,
  TaskWatch,
  type TaskWatchDeps,
  type WatchedTask,
  type WatchObservation,
  watchAction,
  watchCandidates,
  watchClass,
} from "./task-watch";
import type { TaskWatchDecision, TaskWatchJudge, TaskWatchJudgeInput } from "./task-watch-judge";

const MIN = 60_000;
/** The look happens at 10 hours, so every fixture can start hours before it. */
const NOW = 600 * MIN;

function run(overrides: Partial<WatchObservation> = {}): WatchObservation {
  return {
    channelId: "c1",
    channelName: "pagamentos",
    taskId: "t1",
    revision: 3,
    kind: "running",
    agentId: "writer",
    agentName: "Writer",
    provider: "codex",
    turnStartedAt: NOW - 180 * MIN,
    lastEventAt: NOW - MIN,
    stepOpen: false,
    startingAssignmentId: null,
    hold: null,
    ...overrides,
  };
}

function request(overrides: Partial<WatchObservation> = {}): WatchObservation {
  return run({
    taskId: "q1",
    kind: "queued",
    agentId: "qa",
    agentName: "QA",
    turnStartedAt: null,
    lastEventAt: null,
    ...overrides,
  });
}

function failedStart(overrides: Partial<WatchObservation> = {}): WatchObservation {
  return request({ taskId: "f1", kind: "start-failed", agentId: "editor", agentName: "Editor", ...overrides });
}

interface Setup {
  watch: TaskWatch;
  ledger: RecoveryLedger;
  clock: { now: number };
  tasks: WatchObservation[];
  commands: string[];
  questions: TaskWatchJudgeInput[];
  failures: string[];
  /** The lines of the log, with their fields. */
  logs: { message: string; fields: Record<string, string | number | boolean> }[];
  state: { watch: TaskWatchPreference; recovery: AutoRecoveryPreference; dropped: boolean };
}

function setup(
  options: {
    tasks?: WatchObservation[];
    judge?: TaskWatchJudge | null;
    reassign?: boolean;
    candidate?: string | null;
    failCommand?: boolean;
    ledger?: RecoveryLedger;
    /** The switch `fiscal-resume-grace`. Omitted: the reviewer has no switch, as before. */
    sleepGrace?: boolean;
  } = {},
): Setup {
  const clock = { now: NOW };
  const ledger = options.ledger ?? new RecoveryLedger();
  const tasks = options.tasks ?? [];
  const commands: string[] = [];
  const questions: TaskWatchJudgeInput[] = [];
  const failures: string[] = [];
  const logs: Setup["logs"] = [];
  const state = {
    watch: { enabled: true, quietMinutes: 15 },
    recovery: { enabled: true, intervalMinutes: 30, reassign: options.reassign ?? true },
    dropped: false,
  };
  const judge =
    options.judge === undefined
      ? null
      : options.judge && {
          ready: () => options.judge?.ready() ?? false,
          decide: (input: TaskWatchJudgeInput) => {
            questions.push(input);
            return options.judge?.decide(input) ?? Promise.resolve(null);
          },
        };
  const deps: TaskWatchDeps = {
    preference: () => state.watch,
    recovery: () => state.recovery,
    observe: () => tasks,
    ledger,
    candidate: () => (options.candidate === undefined ? "beta" : options.candidate),
    command: async (type, task, recipient) => {
      if (options.failCommand) throw new Error("the channel refused");
      if (state.dropped) return false;
      commands.push(`${type} ${task.taskId}${recipient ? ` ${recipient}` : ""}`);
      return true;
    },
    judge,
    texts: () => ({ request: "Fix the payment form", lastWords: "Running the whole test suite now." }),
    load: () => ({ activeAgents: 3, agentLimit: 10 }),
    agentNameOf: (agentId) => agentId.toUpperCase(),
    now: () => clock.now,
    onFailure: (kind, _channelId, taskId) => failures.push(`${kind} ${taskId}`),
    log: { info: (message, fields) => logs.push({ message, fields }) },
    ...(options.sleepGrace === undefined ? {} : { sleepGrace: () => options.sleepGrace === true }),
  };
  return { watch: new TaskWatch(deps), ledger, clock, tasks, commands, questions, failures, logs, state };
}

const answering = (decision: TaskWatchDecision | null): TaskWatchJudge => ({
  ready: () => true,
  decide: async () => decision,
});

describe("the classes of a task", () => {
  it("is healthy below the threshold, slow up to twice it, then stalled", () => {
    expect(classifyQuiet(14 * MIN, 15 * MIN)).toBe("healthy");
    expect(classifyQuiet(15 * MIN, 15 * MIN)).toBe("slow");
    expect(classifyQuiet(29 * MIN, 15 * MIN)).toBe("slow");
    expect(classifyQuiet(30 * MIN, 15 * MIN)).toBe("stalled");
  });

  it(`keeps a run with an open work step slow up to ${OPEN_STEP_STALL_FACTOR} times the threshold`, () => {
    const step = { kind: "running" as const, stepOpen: true, startingAssignmentId: null };
    expect(watchClass(step, 30 * MIN, 15 * MIN)).toBe("slow");
    expect(watchClass(step, 59 * MIN, 15 * MIN)).toBe("slow");
    expect(watchClass(step, 60 * MIN, 15 * MIN)).toBe("stalled");
    expect(runningQuiet(NOW - 300 * MIN, NOW - 40 * MIN, NOW, 15 * MIN, true)).toEqual({ state: "slow", minutes: 40 });
  });

  it("gives a request whose start is under way no slow band: it is stalled only at twice the threshold", () => {
    const starting = { kind: "queued" as const, stepOpen: false, startingAssignmentId: "a1" };
    expect(watchClass(starting, 20 * MIN, 15 * MIN)).toBe("healthy");
    expect(watchClass(starting, 30 * MIN, 15 * MIN)).toBe("stalled");
    expect(watchClass({ ...starting, startingAssignmentId: null }, 20 * MIN, 15 * MIN)).toBe("slow");
  });

  it("marks a running row by its last sign, not by its start", () => {
    expect(runningQuiet(NOW - 300 * MIN, NOW - 2 * MIN, NOW, 15 * MIN)).toBeUndefined();
    expect(runningQuiet(NOW - 300 * MIN, NOW - 20 * MIN, NOW, 15 * MIN)).toEqual({ state: "slow", minutes: 20 });
    expect(runningQuiet(NOW - 40 * MIN, null, NOW, 15 * MIN)).toEqual({ state: "stalled", minutes: 40 });
  });
});

describe("the tasks the reviewer can act on", () => {
  const context = { now: NOW, thresholdMs: 15 * MIN, intervalMs: 30 * MIN };
  const clocked = (observation: WatchObservation, lastSignAt: number): WatchedTask => ({
    ...observation,
    startedAt: NOW - 200 * MIN,
    lastSignAt,
  });

  it("puts a stalled run first, then a stalled request, a failed start, and the slow ones", () => {
    const candidates = watchCandidates(
      [
        clocked(request({ taskId: "slow-q" }), NOW - 20 * MIN),
        clocked(run({ taskId: "slow-r" }), NOW - 20 * MIN),
        clocked(failedStart(), NOW),
        clocked(request({ taskId: "stalled-q" }), NOW - 90 * MIN),
        clocked(run({ taskId: "stalled-r" }), NOW - 40 * MIN),
      ],
      context,
      (task) =>
        task.kind === "start-failed"
          ? {
              seenAt: NOW - 60 * MIN,
              lastActionAt: null,
              resumes: 0,
              reassigns: 0,
              tried: [],
              gaveUp: false,
              lastSeenAt: NOW,
            }
          : undefined,
    );
    expect(candidates.map((candidate) => candidate.task.taskId)).toEqual([
      "stalled-r",
      "stalled-q",
      "f1",
      "slow-r",
      "slow-q",
    ]);
  });

  it("leaves out a held task, a task it gave up on, and a task it acted on less than an interval ago", () => {
    const record = (overrides: Partial<LedgerRecord>): LedgerRecord => ({
      seenAt: 0,
      lastActionAt: null,
      resumes: 0,
      reassigns: 0,
      tried: [],
      gaveUp: false,
      lastSeenAt: NOW,
      ...overrides,
    });
    const candidates = watchCandidates(
      [
        clocked(run({ taskId: "held", hold: "attention" }), NOW - 90 * MIN),
        clocked(run({ taskId: "given-up" }), NOW - 90 * MIN),
        clocked(run({ taskId: "recent" }), NOW - 90 * MIN),
        clocked(run({ taskId: "due" }), NOW - 90 * MIN),
      ],
      context,
      (task) =>
        task.taskId === "given-up"
          ? record({ gaveUp: true })
          : task.taskId === "recent"
            ? record({ lastActionAt: NOW - 10 * MIN })
            : task.taskId === "due"
              ? record({ lastActionAt: NOW - 31 * MIN, resumes: 1 })
              : undefined,
    );
    expect(candidates.map((candidate) => candidate.task.taskId)).toEqual(["due"]);
  });
});

describe("what the reviewer does with a task", () => {
  const pick = () => "beta";

  it(`resumes a run or a request ${MAX_RESUMES} times, then reassigns, then stops a run or leaves a request`, () => {
    expect(watchAction("running", undefined, true, pick)).toEqual({ type: "resume" });
    expect(watchAction("running", { resumes: MAX_RESUMES, reassigns: 0 }, true, pick)).toEqual({
      type: "reassign",
      agentId: "beta",
    });
    expect(watchAction("running", { resumes: MAX_RESUMES, reassigns: MAX_REASSIGNS }, true, pick)).toEqual({
      type: "stop",
    });
    expect(watchAction("queued", { resumes: MAX_RESUMES, reassigns: MAX_REASSIGNS }, true, pick)).toEqual({
      type: "give-up",
    });
  });

  it("follows a failed start with a resume, then a reassign and a resume by turns", () => {
    expect(watchAction("start-failed", { resumes: 0, reassigns: 0 }, true, pick)).toEqual({ type: "resume" });
    expect(watchAction("start-failed", { resumes: 1, reassigns: 0 }, true, pick)).toEqual({
      type: "reassign",
      agentId: "beta",
    });
    expect(watchAction("start-failed", { resumes: 1, reassigns: 1 }, true, pick)).toEqual({ type: "resume" });
    expect(watchAction("start-failed", { resumes: 2, reassigns: 1 }, true, pick)).toEqual({
      type: "reassign",
      agentId: "beta",
    });
  });

  it("resumes a failed start again when no other agent can take it, or the person did not allow a reassign", () => {
    expect(watchAction("start-failed", { resumes: 1, reassigns: 0 }, false, pick)).toEqual({ type: "resume" });
    expect(watchAction("start-failed", { resumes: 1, reassigns: 0 }, true, () => null)).toEqual({
      type: "resume",
    });
    expect(watchAction("start-failed", { resumes: 3, reassigns: 0 }, false, pick)).toEqual({ type: "resume" });
  });

  it("waits N for the first action on a failed start, then twice as long each time, up to the interval", () => {
    const waits = [0, 1, 2, 3, 4].map((actions) =>
      startFailedWaitMs({ thresholdMs: 5 * MIN, intervalMs: 30 * MIN }, actions),
    );
    expect(waits).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 30 * MIN, 30 * MIN]);
  });

  it(`gives up a failed start after ${TASK_WATCH_START_ACTIONS} actions`, () => {
    const done = Array.from({ length: TASK_WATCH_START_ACTIONS }, (_value, index) => NOW - index * 30 * MIN);
    expect(watchAction("start-failed", { resumes: 3, reassigns: 3, startActions: done }, true, pick)).toEqual({
      type: "give-up",
    });
    expect(watchAction("start-failed", { resumes: 3, reassigns: 2, startActions: done.slice(1) }, true, pick)).toEqual({
      type: "reassign",
      agentId: "beta",
    });
  });

  it("never reassigns when the person did not allow it, or when no agent can take the task", () => {
    expect(watchAction("running", { resumes: MAX_RESUMES, reassigns: 0 }, true, () => null)).toEqual({
      type: "stop",
    });
  });
});

describe("the task reviewer", () => {
  it("never touches a long run that gives signs of life", async () => {
    const { watch, commands } = setup({ tasks: [run({ turnStartedAt: NOW - 300 * MIN })] });
    await watch.tick();
    expect(commands).toEqual([]);
    expect(watch.recent()).toEqual([]);
  });

  it("starts a stalled run again: it holds a place that other tasks wait for", async () => {
    const { watch, commands, ledger } = setup({ tasks: [run({ lastEventAt: NOW - 40 * MIN })] });
    await watch.tick();
    expect(commands).toEqual(["resume t1"]);
    expect(ledger.peek("c1", "t1")).toMatchObject({ resumes: 1, lastActionAt: NOW });
    expect(watch.recent()[0]).toMatchObject({
      channelName: "pagamentos",
      action: "resumed",
      reason: "no-sign",
      minutes: 40,
      by: "local",
    });
  });

  it("acts on the stalled run, not on the request that waits behind it", async () => {
    const { watch, commands } = setup({
      tasks: [
        request({ agentId: "writer", hold: "agent-busy", turnStartedAt: null }),
        run({ lastEventAt: NOW - 45 * MIN }),
      ],
    });
    await watch.tick();
    expect(commands).toEqual(["resume t1"]);
  });

  it("puts a request that waits too long with a free place in the queue again", async () => {
    const { watch, commands, clock } = setup({ tasks: [request()] });
    await watch.tick();
    clock.now = NOW + 31 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume q1"]);
    expect(watch.recent()[0]).toMatchObject({ action: "resumed", reason: "queued", minutes: 31 });
  });

  it("gives a start that fails again to another agent of the same model, not a second resume", async () => {
    const { watch, commands, clock, ledger } = setup({ tasks: [failedStart()] });
    await watch.tick();
    expect(commands).toEqual([]);
    clock.now = NOW + 30 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume f1"]);
    // The resume failed to start again: the next look one interval later goes to another agent.
    clock.now = NOW + 60 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume f1", "reassign f1 beta"]);
    expect(ledger.peek("c1", "f1")).toMatchObject({ resumes: 1, reassigns: 1, tried: ["beta"] });
    expect(watch.recent()[0]).toMatchObject({
      action: "reassigned",
      agentName: "BETA",
      reason: "start-failed",
      minutes: null,
    });
  });

  it("leaves a start that fails again after its actions, and says so, when reassigning is off", async () => {
    const { watch, commands, clock, ledger } = setup({ tasks: [failedStart()], reassign: false });
    const record = ledger.see("c1", "f1", NOW - 60 * MIN);
    record.resumes = TASK_WATCH_START_ACTIONS;
    record.startActions = Array.from({ length: TASK_WATCH_START_ACTIONS }, (_value, index) => NOW - (index + 1) * MIN);
    await watch.tick();
    expect(commands).toEqual([]);
    expect(ledger.peek("c1", "f1")?.gaveUp).toBe(true);
    expect(watch.recent()[0]).toMatchObject({ action: "gave-up", reason: "start-failed" });
    clock.now = NOW + 600 * MIN;
    await watch.tick();
    expect(commands).toEqual([]);
  });

  it("never touches a task that the person stopped on purpose", async () => {
    const { watch, commands } = setup({
      tasks: [run({ lastEventAt: NOW - 300 * MIN, hold: "person" }), request({ hold: "person" })],
    });
    await watch.tick();
    expect(commands).toEqual([]);
    expect(watch.recent()).toEqual([]);
  });

  it("leaves a request alone while the cap on agents is reached", async () => {
    const { watch, commands, clock } = setup({ tasks: [request({ hold: "slot" })] });
    await watch.tick();
    clock.now = NOW + 300 * MIN;
    await watch.tick();
    expect(commands).toEqual([]);
  });

  it("stops the clock while a hold lasts, so a request is not stalled the moment its place frees", async () => {
    const { watch, commands, clock, tasks } = setup({ tasks: [request({ hold: "slot" })] });
    for (let look = 0; look <= 6; look += 1) {
      clock.now = NOW + look * 10 * MIN;
      await watch.tick();
    }
    // The cap held it for an hour. The place frees, and the drain starts the turn now.
    tasks[0] = request();
    clock.now = NOW + 61 * MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    expect(watch.recent()).toEqual([]);
    // Two thresholds after the last look that found the hold, it is stalled.
    clock.now = NOW + 90 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume q1"]);
    expect(watch.recent()[0]).toMatchObject({ action: "resumed", minutes: 30 });
  });

  it("starts the clock of a request again when the drain gives it a new assignment", async () => {
    const { watch, commands, clock, tasks } = setup({ tasks: [request({ startingAssignmentId: "a1" })] });
    await watch.tick();
    clock.now = NOW + 20 * MIN;
    tasks[0] = request({ startingAssignmentId: "a2" });
    await watch.tick();
    clock.now = NOW + 40 * MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    clock.now = NOW + 50 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume q1"]);
  });

  it(`never touches a run with an open work step and no events at twice the threshold, only at ${OPEN_STEP_STALL_FACTOR} times`, async () => {
    const { watch, commands, clock, tasks } = setup({
      tasks: [run({ lastEventAt: NOW - 30 * MIN, stepOpen: true })],
    });
    await watch.tick();
    expect(commands).toEqual([]);
    expect(watch.recent()[0]).toMatchObject({ action: "waited", by: "local", minutes: 30 });
    clock.now = NOW + 29 * MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    tasks[0] = run({ lastEventAt: NOW - 30 * MIN, stepOpen: true });
    clock.now = NOW + 30 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume t1"]);
  });

  it('gives up on a request with its own mark, so the shared tries still let "Resume by itself" act later', async () => {
    const ledger = new RecoveryLedger();
    Object.assign(ledger.see("c1", "q1", NOW - 120 * MIN), { resumes: MAX_RESUMES, lastActionAt: NOW - 60 * MIN });
    // No free agent can take it now: every agent of the same model runs.
    const { watch, commands, clock, tasks } = setup({
      tasks: [request({ turnStartedAt: null })],
      candidate: null,
      ledger,
    });
    await watch.tick();
    clock.now = NOW + 31 * MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    expect(watch.recent()[0]).toMatchObject({ action: "gave-up", reason: "queued" });
    const record = ledger.peek("c1", "q1");
    expect(record?.gaveUp).toBe(false);
    // It leaves this revision alone…
    clock.now = NOW + 120 * MIN;
    await watch.tick();
    expect(watch.recent()).toHaveLength(1);
    // …and the task that stops later is still the automatic recovery's: it gives it to a free agent.
    tasks.length = 0;
    if (!record) throw new Error("The record is missing.");
    expect(decideRecovery(record, NOW + 240 * MIN, { intervalMs: 30 * MIN, reassign: true }, () => "gamma")).toEqual({
      type: "reassign",
      agentId: "gamma",
    });
  });

  it("does not renew the tries of a task that works well, so they are forgotten after the retention time", async () => {
    const ledger = new RecoveryLedger();
    Object.assign(ledger.see("c1", "t1", NOW - 60 * MIN), { resumes: MAX_RESUMES, lastActionAt: NOW - 60 * MIN });
    const { watch, clock, tasks } = setup({ tasks: [run({ lastEventAt: NOW })], ledger });
    for (let look = 0; look < 6; look += 1) {
      clock.now = NOW + look * 60 * MIN;
      tasks[0] = run({ lastEventAt: clock.now });
      await watch.tick();
    }
    expect(ledger.peek("c1", "t1")?.lastSeenAt).toBe(NOW - 60 * MIN);
    ledger.sweep(NOW + 301 * MIN);
    expect(ledger.peek("c1", "t1")).toBeUndefined();
  });

  it("uses the tries of the automatic recovery: a run it already resumed twice goes to another agent", async () => {
    const { watch, commands, ledger } = setup({ tasks: [run({ lastEventAt: NOW - 40 * MIN })] });
    Object.assign(ledger.see("c1", "t1", NOW - 120 * MIN), { resumes: MAX_RESUMES, lastActionAt: NOW - 60 * MIN });
    await watch.tick();
    expect(commands).toEqual(["reassign t1 beta"]);
  });

  it("stops a run at the end of its tries, so it frees its place, and then leaves it", async () => {
    const { watch, commands, ledger, clock } = setup({ tasks: [run({ lastEventAt: NOW - 40 * MIN })] });
    Object.assign(ledger.see("c1", "t1", NOW - 300 * MIN), {
      resumes: MAX_RESUMES,
      reassigns: MAX_REASSIGNS,
      lastActionAt: NOW - 60 * MIN,
    });
    await watch.tick();
    expect(commands).toEqual(["stop t1"]);
    expect(ledger.peek("c1", "t1")?.gaveUp).toBe(true);
    expect(watch.recent()[0]?.action).toBe("stopped");
    clock.now = NOW + 600 * MIN;
    await watch.tick();
    expect(commands).toEqual(["stop t1"]);
  });

  it("decides about one task in each look", async () => {
    const { watch, commands } = setup({
      tasks: [run({ lastEventAt: NOW - 40 * MIN }), run({ taskId: "t2", agentId: "qa", lastEventAt: NOW - 50 * MIN })],
    });
    await watch.tick();
    expect(commands).toEqual(["resume t2"]);
    await watch.tick();
    expect(commands).toEqual(["resume t2", "resume t1"]);
  });

  it("waits an interval before it acts on the same task again", async () => {
    const { watch, commands, clock } = setup({ tasks: [run({ lastEventAt: NOW - 40 * MIN })] });
    await watch.tick();
    clock.now = NOW + 29 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume t1"]);
    clock.now = NOW + 30 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume t1", "resume t1"]);
  });

  it("counts nothing when the task changed before the command applied", async () => {
    const { watch, commands, ledger, state } = setup({ tasks: [run({ lastEventAt: NOW - 40 * MIN })] });
    state.dropped = true;
    await watch.tick();
    expect(commands).toEqual([]);
    expect(ledger.peek("c1", "t1")?.resumes ?? 0).toBe(0);
    expect(watch.recent()).toEqual([]);
  });

  it("counts a failed command as a try, and never throws", async () => {
    const { watch, ledger, failures } = setup({ tasks: [run({ lastEventAt: NOW - 40 * MIN })], failCommand: true });
    await expect(watch.tick()).resolves.toBeUndefined();
    expect(ledger.peek("c1", "t1")?.resumes).toBe(1);
    expect(failures).toEqual(["resume t1"]);
  });

  it("does nothing while its switch or the switch of the automatic recovery is off", async () => {
    const { watch, commands, state } = setup({ tasks: [run({ lastEventAt: NOW - 90 * MIN })] });
    state.watch = { ...state.watch, enabled: false };
    await watch.tick();
    state.watch = { ...state.watch, enabled: true };
    state.recovery = { ...state.recovery, enabled: false };
    await watch.tick();
    expect(watch.active()).toBe(false);
    expect(commands).toEqual([]);
  });
});

describe("the model of the Guard for a slow task", () => {
  const slowRun = () => run({ lastEventAt: NOW - 20 * MIN });

  it("waits, with the local rules, when no model is chosen", async () => {
    const { watch, commands } = setup({ tasks: [slowRun()], judge: null });
    await watch.tick();
    expect(commands).toEqual([]);
    expect(watch.recent()[0]).toMatchObject({ action: "waited", by: "local", minutes: 20 });
  });

  it("waits, with the local rules, when the model cannot run now", async () => {
    const { watch, commands, questions } = setup({
      tasks: [slowRun()],
      judge: { ready: () => false, decide: async () => "act" },
    });
    await watch.tick();
    expect(questions).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("never lets the model reassign or stop a slow task: with no resume left, it waits and asks nothing", async () => {
    const { watch, commands, questions, ledger } = setup({ tasks: [slowRun()], judge: answering("act") });
    Object.assign(ledger.see("c1", "t1", NOW - 120 * MIN), { resumes: MAX_RESUMES, lastActionAt: NOW - 60 * MIN });
    await watch.tick();
    expect(questions).toEqual([]);
    expect(commands).toEqual([]);
    expect(watch.recent()[0]).toMatchObject({ action: "waited", by: "local" });
  });

  it("acts at once when the model says the task is stuck", async () => {
    const { watch, commands, questions } = setup({ tasks: [slowRun()], judge: answering("act") });
    await watch.tick();
    expect(commands).toEqual(["resume t1"]);
    expect(watch.recent()[0]).toMatchObject({ action: "resumed", by: "model" });
    expect(questions[0]).toMatchObject({ kind: "running", minutesQuiet: 20, resumes: 0, provider: "codex" });
  });

  it("asks once for each slow period, and acts with the local rules when the task is stalled", async () => {
    const { watch, commands, questions, clock } = setup({ tasks: [slowRun()], judge: answering("wait") });
    await watch.tick();
    clock.now = NOW + 5 * MIN;
    await watch.tick();
    expect(questions).toHaveLength(1);
    expect(commands).toEqual([]);
    expect(watch.recent()[0]).toMatchObject({ action: "waited", by: "model" });
    clock.now = NOW + 10 * MIN;
    await watch.tick();
    expect(commands).toEqual(["resume t1"]);
    expect(watch.recent()[0]).toMatchObject({ action: "resumed", by: "local", minutes: 30 });
  });

  it("waits, with the local rules, when the model fails or gives no answer", async () => {
    const failing = setup({
      tasks: [slowRun()],
      judge: { ready: () => true, decide: async () => Promise.reject(new Error("502")) },
    });
    await failing.watch.tick();
    expect(failing.commands).toEqual([]);
    expect(failing.failures).toEqual(["judge t1"]);
    expect(failing.watch.recent()[0]).toMatchObject({ action: "waited", by: "local" });

    const silent = setup({ tasks: [slowRun()], judge: answering(null) });
    await silent.watch.tick();
    expect(silent.commands).toEqual([]);
    expect(silent.watch.recent()[0]).toMatchObject({ action: "waited", by: "local" });
  });

  it(`asks at most ${TASK_WATCH_MODEL_CALLS_PER_HOUR} times in one hour, then decides with the local rules`, async () => {
    const tasks = Array.from({ length: TASK_WATCH_MODEL_CALLS_PER_HOUR + 3 }, (_, index) =>
      run({ taskId: `t${index}`, agentId: `a${index}`, lastEventAt: NOW - (16 + index / 100) * MIN }),
    );
    const { watch, questions, clock, commands } = setup({ tasks, judge: answering("wait") });
    for (let look = 0; look < tasks.length; look += 1) {
      clock.now = NOW + look * 1_000;
      await watch.tick();
    }
    expect(questions).toHaveLength(TASK_WATCH_MODEL_CALLS_PER_HOUR);
    expect(commands).toEqual([]);
    expect(watch.recent()[0]).toMatchObject({ action: "waited", by: "local" });
  });
});

describe("a stop by the person", () => {
  const command = (
    type: "stop" | "resume" | "reassign",
    operationId: string,
    recipientAgentId: string | null = null,
  ): ChannelCommand => ({ type, operationId, channelId: "c1", taskId: "t1", recipientAgentId });
  const stop = (operationId: string) => command("stop", operationId);
  const parents: Record<string, string | null> = { t1: null, child: "t1", grandchild: "child", other: null };
  const parentOf = (taskId: string) => parents[taskId] ?? null;

  it("is a stop that the app did not send, and covers the tasks below it", () => {
    const stops = new DeliberateStops();
    stops.note(stop("stop:click"), false);
    expect(stops.covers("c1", "t1", parentOf)).toBe(true);
    expect(stops.covers("c1", "grandchild", parentOf)).toBe(true);
    expect(stops.covers("c1", "other", parentOf)).toBe(false);
    expect(stops.covers("c2", "t1", parentOf)).toBe(false);
  });

  it("is not a stop of the automatic recovery or of the reviewer, and not a resume by the app", () => {
    const stops = new DeliberateStops();
    stops.note(stop(`${AUTO_OPERATION_PREFIX}1`), true);
    expect(stops.covers("c1", "t1", parentOf)).toBe(false);
    stops.note(stop("work:panel-click"), false);
    stops.note(command("resume", `${AUTO_OPERATION_PREFIX}2`), true);
    expect(stops.covers("c1", "t1", parentOf)).toBe(true);
  });

  it("trusts the sender, not the text of the operation id: a forged app id is still a person's stop", () => {
    const stops = new DeliberateStops();
    stops.note(stop(`${AUTO_OPERATION_PREFIX}forged`), false);
    expect(stops.covers("c1", "t1", parentOf)).toBe(true);
  });

  it("ends when the person continues or reassigns the task", () => {
    const stops = new DeliberateStops();
    stops.note(stop("stop:click"), false);
    stops.note(command("resume", "continue:click"), false);
    expect(stops.covers("c1", "t1", parentOf)).toBe(false);
    stops.note(stop("stop:again"), false);
    stops.note(command("reassign", "reassign:click", "beta"), false);
    expect(stops.covers("c1", "t1", parentOf)).toBe(false);
  });
});

describe("a sleep of the computer (fiscal-resume-grace)", () => {
  // A run that gave a sign one minute before the computer slept for an hour. Its provider sent nothing
  // while the computer slept, so at the wake it reads as quiet for 61 minutes: stalled at N = 15.
  const beforeSleep = () => run({ turnStartedAt: NOW - 10 * MIN, lastEventAt: NOW - MIN });

  it("acts at the first look after the wake while the switch is off, as before", async () => {
    for (const sleepGrace of [undefined, false]) {
      const { watch, clock, commands } = setup({
        tasks: [beforeSleep()],
        ...(sleepGrace === undefined ? {} : { sleepGrace }),
      });
      await watch.tick();
      expect(commands).toEqual([]);
      clock.now += 60 * MIN;
      await watch.tick();
      expect(commands).toEqual(["resume t1"]);
    }
  });

  it("holds every task for two looks after a gap, then counts the time with no sign from the grace", async () => {
    const { watch, clock, commands, logs } = setup({ tasks: [beforeSleep()], sleepGrace: true });
    await watch.tick();
    clock.now += 60 * MIN;
    await watch.tick();
    clock.now += MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    expect(watch.waits().map((wait) => wait.state)).toEqual(["watching"]);
    // After the grace, the run is quiet for one minute only.
    clock.now += MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    // The timer looks each minute. With no sign for twice N from the last look of the grace, it is
    // stalled again: at 61 + 30 minutes.
    while (commands.length === 0 && clock.now < NOW + 120 * MIN) {
      clock.now += MIN;
      await watch.tick();
    }
    expect(commands).toEqual(["resume t1"]);
    expect((clock.now - NOW) / MIN).toBe(91);
    const hold = logs.find((line) => line.message === "The task reviewer holds every task after a sleep.");
    expect(hold?.fields).toEqual({ cause: "gap", gapMinutes: 60, looks: 2 });
  });

  it("holds after the wake event of the computer, also with no gap", async () => {
    const { watch, clock, commands, logs } = setup({
      tasks: [run({ turnStartedAt: NOW - 60 * MIN, lastEventAt: NOW - 40 * MIN })],
      sleepGrace: true,
    });
    watch.noteResume();
    await watch.tick();
    clock.now += MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    expect(logs.some((line) => line.fields.cause === "resume")).toBe(true);
  });

  it("holds a failed start that is due, and acts on it after the grace", async () => {
    const { watch, clock, commands } = setup({ tasks: [failedStart()], sleepGrace: true });
    await watch.tick();
    clock.now += 60 * MIN;
    await watch.tick();
    clock.now += MIN;
    await watch.tick();
    expect(commands).toEqual([]);
    clock.now += MIN;
    await watch.tick();
    expect(commands).toEqual(["resume f1"]);
  });

  it("does not count a gap while the reviewer was off", async () => {
    const { watch, clock, commands, state } = setup({ tasks: [beforeSleep()], sleepGrace: true });
    await watch.tick();
    state.watch = { ...state.watch, enabled: false };
    clock.now += 60 * MIN;
    await watch.tick();
    state.watch = { ...state.watch, enabled: true };
    await watch.tick();
    expect(commands).toEqual(["resume t1"]);
  });
});
