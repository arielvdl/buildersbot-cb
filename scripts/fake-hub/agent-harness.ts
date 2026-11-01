// Test only. The agent side of the Hub connection E2E scripts: a fake Codex app-server that calls
// tools as a model does, and the real agent service, tool router, Guard, approval cards and Hub
// client around it. The Hub client's requests go to the fake Hub through an injected fetch.
//
// `startAgentHarness` sets HOME, CODEX_HOME and OPENBOT_CODEX_PATH before it loads the service
// modules: the Codex process and the stores read the home folder. Call it before any other import of
// `src/backend`. Nothing reaches the network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HubJson, type HubJsonObject, isHubJsonObject } from "@openbot/contracts/hub-connections";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../../src/backend/agent/turn-lifecycle";

/**
 * What `config/read` of the fake Codex answers: the person's servers, as Codex reads them from its own
 * files. While the file `failFlag` exists, `config/read` fails, as it does for a damaged `config.toml`.
 */
export interface FakeCodexConfig {
  readonly mcpServers: HubJsonObject;
  readonly failFlag?: string;
}

/**
 * A Codex app-server with the methods that the service calls. A turn whose input has
 * `<mark> <<CALLS:<base64 JSON>>>` runs each listed call in order and waits for each result: a
 * `tool_search` or `tool_describe` item calls that discovery tool, and any other item goes through
 * `tool_call`, as a model does. It logs the thread setup, the turn input, its own environment and
 * each result, then ends the turn. Other turns answer "Done.".
 */
export function fakeCodexSource(log: string, mark: string, config: FakeCodexConfig): string {
  const servers = JSON.stringify(config.mcpServers);
  return `#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(log)};
const FAIL_FLAG = ${JSON.stringify(config.failFlag ?? null)};
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
log({ kind: "env", env: process.env });
const servers = ${servers};
const configRead = (id) => {
  if (FAIL_FLAG && existsSync(FAIL_FLAG)) return write({ id, error: { code: -32603, message: "config.toml: invalid value" } });
  write({ id, result: { config: { mcp_servers: servers }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: servers } }] } });
};
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answers = new Map();
const finish = (threadId, turnId) => {
  const text = answers.get(turnId) || "Done.";
  answers.delete(turnId);
  const item = { type: "agentMessage", id: "message-" + turnId, text, phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const next = (threadId, turnId, calls, index) => {
  if (index >= calls.length) return finish(threadId, turnId);
  const call = calls[index];
  const id = "tool-" + turnId + "-" + index;
  waiting.set(id, { threadId, turnId, calls, index, sentAt: Date.now() });
  const discovery = call.tool === "tool_search" || call.tool === "tool_describe";
  write({
    id,
    method: "item/tool/call",
    params: {
      threadId,
      turnId,
      callId: "call-" + turnId + "-" + index,
      namespace: "openbot",
      tool: discovery ? call.tool : "tool_call",
      arguments: discovery ? call.arguments : { name: call.tool, arguments: call.arguments },
    },
  });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return configRead(message.id);
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start":
      log({ kind: "thread", params });
      return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume":
      log({ kind: "thread", params });
      return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      log({ kind: "input", turnId, text });
      // \`<<ANSWER:<base64>>>\` sets the final answer of the turn, as a model would write it.
      const answer = [...text.matchAll(/<<ANSWER:([A-Za-z0-9+\\/=]+)>>/g)].at(-1);
      if (answer) answers.set(turnId, Buffer.from(answer[1], "base64").toString("utf8"));
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const match = text.includes(${JSON.stringify(mark)}) ? [...text.matchAll(/<<CALLS:([A-Za-z0-9+\\/=]+)>>/g)].at(-1) : null;
      if (!match) return setTimeout(() => finish(params.threadId, turnId), 20);
      const calls = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      return next(params.threadId, turnId, calls, 0);
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        log({ kind: "result", turnId: turn.turnId, index: turn.index, call: turn.calls[turn.index], result: message.result ?? null, error: message.error ?? null, ms: Date.now() - turn.sentAt });
        next(turn.threadId, turn.turnId, turn.calls, turn.index + 1);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;
}

export interface Call {
  readonly tool: string;
  readonly arguments: HubJsonObject;
}

export interface LogEntry {
  readonly kind: "env" | "thread" | "input" | "result";
  readonly turnId?: string;
  readonly index?: number;
  readonly call?: Call;
  readonly result?: { success: boolean; contentItems: { type: string; text: string }[] } | null;
  readonly error?: unknown;
  readonly text?: string;
  readonly params?: unknown;
  readonly env?: Record<string, string>;
  /** How long the app took to answer the tool call, in milliseconds. */
  readonly ms?: number;
}

/** One tool result as the agent reads it: the app's JSON fields, and the text with the envelope. */
export interface Seen {
  readonly success: boolean;
  readonly fields: HubJsonObject;
  readonly text: string;
  /** The tool that the agent called. */
  readonly tool: string;
  /** The turn of the fake Codex that made the call. */
  readonly turnId: string;
  /** How long the app took to answer, in milliseconds. */
  readonly ms: number;
}

/** One approval card that the person saw, and the answer that the harness gave. */
export interface SeenCard {
  readonly reason: string;
  readonly guard: boolean;
  readonly decision: "accept" | "decline";
}

export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function waitFor<T>(
  label: string,
  read: () => T | null | undefined | false,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

/** The JSON inside the first `<connection_output>` of a result. */
export function envelope(seen: Seen): string {
  const start = seen.text.indexOf("<connection_output");
  const end = seen.text.indexOf("</connection_output>");
  assert.ok(start >= 0 && end > start, `no envelope in: ${seen.text.slice(0, 300)}`);
  return seen.text.slice(seen.text.indexOf(">", start) + 1, end).trim();
}

/** The app's JSON fields of a result: its first line that parses as an object, after any Guard note. */
function resultFields(text: string): HubJsonObject {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed: HubJson = JSON.parse(line);
      if (isHubJsonObject(parsed)) return parsed;
    } catch {
      // A failure of the router is plain text.
    }
  }
  return {};
}

export interface AgentHarnessOptions {
  /** A new empty folder for the profile, the home folder and the fake Codex. */
  readonly root: string;
  /** The text that marks a turn whose input lists calls. */
  readonly mark: string;
  readonly hubFetch: typeof fetch;
  /** What `config/read` answers. Default: no servers of the person's own. */
  readonly codexConfig?: FakeCodexConfig;
  /** The stored Cultura Builder session, read at each use. */
  readonly session: () => string | null;
  readonly saveSession: (value: string | null) => void;
  /** The answer to each approval card. */
  readonly decide: (card: { readonly reason: string; readonly guard: boolean }) => "accept" | "decline";
  /** Whether a person that the host stamps on a message is a team member. Default: nobody is. */
  readonly remotePerson?: (personId: string) => boolean;
}

/** A person of the team, as the host stamps one on a message. */
export const TEAM_MEMBER = { id: "member-remote", name: "Remote member" } as const;

function seenOf(entry: LogEntry): Seen {
  const text = entry.result?.contentItems.map((item) => item.text).join("\n") ?? JSON.stringify(entry.error);
  return {
    success: entry.result?.success === true,
    fields: resultFields(text),
    text,
    tool: entry.call?.tool ?? "",
    turnId: entry.turnId ?? "",
    ms: entry.ms ?? 0,
  };
}

/** The text of a message whose turn runs `calls`, and then answers `answer` when one is given. */
export function callsText(mark: string, calls: readonly Call[], answer?: string): string {
  const answered = answer === undefined ? "" : ` <<ANSWER:${Buffer.from(answer).toString("base64")}>>`;
  return `${mark} <<CALLS:${Buffer.from(JSON.stringify(calls)).toString("base64")}>>${answered}`;
}

/** Starts the real agent service with the fake Codex, and one agent. */
export async function startAgentHarness(options: AgentHarnessOptions) {
  const userData = join(options.root, "user-data");
  const home = join(options.root, "home");
  const fakeCodex = join(options.root, "codex");
  const log = join(options.root, "codex.jsonl");
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.OPENBOT_CODEX_PATH = fakeCodex;
  mkdirSync(home, { recursive: true });
  await writeFile(fakeCodex, fakeCodexSource(log, options.mark, options.codexConfig ?? { mcpServers: {} }), {
    mode: 0o755,
  });

  const { AgentService } = await import("../../src/backend/agent-service");
  const { AgentStore } = await import("../../src/backend/agent-store");
  const { runCauseEffect } = await import("../../src/backend/effect-boundary");
  const { MailboxStore } = await import("../../src/backend/mailbox-store");
  const { BuildersBotDatabase } = await import("../../src/backend/openbot-database");

  const events: AgentEvent[] = [];
  const cards: SeenCard[] = [];
  const database = new BuildersBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    timezone: () => "UTC",
    credentials: {
      apiKey: (provider) => (provider === "cultura-builder" ? options.session() : null),
      saveApiKey: (provider, value) =>
        Effect.sync(() => {
          if (provider === "cultura-builder") options.saveSession(value);
        }),
      customProviders: () => [],
      mcpServers: () => [],
    },
    hubConnections: { fetch: options.hubFetch },
    ...(options.remotePerson ? { channelRemotePerson: options.remotePerson } : {}),
  });
  agents.on("event", (event) => {
    events.push(event);
    if (event.type !== "approval") return;
    const card = { reason: event.approval.reason ?? "", guard: event.approval.guard === true };
    const decision = options.decide(card);
    cards.push({ ...card, decision });
    void runCauseEffect(agents.respondToApproval({ requestId: event.approval.requestId, decision }));
  });

  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Researcher",
      description: "Finds market data.",
      avatarSeed: "researcher",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  const agentId = agent.id;
  const idle = () =>
    waitFor("the turn to end", () =>
      agents
        .listQueue(agentId)
        .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
    );
  await idle();

  const resultEntries = () => readLog(log).filter((entry) => entry.kind === "result");
  /** Waits for `count` more tool results after the first `before`, in the order the agents read them. */
  async function resultsAfter(before: number, count: number, timeoutMs = 90_000): Promise<Seen[]> {
    const entries = await waitFor(
      `${count} tool results`,
      () => {
        const all = resultEntries();
        return all.length >= before + count ? all.slice(before, before + count) : null;
      },
      timeoutMs,
    );
    return entries.map(seenOf);
  }
  /** Waits until no agent of this computer has work queued or running. */
  async function allIdle(): Promise<void> {
    await waitFor(
      "every agent to end its turns",
      () =>
        agents
          .listAgents()
          .every((agent) =>
            agents
              .listQueue(agent.id)
              .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
          ),
      90_000,
    );
  }

  /**
   * Sends one person's message whose turn runs `calls`, and returns what the agent read for each.
   * `member` is a person that the host stamps on the message, as a team member's app sends one.
   */
  async function turn(
    calls: Call[],
    turnOptions: { routine?: boolean; member?: { readonly id: string; readonly name: string } } = {},
  ): Promise<Seen[]> {
    const before = readLog(log).filter((entry) => entry.kind === "result").length;
    const text = callsText(options.mark, calls);
    if (turnOptions.routine) {
      const routine = agents.createRoutine({
        agentId,
        name: `Routine ${randomUUID().slice(0, 8)}`,
        instruction: text,
        active: false,
        timezone: "UTC",
        schedule: { kind: "daily", time: "09:00" },
      });
      await runCauseEffect(agents.testRoutine({ agentId, routineId: routine.id }));
    } else {
      await runCauseEffect(agents.sendMessage({ agentId, text, attachmentDraftIds: [] }, turnOptions.member));
    }
    const results = await waitFor(
      `${calls.length} tool results`,
      () => {
        const all = readLog(log).filter((entry) => entry.kind === "result");
        return all.length >= before + calls.length ? all.slice(before, before + calls.length) : null;
      },
      60_000,
    );
    await idle();
    return results.map(seenOf);
  }

  return {
    agents,
    agentId,
    events,
    cards,
    userData,
    home,
    log,
    turn,
    resultsAfter,
    resultCount: () => resultEntries().length,
    allIdle,
    readLog: () => readLog(log),
    runCauseEffect,
    async stop() {
      await runCauseEffect(agents.stop()).catch(() => undefined);
      database.close();
    },
  };
}
