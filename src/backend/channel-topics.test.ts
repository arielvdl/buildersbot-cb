// @vitest-environment node
// The tabs of a channel: one conversation each, under one channel memory, one member list and one
// lead. A tab owns its messages, its tasks, its sessions and its read cursor, and nothing of it
// leaks into the tab beside it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelStore } from "./channel-store";
import { BuildersBotDatabase } from "./openbot-database";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];

async function openStore(): Promise<{ store: ChannelStore; channelId: string; first: string }> {
  const root = await mkdtemp(join(tmpdir(), "channel-topics-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const channels = new ChannelStore(database);
  const channelId = "channel-topics";
  channels.update(
    channels.create(channelId, { name: "Launch", title: "", instructions: "", members: [], leadAgentId: null }),
    {
      topics: [{ id: "topic-main", channelId, name: "Main", createdAt: "2026-10-01T08:00:00.000Z", revision: 0 }],
    },
    "topics:create",
  );
  return { store: channels, channelId, first: "topic-main" };
}

function message(channelId: string, topicId: string, id: string, text: string): ChannelMessage {
  return {
    id,
    channelId,
    topicId,
    taskId: null,
    author: { kind: "member", id: "local", name: "Reader" },
    sequence: 0,
    superseded: false,
    message: { id, text, author: "user", createdAt: "2026-10-01T08:00:00.000Z", status: "completed" },
  };
}

function task(channelId: string, topicId: string, id: string): ChannelTask {
  return {
    id,
    channelId,
    topicId,
    parentTaskId: null,
    rootTaskId: id,
    ownerAgentId: null,
    requestMessageId: `${id}-message`,
    instruction: "Do it",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: "queued",
    revision: 0,
    assignmentCount: 0,
    error: null,
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("channel tabs", () => {
  it("keeps each tab's messages and work to itself", async () => {
    const { store, channelId, first } = await openStore();
    store.update(store.get(channelId), {
      topics: [
        ...store.topics(channelId),
        { id: "topic-second", channelId, name: "Second", createdAt: "2026-10-01T09:00:00.000Z", revision: 0 },
      ],
    });
    store.update(store.get(channelId), {
      messages: [message(channelId, first, "message-main", "In the first tab")],
      tasks: [task(channelId, first, "task-main")],
    });
    store.update(store.get(channelId), {
      messages: [message(channelId, "topic-second", "message-second", "In the second tab")],
      tasks: [task(channelId, "topic-second", "task-second")],
    });

    expect(store.page(channelId, first).messages.map((entry) => entry.id)).toEqual(["message-main"]);
    expect(store.page(channelId, "topic-second").messages.map((entry) => entry.id)).toEqual(["message-second"]);
    expect(store.tasks(channelId, first).map((entry) => entry.id)).toEqual(["task-main"]);
    // Without a tab, the tasks are the whole channel: the scheduler walks them all.
    expect(
      store
        .tasks(channelId)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["task-main", "task-second"]);
  });

  it("keeps a session and a read cursor per tab", async () => {
    const { store, channelId, first } = await openStore();
    store.update(store.get(channelId), {
      topics: [
        ...store.topics(channelId),
        { id: "topic-second", channelId, name: "Second", createdAt: "2026-10-01T09:00:00.000Z", revision: 0 },
      ],
    });
    const one = store.context(channelId, first, "chief");
    const two = store.context(channelId, "topic-second", "chief");
    expect(one.threadId).not.toBe(two.threadId);

    store.update(store.get(channelId), {
      messages: [message(channelId, first, "message-main", "One")],
    });
    store.markRead(channelId, first, "local", store.page(channelId, first).throughSequence, "read:one");
    expect(store.page(channelId, first).messages).toHaveLength(1);
    // The second tab has read nothing, so its own count of unread messages is untouched.
    expect(store.page(channelId, "topic-second").messages).toHaveLength(0);
  });

  it("keeps the summary of each tab apart", async () => {
    const { store, channelId, first } = await openStore();
    store.saveSummary(channelId, first, { version: 1, throughSequence: 4, text: "Only the first tab." });
    expect(store.summary(channelId, first).text).toBe("Only the first tab.");
    expect(store.summary(channelId, "topic-other").text).toBe("");
  });

  it("carries the tab on a message that arrives without one, into the first tab", async () => {
    const { store, channelId, first } = await openStore();
    const withoutTopic = message(channelId, first, "message-plain", "From an older client");
    delete withoutTopic.topicId;
    store.update(store.get(channelId), { messages: [withoutTopic] });
    expect(store.page(channelId, first).messages[0]?.topicId).toBe(first);
  });

  it("deletes a tab with its messages, tasks and cursors, and keeps the others", async () => {
    const { store, channelId, first } = await openStore();
    store.update(store.get(channelId), {
      topics: [
        ...store.topics(channelId),
        { id: "topic-second", channelId, name: "Second", createdAt: "2026-10-01T09:00:00.000Z", revision: 0 },
      ],
      messages: [message(channelId, first, "message-main", "Kept")],
    });
    store.update(store.get(channelId), {
      messages: [message(channelId, "topic-second", "message-second", "Dropped")],
      tasks: [task(channelId, "topic-second", "task-second")],
    });
    store.deleteTopic(channelId, "topic-second");

    expect(store.topics(channelId).map((topic) => topic.id)).toEqual([first]);
    expect(store.page(channelId, first).messages.map((entry) => entry.id)).toEqual(["message-main"]);
    expect(store.tasks(channelId).map((entry) => entry.id)).toEqual([]);
  });

  it("gives every channel a first tab in the upgrade of an older database", async () => {
    const root = await mkdtemp(join(tmpdir(), "channel-topics-migration-"));
    roots.push(root);
    const database = new BuildersBotDatabase(root);
    databases.push(database);
    await Effect.runPromise(database.initialize());
    const channels = new ChannelStore(database);
    const channelId = "channel-legacy";
    channels.update(
      channels.create(channelId, { name: "Old", title: "", instructions: "", members: [], leadAgentId: null }),
      {
        topics: [{ id: "topic-old", channelId, name: "Main", createdAt: "2026-10-01T08:00:00.000Z", revision: 0 }],
      },
    );
    channels.update(channels.get(channelId), {
      messages: [message(channelId, "topic-old", "message-old", "From before tabs")],
    });

    // What an older database holds: the tab columns gone from the stored message.
    database.connection
      .prepare("UPDATE projection_channel_messages SET message_json = json_remove(message_json, '$.topicId')")
      .run();
    // A message read back without a tab lands in the first one.
    expect(channels.page(channelId, "topic-old").messages[0]?.topicId).toBe("topic-old");
  });
});
