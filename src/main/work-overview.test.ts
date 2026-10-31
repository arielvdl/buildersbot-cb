// @vitest-environment node
import type { ChannelTask } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { buildRunningWork, buildStoppedWork, clipText, runningAgentCount } from "./work-overview";

function task(id: string, overrides: Partial<ChannelTask> = {}): ChannelTask {
  return {
    id,
    channelId: "c1",
    topicId: "t1",
    parentTaskId: null,
    rootTaskId: id,
    ownerAgentId: "writer",
    requestMessageId: `${id}-message`,
    instruction: `Do ${id}`,
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: "queued",
    revision: 0,
    assignmentCount: 0,
    error: null,
    ...overrides,
  };
}

const names = (id: string) => ({ writer: "Writer", qa: "QA Naia" })[id] ?? null;
const topics = (topicId: string) => ({ t1: "Main", t2: "cadastro" })[topicId] ?? null;

describe("clipping text", () => {
  it("keeps a short text, collapses spaces, and ends a long one with an ellipsis within the limit", () => {
    expect(clipText("  a   b\n c ", 20)).toBe("a b c");
    const clipped = clipText("x".repeat(300), 50);
    expect(clipped.length).toBeLessThanOrEqual(50);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("the stopped work of the channels", () => {
  const channel = (tasks: ChannelTask[], overrides: { archived?: boolean } = {}) => ({
    id: "c1",
    name: "cadastro",
    archived: overrides.archived ?? false,
    tasks,
    topicName: topics,
  });

  it("lists a paused or failed task that has a reason, with the channel, its tab, the request and the reason", () => {
    const stopped = buildStoppedWork(
      [channel([task("a", { state: "failed", error: "The provider could not start this assignment." })])],
      names,
    );
    expect(stopped).toEqual([
      {
        channelId: "c1",
        channelName: "cadastro",
        topicName: "Main",
        taskId: "a",
        title: "Do a",
        reason: "The provider could not start this assignment.",
        agentName: "Writer",
        state: "failed",
        candidates: [],
        auto: null,
      },
    ]);
  });

  it("adds what the caller knows about each task: the agents that can take it and what the automatic recovery does", () => {
    const [entry] = buildStoppedWork(
      [channel([task("a", { state: "failed", error: "x" })])],
      names,
      (channelId, stoppedTask) => ({
        candidates: [{ agentId: `${channelId}-${stoppedTask.id}`, name: "QA Naia", sameModel: true }],
        auto: "waiting",
      }),
    );
    expect(entry?.candidates).toEqual([{ agentId: "c1-a", name: "QA Naia", sameModel: true }]);
    expect(entry?.auto).toBe("waiting");
  });

  it("names the tab of each task, and no tab when the task has none or its tab is gone", () => {
    const stopped = buildStoppedWork(
      [
        channel([
          task("a", { state: "failed", error: "x", topicId: "t2" }),
          task("b", { state: "failed", error: "x", topicId: "gone" }),
          task("c", { state: "failed", error: "x", topicId: undefined }),
        ]),
      ],
      names,
    );
    expect(stopped.map((entry) => entry.topicName)).toEqual(["cadastro", null, null]);
  });

  it("skips a task with no reason: it was stopped on purpose or never ran", () => {
    expect(buildStoppedWork([channel([task("a", { state: "paused", error: null })])], names)).toEqual([]);
    expect(buildStoppedWork([channel([task("a", { state: "queued", error: "x" })])], names)).toEqual([]);
  });

  it("lists a run once, by its root, when the root and a child both stopped", () => {
    const root = task("root", { state: "paused", error: "The previous turn has no confirmed result." });
    const child = task("child", { rootTaskId: "root", parentTaskId: "root", state: "failed", error: "boom" });
    const stopped = buildStoppedWork([channel([child, root])], names);
    expect(stopped.map((entry) => entry.taskId)).toEqual(["root"]);
  });

  it("lists the child when only the child stopped", () => {
    const root = task("root", { state: "running" });
    const child = task("child", { rootTaskId: "root", parentTaskId: "root", state: "failed", error: "boom" });
    expect(buildStoppedWork([channel([root, child])], names).map((entry) => entry.taskId)).toEqual(["child"]);
  });

  it("skips an archived channel", () => {
    expect(
      buildStoppedWork([channel([task("a", { state: "failed", error: "x" })], { archived: true })], names),
    ).toEqual([]);
  });

  it("names no agent for a task with no owner or a deleted one", () => {
    const stopped = buildStoppedWork(
      [
        channel([
          task("a", { state: "failed", error: "x", ownerAgentId: "gone" }),
          task("b", { state: "failed", error: "y", ownerAgentId: null }),
        ]),
      ],
      names,
    );
    expect(stopped.map((entry) => entry.agentName)).toEqual([null, null]);
  });

  it("clips a long request and a long reason, and keeps the most recent first up to the limit", () => {
    const many = Array.from({ length: 70 }, (_, index) =>
      task(`t${index}`, { state: "failed", error: "r".repeat(500), instruction: "i".repeat(5_000) }),
    );
    const stopped = buildStoppedWork([channel(many)], names);
    expect(stopped).toHaveLength(50);
    expect(stopped[0]?.title.length).toBeLessThanOrEqual(1_000);
    expect(stopped[0]?.reason.length).toBeLessThanOrEqual(200);
  });

  it("goes through several channels in the order given", () => {
    const stopped = buildStoppedWork(
      [
        {
          id: "c1",
          name: "one",
          archived: false,
          tasks: [task("a", { channelId: "c1", state: "failed", error: "x" })],
          topicName: topics,
        },
        {
          id: "c2",
          name: "two",
          archived: false,
          tasks: [task("b", { channelId: "c2", state: "paused", error: "y" })],
          topicName: topics,
        },
      ],
      names,
    );
    expect(stopped.map((entry) => `${entry.channelName}:${entry.taskId}`)).toEqual(["one:a", "two:b"]);
  });
});

describe("the count of the agents that run", () => {
  const turn = (turnId: string, agentId: string) => ({ turnId, agentId, threadId: `${agentId}-thread`, startedAt: "" });

  it("counts each agent one time, also an agent with turns in its chat and in a channel", () => {
    expect(runningAgentCount([])).toBe(0);
    expect(runningAgentCount([turn("a", "writer")])).toBe(1);
    expect(runningAgentCount([turn("a", "writer"), turn("b", "writer"), turn("c", "qa")])).toBe(2);
  });

  it("goes past ten, with no cap", () => {
    const turns = Array.from({ length: 12 }, (_, index) => turn(`t${index}`, `agent-${index}`));
    expect(runningAgentCount(turns)).toBe(12);
  });
});

describe("the running work", () => {
  const turn = (turnId: string, agentId: string, threadId: string) => ({
    turnId,
    agentId,
    threadId,
    startedAt: "2026-10-30T21:00:00.000Z",
  });

  it("says where a turn runs: in a channel with its tab and task, or in the chat of the agent", () => {
    const running = buildRunningWork([turn("a", "writer", "ch-thread"), turn("b", "qa", "chat-thread")], {
      agentName: names,
      channelOfThread: (threadId) => (threadId === "ch-thread" ? { id: "c1", name: "cadastro" } : null),
      taskOf: (channelId, agentId) =>
        channelId === "c1" && agentId === "writer" ? { taskId: "t9", title: "Fix the form", topicId: "t2" } : null,
      topicName: (channelId, topicId) => (channelId === "c1" ? topics(topicId) : null),
    });
    expect(running).toEqual([
      {
        turnId: "a",
        agentId: "writer",
        agentName: "Writer",
        channelId: "c1",
        channelName: "cadastro",
        topicName: "cadastro",
        taskId: "t9",
        title: "Fix the form",
        startedAt: "2026-10-30T21:00:00.000Z",
      },
      {
        turnId: "b",
        agentId: "qa",
        agentName: "QA Naia",
        channelId: null,
        channelName: null,
        topicName: null,
        taskId: null,
        title: "",
        startedAt: "2026-10-30T21:00:00.000Z",
      },
    ]);
  });

  it("keeps a channel turn whose task is not found, and names an agent that is gone by its id", () => {
    const [entry] = buildRunningWork([turn("a", "ghost", "ch-thread")], {
      agentName: names,
      channelOfThread: () => ({ id: "c1", name: "cadastro" }),
      taskOf: () => null,
      topicName: topics,
    });
    expect(entry).toMatchObject({ agentName: "ghost", channelId: "c1", topicName: null, taskId: null, title: "" });
  });
});
