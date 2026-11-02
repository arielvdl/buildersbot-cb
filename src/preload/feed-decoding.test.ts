// @vitest-environment node

import {
  FEED_CANDIDATE_LIMIT,
  FEED_CHOICE_LIMIT,
  FEED_DELTA_LIMIT,
  FEED_TEXT_LIMIT,
  type FeedItem,
} from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { decodeFeedActionResult, decodeFeedDelta, decodeFeedDeltaOrNull, decodeFeedSnapshot } from "./feed-decoding";

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

describe("the fields of stage 2", () => {
  const ACTIONS: FeedItem = {
    ...ITEM,
    id: "local:t:agent-1:thread-2",
    need: {
      kind: "approval",
      requestId: 8,
      approvalKind: "permissions",
      label: "",
      since: ITEM.startedAt,
      risk: "high",
      reason: "The Guard asks you to check this step.",
      access: { network: true, write: 2 },
    },
    reassignTo: [{ agentId: "agent-2", name: "Helper" }],
    actions: ["open", "approve", "deny"],
  };
  const QUESTION: FeedItem = {
    ...ITEM,
    id: "local:t:agent-1:thread-3",
    need: {
      kind: "prompt",
      requestId: "prompt-1",
      label: "Which one?",
      questionCount: 1,
      since: ITEM.startedAt,
      form: { choices: ["A", "B"], text: true },
    },
    actions: ["open", "answer"],
  };

  it("copies the risk, the access, the form and the candidates, and drops what the contract does not have", () => {
    const decoded = decodeFeedSnapshot({
      v: 1,
      cursor: 1,
      truncated: false,
      items: [
        {
          ...ACTIONS,
          need: { ...ACTIONS.need, command: "rm -rf /", access: { ...ACTIONS.need?.access, paths: ["/etc"] } },
          reassignTo: [{ agentId: "agent-2", name: "Helper", provider: "codex" }],
        },
        { ...QUESTION, need: { ...QUESTION.need, form: { choices: ["A", "B"], text: true, labels: ["raw"] } } },
      ],
    });
    expect(decoded.items).toEqual([ACTIONS, QUESTION]);
  });

  it("drops a card with too many choices, too many candidates or an unknown risk", () => {
    const decoded = decodeFeedSnapshot({
      v: 1,
      cursor: 1,
      truncated: false,
      items: [
        {
          ...QUESTION,
          id: "many-choices",
          need: {
            ...QUESTION.need,
            form: { choices: Array.from({ length: FEED_CHOICE_LIMIT + 1 }, (_, i) => `c${i}`), text: true },
          },
        },
        {
          ...ACTIONS,
          id: "many-candidates",
          reassignTo: Array.from({ length: FEED_CANDIDATE_LIMIT + 1 }, (_, i) => ({ agentId: `a${i}`, name: "A" })),
        },
        { ...ACTIONS, id: "unknown-risk", need: { ...ACTIONS.need, risk: "medium" } },
        ITEM,
      ],
    });
    expect(decoded.items.map((item) => item.id)).toEqual([ITEM.id]);
  });
});

describe("decodeFeedActionResult", () => {
  it("keeps the count and the failures, and drops other fields", () => {
    expect(
      decodeFeedActionResult({
        v: 1,
        done: 1,
        failed: [{ itemId: "local:task:t1", reason: "stale", cause: "Error: secret" }],
        stack: "x",
      }),
    ).toEqual({ v: 1, done: 1, failed: [{ itemId: "local:task:t1", reason: "stale" }] });
  });

  it("refuses another version and an unknown reason", () => {
    expect(() => decodeFeedActionResult({ v: 2, done: 0, failed: [] })).toThrow("Invalid feed action result.");
    expect(() =>
      decodeFeedActionResult({ v: 1, done: 0, failed: [{ itemId: "local:task:t1", reason: "exploded" }] }),
    ).toThrow("Invalid feed action result.");
  });
});
