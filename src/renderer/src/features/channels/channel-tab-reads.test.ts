import type { ChannelTopic } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { ChannelReadMarks, channelReadCommand, openTabUnreadCount, unreadChannelTabs } from "./channel-tab-reads";

const tab = (id: string, unreadCount?: number): ChannelTopic => ({
  id,
  channelId: "channel",
  name: id,
  createdAt: "2026-10-29T00:00:00.000Z",
  revision: 0,
  ...(unreadCount === undefined ? {} : { unreadCount }),
});

describe("the unread count of the open tab", () => {
  // The QA run: the second tab had one unread, and an empty Main showed "1 new message".
  it("is the open tab's, not the channel's that sums every tab", () => {
    const summary = { unreadCount: 4, topics: [tab("main", 3), tab("second", 1)] };
    expect(openTabUnreadCount(summary, "main")).toBe(3);
    expect(openTabUnreadCount(summary, "second")).toBe(1);
    expect(openTabUnreadCount({ unreadCount: 1, topics: [tab("main", 0), tab("second", 1)] }, "main")).toBe(0);
  });

  it("is the channel's on a host without tabs", () => {
    expect(openTabUnreadCount({ unreadCount: 2 }, "")).toBe(2);
    expect(openTabUnreadCount({ unreadCount: 2 }, undefined)).toBe(2);
  });

  it("is nothing for a tab the list does not name, or before the list arrives", () => {
    expect(openTabUnreadCount({ unreadCount: 2, topics: [tab("main", 2)] }, "new")).toBe(0);
    expect(openTabUnreadCount({ unreadCount: 2, topics: [tab("main", 2)] }, undefined)).toBe(0);
    expect(openTabUnreadCount(undefined, "main")).toBe(0);
  });
});

describe("the read of a page", () => {
  it("names the page's tab, so Mark as read moves the cursor of the tab on screen", () => {
    expect(channelReadCommand("channel", { topicId: "second", throughSequence: 12 }, "op")).toEqual({
      type: "read",
      channelId: "channel",
      topicId: "second",
      throughSequence: 12,
      operationId: "op",
    });
  });

  it("names no tab for a page of a host without tabs", () => {
    expect(channelReadCommand("channel", { topicId: "", throughSequence: 3 }, "op")).toEqual({
      type: "read",
      channelId: "channel",
      throughSequence: 3,
      operationId: "op",
    });
  });
});

describe("the tabs Mark all read reads", () => {
  it("reads every unread tab, and no tab of a read channel", () => {
    expect(
      unreadChannelTabs([
        { id: "one", unreadCount: 3, topics: [tab("main", 1), tab("second", 0), tab("third", 2)] },
        { id: "two", unreadCount: 0, topics: [tab("other", 0)] },
      ]),
    ).toEqual([
      { channelId: "one", topicId: "main" },
      { channelId: "one", topicId: "third" },
    ]);
  });

  it("reads the channel as before tabs when the list has no tab counts", () => {
    expect(
      unreadChannelTabs([
        { id: "old", unreadCount: 2 },
        { id: "uncounted", unreadCount: 1, topics: [tab("main")] },
      ]),
    ).toEqual([{ channelId: "old" }, { channelId: "uncounted" }]);
  });
});

describe("the reads already sent", () => {
  it("keeps a mark per tab, so an older sequence in another tab is still read", () => {
    const marks = new ChannelReadMarks();
    expect(marks.claim("channel", "second", 10)).toBe(true);
    expect(marks.claim("channel", "main", 9)).toBe(true);
    expect(marks.claim("channel", "main", 9)).toBe(false);
    expect(marks.claim("channel", "second", 10)).toBe(false);
    expect(marks.claim("other", "main", 9)).toBe(true);
  });

  it("sends a read again after it failed, or after its channel went", () => {
    const marks = new ChannelReadMarks();
    marks.claim("channel", "main", 4);
    marks.claim("channel", "second", 6);
    marks.claim("other", "main", 5);
    marks.release("channel", "main");
    expect(marks.claim("channel", "main", 4)).toBe(true);
    marks.forget("channel");
    expect(marks.claim("channel", "second", 6)).toBe(true);
    expect(marks.claim("other", "main", 5)).toBe(false);
    marks.clear();
    expect(marks.claim("other", "main", 5)).toBe(true);
  });
});
