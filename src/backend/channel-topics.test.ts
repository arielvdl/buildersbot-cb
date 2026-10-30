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

async function openStore(): Promise<{
  store: ChannelStore;
  channelId: string;
  first: string;
  database: BuildersBotDatabase;
}> {
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
  return { store: channels, channelId, first: "topic-main", database };
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
  it("reads the first tab when a read names none, and refuses a tab that is not in the channel", async () => {
    const { store, channelId, first } = await openStore();

    expect(store.readTopicId(channelId)).toBe(first);
    expect(store.readTopicId(channelId, first)).toBe(first);
    expect(() => store.readTopicId(channelId, "openbot-topic-of-another-channel")).toThrow(
      "This tab of the channel no longer exists.",
    );
  });

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

  it("counts the unread of each tab against that tab's own cursor", async () => {
    const { store, channelId, first } = await openStore();
    store.update(store.get(channelId), {
      topics: [
        ...store.topics(channelId),
        { id: "topic-second", channelId, name: "Second", createdAt: "2026-10-01T09:00:00.000Z", revision: 0 },
      ],
    });
    // Written by another member, so the reader's own messages do not hide the count.
    const fromOther = (topicId: string, id: string, text: string) => {
      const entry = message(channelId, topicId, id, text);
      entry.author = { kind: "member", id: "other", name: "Other" };
      return entry;
    };
    store.update(store.get(channelId), {
      messages: [
        fromOther(first, "message-main", "Read already"),
        fromOther("topic-second", "message-second", "Not read"),
      ],
    });
    // Reading the newer tab first must not hide the older tab's message: each tab has its cursor.
    store.markRead(
      channelId,
      "topic-second",
      "local",
      store.page(channelId, "topic-second").throughSequence,
      "read:second",
    );
    expect(store.list("local")[0]?.unreadCount).toBe(1);
    store.markRead(channelId, first, "local", store.page(channelId, first).throughSequence, "read:first");
    expect(store.list("local")[0]?.unreadCount).toBe(0);
  });

  it("keeps the summary of each tab apart", async () => {
    const { store, channelId, first } = await openStore();
    store.saveSummary(channelId, first, { version: 1, throughSequence: 4, text: "Only the first tab." });
    expect(store.summary(channelId, first).text).toBe("Only the first tab.");
    expect(store.summary(channelId, "topic-other").text).toBe("");
  });

  it("gives each tab the time of its newest message, or its creation", async () => {
    const { store, channelId, first } = await openStore();
    store.update(store.get(channelId), {
      topics: [
        ...store.topics(channelId),
        { id: "topic-second", channelId, name: "Second", createdAt: "2026-10-01T09:00:00.000Z", revision: 0 },
      ],
    });
    const older = message(channelId, first, "message-older", "Older");
    older.message.createdAt = "2026-10-01T10:00:00.000Z";
    const newer = message(channelId, first, "message-newer", "Newer");
    newer.message.createdAt = "2026-10-02T10:00:00.000Z";
    store.update(store.get(channelId), { messages: [newer, older] });

    const topics = store.list("local")[0]?.topics ?? [];
    expect(topics.find((topic) => topic.id === first)?.updatedAt).toBe("2026-10-02T10:00:00.000Z");
    // A tab nobody wrote in keeps its creation, so it still has an age.
    expect(topics.find((topic) => topic.id === "topic-second")?.updatedAt).toBe("2026-10-01T09:00:00.000Z");
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
    store.deleteTopic(channelId, "topic-second", "topic-delete:test");

    expect(store.topics(channelId).map((topic) => topic.id)).toEqual([first]);
    expect(store.page(channelId, first).messages.map((entry) => entry.id)).toEqual(["message-main"]);
    expect(store.tasks(channelId).map((entry) => entry.id)).toEqual([]);
  });

  it("deletes a tab with everything that points at it, and the other tab survives", async () => {
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
      assignments: [
        {
          id: "assignment-second",
          channelId,
          taskId: "task-second",
          agentId: "chief",
          taskRevision: 0,
          requestMessageId: "task-second-message",
          resources: [],
          deliveryId: "delivery-second",
          turnId: null,
          state: "running",
          throughSequence: 0,
          summaryVersion: 0,
          awaitedTaskIds: [],
          pendingRevision: null,
          pendingOutcome: null,
        },
      ],
    });
    const context = store.context(channelId, "topic-second", "chief");
    store.saveSummary(channelId, "topic-second", { version: 1, throughSequence: 3, text: "Second only." });
    store.markRead(
      channelId,
      "topic-second",
      "local",
      store.page(channelId, "topic-second").throughSequence,
      "read:second",
    );

    store.deleteTopic(channelId, "topic-second", "topic-delete:test");

    // The rows that reference the tab go before it, so the session thread can go after.
    expect(store.topics(channelId).map((topic) => topic.id)).toEqual([first]);
    expect(store.tasks(channelId).map((entry) => entry.id)).toEqual([]);
    expect(store.assignments(channelId)).toEqual([]);
    expect(store.topicThreads(channelId, "topic-second")).toEqual([]);
    expect(store.summary(channelId, "topic-second").text).toBe("");
    expect(store.page(channelId, first).messages.map((entry) => entry.id)).toEqual(["message-main"]);
    expect(() => store.deleteThreads([context.threadId])).not.toThrow();
  });

  it("takes a message with no tab with the first tab, where it is read", async () => {
    const { store, channelId, first, database } = await openStore();
    store.update(store.get(channelId), {
      topics: [
        ...store.topics(channelId),
        { id: "topic-second", channelId, name: "Second", createdAt: "2026-10-01T09:00:00.000Z", revision: 0 },
      ],
    });
    const plain = message(channelId, first, "message-plain", "From before tabs");
    delete plain.topicId;
    store.update(store.get(channelId), { messages: [plain] });
    // The row carries no tab, as a replayed older event leaves it.
    database.connection
      .prepare("UPDATE projection_channel_messages SET message_json = json_remove(message_json, '$.topicId')")
      .run();
    expect(store.page(channelId, first).messages.map((entry) => entry.id)).toEqual(["message-plain"]);

    store.deleteTopic(channelId, first, "topic-delete:first");

    expect(store.topics(channelId).map((topic) => topic.id)).toEqual(["topic-second"]);
    expect(store.page(channelId, "topic-second").messages).toEqual([]);
  });

  it("gives a channel written without tabs its one tab, and keeps it on the next write", async () => {
    const root = await mkdtemp(join(tmpdir(), "channel-topics-seed-"));
    roots.push(root);
    const database = new BuildersBotDatabase(root);
    databases.push(database);
    await Effect.runPromise(database.initialize());
    const channels = new ChannelStore(database);
    const channelId = "channel-seed";
    // What a seed does: create and update with no tab list.
    channels.update(
      channels.create(channelId, { name: "Seeded", title: "", instructions: "", members: [], leadAgentId: null }),
      {},
      "seed:create",
    );
    const first = channels.firstTopic(channelId);
    expect(first?.id).toBe(`openbot-topic-${channelId}`);
    expect(first?.name).toBe("Main");
    // A context written with the tab the seed reads back is accepted.
    expect(channels.context(channelId, first?.id ?? "", "chief").threadId).toContain("openbot-thread-");
    channels.update(channels.get(channelId), { messages: [message(channelId, first?.id ?? "", "m", "Hi")] });
    expect(channels.topics(channelId)).toHaveLength(1);
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
