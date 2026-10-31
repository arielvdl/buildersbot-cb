import type { LoadSnapshot } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  activeAgentLimit,
  clampAgentLimit,
  clampRecoveryMinutes,
  clampWatchMinutes,
  elapsedMinutes,
  formatGigabytes,
  loadAgentArc,
  loadLaneRows,
  loadMemoryPercent,
  loadRecentEvents,
  loadRingTone,
  loadTone,
  requestText,
  stoppedCount,
  stoppedTone,
  toggledKey,
  withChannelFirst,
} from "../../../../../packages/ui/src/features/window/load-view";

function snapshot(overrides: Partial<LoadSnapshot> = {}): LoadSnapshot {
  return {
    sampledAt: "2026-10-30T20:00:00.000Z",
    memory: { usedMb: 8192, agentsMb: 6000, totalMb: 32768 },
    activeAgents: 2,
    providerProcesses: 40,
    lane: { enabled: true, order: ["b", "a"], running: ["a"], queued: ["b", "c"] },
    running: [],
    waiting: [],
    stopped: [],
    recovery: { enabled: false, intervalMinutes: 30, reassign: false, recent: [] },
    agentLimit: { enabled: false, max: 10 },
    taskWatch: { enabled: false, quietMinutes: 15, active: false, modelReady: false, recent: [] },
    ...overrides,
  };
}

describe("the load ring", () => {
  it("reads the share of memory in use", () => {
    expect(loadMemoryPercent(snapshot())).toBe(25);
  });

  it("has no share before the first sample, and keeps it between 0 and 100", () => {
    expect(loadMemoryPercent(snapshot({ memory: { usedMb: null, agentsMb: null, totalMb: 32768 } }))).toBeNull();
    expect(loadMemoryPercent(snapshot({ memory: { usedMb: 99999, agentsMb: 0, totalMb: 32768 } }))).toBe(100);
    expect(loadMemoryPercent(snapshot({ memory: { usedMb: 10, agentsMb: 0, totalMb: 0 } }))).toBeNull();
  });

  it("turns amber at 60% and red at 80%", () => {
    expect(loadTone(null)).toBe("ok");
    expect(loadTone(59)).toBe("ok");
    expect(loadTone(60)).toBe("warning");
    expect(loadTone(79)).toBe("warning");
    expect(loadTone(80)).toBe("critical");
  });

  it("writes memory short", () => {
    expect(formatGigabytes(512)).toBe("0.5 GB");
    expect(formatGigabytes(7625)).toBe("7.4 GB");
    expect(formatGigabytes(32768)).toBe("32 GB");
  });
});

describe("the arc and the colour of the ring", () => {
  it("is the agents that run, of ten, and stays full above ten", () => {
    expect(loadAgentArc(0)).toBe(0);
    expect(loadAgentArc(3)).toBe(30);
    expect(loadAgentArc(10)).toBe(100);
    expect(loadAgentArc(12)).toBe(100);
  });

  it("is the agents of the limit when the person set one", () => {
    expect(loadAgentArc(3, 4)).toBe(75);
    expect(loadAgentArc(4, 4)).toBe(100);
    expect(loadAgentArc(3, 10)).toBe(30);
    expect(activeAgentLimit(snapshot())).toBeNull();
    expect(activeAgentLimit(snapshot({ agentLimit: { enabled: true, max: 4 } }))).toBe(4);
  });

  it("keeps the limit a whole number from 1 to 64, and 10 for a value that is not a number", () => {
    expect(clampAgentLimit(0)).toBe(1);
    expect(clampAgentLimit(3.6)).toBe(4);
    expect(clampAgentLimit(100)).toBe(64);
    expect(clampAgentLimit(Number.NaN)).toBe(10);
  });

  it("takes its colour from the memory: what macOS says, else the share in use", () => {
    expect(loadRingTone(snapshot())).toBe("ok");
    expect(loadRingTone(snapshot({ memory: { usedMb: 28_000, agentsMb: 0, totalMb: 32_768 } }))).toBe("critical");
    const pressure = (level: "ok" | "low" | "critical") =>
      snapshot({
        memory: { usedMb: 8192, agentsMb: 0, totalMb: 32_768, pressure: { level, freePercent: 9, swapUsedMb: 0 } },
      });
    expect(loadRingTone(pressure("low"))).toBe("warning");
    expect(loadRingTone(pressure("critical"))).toBe("critical");
  });
});

describe("the channel lane in the panel", () => {
  it("lists the channels that run before the ones that wait, with a place for each waiting one", () => {
    expect(loadLaneRows(snapshot())).toEqual([
      { id: "a", status: "running" },
      { id: "b", status: "queued", position: 1 },
      { id: "c", status: "queued", position: 2 },
    ]);
  });

  it("puts a channel first without losing the rest of the order", () => {
    expect(withChannelFirst(snapshot(), "c")).toEqual({ enabled: true, order: ["c", "b", "a"] });
    expect(withChannelFirst(snapshot(), "a")).toEqual({ enabled: true, order: ["a", "b"] });
  });
});

describe("the recovery interval", () => {
  it("keeps a whole number of minutes between 5 and 1440", () => {
    expect(clampRecoveryMinutes(30)).toBe(30);
    expect(clampRecoveryMinutes(2)).toBe(5);
    expect(clampRecoveryMinutes(99999)).toBe(1440);
    expect(clampRecoveryMinutes(17.6)).toBe(18);
  });

  it("falls back to 30 for a value that is not a number", () => {
    expect(clampRecoveryMinutes(Number.NaN)).toBe(30);
    expect(clampRecoveryMinutes(Number.POSITIVE_INFINITY)).toBe(30);
  });
});

describe("the task reviewer in the panel", () => {
  it("keeps its threshold a whole number of minutes between 5 and 120, and 15 for a value that is not a number", () => {
    expect(clampWatchMinutes(15)).toBe(15);
    expect(clampWatchMinutes(1)).toBe(5);
    expect(clampWatchMinutes(500)).toBe(120);
    expect(clampWatchMinutes(22.4)).toBe(22);
    expect(clampWatchMinutes(Number.NaN)).toBe(15);
  });

  it("lists its actions in Lately beside those of the automatic recovery, the newest first", () => {
    const events = loadRecentEvents(
      snapshot({
        recovery: {
          enabled: true,
          intervalMinutes: 30,
          reassign: true,
          recent: [{ at: "2026-10-30T20:10:00.000Z", channelName: "bugs", action: "resumed", agentName: null }],
        },
        taskWatch: {
          enabled: true,
          quietMinutes: 15,
          active: true,
          modelReady: false,
          recent: [
            {
              at: "2026-10-30T20:20:00.000Z",
              channelName: "pagamentos",
              action: "reassigned",
              agentName: "QA",
              reason: "no-sign",
              minutes: 32,
              by: "local",
            },
            {
              at: "2026-10-30T20:00:00.000Z",
              channelName: "deploys",
              action: "waited",
              agentName: null,
              reason: "queued",
              minutes: 18,
              by: "model",
            },
          ],
        },
      }),
    );
    expect(events.map((entry) => `${entry.by}:${entry.event.channelName}`)).toEqual([
      "reviewer:pagamentos",
      "recovery:bugs",
      "reviewer:deploys",
    ]);
  });
});

describe("the time a turn has run", () => {
  it("counts whole minutes, and never goes below zero", () => {
    expect(elapsedMinutes("2026-10-30T20:00:00.000Z", Date.parse("2026-10-30T20:07:30.000Z"))).toBe(7);
    expect(elapsedMinutes("2026-10-30T20:00:00.000Z", Date.parse("2026-10-30T19:00:00.000Z"))).toBe(0);
    expect(elapsedMinutes("not a date", Date.now())).toBe(0);
  });
});

describe("the alert of stopped work", () => {
  const row = (taskId: string) => ({
    channelId: "c",
    channelName: "cadastro",
    topicName: null,
    taskId,
    title: "Do it",
    reason: "boom",
    agentName: null,
    state: "failed" as const,
    candidates: [],
    auto: null,
  });

  it("counts the stopped work that the panel lists", () => {
    expect(stoppedCount(snapshot())).toBe(0);
    expect(stoppedCount(snapshot({ stopped: [row("a"), row("b")] }))).toBe(2);
  });

  it("marks a failed task as an error and a paused one as a warning", () => {
    expect(stoppedTone("failed")).toBe("danger");
    expect(stoppedTone("paused")).toBe("warning");
  });
});

describe("the request of a task in the panel", () => {
  it("removes the attachment marks and counts them", () => {
    expect(requestText("Fix the form @[image.png](attachment:a1) as in @[shot.png](attachment:a2) please")).toEqual({
      text: "Fix the form as in please",
      attachments: 2,
    });
  });

  it("keeps a request with no marks as it is", () => {
    expect(requestText("Publish the answer in the channel")).toEqual({
      text: "Publish the answer in the channel",
      attachments: 0,
    });
  });

  it("removes a mark that the clip cut, and keeps the ellipsis", () => {
    expect(requestText("Check this @[image.png](attachm…")).toEqual({ text: "Check this …", attachments: 1 });
    expect(requestText("Check this @[ima…")).toEqual({ text: "Check this …", attachments: 1 });
    expect(requestText("Check this @[image.png]…")).toEqual({ text: "Check this …", attachments: 1 });
  });

  it("has no text when the request is only attachments", () => {
    expect(requestText("@[image.png](attachment:a1)")).toEqual({ text: "", attachments: 1 });
    expect(requestText("@[image.png](attach…")).toEqual({ text: "", attachments: 1 });
  });

  it("keeps an ellipsis that is not part of a mark", () => {
    expect(requestText("Wait for it…")).toEqual({ text: "Wait for it…", attachments: 0 });
  });
});

describe("the expanded requests", () => {
  it("adds a request that is closed, and removes one that is open", () => {
    const open = toggledKey(new Set(), "c1:t1");
    expect([...open]).toEqual(["c1:t1"]);
    expect([...toggledKey(open, "c1:t2")]).toEqual(["c1:t1", "c1:t2"]);
    expect([...toggledKey(open, "c1:t1")]).toEqual([]);
  });
});
