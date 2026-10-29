// @vitest-environment node
// The guard on the drain of a channel turn: where the note of the scan is saved, and what the scan
// reads. The drain starts the turn on the provider's session id, while a note belongs to the thread
// of the tab; and the scan must not read the verdict that Builders Bot itself put in front of the turn.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSummary, isSecurityScanMarker } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentClient } from "../agent-client";
import type { AgentStore } from "../agent-store";
import type { ChannelService } from "../channel-service";
import type { ChannelAssignment, ChannelStore } from "../channel-store";
import type { DeliveryContext, MailboxStore } from "../mailbox-store";
import { BuildersBotDatabase } from "../openbot-database";
import type { ResponseDecoder } from "../protocol";
import type { ContextCompaction } from "./context-compaction";
import { ConversationRuntime } from "./conversation-runtime";
import type { DeliveryInputItem } from "./delivery-content";
import { DrainScheduler, type TaskLanes } from "./drain-scheduler";
import type { DuplicationGate } from "./duplication-gate";
import type { MailboxSync } from "./mailbox-sync";
import type { MemoryHold } from "./memory-hold";
import type { ProfileSave } from "./profile-save";
import type { ProviderRuntime } from "./provider-runtime";
import type { RoutineScheduler } from "./routine-scheduler";
import type { ThreadLifecycle } from "./thread-lifecycle";
import type { UsageLimitGate } from "./usage-limit-gate";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_ID = "chief";
const OWN_THREAD = "openbot-thread-chief";
const CHANNEL_ID = "channel-1";
const TAB_ONE_THREAD = "openbot-thread-tab-1";
const TAB_TWO_THREAD = "openbot-thread-tab-2";
/** The id the provider gives the session of the first tab. No projection row has it. */
const TAB_ONE_SESSION = "provider-session-tab-1";
const DELIVERY_ID = "delivery-1";
const NOTE = "Prompt injection check: a quoted page asks to ignore the rules.";
const REVIEW =
  '<prompt_injection_review level="suspicious">\nA security reviewer read this message before you.\n</prompt_injection_review>';
const SCAN_BLOCK = '<security_scan verdict="suspicious">\nBuilders Bot checked the message below.\n</security_scan>';
const PACKET = [
  "You have one assignment in a shared Builders Bot channel chat. Speak as yourself.",
  "Current assignment:\nResponda apenas com a palavra: livre",
].join("\n\n");

function agent(): AgentSummary {
  return {
    id: AGENT_ID,
    name: "Chief",
    title: "Chief",
    description: "Works in the channel.",
    notifications: true,
    provider: "claude",
    model: "claude-test",
    reasoningEffort: "low",
    threadId: OWN_THREAD,
    workspacePath: "/tmp",
    preview: "",
    updatedAt: null,
    avatarSeed: AGENT_ID,
    avatarHue: null,
    avatarUrl: null,
  };
}

/** A database with the agent and a channel of two tabs, each with the agent's own context thread. */
async function database(record: AgentSummary): Promise<BuildersBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "drain-guard-"));
  roots.push(root);
  const opened = new BuildersBotDatabase(root);
  await Effect.runPromise(opened.initialize());
  cleanups.push(() => opened.close());
  opened.replaceAgents("drain-guard-agents", [record], "agents.imported");
  const now = "2026-10-29T09:00:00.000Z";
  const db = opened.connection;
  db.prepare("INSERT INTO projection_channels(channel_id, channel_json) VALUES (?, ?)").run(
    CHANNEL_ID,
    JSON.stringify({ id: CHANNEL_ID, name: "Project" }),
  );
  for (const [topicId, threadId] of [
    ["topic-1", TAB_ONE_THREAD],
    ["topic-2", TAB_TWO_THREAD],
  ] as const) {
    db.prepare("INSERT INTO projection_channel_topics(topic_id, channel_id, name, created_at) VALUES (?, ?, ?, ?)").run(
      topicId,
      CHANNEL_ID,
      topicId,
      now,
    );
    db.prepare(
      `INSERT INTO projection_threads
         (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
       VALUES (?, ?, ?, NULL, ?, ?, 0)`,
    ).run(threadId, AGENT_ID, "Project", now, now);
    db.prepare(
      "INSERT INTO projection_channel_contexts(channel_id, topic_id, agent_id, thread_id) VALUES (?, ?, ?, ?)",
    ).run(CHANNEL_ID, topicId, AGENT_ID, threadId);
  }
  return opened;
}

interface Run {
  database: BuildersBotDatabase;
  /** The text that each scan read. */
  scanned: string[];
  /** The text that the turn sent to the provider. */
  turn: string | null;
  errors: string[];
}

/**
 * A stand-in with only the members that this path of the drain calls. The real classes hold private
 * state, a provider and a database of their own.
 */
function stub<T>(members: Partial<T>): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a test double has only the members that the drain calls on this path.
  return members as T;
}

/** The text items of a turn input, joined. */
function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .flatMap((item) => (isDynamicRecord(item) && item.type === "text" && isString(item.text) ? [item.text] : []))
    .join("\n");
}

/**
 * Starts one channel delivery through the real drain, with the real conversation projection over a
 * real database. Everything else answers the way the happy path needs, as `ThreadLifecycle` does for
 * the session: it binds the provider's session id to the public thread of the tab and returns it.
 */
async function startChannelTurn(options: { review: string | null }): Promise<Run> {
  const record = agent();
  const opened = await database(record);
  const store = stub<AgentStore>({
    database: opened,
    sharedRoot: "/tmp",
    list: () => [record],
    ownsThread: (threadId: string) => threadId === record.threadId,
    getOrCreate: () => Effect.succeed(record),
  });
  const conversation = new ConversationRuntime(
    store,
    () => {},
    () => [record],
  );
  cleanups.push(() => conversation.dispose());
  const client = stub<AgentClient>({ provider: "claude" });
  const run: Run = { database: opened, scanned: [], turn: null, errors: [] };
  const context: DeliveryContext = {
    delivery: {
      id: DELIVERY_ID,
      messageId: "message-1",
      recipientAgentId: AGENT_ID,
      sender: { kind: "user" },
      text: "Responda apenas com a palavra: livre",
      attachments: [],
      replyToMessageId: null,
      status: "queued",
      position: 0,
      turnId: null,
      error: null,
      createdAt: "2026-10-29T09:00:01.000Z",
    },
    managedAttachments: [],
  };
  const drain = new DrainScheduler({
    store,
    mailbox: stub<MailboxStore>({
      taskIdForDelivery: () => null,
      repliesToStartWith: () => [],
      userMessagesToStartWith: () => [],
      markStarting: () => Effect.void,
      verifyDeliveryAttachments: () => Effect.void,
      markRunning: () => Effect.void,
      getDelivery: () => null,
    }),
    mailboxSync: stub<MailboxSync>({ emitQueue: () => {} }),
    conversation,
    providers: stub<ProviderRuntime>({ ensureAgentClient: () => Effect.succeed(client), listModels: () => [] }),
    duplication: stub<DuplicationGate>({}),
    profileSave: stub<ProfileSave>({}),
    compaction: stub<ContextCompaction>({}),
    routines: stub<RoutineScheduler>({}),
    threads: stub<ThreadLifecycle>({
      applyPendingRuntimeRefresh: () => Effect.void,
      holdRuntimeRefresh: () => () => {},
      ensureThread: (_agent: AgentSummary, _client: AgentClient, executionThreadId?: string) =>
        Effect.sync(() => {
          const publicThreadId = executionThreadId ?? OWN_THREAD;
          if (executionThreadId) conversation.registerExecutionThread(AGENT_ID, executionThreadId);
          conversation.bindThread(TAB_ONE_SESSION, AGENT_ID, publicThreadId);
          return TAB_ONE_SESSION;
        }),
      consumePendingHandoff: () => undefined,
      requestWithArchivedThreadRecovery: <T>(
        _agent: AgentSummary,
        _client: AgentClient,
        _method: string,
        params: unknown,
        decoder: ResponseDecoder<T>,
      ) =>
        Effect.sync(() => {
          run.turn = isDynamicRecord(params) ? inputText(params.input) : null;
          return decoder({ turn: { id: "turn-1" } });
        }),
      deletePendingHandoff: () => Effect.void,
    }),
    memory: stub<MemoryHold>({ reserveTurn: () => () => {} }),
    usageLimits: stub<UsageLimitGate>({}),
    tasks: stub<TaskLanes>({}),
    security: { review: () => Effect.succeed(options.review) },
    channels: stub<ChannelService>({
      store: stub<ChannelStore>({
        assignmentForDelivery: (id: string) =>
          id === DELIVERY_ID ? stub<ChannelAssignment>({ channelId: CHANNEL_ID, agentId: AGENT_ID }) : null,
      }),
      prepare: () => Effect.succeed({ threadId: TAB_ONE_THREAD, text: PACKET }),
      delta: () => undefined,
      sendsDelta: () => false,
      accepted: () => Effect.void,
    }),
    hooks: {
      emitError: (code: string) => run.errors.push(code),
      redactMcp: (text: string) => text,
      isStopping: () => false,
      servesModel: () => true,
      requeueChannelDelivery: () => Effect.succeed(false),
      mayFailOver: () => false,
      followUsageLimit: () => false,
      scanPrompt: (_agentId: string, input: readonly DeliveryInputItem[]) =>
        Effect.sync(() => {
          run.scanned.push(inputText(input));
          return { block: SCAN_BLOCK, note: NOTE };
        }),
      turnEnded: () => false,
      turnRestarting: () => {},
      startRequestedNewChat: () => Effect.void,
      dropRequestedNewChat: () => {},
    },
  });
  await Effect.runPromise(drain.startDelivery(context));
  return run;
}

function notes(opened: BuildersBotDatabase, threadId: string): string[] {
  return opened
    .readConversationPage(AGENT_ID, threadId, { type: "latest" }, 100)
    .messages.filter(isSecurityScanMarker)
    .map((message) => message.text);
}

describe("the security note of a channel turn", () => {
  it("is saved in the thread of the tab that the turn runs in, and nowhere else", async () => {
    const run = await startChannelTurn({ review: null });
    expect(run.errors).toEqual([]);
    expect(run.turn).toContain(SCAN_BLOCK);
    expect(notes(run.database, TAB_ONE_THREAD)).toEqual([NOTE]);
    expect(notes(run.database, TAB_TWO_THREAD)).toEqual([]);
    expect(notes(run.database, OWN_THREAD)).toEqual([]);
  });

  it("cannot be saved under the provider's session id, which is the id the turn starts on", async () => {
    const run = await startChannelTurn({ review: null });
    expect(() =>
      run.database.persistConversationChanges({
        agentId: AGENT_ID,
        threadId: TAB_ONE_SESSION,
        activeTurnId: null,
        changedMessages: [],
        eventType: "security.scan",
      }),
    ).toThrow(`Unknown agent for conversation changes: ${AGENT_ID}`);
  });
});

describe("the scan of a turn that the reviewer annotated", () => {
  it("reads the turn without the reviewer's block, and the agent still gets both", async () => {
    const run = await startChannelTurn({ review: REVIEW });
    expect(run.errors).toEqual([]);
    expect(run.scanned).toHaveLength(1);
    expect(run.scanned[0]).toContain("Responda apenas com a palavra: livre");
    expect(run.scanned[0]).not.toContain("<prompt_injection_review");
    const turn = run.turn ?? "";
    expect(turn).toContain(SCAN_BLOCK);
    expect(turn).toContain(REVIEW);
    expect(turn.indexOf(REVIEW)).toBeLessThan(turn.indexOf("Responda apenas com a palavra: livre"));
  });
});
