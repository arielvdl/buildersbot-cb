// @vitest-environment node
// What a channel summary says about each tab, the parallel limit of a tab, and the name a tab takes
// from its first message. The channel totals and the one-turn-per-agent rule must not change.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSummary,
  CHANNEL_PARALLEL_LIMIT,
  type ChannelMessage,
  type ChannelTask,
  DEFAULT_AGENT_DEFAULTS,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { type ChannelOperationError, channelFailure } from "./channel-effects";
import { ChannelService } from "./channel-service";
import { MailboxStore } from "./mailbox-store";
import { BuildersBotDatabase } from "./openbot-database";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function agent(id: string): AgentSummary {
  return {
    id,
    name: id,
    title: id,
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
  first: string;
  cleanup(): Promise<void>;
}

async function harness(
  options: { naming?: () => Effect.Effect<string, ChannelOperationError> } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "channel-summary-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const mailbox = new MailboxStore(root, root, database);
  await Effect.runPromise(mailbox.initialize());
  const members = [agent("writer"), agent("helper"), agent("second")];
  const service = new ChannelService(database, mailbox, {
    agents: () => members,
    generate: (_lead, prompt) =>
      prompt.startsWith("Name this channel tab")
        ? (options.naming?.() ?? Effect.succeed("Resumo Curto"))
        : Effect.succeed("{}"),
    schedule: () => {},
    interrupt: () => Effect.void,
    busy: () => false,
    awaitDrain: () => Effect.void,
    changed: () => {},
    error: () => {},
  });
  const channelId = "channel-summary";
  await Effect.runPromise(
    service.command(
      {
        type: "save",
        operationId: "save:create",
        channelId,
        update: false,
        draft: {
          name: "Launch",
          title: "",
          instructions: "",
          members: members.map((member) => ({ agentId: member.id })),
          leadAgentId: null,
        },
      },
      { id: "local", name: "You" },
    ),
  );
  const first = service.store.firstTopicId(channelId);
  return {
    service,
    mailbox,
    channelId,
    first,
    cleanup: async () => {
      await Effect.runPromise(service.stop()).catch(() => {});
    },
  };
}

async function addTopic(service: ChannelService, channelId: string, topicId: string, name = "Second"): Promise<void> {
  await Effect.runPromise(
    service.command(
      { type: "topic-create", operationId: `topic:${topicId}`, channelId, topicId, name },
      { id: "local", name: "You" },
    ),
  );
}

async function send(
  service: ChannelService,
  channelId: string,
  text: string,
  options: { topicId?: string; recipientAgentId?: string; operationId: string },
): Promise<void> {
  await Effect.runPromise(
    service.command(
      {
        type: "send",
        operationId: options.operationId,
        channelId,
        ...(options.topicId ? { topicId: options.topicId } : {}),
        text,
        recipientAgentId: options.recipientAgentId ?? null,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      { id: "local", name: "You" },
    ),
  );
}

/** Waits for a condition the naming turn settles on its own. */
async function until(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Waits for the pump to put a queued delivery in the agent's mailbox. */
async function queuedDelivery(mailbox: MailboxStore, agentId: string, timeoutMs = 1500): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [first] = mailbox.queuedDeliveryIds(agentId);
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

/** A message written by another member, so it is unread for the reader. */ function message(
  channelId: string,
  topicId: string | null,
  id: string,
  text: string,
): ChannelMessage {
  return {
    id,
    channelId,
    ...(topicId ? { topicId } : {}),
    taskId: null,
    author: { kind: "member", id: "other", name: "Other" },
    sequence: 0,
    superseded: false,
    message: { id, text, author: "user", createdAt: "2026-10-01T08:00:00.000Z", status: "completed" },
  };
}

function task(channelId: string, topicId: string, id: string, state: ChannelTask["state"]): ChannelTask {
  return {
    id,
    channelId,
    topicId,
    parentTaskId: null,
    rootTaskId: id,
    ownerAgentId: "helper",
    requestMessageId: `${id}-message`,
    instruction: "Do it",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state,
    revision: 0,
    assignmentCount: 0,
    error: null,
  };
}

function runningAssignment(channelId: string, taskId: string, agentId: string) {
  return {
    id: `assignment-${taskId}`,
    channelId,
    taskId,
    agentId,
    taskRevision: 0,
    requestMessageId: null,
    resources: [],
    deliveryId: null,
    turnId: `turn-${taskId}`,
    state: "running" as const,
    throughSequence: 0,
    summaryVersion: 0,
    awaitedTaskIds: [],
    pendingRevision: null,
    pendingOutcome: null,
  };
}

describe("channel tab summary", () => {
  it("counts each tab on its own, and leaves the channel totals as they were", async () => {
    const { service, channelId, first, cleanup } = await harness();
    await addTopic(service, channelId, "topic-second");
    service.store.update(service.store.get(channelId), {
      messages: [
        message(channelId, first, "message-main", "In the first tab"),
        message(channelId, "topic-second", "message-second", "In the second tab"),
        // A row written before tabs belongs to the first tab.
        message(channelId, null, "message-legacy", "From before tabs"),
      ],
      tasks: [
        task(channelId, first, "task-running", "running"),
        task(channelId, "topic-second", "task-queued", "queued"),
        task(channelId, "topic-second", "task-done", "completed"),
      ],
      assignments: [runningAssignment(channelId, "task-running", "helper")],
    });

    const [summary] = service.store.list("local");
    const main = summary?.topics?.find((topic) => topic.id === first);
    const second = summary?.topics?.find((topic) => topic.id === "topic-second");
    expect(main?.messageCount).toBe(2);
    expect(main?.unreadCount).toBe(2);
    expect(main?.activeTasks).toBe(1);
    expect(main?.openTasks).toBe(1);
    expect(second?.messageCount).toBe(1);
    expect(second?.unreadCount).toBe(1);
    expect(second?.activeTasks).toBe(0);
    expect(second?.openTasks).toBe(1);
    // The channel still sums every tab.
    expect(summary?.unreadCount).toBe(3);
    expect(summary?.activeTasks).toBe(1);
    expect(summary?.openTasks).toBe(2);

    // A tab read to the end has nothing unread and still counts its messages.
    service.store.markRead(
      channelId,
      "topic-second",
      "local",
      service.store.page(channelId, "topic-second").throughSequence,
      "read:second",
    );
    const [after] = service.store.list("local");
    expect(after?.topics?.find((topic) => topic.id === "topic-second")?.unreadCount).toBe(0);
    expect(after?.topics?.find((topic) => topic.id === "topic-second")?.messageCount).toBe(1);
    await cleanup();
  });

  it("does not make a second tab wait for the first tab's parallel limit", async () => {
    const { service, channelId, first, mailbox, cleanup } = await harness();
    await addTopic(service, channelId, "topic-second");
    // The first tab is already at the limit, with owners of its own.
    const busy = Array.from({ length: CHANNEL_PARALLEL_LIMIT }, (_, index) =>
      task(channelId, first, `task-busy-${index}`, "running"),
    );
    service.store.update(service.store.get(channelId), {
      tasks: busy,
      assignments: busy.map((item, index) => runningAssignment(channelId, item.id, index === 0 ? "helper" : "second")),
    });

    await send(service, channelId, "Second tab work", {
      topicId: "topic-second",
      recipientAgentId: "writer",
      operationId: "send:second",
    });

    expect(await queuedDelivery(mailbox, "writer")).not.toBeNull();
    await cleanup();
  });

  it("still serializes one agent across tabs", async () => {
    const { service, channelId, first, mailbox, cleanup } = await harness();
    await addTopic(service, channelId, "topic-second");
    service.store.update(service.store.get(channelId), {
      tasks: [task(channelId, first, "task-same-agent", "running")],
      assignments: [runningAssignment(channelId, "task-same-agent", "writer")],
    });

    await send(service, channelId, "Same agent, other tab", {
      topicId: "topic-second",
      recipientAgentId: "writer",
      operationId: "send:second",
    });

    expect(await queuedDelivery(mailbox, "writer", 400)).toBeNull();
    await cleanup();
  });
});

describe("a tab named by its first message", () => {
  it("shows the first line at once, then the model's name over it", async () => {
    let release: (value: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { service, channelId, cleanup } = await harness({ naming: () => Effect.promise(() => held) });
    await addTopic(service, channelId, "topic-second", "Aba 2");
    const long = `${"  Revisar   o lançamento ".repeat(3)}\nsegunda linha`;
    await send(service, channelId, long, { topicId: "topic-second", operationId: "send:first" });

    // The placeholder is the first line, collapsed and cut, while the model still runs.
    const placeholder = service.store.topic(channelId, "topic-second")?.name ?? "";
    expect(placeholder.startsWith("Revisar o lançamento")).toBe(true);
    expect(Array.from(placeholder)).toHaveLength(33);
    expect(placeholder.endsWith("…")).toBe(true);
    expect(placeholder).not.toContain("segunda linha");

    release('"Lançamento do login"');
    await until(() => service.store.topic(channelId, "topic-second")?.name === "Lançamento do login");
    expect(service.store.topic(channelId, "topic-second")?.revision).toBe(2);
    await cleanup();
  });

  it("keeps the name on later messages and never overwrites a rename", async () => {
    const { service, channelId, cleanup } = await harness();
    await addTopic(service, channelId, "topic-second", "Aba 2");
    await send(service, channelId, "Primeira mensagem", { topicId: "topic-second", operationId: "send:one" });
    await until(() => service.store.topic(channelId, "topic-second")?.name === "Resumo Curto");
    expect(service.store.topic(channelId, "topic-second")?.name).toBe("Resumo Curto");
    await send(service, channelId, "Outra mensagem", { topicId: "topic-second", operationId: "send:two" });
    expect(service.store.topic(channelId, "topic-second")?.name).toBe("Resumo Curto");

    await Effect.runPromise(
      service.command(
        { type: "topic-rename", operationId: "rename", channelId, topicId: "topic-second", name: "Escolhido" },
        { id: "local", name: "You" },
      ),
    );
    await addTopic(service, channelId, "topic-third", "Aba 3");
    await send(service, channelId, "Volta ao escolhido", { topicId: "topic-second", operationId: "send:three" });
    expect(service.store.topic(channelId, "topic-second")?.name).toBe("Escolhido");
    // A tab with a message already written never takes a new name from the next one.
    await send(service, channelId, "Aba 3 primeiro", { topicId: "topic-third", operationId: "send:four" });
    await until(() => service.store.topic(channelId, "topic-third")?.name === "Resumo Curto");
    expect(service.store.topic(channelId, "topic-third")?.name).toBe("Resumo Curto");
    await cleanup();
  });

  it("keeps a rename made while the model runs", async () => {
    let release: (value: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { service, channelId, cleanup } = await harness({ naming: () => Effect.promise(() => held) });
    await addTopic(service, channelId, "topic-second", "Aba 2");
    await send(service, channelId, "Primeira mensagem", { topicId: "topic-second", operationId: "send:one" });
    await Effect.runPromise(
      service.command(
        { type: "topic-rename", operationId: "rename", channelId, topicId: "topic-second", name: "Escolhido" },
        { id: "local", name: "You" },
      ),
    );
    release("Nome atrasado");
    await until(() => service.store.topic(channelId, "topic-second")?.revision === 2);
    expect(service.store.topic(channelId, "topic-second")?.name).toBe("Escolhido");
    await cleanup();
  });

  it("keeps the placeholder when the model fails", async () => {
    let called = false;
    const { service, channelId, cleanup } = await harness({
      naming: () => {
        called = true;
        return channelFailure(new Error("no model"));
      },
    });
    await addTopic(service, channelId, "topic-second", "Aba 2");
    await send(service, channelId, "Ajustar o filtro", { topicId: "topic-second", operationId: "send:one" });
    await until(() => called);
    expect(service.store.topic(channelId, "topic-second")?.name).toBe("Ajustar o filtro");
    await cleanup();
  });

  it("leaves the first tab and an attachment-only message alone", async () => {
    const { service, channelId, first, cleanup } = await harness();
    await addTopic(service, channelId, "topic-second", "Aba 2");
    await send(service, channelId, "Texto na primeira", { operationId: "send:first" });
    expect(service.store.topic(channelId, first)?.name).toBe("Main");
    // No text: nothing to name it by.
    await send(service, channelId, "   ", { topicId: "topic-second", operationId: "send:blank" });
    expect(service.store.topic(channelId, "topic-second")?.name).toBe("Aba 2");
    await cleanup();
  });
});

describe("the first message of a tab", () => {
  /** A message of an agent or of a person, in a tab, at a place in the channel. */
  function written(
    channelId: string,
    topicId: string,
    id: string,
    text: string,
    kind: ChannelMessage["author"]["kind"],
  ): ChannelMessage {
    const base = message(channelId, topicId, id, text);
    return {
      ...base,
      author: { kind, id: kind === "member" ? "local" : "writer", name: kind === "member" ? "You" : "writer" },
      message: { ...base.message, author: kind === "member" ? "user" : "assistant" },
    };
  }

  it("gives each tab the first and the last message a person sent in it, also after a rename", async () => {
    const { service, channelId, first, cleanup } = await harness();
    await addTopic(service, channelId, "topic-second", "Aba 2");
    await addTopic(service, channelId, "topic-empty", "Aba 3");
    const long = `Revise o deploy. ${"a".repeat(2_100)}`;
    service.store.update(service.store.get(channelId), {
      messages: [
        written(channelId, "topic-second", "agent-first", "An agent wrote before the person", "agent"),
        written(channelId, "topic-second", "person-blank", "   ", "member"),
        written(channelId, "topic-second", "person-first", "  Ajuste o **filtro** da busca  ", "member"),
        written(channelId, first, "person-main", long, "member"),
        written(channelId, "topic-second", "agent-reply", "Done.", "agent"),
        written(channelId, "topic-second", "person-last", "Agora o botão", "member"),
        written(channelId, "topic-empty", "agent-only", "Only an agent wrote here", "agent"),
      ],
    });
    await Effect.runPromise(
      service.command(
        { type: "topic-rename", operationId: "rename", channelId, topicId: "topic-second", name: "Outro nome" },
        { id: "local", name: "You" },
      ),
    );

    const [summary] = service.store.list("local");
    const topic = (id: string) => summary?.topics?.find((item) => item.id === id);
    expect(topic("topic-second")?.name).toBe("Outro nome");
    // The person's first message with text, as written: the tab expands its marks when it shows it.
    expect(topic("topic-second")?.firstMessage).toBe("Ajuste o **filtro** da busca");
    expect(topic("topic-second")?.lastUserMessage).toBe("Agora o botão");
    // A long message is cut as the first message of a side thread is.
    expect(topic(first)?.firstMessage?.startsWith("Revise o deploy.")).toBe(true);
    expect(Array.from(topic(first)?.firstMessage ?? "")).toHaveLength(2_000);
    expect(topic(first)?.firstMessage?.endsWith("…")).toBe(true);
    expect(topic(first)?.lastUserMessage).toBe(topic(first)?.firstMessage);
    // A tab where no person wrote has nothing to show.
    expect(topic("topic-empty")?.firstMessage).toBe("");
    expect(topic("topic-empty")?.lastUserMessage).toBe("");
    await cleanup();
  });
});

// The default is referenced so the fixture cannot drift from the contract silently.
void DEFAULT_AGENT_DEFAULTS;
