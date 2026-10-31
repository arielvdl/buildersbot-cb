import type { ChannelSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_RECENT_WINDOW_MS,
  sidebarActivityHiddenCount,
  sidebarAgentFinishedRecently,
  sidebarAgentPassesActivityFilter,
  sidebarChannelFinishedRecently,
  sidebarChannelPassesActivityFilter,
} from "../../../../../packages/ui/src/features/sidebar/sidebar-activity-filter";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

type Channel = Pick<ChannelSummary, "id" | "activeTasks" | "openTasks" | "lastMessage">;

function channel(id: string, input: Partial<Channel> & { hoursAgo?: number; by?: "agent" | "member" } = {}): Channel {
  const { hoursAgo = 1, by = "agent", ...rest } = input;
  return {
    id,
    activeTasks: 0,
    openTasks: 0,
    lastMessage: {
      authorName: by === "agent" ? "Scout" : "Ariel",
      author: { kind: by, id: by === "agent" ? "scout" : "member-1" },
      status: "completed",
      text: "Done",
      at: at(hoursAgo),
    },
    ...rest,
  };
}

describe("a chat that finished recently", () => {
  it("is an agent with no work now and a message in the last 24 hours", () => {
    expect(sidebarAgentFinishedRecently({ updatedAt: at(2) }, undefined, NOW)).toBe(true);
    expect(sidebarAgentFinishedRecently({ updatedAt: at(2) }, { kind: "unread", count: 1 }, NOW)).toBe(true);
    expect(sidebarAgentFinishedRecently({ updatedAt: at(2) }, { kind: "working" }, NOW)).toBe(false);
    expect(sidebarAgentFinishedRecently({ updatedAt: at(25) }, undefined, NOW)).toBe(false);
    expect(sidebarAgentFinishedRecently({ updatedAt: null }, undefined, NOW)).toBe(false);
    expect(SIDEBAR_RECENT_WINDOW_MS).toBe(24 * HOUR);
  });

  it("is a channel whose newest message is a complete agent reply in the last 24 hours, with no task now", () => {
    expect(sidebarChannelFinishedRecently(channel("a"), undefined, NOW)).toBe(true);
    expect(sidebarChannelFinishedRecently(channel("b", { by: "member" }), undefined, NOW)).toBe(false);
    expect(sidebarChannelFinishedRecently(channel("c", { activeTasks: 1 }), undefined, NOW)).toBe(false);
    expect(sidebarChannelFinishedRecently(channel("d", { hoursAgo: 30 }), undefined, NOW)).toBe(false);
    const wait = { kind: "waiting", reason: "approval", detail: null } as const;
    expect(sidebarChannelFinishedRecently(channel("e"), wait, NOW)).toBe(false);
    const streaming = channel("f");
    expect(
      sidebarChannelFinishedRecently(
        { ...streaming, lastMessage: streaming.lastMessage && { ...streaming.lastMessage, status: "streaming" } },
        undefined,
        NOW,
      ),
    ).toBe(false);
  });

  it("counts the newest message of a host that sends no author or status", () => {
    const older = { ...channel("g"), lastMessage: { authorName: "Scout", text: "Done", at: at(3) } };
    expect(sidebarChannelFinishedRecently(older, undefined, NOW)).toBe(true);
  });
});

describe("the activity filters", () => {
  const idle = { updatedAt: at(3) };

  it("keep every chat with no filter", () => {
    expect(sidebarAgentPassesActivityFilter(null, idle, undefined, false, NOW)).toBe(true);
    expect(sidebarChannelPassesActivityFilter(null, channel("a", { hoursAgo: 90 }), undefined, false, NOW)).toBe(true);
  });

  it("exclude each other: one kind of chat, or the finished ones of both kinds", () => {
    const working = { kind: "working" } as const;
    expect(sidebarAgentPassesActivityFilter("agents", idle, working, false, NOW)).toBe(true);
    expect(sidebarAgentPassesActivityFilter("channels", idle, working, false, NOW)).toBe(false);
    expect(sidebarAgentPassesActivityFilter("finished", idle, working, false, NOW)).toBe(false);
    expect(sidebarAgentPassesActivityFilter("finished", idle, undefined, false, NOW)).toBe(true);
    expect(sidebarAgentPassesActivityFilter("agents", idle, undefined, false, NOW)).toBe(false);
    const busy = channel("b", { activeTasks: 1 });
    expect(sidebarChannelPassesActivityFilter("channels", busy, undefined, false, NOW)).toBe(true);
    expect(sidebarChannelPassesActivityFilter("agents", busy, undefined, false, NOW)).toBe(false);
    expect(sidebarChannelPassesActivityFilter("finished", channel("c"), undefined, false, NOW)).toBe(true);
  });

  it("keep the open chat under a filter that lists its kind", () => {
    expect(sidebarAgentPassesActivityFilter("agents", { updatedAt: null }, undefined, true, NOW)).toBe(true);
    expect(sidebarAgentPassesActivityFilter("finished", { updatedAt: null }, undefined, true, NOW)).toBe(true);
    expect(sidebarAgentPassesActivityFilter("channels", { updatedAt: null }, undefined, true, NOW)).toBe(false);
    expect(sidebarChannelPassesActivityFilter("agents", channel("d"), undefined, true, NOW)).toBe(false);
  });
});

describe("the chats that a filter hides", () => {
  const input = {
    agents: [
      { id: "scout", updatedAt: at(1) },
      { id: "writer", updatedAt: at(40) },
      { id: "hacker", updatedAt: at(2) },
    ],
    channels: [channel("launch"), channel("ops", { activeTasks: 2 }), channel("old", { hoursAgo: 50 })],
    agentStates: { hacker: { kind: "working" } as const },
    activeAgentId: "writer",
    now: NOW,
  };

  it("are none with no filter", () => {
    expect(sidebarActivityHiddenCount({ ...input, filter: null })).toBe(0);
  });

  it("are counted for each filter, without the open chat", () => {
    // Active channels: every agent and the two channels with no task.
    expect(sidebarActivityHiddenCount({ ...input, filter: "channels" })).toBe(5);
    // Active agents: scout (idle) and the three channels; the open writer stays.
    expect(sidebarActivityHiddenCount({ ...input, filter: "agents" })).toBe(4);
    // Finished recently: hacker works, ops works, old is too old; the open writer stays.
    expect(sidebarActivityHiddenCount({ ...input, filter: "finished" })).toBe(3);
  });
});
