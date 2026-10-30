// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  AutoRecovery,
  type AutoRecoveryDeps,
  autoReassignee,
  decideRecovery,
  MAX_REASSIGNS,
  MAX_RESUMES,
  type RecoveryRecord,
  reassignCandidates,
} from "./auto-recovery";

const MIN = 60_000;
const member = (agentId: string, provider: string, model: string, available = true) => ({
  agentId,
  name: agentId.toUpperCase(),
  provider,
  model,
  available,
});

describe("who can take a stopped task", () => {
  const owner = { agentId: "a", provider: "codex", model: "m1" };
  const members = [
    member("a", "codex", "m1"),
    member("b", "codex", "m1"),
    member("c", "codex", "m2"),
    member("d", "claude", "m9"),
    member("e", "codex", "m1", false),
  ];

  it("leaves out the owner and an agent that is not available, and puts the same model first, then the same provider", () => {
    expect(reassignCandidates(owner, members, new Set()).map((entry) => entry.agentId)).toEqual(["b", "c", "d"]);
  });

  it("flags the same model and the same provider", () => {
    const [b, c, d] = reassignCandidates(owner, members, new Set());
    expect([b?.sameModel, b?.sameProvider]).toEqual([true, true]);
    expect([c?.sameModel, c?.sameProvider]).toEqual([false, true]);
    expect([d?.sameModel, d?.sameProvider]).toEqual([false, false]);
  });

  it("leaves out the agents that were tried already", () => {
    expect(reassignCandidates(owner, members, new Set(["b"])).map((entry) => entry.agentId)).toEqual(["c", "d"]);
  });

  it("lists every available member when the task has no owner", () => {
    expect(reassignCandidates(null, members, new Set()).map((entry) => entry.agentId)).toEqual(["a", "b", "c", "d"]);
  });

  it("is limited in length", () => {
    const many = Array.from({ length: 30 }, (_, index) => member(`x${index}`, "codex", "m1"));
    expect(reassignCandidates(owner, many, new Set()).length).toBeLessThanOrEqual(8);
  });

  it("lets the automatic choice take only the same model or the same provider, never another provider", () => {
    const list = reassignCandidates(owner, members, new Set());
    expect(autoReassignee(list)).toBe("b");
    expect(
      autoReassignee(reassignCandidates(owner, [member("a", "codex", "m1"), member("d", "claude", "m9")], new Set())),
    ).toBeNull();
    expect(
      autoReassignee(reassignCandidates(owner, [member("a", "codex", "m1"), member("c", "codex", "m2")], new Set())),
    ).toBe("c");
  });
});

describe("deciding what to do with a stopped task", () => {
  const prefs = { intervalMs: 30 * MIN, reassign: true };
  const record = (overrides: Partial<RecoveryRecord> = {}): RecoveryRecord => ({
    seenAt: 0,
    lastActionAt: null,
    resumes: 0,
    reassigns: 0,
    tried: [],
    gaveUp: false,
    ...overrides,
  });
  const pick = () => "b";

  it("waits the whole interval from the first time it saw the task", () => {
    expect(decideRecovery(record(), 29 * MIN, prefs, pick)).toBeNull();
    expect(decideRecovery(record(), 30 * MIN, prefs, pick)).toEqual({ type: "resume" });
  });

  it("waits the interval again after each action", () => {
    const r = record({ lastActionAt: 40 * MIN, resumes: 1 });
    expect(decideRecovery(r, 69 * MIN, prefs, pick)).toBeNull();
    expect(decideRecovery(r, 70 * MIN, prefs, pick)).toEqual({ type: "resume" });
  });

  it(`resumes up to ${MAX_RESUMES} times, then reassigns`, () => {
    expect(decideRecovery(record({ resumes: MAX_RESUMES - 1 }), 99 * MIN, prefs, pick)).toEqual({ type: "resume" });
    expect(decideRecovery(record({ resumes: MAX_RESUMES }), 99 * MIN, prefs, pick)).toEqual({
      type: "reassign",
      agentId: "b",
    });
  });

  it("gives up, and says so, when reassigning is off", () => {
    expect(decideRecovery(record({ resumes: MAX_RESUMES }), 99 * MIN, { ...prefs, reassign: false }, pick)).toEqual({
      type: "give-up",
    });
  });

  it("gives up when no other agent can take it", () => {
    expect(decideRecovery(record({ resumes: MAX_RESUMES }), 99 * MIN, prefs, () => null)).toEqual({ type: "give-up" });
  });

  it(`gives up after ${MAX_REASSIGNS} reassignments`, () => {
    expect(decideRecovery(record({ resumes: MAX_RESUMES, reassigns: MAX_REASSIGNS }), 99 * MIN, prefs, pick)).toEqual({
      type: "give-up",
    });
  });

  it("does nothing for a task it gave up on", () => {
    expect(decideRecovery(record({ gaveUp: true }), 999 * MIN, prefs, pick)).toBeNull();
  });
});

describe("the automatic recovery", () => {
  interface Log {
    resumed: string[];
    reassigned: string[];
  }

  function setup(options: { reassign?: boolean; enabled?: boolean; failResume?: boolean } = {}) {
    const clock = { now: 0 };
    const log: Log = { resumed: [], reassigned: [] };
    const stopped: { channelId: string; taskId: string; channelName: string; agentName: string | null }[] = [
      { channelId: "c1", taskId: "t1", channelName: "cadastro", agentName: "Writer" },
    ];
    const deps: AutoRecoveryDeps = {
      preference: () => ({ enabled: options.enabled ?? true, intervalMinutes: 30, reassign: options.reassign ?? true }),
      stopped: () => stopped,
      candidate: () => "b",
      resume: async (channelId, taskId) => {
        if (options.failResume) throw new Error("boom");
        log.resumed.push(`${channelId}:${taskId}`);
      },
      reassign: async (channelId, taskId, agentId) => {
        log.reassigned.push(`${channelId}:${taskId}:${agentId}`);
      },
      now: () => clock.now,
      onFailure: () => {},
    };
    return { recovery: new AutoRecovery(deps), clock, log, stopped };
  }

  it("does nothing while it is off", async () => {
    const { recovery, clock, log } = setup({ enabled: false });
    await recovery.tick();
    clock.now = 999 * MIN;
    await recovery.tick();
    expect(log.resumed).toEqual([]);
  });

  it("sees a task, waits the interval, and resumes it once", async () => {
    const { recovery, clock, log } = setup();
    await recovery.tick();
    clock.now = 29 * MIN;
    await recovery.tick();
    expect(log.resumed).toEqual([]);
    clock.now = 30 * MIN;
    await recovery.tick();
    await recovery.tick();
    expect(log.resumed).toEqual(["c1:t1"]);
  });

  it("does not count the time it was off: turning it on starts the wait from the next look", async () => {
    const state = { enabled: false };
    const clock = { now: 0 };
    const resumed: string[] = [];
    const recovery = new AutoRecovery({
      preference: () => ({ enabled: state.enabled, intervalMinutes: 30, reassign: false }),
      stopped: () => [{ channelId: "c", taskId: "t", channelName: "n", agentName: null }],
      candidate: () => null,
      resume: async (channelId, taskId) => void resumed.push(`${channelId}:${taskId}`),
      reassign: async () => {},
      now: () => clock.now,
      onFailure: () => {},
    });
    await recovery.tick();
    clock.now = 600 * MIN;
    state.enabled = true;
    await recovery.tick();
    expect(resumed).toEqual([]);
    clock.now = 630 * MIN;
    await recovery.tick();
    expect(resumed).toEqual(["c:t"]);
  });

  it("resumes twice, reassigns once the owner keeps failing, and then reports that it gave up", async () => {
    const { recovery, clock, log } = setup();
    await recovery.tick();
    for (let step = 1; step <= 8; step += 1) {
      clock.now = step * 30 * MIN;
      await recovery.tick();
    }
    expect(log.resumed).toHaveLength(MAX_RESUMES);
    expect(log.reassigned.length).toBeGreaterThanOrEqual(1);
    expect(log.reassigned.length).toBeLessThanOrEqual(MAX_REASSIGNS);
    const events = recovery.recent().map((event) => event.action);
    expect(events).toContain("gave-up");
    expect(recovery.statusOf("c1", "t1")).toBe("gave-up");
  });

  it("counts a failed attempt as an attempt, and never throws", async () => {
    const { recovery, clock } = setup({ failResume: true, reassign: false });
    await recovery.tick();
    for (let step = 1; step <= 6; step += 1) {
      clock.now = step * 30 * MIN;
      await expect(recovery.tick()).resolves.toBeUndefined();
    }
    expect(recovery.statusOf("c1", "t1")).toBe("gave-up");
  });

  it("remembers a task that left the list for a while, so a task that fails again is not counted anew", async () => {
    const { recovery, clock, log, stopped } = setup({ reassign: false });
    await recovery.tick();
    clock.now = 30 * MIN;
    await recovery.tick();
    expect(log.resumed).toHaveLength(1);
    const kept = stopped.splice(0);
    clock.now = 40 * MIN;
    await recovery.tick();
    stopped.push(...kept);
    clock.now = 70 * MIN;
    await recovery.tick();
    clock.now = 100 * MIN;
    await recovery.tick();
    expect(log.resumed).toHaveLength(MAX_RESUMES);
    clock.now = 200 * MIN;
    await recovery.tick();
    expect(log.resumed).toHaveLength(MAX_RESUMES);
  });

  it("forgets a task that has not stopped for many hours", async () => {
    const { recovery, clock, stopped } = setup();
    await recovery.tick();
    const kept = stopped.splice(0);
    clock.now = 7 * 60 * MIN;
    await recovery.tick();
    stopped.push(...kept);
    expect(recovery.statusOf("c1", "t1")).toBeNull();
  });

  it("acts on at most a few tasks at each look, so one bad hour cannot start a storm", async () => {
    const clock = { now: 0 };
    const resumed: string[] = [];
    const many = Array.from({ length: 20 }, (_, index) => ({
      channelId: "c",
      taskId: `t${index}`,
      channelName: "n",
      agentName: null,
    }));
    const recovery = new AutoRecovery({
      preference: () => ({ enabled: true, intervalMinutes: 30, reassign: false }),
      stopped: () => many,
      candidate: () => null,
      resume: async (_channelId, taskId) => void resumed.push(taskId),
      reassign: async () => {},
      now: () => clock.now,
      onFailure: () => {},
    });
    await recovery.tick();
    clock.now = 30 * MIN;
    await recovery.tick();
    expect(resumed.length).toBeLessThanOrEqual(3);
    clock.now = 31 * MIN;
    await recovery.tick();
    expect(resumed.length).toBeLessThanOrEqual(6);
  });

  it("keeps a short list of what it did, newest first", async () => {
    const { recovery, clock } = setup();
    await recovery.tick();
    clock.now = 30 * MIN;
    await recovery.tick();
    const [first] = recovery.recent();
    expect(first).toMatchObject({ channelName: "cadastro", action: "resumed", agentName: "Writer" });
    expect(recovery.recent().length).toBeLessThanOrEqual(5);
  });
});
