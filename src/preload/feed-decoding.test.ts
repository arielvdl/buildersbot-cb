// @vitest-environment node

import { FEED_DELTA_LIMIT, FEED_TEXT_LIMIT, type FeedItem } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { decodeFeedDelta, decodeFeedDeltaOrNull, decodeFeedSnapshot } from "./feed-decoding";

const ITEM: FeedItem = {
  v: 1,
  id: "local:t:agent-1:thread-1",
  serverId: "local",
  agentId: "agent-1",
  agentName: "Builder",
  projectId: "section-1",
  projectName: "Site",
  threadId: "thread-1",
  channelId: null,
  taskId: null,
  title: "",
  state: "needs-you",
  startedAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:01:00.000Z",
  endedAt: null,
  lastStep: { at: "2026-11-02T10:00:30.000Z", kind: "progress", text: "Running a command…" },
  steps: [{ at: "2026-11-02T10:00:30.000Z", kind: "progress", text: "Running a command…" }],
  stepCount: 1,
  need: {
    kind: "approval",
    requestId: 7,
    approvalKind: "command",
    label: "git",
    since: "2026-11-02T10:01:00.000Z",
  },
  stop: null,
  actions: ["open"],
  revision: 3,
};

describe("decodeFeedSnapshot", () => {
  it("keeps valid cards and drops fields that the contract does not have", () => {
    const decoded = decodeFeedSnapshot({
      v: 1,
      cursor: 4,
      truncated: false,
      extra: "dropped",
      items: [{ ...ITEM, command: "git push https://x:token@example.com", need: { ...ITEM.need, command: "x" } }],
    });
    expect(decoded).toEqual({ v: 1, cursor: 4, truncated: false, items: [ITEM] });
    expect(decoded.items[0]).not.toHaveProperty("command");
    expect(decoded.items[0]?.need).not.toHaveProperty("command");
  });

  it("refuses a snapshot of another version", () => {
    expect(() => decodeFeedSnapshot({ v: 2, cursor: 0, truncated: false, items: [] })).toThrow(
      "Invalid feed snapshot.",
    );
  });

  it("drops a card with an unknown state, another version or a text over its limit, and keeps the others", () => {
    const decoded = decodeFeedSnapshot({
      v: 1,
      cursor: 1,
      truncated: false,
      items: [
        { ...ITEM, id: "unknown-state", state: "exploded" },
        { ...ITEM, id: "next-version", v: 2 },
        {
          ...ITEM,
          id: "long-step",
          lastStep: { at: ITEM.startedAt, kind: "progress", text: "x".repeat(FEED_TEXT_LIMIT + 1) },
        },
        { ...ITEM, id: "unknown-action", actions: ["delete-everything"] },
        ITEM,
      ],
    });
    expect(decoded.items.map((item) => item.id)).toEqual([ITEM.id]);
  });
});

describe("decodeFeedDelta", () => {
  it("keeps the cards and the removed ids", () => {
    expect(decodeFeedDelta({ v: 1, cursor: 9, upserts: [ITEM], removes: ["local:t:agent-1:old"] })).toEqual({
      v: 1,
      cursor: 9,
      upserts: [ITEM],
      removes: ["local:t:agent-1:old"],
    });
  });

  it("refuses a delta of another version or with more cards than a delta holds", () => {
    expect(() => decodeFeedDelta({ v: 2, cursor: 1, upserts: [], removes: [] })).toThrow("Invalid feed delta.");
    const tooMany = Array.from({ length: FEED_DELTA_LIMIT + 1 }, (_, index) => ({ ...ITEM, id: `card-${index}` }));
    expect(() => decodeFeedDelta({ v: 1, cursor: 1, upserts: tooMany, removes: [] })).toThrow("Invalid feed delta.");
    expect(decodeFeedDeltaOrNull({ v: 2, cursor: 1, upserts: [], removes: [] })).toBeNull();
  });
});
