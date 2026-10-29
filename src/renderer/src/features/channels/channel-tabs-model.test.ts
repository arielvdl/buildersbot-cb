import { describe, expect, it } from "vitest";
import {
  channelTabClose,
  channelTabDropIndex,
  channelTabDropSlot,
  moveChannelTopic,
  orderChannelTopics,
  readChannelTabOrders,
  saveChannelTabOrder,
} from "./channel-tabs-model";

const KEY = "openbot:channel-tab-order:v1";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: readonly { id: string }[]) => list.map((topic) => topic.id);

describe("the saved order of a channel's tabs", () => {
  it("keeps the service's order when nothing is saved", () => {
    expect(ids(orderChannelTopics(tabs("a", "b", "c"), undefined))).toEqual(["a", "b", "c"]);
    expect(ids(orderChannelTopics(tabs("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
  });

  it("puts a tab the order does not name last, and skips a tab that is gone", () => {
    expect(ids(orderChannelTopics(tabs("a", "b", "c", "d"), ["c", "gone", "a"]))).toEqual(["c", "a", "b", "d"]);
  });

  it("names each tab once even when the saved order repeats one", () => {
    expect(ids(orderChannelTopics(tabs("a", "b"), ["b", "b", "a"]))).toEqual(["b", "a"]);
  });

  it("is kept per channel and read back", () => {
    const storage = memoryStorage();
    saveChannelTabOrder("one", ["b", "a"], ["a", "b"], storage);
    saveChannelTabOrder("two", ["y", "x"], ["x", "y"], storage);
    expect(readChannelTabOrders(storage)).toEqual({ one: ["b", "a"], two: ["y", "x"] });
  });

  it("forgets an order that is the service's own", () => {
    const storage = memoryStorage();
    saveChannelTabOrder("one", ["b", "a"], ["a", "b"], storage);
    expect(saveChannelTabOrder("one", ["a", "b"], ["a", "b"], storage)).toEqual({});
    expect(readChannelTabOrders(storage)).toEqual({});
  });

  it("keeps the order another window saved for another channel", () => {
    const storage = memoryStorage({ [KEY]: JSON.stringify({ other: ["q", "p"] }) });
    expect(saveChannelTabOrder("one", ["b", "a"], ["a", "b"], storage)).toEqual({
      other: ["q", "p"],
      one: ["b", "a"],
    });
  });

  it("reads nothing from storage that is not an order", () => {
    expect(readChannelTabOrders(memoryStorage({ [KEY]: "not json" }))).toEqual({});
    expect(readChannelTabOrders(memoryStorage({ [KEY]: JSON.stringify(["a"]) }))).toEqual({});
    expect(
      readChannelTabOrders(memoryStorage({ [KEY]: JSON.stringify({ one: [1, "a", null, "a"], two: "x" }) })),
    ).toEqual({ one: ["a"] });
  });

  it("does not throw when storage refuses a write", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(saveChannelTabOrder("one", ["b", "a"], ["a", "b"], storage)).toEqual({ one: ["b", "a"] });
  });
});

describe("moving a tab", () => {
  it("moves a tab to an index counted without it", () => {
    expect(moveChannelTopic(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveChannelTopic(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveChannelTopic(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
  });

  it("stops at the ends, so a key at the first or last tab changes nothing", () => {
    expect(moveChannelTopic(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveChannelTopic(["a", "b", "c"], "c", 3)).toEqual(["a", "b", "c"]);
  });

  it("leaves the order alone for a tab it does not have", () => {
    expect(moveChannelTopic(["a", "b"], "z", 0)).toEqual(["a", "b"]);
  });

  it("finds the gap under the pointer from the middle of each tab", () => {
    const middles = [10, 30, 50];
    expect(channelTabDropSlot(middles, 0)).toBe(0);
    expect(channelTabDropSlot(middles, 20)).toBe(1);
    expect(channelTabDropSlot(middles, 45)).toBe(2);
    expect(channelTabDropSlot(middles, 80)).toBe(3);
  });

  it("drops a tab in a gap, and a gap beside the tab moves nothing", () => {
    // Tab 1 of a, b, c, d.
    expect(channelTabDropIndex(1, 1)).toBeNull();
    expect(channelTabDropIndex(1, 2)).toBeNull();
    expect(channelTabDropIndex(1, 0)).toBe(0);
    expect(channelTabDropIndex(1, 3)).toBe(2);
    expect(channelTabDropIndex(1, 4)).toBe(3);
    expect(channelTabDropIndex(-1, 0)).toBeNull();
  });
});

describe("closing a tab", () => {
  it("warns of the work when the tab has open tasks", () => {
    expect(channelTabClose({ openTasks: 1, messageCount: 0 })).toBe("confirm-work");
    expect(channelTabClose({ openTasks: 2, messageCount: 5 })).toBe("confirm-work");
    expect(channelTabClose({ openTasks: 1 })).toBe("confirm-work");
  });

  it("asks when the tab has a conversation", () => {
    expect(channelTabClose({ openTasks: 0, messageCount: 3 })).toBe("confirm");
  });

  it("asks when the service did not say what the tab holds", () => {
    expect(channelTabClose({})).toBe("confirm");
    expect(channelTabClose({ messageCount: 0 })).toBe("confirm");
    expect(channelTabClose({ openTasks: 0 })).toBe("confirm");
  });

  it("closes an empty, idle tab at once", () => {
    expect(channelTabClose({ openTasks: 0, messageCount: 0 })).toBe("now");
  });
});
