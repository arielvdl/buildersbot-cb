// @vitest-environment node
// The event log of a channel: every change writes the whole channel, so only the newest one can ever
// be read. Without pruning the log grew by a channel per change - 11k rows and 27 MB on a real
// profile - and the projection is what a reader uses, not the events.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelStore } from "./channel-store";
import { BuildersBotDatabase } from "./openbot-database";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];

async function openStore(): Promise<{ store: ChannelStore; channelId: string; database: BuildersBotDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "channel-events-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const store = new ChannelStore(database);
  const channelId = "channel-events";
  const draft = store.create(channelId, { name: "Launch", title: "", instructions: "", members: [], leadAgentId: null });
  store.update(draft, {}, "events:create");
  return { store, channelId, database };
}

function countEvents(database: BuildersBotDatabase): number {
  const row = database.connection
    .prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_type = 'channel'")
    .get();
  return Number((row as { count: number }).count);
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ChannelStore event log", () => {
  it("keeps one event per change instead of one per revision", async () => {
    const { store, channelId, database } = await openStore();
    for (let index = 0; index < 40; index += 1) {
      const current = store.get(channelId);
      store.update({ ...current, name: `Launch ${index}` }, {}, `events:${index}`);
    }
    expect(countEvents(database)).toBe(1);
    // The projection still holds the latest value, which is what every reader uses.
    expect(store.get(channelId)?.name).toBe("Launch 39");
  });

  it("does not prune the event of another channel", async () => {
    const { store, channelId, database } = await openStore();
    const other = store.create("channel-other", {
      name: "Other",
      title: "",
      instructions: "",
      members: [],
      leadAgentId: null,
    });
    store.update(other, {}, "events:other");
    store.update({ ...store.get(channelId), name: "Launch again" }, {}, "events:own");
    expect(countEvents(database)).toBe(2);
    expect(store.get("channel-other")?.name).toBe("Other");
  });
});
