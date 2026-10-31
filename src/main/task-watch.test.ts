// @vitest-environment node
import type { AutoRecoveryPreference, ChannelCommand, TaskWatchPreference } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { type LedgerRecord, MAX_REASSIGNS, MAX_RESUMES, RecoveryLedger } from "./auto-recovery";
import {
  AUTO_OPERATION_PREFIX,
  classifyQuiet,
  DeliberateStops,
  runningQuiet,
  TASK_WATCH_MODEL_CALLS_PER_HOUR,
  TaskWatch,
  type TaskWatchDeps,
  type WatchedTask,
  type WatchObservation,
  watchAction,
  watchCandidates,
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
  state: { watch: TaskWatchPreference; recovery: AutoRecoveryPreference; dropped: boolean };
}

function setup(
  options: {
    tasks?: WatchObservation[];
    judge?: TaskWatchJudge | null;
    reassign?: boolean;
    candidate?: string | null;
    failCommand?: boolean;
  } = {},
): Setup {
  const clock = { now: NOW };
  const ledger = new RecoveryLedger();
  const tasks = options.tasks ?? [];
  const commands: string[] = [];
  const questions: TaskWatchJudgeInput[] = [];
  const failures: string[] = [];
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
    log: { info: () => {} },
  };
  return { watch: new TaskWatch(deps), ledger, clock, tasks, commands, questions, failures, state };
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

  it("gives a failed start one resume only, because the same agent failed to start it already", () => {
    expect(watchAction("start-failed", { resumes: 0, reassigns: 0 }, true, pick)).toEqual({ type: "resume" });
    expect(watchAction("start-failed", { resumes: 1, reassigns: 0 }, true, pick)).toEqual({
      type: "reassign",
      agentId: "beta",
    });
  });

  it("never reassigns when the person did not allow it, or when no agent can take the task", () => {
    expect(watchAction("start-failed", { resumes: 1, reassigns: 0 }, false, pick)).toEqual({ type: "give-up" });
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

  it("leaves a start that fails again, and says so, when reassigning is off", async () => {
    const { watch, commands, clock, ledger } = setup({ tasks: [failedStart()], reassign: false });
    ledger.see("c1", "f1", NOW - 60 * MIN).resumes = 1;
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
    stops.note(stop("stop:click"));
    expect(stops.covers("c1", "t1", parentOf)).toBe(true);
    expect(stops.covers("c1", "grandchild", parentOf)).toBe(true);
    expect(stops.covers("c1", "other", parentOf)).toBe(false);
    expect(stops.covers("c2", "t1", parentOf)).toBe(false);
  });

  it("is not a stop of the automatic recovery or of the reviewer, and not a resume by the app", () => {
    const stops = new DeliberateStops();
    stops.note(stop(`${AUTO_OPERATION_PREFIX}1`));
    expect(stops.covers("c1", "t1", parentOf)).toBe(false);
    stops.note(stop("work:panel-click"));
    stops.note(command("resume", `${AUTO_OPERATION_PREFIX}2`));
    expect(stops.covers("c1", "t1", parentOf)).toBe(true);
  });

  it("ends when the person continues or reassigns the task", () => {
    const stops = new DeliberateStops();
    stops.note(stop("stop:click"));
    stops.note(command("resume", "continue:click"));
    expect(stops.covers("c1", "t1", parentOf)).toBe(false);
    stops.note(stop("stop:again"));
    stops.note(command("reassign", "reassign:click", "beta"));
    expect(stops.covers("c1", "t1", parentOf)).toBe(false);
  });
});
