// @vitest-environment node
// Closing a tab of a channel: the command must go through, take the tab's work with it, and leave
// nothing of that tab in the mailbox or holding its agent. The rows that reference a tab are
// removed before it, or the foreign keys refuse the delete.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSummary, DEFAULT_AGENT_DEFAULTS, decodeChannelPage } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelService } from "./channel-service";
import { MailboxStore } from "./mailbox-store";
import { BuildersBotDatabase } from "./openbot-database";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function agent(id: string, name: string): AgentSummary {
  return {
    id,
    name,
    title: name,
    description: "Works in the channel.",
    notifications: true,
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    threadId: null,
    workspacePath: "/tmp",
    preview: "",
    updatedAt: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

interface Harness {
  service: ChannelService;
  mailbox: MailboxStore;
  channelId: string;
  scheduled: string[];
  /** `agent:turn:thread` of each interrupt. */
  interrupted: string[];
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "channel-delete-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const mailbox = new MailboxStore(root, root, database);
  await Effect.runPromise(mailbox.initialize());
  const scheduled: string[] = [];
  const interrupted: string[] = [];
  const members = [agent("chief", "Chief"), agent("writer", "Writer")];
  const service = new ChannelService(database, mailbox, {
    agents: () => members,
    generate: () => Effect.succeed("{}"),
    schedule: (agentId) => scheduled.push(agentId),
    interrupt: (agentId, turnId, threadId) =>
      Effect.sync(() => {
        interrupted.push(`${agentId}:${turnId}:${threadId}`);
      }),
    busy: () => false,
    awaitDrain: () => Effect.void,
    changed: () => {},
    error: () => {},
  });
  const channelId = "channel-delete";
  await Effect.runPromise(
    service.command(
      {
        type: "save",
        operationId: "save:create",
        channelId,
        update: false,
        draft: { name: "Launch", title: "", instructions: "", members: [{ agentId: "writer" }], leadAgentId: null },
      },
      { id: "local", name: "You" },
    ),
  );
  return { service, mailbox, channelId, scheduled, interrupted };
}

/** Waits for the pump to put a queued delivery in the agent's mailbox. */
async function queuedDelivery(mailbox: MailboxStore, agentId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [first] = mailbox.queuedDeliveryIds(agentId);
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

const actor = { id: "local", name: "You" };

describe("closing a channel tab", () => {
  it("removes the tab, its messages and its queued delivery, and releases the agent", async () => {
    const { service, mailbox, channelId, scheduled, interrupted } = await harness();
    await Effect.runPromise(
      service.command(
        { type: "topic-create", operationId: "topic:new", channelId, topicId: "topic-second", name: "Second" },
        actor,
      ),
    );
    expect(service.store.topic(channelId, "topic-second")).not.toBeNull();

    await Effect.runPromise(
      service.command(
        {
          type: "send",
          operationId: "send:one",
          channelId,
          topicId: "topic-second",
          text: "Do it",
          recipientAgentId: null,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    const delivery = await queuedDelivery(mailbox, "writer");
    expect(delivery).not.toBeNull();
    // The turn started: its assignment runs on the session of this tab, not of the first one.
    const assignment = service.store.assignments(channelId).find((entry) => entry.agentId === "writer");
    const task = service.store.tasks(channelId).find((entry) => entry.id === assignment?.taskId);
    if (!assignment || !task) throw new Error("the pump did not assign the task");
    const thread = service.store.context(channelId, "topic-second", "writer").threadId;
    service.store.update(service.store.get(channelId), {
      assignments: [{ ...assignment, state: "running", turnId: "turn-1" }],
      tasks: [{ ...task, state: "running" }],
    });

    await Effect.runPromise(
      service.command({ type: "topic-delete", operationId: "topic:delete", channelId, topicId: "topic-second" }, actor),
    );
    // The interrupt stops the session of the deleted tab, not the first tab's.
    expect(interrupted).toEqual([`writer:turn-1:${thread}`]);

    expect(service.store.topics(channelId).map((topic) => topic.id)).not.toContain("topic-second");
    expect(service.store.tasks(channelId).map((task) => task.topicId)).not.toContain("topic-second");
    expect(mailbox.queuedDeliveryIds("writer")).toEqual([]);
    expect(mailbox.getDelivery(delivery ?? "")).toBeNull();
    // The agent the tab held is asked to drain again.
    expect(scheduled).toContain("writer");
    // The tab had no session yet, so nothing of it is left in the context table either.
    expect(service.store.contextThreads(channelId)).toEqual([]);
  });

  it("keeps the other tab and its work", async () => {
    const { service, channelId } = await harness();
    await Effect.runPromise(
      service.command(
        { type: "topic-create", operationId: "topic:new", channelId, topicId: "topic-second", name: "Second" },
        actor,
      ),
    );
    await Effect.runPromise(
      service.command(
        {
          type: "send",
          operationId: "send:first",
          channelId,
          text: "Stay",
          recipientAgentId: null,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    await Effect.runPromise(
      service.command(
        {
          type: "send",
          operationId: "send:second",
          channelId,
          topicId: "topic-second",
          text: "Go",
          recipientAgentId: null,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    await Effect.runPromise(
      service.command({ type: "topic-delete", operationId: "topic:delete", channelId, topicId: "topic-second" }, actor),
    );

    const first = service.store.firstTopic(channelId);
    expect(first).not.toBeNull();
    const page = service.store.page(channelId, first?.id ?? "");
    expect(page.messages.map((message) => message.message.text)).toContain("Stay");
    expect(page.messages.map((message) => message.message.text)).not.toContain("Go");
  });

  it("answers in the tab the work came from, and reads the shared memory from any tab", async () => {
    const { service, mailbox, channelId } = await harness();
    await Effect.runPromise(
      service.command(
        { type: "topic-create", operationId: "topic:new", channelId, topicId: "topic-second", name: "Second" },
        actor,
      ),
    );
    await Effect.runPromise(
      service.command(
        {
          type: "send",
          operationId: "send:one",
          channelId,
          topicId: "topic-second",
          text: "Do it",
          recipientAgentId: null,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        actor,
      ),
    );
    const delivery = await queuedDelivery(mailbox, "writer");
    expect(delivery).not.toBeNull();
    const assignment = service.store.assignments(channelId).find((entry) => entry.agentId === "writer");
    const task = service.store.tasks(channelId).find((entry) => entry.id === assignment?.taskId);
    if (!assignment || !task) throw new Error("the pump did not assign the task");
    // What the drain does when it starts the turn.
    service.store.update(service.store.get(channelId), {
      assignments: [{ ...assignment, state: "running", turnId: "turn-1" }],
      tasks: [{ ...task, state: "running" }],
    });

    await Effect.runPromise(
      service.tool(channelId, "writer", "turn-1", "call-1", "channel_remember", { text: "Ship on Friday." }),
    );
    await Effect.runPromise(service.tool(channelId, "writer", "turn-1", "call-2", "channel_result", { text: "Done." }));

    const second = service.store.page(channelId, "topic-second");
    expect(second.messages.map((message) => message.message.text)).toContain("Done.");
    const first = service.store.firstTopic(channelId);
    expect(
      service.store.page(channelId, first?.id ?? "").messages.map((message) => message.message.text),
    ).not.toContain("Done.");
    // One memory for the whole channel, written from a tab and read beside the other.
    expect(service.memories.list(channelId).map((memory) => memory.text)).toEqual(["Ship on Friday."]);

    const history = await Effect.runPromise(
      service.tool(channelId, "writer", "turn-1", "call-3", "channel_history", {}),
    );
    const historyMessages = decodeChannelPage(history).messages.map((message) => message.message.text);
    expect(historyMessages).toContain("Do it");
    expect(historyMessages).toContain("Done.");
  });

  it("requeues a task of another tab that waited on a deleted one", async () => {
    const { service, channelId } = await harness();
    await Effect.runPromise(
      service.command(
        { type: "topic-create", operationId: "topic:new", channelId, topicId: "topic-second", name: "Second" },
        actor,
      ),
    );
    const send = (operationId: string, topicId?: string) =>
      Effect.runPromise(
        service.command(
          {
            type: "send",
            operationId,
            channelId,
            ...(topicId ? { topicId } : {}),
            text: "Work",
            recipientAgentId: null,
            replyToMessageId: null,
            attachmentDraftIds: [],
          },
          actor,
        ),
      );
    await send("send:first");
    await send("send:second", "topic-second");
    const first = service.store.firstTopic(channelId);
    const firstTabTasks = service.store.tasks(channelId, first?.id ?? "");
    const secondTabTasks = service.store.tasks(channelId, "topic-second");
    expect(firstTabTasks).toHaveLength(1);
    expect(secondTabTasks).toHaveLength(1);
    const [parent] = firstTabTasks;
    const [child] = secondTabTasks;
    if (!parent || !child) throw new Error("the sends did not create a task each");
    // The parent waits on the child of the other tab, as an assignment across tabs can leave it.
    service.store.update(service.store.get(channelId), {
      tasks: [{ ...parent, state: "waiting", dependencies: [child.id] }],
    });

    await Effect.runPromise(
      service.command({ type: "topic-delete", operationId: "topic:delete", channelId, topicId: "topic-second" }, actor),
    );

    expect(service.store.tasks(channelId, first?.id ?? "").map((task) => task.state)).toEqual(["queued"]);
  });

  it("refuses to close the last tab", async () => {
    const { service, channelId } = await harness();
    const first = service.store.firstTopic(channelId);
    await expect(
      Effect.runPromise(
        service.command(
          { type: "topic-delete", operationId: "topic:delete", channelId, topicId: first?.id ?? "" },
          actor,
        ),
      ),
    ).rejects.toThrow();
    expect(service.store.topics(channelId)).toHaveLength(1);
  });

  it("refuses a tab of another channel", async () => {
    const { service, channelId } = await harness();
    await expect(
      Effect.runPromise(
        service.command(
          { type: "topic-delete", operationId: "topic:delete", channelId, topicId: "topic-nowhere" },
          actor,
        ),
      ),
    ).rejects.toThrow();
  });
});

// The default is referenced so the fixture cannot drift from the contract silently.
void DEFAULT_AGENT_DEFAULTS;
