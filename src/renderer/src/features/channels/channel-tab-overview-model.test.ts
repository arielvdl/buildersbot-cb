import { describe, expect, it } from "vitest";
import {
  channelTabAge,
  isChannelTabPinned,
  orderChannelTabOverview,
  readChannelTabPins,
  toggleChannelTabPin,
} from "./channel-tab-overview-model";

const KEY = "openbot:channel-tab-pins:v1";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const at = (iso: string) => ({ id: iso, name: iso, createdAt: iso, updatedAt: iso, activeTasks: 0 });
const ids = (list: readonly { id: string }[]) => list.map((topic) => topic.id);

describe("the age of a tab", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const before = (ms: number) => new Date(now - ms).toISOString();

  it("reads seconds as now and a clock set back as now", () => {
    expect(channelTabAge(before(5_000), now)).toEqual({ unit: "now", count: 0 });
    expect(channelTabAge(before(-60_000), now)).toEqual({ unit: "now", count: 0 });
  });

  it("counts minutes, hours and days", () => {
    expect(channelTabAge(before(3 * 60_000), now)).toEqual({ unit: "minute", count: 3 });
    expect(channelTabAge(before(5 * 3_600_000), now)).toEqual({ unit: "hour", count: 5 });
    expect(channelTabAge(before(4 * 86_400_000), now)).toEqual({ unit: "day", count: 4 });
  });

  it("gives a date after a month", () => {
    const age = channelTabAge(before(40 * 86_400_000), now);
    expect(age.unit).toBe("date");
    expect(age.unit === "date" && age.at.toISOString()).toBe("2026-09-19T12:00:00.000Z");
  });
});

describe("the order of the tab list", () => {
  const topics = [
    { ...at("2026-10-29T10:00:00.000Z"), id: "old", name: "Antigo" },
    { ...at("2026-10-29T11:59:00.000Z"), id: "new", name: "Vídeo novo" },
    { ...at("2026-10-29T11:00:00.000Z"), id: "mid", name: "Meio", activeTasks: 1 },
  ];

  it("puts the running ones first when asked", () => {
    expect(ids(orderChannelTabOverview(topics, undefined, "running"))).toEqual(["mid", "new", "old"]);
  });

  it("puts the most recent first when asked", () => {
    expect(ids(orderChannelTabOverview(topics, undefined, "recent"))).toEqual(["new", "mid", "old"]);
  });

  it("keeps a pinned tab first whatever the sort is, even an old one", () => {
    expect(ids(orderChannelTabOverview(topics, ["old"], "recent"))).toEqual(["old", "new", "mid"]);
    expect(ids(orderChannelTabOverview(topics, ["old"], "running"))).toEqual(["old", "mid", "new"]);
  });

  it("searches the names without case or accents", () => {
    expect(ids(orderChannelTabOverview(topics, undefined, "recent", "video"))).toEqual(["new"]);
    expect(ids(orderChannelTabOverview(topics, undefined, "recent", "ANTIGO"))).toEqual(["old"]);
    expect(orderChannelTabOverview(topics, undefined, "recent", "nada")).toEqual([]);
  });
});

describe("the pins of a channel's tabs", () => {
  it("pins and unpins a tab per channel", () => {
    const storage = memoryStorage();
    toggleChannelTabPin("one", "b", storage);
    toggleChannelTabPin("one", "a", storage);
    expect(readChannelTabPins(storage)).toEqual({ one: ["b", "a"] });
    toggleChannelTabPin("one", "b", storage);
    expect(readChannelTabPins(storage)).toEqual({ one: ["a"] });
    expect(isChannelTabPinned(["a"], "a")).toBe(true);
    expect(isChannelTabPinned(["a"], "b")).toBe(false);
  });

  it("keeps the pins another window saved for another channel", () => {
    const storage = memoryStorage({ [KEY]: JSON.stringify({ other: ["q"] }) });
    expect(toggleChannelTabPin("one", "b", storage)).toEqual({ other: ["q"], one: ["b"] });
  });

  it("drops the channel key when its last pin goes", () => {
    const storage = memoryStorage({ [KEY]: JSON.stringify({ one: ["a"] }) });
    expect(toggleChannelTabPin("one", "a", storage)).toEqual({});
  });
});
