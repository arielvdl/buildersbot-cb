// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelLanePreferenceStore } from "./channel-lane-preference-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "channel-lane-preference-"));
  roots.push(root);
  return join(root, "lane.json");
}

describe("the one-channel-at-a-time preference", () => {
  it("reads as off when the file is missing", async () => {
    const store = new ChannelLanePreferenceStore(await path());
    await Effect.runPromise(store.load());
    expect(store.get()).toEqual({ enabled: false, order: [] });
  });

  it("reads as off when the file is not JSON or has another shape", async () => {
    const file = await path();
    await writeFile(file, "{ not json");
    const broken = new ChannelLanePreferenceStore(file);
    await Effect.runPromise(broken.load());
    expect(broken.get()).toEqual({ enabled: false, order: [] });

    await writeFile(file, JSON.stringify({ version: 1, enabled: "yes", order: [] }));
    const wrong = new ChannelLanePreferenceStore(file);
    await Effect.runPromise(wrong.load());
    expect(wrong.get().enabled).toBe(false);
  });

  it("keeps what was set across a restart", async () => {
    const file = await path();
    const first = new ChannelLanePreferenceStore(file);
    await Effect.runPromise(first.set({ enabled: true, order: ["b", "a"] }));

    const second = new ChannelLanePreferenceStore(file);
    await Effect.runPromise(second.load());
    expect(second.get()).toEqual({ enabled: true, order: ["b", "a"] });
  });

  it("stores each channel once, in the order given", async () => {
    const store = new ChannelLanePreferenceStore(await path());
    const saved = await Effect.runPromise(store.set({ enabled: true, order: ["b", "a", "b", "c", "a"] }));
    expect(saved.order).toEqual(["b", "a", "c"]);
  });

  it("does not hand out its own list to be changed", async () => {
    const store = new ChannelLanePreferenceStore(await path());
    await Effect.runPromise(store.set({ enabled: true, order: ["a"] }));
    store.get().order.push("z");
    expect(store.get().order).toEqual(["a"]);
  });
});
