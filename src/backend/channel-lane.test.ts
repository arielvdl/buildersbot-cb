// @vitest-environment node
// The one-channel-at-a-time lane: which channels may start work while the mode is on.
import { describe, expect, it } from "vitest";
import { admittedChannels, nextLaneChannel } from "./channel-lane";

describe("the next channel of the lane", () => {
  it("takes the first channel of the user's order that has work", () => {
    expect(nextLaneChannel(["b", "a"], ["a", "b", "c"])).toBe("b");
  });

  it("skips an ordered channel with no work", () => {
    expect(nextLaneChannel(["x", "b"], ["a", "b"])).toBe("b");
  });

  it("takes the channel that has waited longest when none is ordered", () => {
    expect(nextLaneChannel([], ["c", "a"])).toBe("c");
  });

  it("takes an ordered channel before one that was never ordered", () => {
    expect(nextLaneChannel(["b"], ["a", "b"])).toBe("b");
  });

  it("is undefined when nothing has work", () => {
    expect(nextLaneChannel(["a"], [])).toBeUndefined();
  });
});

describe("the channels the lane lets start", () => {
  const base = { order: ["b", "a"], runnable: ["a", "b"], busy: new Set<string>(), forced: new Set<string>() };

  it("filters nothing while the mode is off", () => {
    expect(admittedChannels({ ...base, enabled: false })).toBeNull();
  });

  it("admits only the first channel when none is busy", () => {
    expect(admittedChannels({ ...base, enabled: true })).toEqual(new Set(["b"]));
  });

  it("admits only the channel that works, and queues the rest, while one is busy", () => {
    expect(admittedChannels({ ...base, enabled: true, busy: new Set(["a"]) })).toEqual(new Set(["a"]));
  });

  it("admits a channel the user chose to run now beside the busy one", () => {
    expect(admittedChannels({ ...base, enabled: true, busy: new Set(["a"]), forced: new Set(["b"]) })).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("admits the requested channel when nothing has work, so a first message is routed", () => {
    expect(admittedChannels({ ...base, enabled: true, runnable: [], requested: "c" })).toEqual(new Set(["c"]));
  });

  it("admits nothing new when nothing has work and none is requested", () => {
    expect(admittedChannels({ ...base, enabled: true, runnable: [] })).toEqual(new Set());
  });
});
