// Checks the safe resume of a channel turn (`docs/architecture/agents.md#safe-turn-resume`): after a brief
// provider failure (529, ECONNRESET) in the middle of a channel task, the turn continues by itself in
// the same provider session only when its effect journal says that nothing can happen twice.
// Runs the real agent service on a temporary profile with the real `CodexAppServerClient`, which talks
// to a stand-in `codex` app-server. The stand-in runs a script per case and per turn from `control.json`:
// reads, file changes, calls to the app's own tools (`item/tool/call`, so the app's real handler runs),
// an outside MCP call that starts and never ends, and the provider failure. It logs each turn, with
// the resume note that the app gave it, and each tool result.
// Checks (the switch 'safe-resume' on, unless the case says off):
//   off. Switch off: the task fails as before, with the provider's text and the error banner; no second turn.
//   a. Only reads before the failure: the turn continues by itself, in the same provider thread, and the
//      task shows the wait ("resuming", hold `retrying`) with no error banner.
//   b. A local file change before an ECONNRESET: it continues.
//   c1. A channel_assign that ended with a result, then a 529: it continues, the note lists the assign as
//       done, and the stand-in, which obeys the note, does not call it again. One subtask.
//   c2. The same with a stand-in that calls the assign again: the app answers "already done" and runs no
//       second assign. One subtask, one result message.
//   d. An outside MCP post that started and has no result: no second turn. The task stops with "this may
//      already be done: MCP slack.post_message" and no provider text.
//   d2. The same with "resume also with an uncertain outside action" on: it continues, and the note marks
//      the post as uncertain with the order to check it first.
//   x1-x3. Outside commands that hide in a short flag group (`curl -sXPOST`), in an exit code (a push that
//      exited with 128 may have landed) and in a git global option (`--git-dir /r/.git push`): no second
//      turn, the task stops for the person.
//   own. An own tool call that the provider announced but never sent: the app's own record says that it
//      did not run, so the turn continues.
//   e. A failure on every turn: 1 + 3 turns with growing waits, then the task fails as before for the task
//      reviewer. The recovery ledger counts one recovery for the episode.
//   e2. The ledger has no recovery left for the task: no second turn, the task fails as before.
//   f. A person's Stop during the wait: no second turn, the task stays stopped.
//   f2. A deleted tab, and a deleted channel, during the wait: no second turn.
//   g. A restart during the wait: the stored wait has no provider text, and the turn continues once.
//   h. Two tabs of one agent: only the tab that failed waits; the other tab runs in the meantime.
// `bun scripts/safe-turn-resume-e2e.ts [--only=a,c2]`. Writes .openbot-build/safe-turn-resume-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentEvent,
  type ChannelTask,
  DEFAULT_START_RETRY_SETTINGS,
  defaultProviderModel,
  type OptimizationId,
  type StartRetrySettings,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { TURN_RESUME_NOTE_END, TURN_RESUME_NOTE_START } from "../src/backend/agent/turn-resume";

const ONLY = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const OUT = resolve(import.meta.dirname, "../.openbot-build/safe-turn-resume-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-safe-resume-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const codexExecutable = join(root, "codex");
const controlFile = join(root, "control.json");
const logFile = join(root, "turns.jsonl");
const MODEL = defaultProviderModel("codex");
// A marker that no stored record may keep: it is in each request and in the provider's error.
const SECRET = `do-not-store-${randomUUID()}`;
const OVERLOADED = `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded ${SECRET}"}}`;
const RESET = `stream disconnected before completion: error sending request: ECONNRESET ${SECRET}`;

process.env.HOME = home;
process.env.OPENBOT_CODEX_PATH = codexExecutable;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CLAUDE_PATH = join(root, "no-claude");
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { CodexAppServerClient } = await import("../src/backend/app-server-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");
const { WorkControl } = await import("../src/main/work-control");

/**
 * The stand-in Codex app-server. `control.json`: { "<case>": [steps of turn 0, steps of turn 1, …] }.
 * A turn with no script answers "Done.". A step:
 *   { do: "read" } / { do: "write" } / { do: "shell", command, exitCode?, open? }: a command or file change
 *     that ended, with an exit code, or that started and has no result (`open`).
 *   { do: "tool", tool, arguments, unlessNoted? }: calls the app's own tool and waits for its result.
 *     `unlessNoted` skips the call when the resume note names that tool, as a model that obeys it.
 *   { do: "started", server, tool }: an outside MCP call that starts and never ends.
 *   { do: "own-started", tool }: an own tool call that the provider announces and never sends.
 *   { do: "fail", message }: the provider error, and the turn ends failed.
 *   { do: "wait" }: the turn waits for an interrupt.
 * "$request" in an argument is the request message id of the task, read from the channel packet.
 */
const STAND_IN_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.1"); process.exit(0); }
const LOG = ${JSON.stringify(logFile)};
const START = ${JSON.stringify(TURN_RESUME_NOTE_START)};
const END = ${JSON.stringify(TURN_RESUME_NOTE_END)};
const threads = new Map();
const waiting = new Map();
const active = new Map();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify({ ...entry, at: Date.now() }) + "\\n");
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
const turnsOf = (caseId) => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "turn" && entry.caseId === caseId).length : 0;
const fill = (value, request) => {
  if (value === "$request") return request;
  if (Array.isArray(value)) return value.map((item) => fill(item, request));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, request)]));
  return value;
};
const run = (turn) => {
  const step = turn.steps.shift();
  const item = (method, value) => write({ method, params: { threadId: turn.threadId, turnId: turn.id, item: value } });
  const finish = (status, error) => {
    active.delete(turn.id);
    if (error) write({ method: "error", params: { threadId: turn.threadId, turnId: turn.id, error: { message: error }, willRetry: false } });
    write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.id, status, items: [] } } });
    log({ kind: "end", caseId: turn.caseId, index: turn.index, turnId: turn.id, status });
  };
  if (!step) {
    item("item/completed", { type: "agentMessage", id: randomUUID(), phase: "final_answer", text: "Done." });
    return finish("completed");
  }
  const next = () => setTimeout(() => run(turn), 5);
  switch (step.do) {
    case "read":
    case "shell": {
      const command = step.command || "cat README.md";
      const id = randomUUID();
      const actions = step.do === "read" ? [{ type: "read", command, name: "README.md", path: "README.md" }] : [{ type: "unknown", command }];
      item("item/started", { type: "commandExecution", id, command, cwd: "/", status: "inProgress", commandActions: actions });
      // \`open\`: the command started and the turn fails before its result.
      if (!step.open) {
        const exitCode = step.exitCode ?? 0;
        item("item/completed", { type: "commandExecution", id, command, cwd: "/", status: exitCode === 0 ? "completed" : "failed", exitCode, aggregatedOutput: "ok", commandActions: actions });
      }
      log({ kind: "step", caseId: turn.caseId, index: turn.index, step: step.do, command });
      return next();
    }
    case "write": {
      const id = randomUUID();
      const changes = [{ path: "/tmp/notes.txt", kind: { type: "add" } }];
      item("item/started", { type: "fileChange", id, changes, status: "inProgress" });
      item("item/completed", { type: "fileChange", id, changes, status: "completed" });
      log({ kind: "step", caseId: turn.caseId, index: turn.index, step: "write" });
      return next();
    }
    case "tool": {
      if (step.unlessNoted && turn.note && turn.note.includes(step.unlessNoted)) {
        log({ kind: "skipped", caseId: turn.caseId, index: turn.index, tool: step.tool });
        return next();
      }
      const id = "call-" + randomUUID();
      const args = fill(step.arguments || {}, turn.request);
      item("item/started", { type: "dynamicToolCall", id, namespace: "openbot", tool: step.tool, arguments: args, status: "inProgress" });
      waiting.set(id, { turn, step, args });
      return write({ id, method: "item/tool/call", params: { threadId: turn.threadId, turnId: turn.id, callId: id, namespace: "openbot", tool: step.tool, arguments: args } });
    }
    case "started": {
      item("item/started", { type: "mcpToolCall", id: randomUUID(), server: step.server, tool: step.tool, arguments: { text: "${SECRET}" }, status: "inProgress" });
      log({ kind: "step", caseId: turn.caseId, index: turn.index, step: "started" });
      return next();
    }
    case "own-started": {
      item("item/started", { type: "dynamicToolCall", id: randomUUID(), namespace: "openbot", tool: step.tool, arguments: {}, status: "inProgress" });
      return next();
    }
    case "fail":
      return finish("failed", step.message);
    case "wait":
      return;
  }
};
const answer = (request) => {
  const params = request.params ?? {};
  const reply = (result) => write({ id: request.id, result });
  const thread = threads.get(params.threadId) ?? { id: params.threadId, turns: [] };
  switch (request.method) {
    case "initialize": return reply({});
    case "account/read": return reply({ account: { type: "chatgpt", email: "codex@example.com" } });
    case "account/rateLimits/read": return reply({ rateLimits: null, rateLimitsByLimitId: null });
    case "model/list": return reply({ data: [{ model: ${JSON.stringify(MODEL)}, displayName: "Primary" }] });
    case "plugin/list": return reply({ marketplaces: [] });
    case "config/read": return reply(config);
    case "config/batchWrite": return reply({});
    case "thread/start": {
      const created = { id: randomUUID(), turns: [] };
      threads.set(created.id, created);
      return reply({ thread: created });
    }
    case "thread/resume":
    case "thread/read": return reply({ thread });
    case "thread/unsubscribe": return reply({ status: "Unsubscribed" });
    case "thread/turns/list": return reply({ data: [], nextCursor: null });
    case "thread/items/list": return reply({ data: [], nextCursor: null });
    case "turn/start": {
      const input = (params.input || []).map((item) => item.text || "").join("\\n");
      const id = randomUUID();
      reply({ turn: { id, status: "inProgress", items: [] } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id } } });
      // Only the request of the task names its case: a subtask or a referenced message does not run it.
      const caseId = /"instruction":"[^"]*?case:([a-z0-9-]+)/.exec(input)?.[1] ?? null;
      const start = input.indexOf(START);
      const note = start >= 0 ? input.slice(start, input.indexOf(END, start) + END.length) : null;
      const request = /"requestMessageId":"([^"]+)"/.exec(input)?.[1] ?? null;
      const index = caseId ? turnsOf(caseId) : 0;
      log({ kind: "turn", caseId, index, threadId: params.threadId, turnId: id, note });
      let control = {};
      try { control = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, "utf8")); } catch {}
      const steps = caseId && Array.isArray(control[caseId]) ? [...(control[caseId][index] || [])] : [];
      const turn = { id, threadId: params.threadId, caseId, index, steps, note, request };
      active.set(id, turn);
      return setTimeout(() => run(turn), 5);
    }
    case "turn/interrupt": {
      reply({});
      const turn = active.get(params.turnId);
      if (turn) {
        active.delete(turn.id);
        write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.id, status: "interrupted", items: [] } } });
        log({ kind: "end", caseId: turn.caseId, index: turn.index, turnId: turn.id, status: "interrupted" });
      }
      return;
    }
    default: return write({ id: request.id, error: { code: -32601, message: "Method not found: " + request.method } });
  }
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method) answer(message);
    else if (message.id !== undefined && waiting.has(message.id)) {
      const { turn, step } = waiting.get(message.id);
      waiting.delete(message.id);
      const text = (message.result?.contentItems || []).map((item) => item.text || "").join("\\n");
      const ok = message.result?.success !== false && !message.error;
      write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.id, item: { type: "dynamicToolCall", id: message.id, namespace: "openbot", tool: step.tool, status: ok ? "completed" : "failed" } } });
      log({ kind: "tool", caseId: turn.caseId, index: turn.index, tool: step.tool, ok, text: text.slice(0, 400) });
      setTimeout(() => run(turn), 5);
    }
  }
});
process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); else throw error; });
`;

interface LogEntry {
  kind: "turn" | "end" | "step" | "tool" | "skipped";
  caseId: string | null;
  index: number;
  threadId?: string;
  turnId?: string;
  note?: string | null;
  status?: string;
  tool?: string;
  ok?: boolean;
  text?: string;
  at: number;
}

/** A value of the report: JSON. */
type Fact = string | number | boolean | null | Fact[] | { [key: string]: Fact };

interface CaseReport {
  name: string;
  passed: boolean;
  facts: { [key: string]: Fact };
  error?: string;
}

const report: { cases: CaseReport[]; passed: boolean; checkedAt?: string; error?: string } = {
  cases: [],
  passed: false,
};

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function entries(caseId?: string): LogEntry[] {
  try {
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): LogEntry => JSON.parse(line))
      .filter((entry) => caseId === undefined || entry.caseId === caseId);
  } catch {
    return [];
  }
}
const turns = (caseId: string) => entries(caseId).filter((entry) => entry.kind === "turn");
const ends = (caseId: string) => entries(caseId).filter((entry) => entry.kind === "end");

type Step = { [key: string]: Fact; do: string };
const control: Record<string, Step[][]> = {};
function script(caseId: string, ...turnSteps: Step[][]) {
  control[caseId] = turnSteps;
  writeFileSync(controlFile, JSON.stringify(control));
}

/** The switches of this host, as the main process keeps them. */
const switches = new Set<OptimizationId>(["safe-resume"]);
let settings: StartRetrySettings = { ...DEFAULT_START_RETRY_SETTINGS, firstDelaySeconds: 1, maxDelaySeconds: 2 };
/** The waits of the safe resume, short so that the check runs in seconds. */
let resumeDelays = [1, 1, 1];
/**
 * The load panel of the main process (`WorkControl`), with "Resume by itself" on and no timer: its
 * recovery ledger is the one that the safe resume takes from, and its plan says what the person sees.
 */
let load: InstanceType<typeof WorkControl> | null = null;
/** The tasks that took a recovery from the ledger. */
const budgetTakes: string[] = [];

function startService() {
  const database = new BuildersBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const service = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    clientFactory: (_provider, cli) => new CodexAppServerClient(cli.executable, 30000),
    channelTabLimit: () => 2,
    startRetry: { settings: () => settings, breakers: { read: () => [], write: () => {} } },
    optimizations: {
      optimizationEnabled: (id) => switches.has(id),
      onOptimizationChange: () => () => {},
    },
    safeResume: {
      delaysSeconds: () => resumeDelays,
      recoveryBudget: {
        take: (channelId, taskId) => {
          const taken = load?.takeSafeResume(channelId, taskId) ?? true;
          if (taken) budgetTakes.push(taskId);
          return taken;
        },
      },
    },
  });
  const events: AgentEvent[] = [];
  service.on("event", (event) => events.push(event));
  load = new WorkControl({
    service,
    agentLimit: () => ({ enabled: false, max: 10 }),
    channelActor: () => ({ id: "person", name: "Person" }),
    preference: () => ({ enabled: true, intervalMinutes: 30, reassign: true }),
    onFailure: () => {},
  });
  return { database, store, mailbox, service, events };
}

/** The plan of the load panel for a stopped task: what the person sees next to it. */
const planOf = (taskId: string) => load?.listStopped().items.find((item) => item.taskId === taskId)?.plan ?? null;

await writeFile(codexExecutable, STAND_IN_CODEX, { mode: 0o755 });
writeFileSync(controlFile, "{}");
let app = startService();
const actor = { id: "person", name: "Person" };

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    app.service.createAgent({
      name,
      description: "Checks the safe resume.",
      avatarSeed: randomUUID(),
      avatarHue: null,
      provider: "codex",
      model: MODEL,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the first turn to end", () =>
    app.service.listQueue(agent.id).deliveries.every((delivery) => delivery.status === "completed"),
  );
  return agent.id;
}

const channelIds: string[] = [];
async function createChannel(name: string, memberIds: string[]) {
  const channelId = randomUUID();
  channelIds.push(channelId);
  await runCauseEffect(
    app.service.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId,
        draft: {
          name,
          title: name,
          instructions: "",
          members: memberIds.map((agentId) => ({ agentId })),
          leadAgentId: memberIds[0] ?? null,
        },
      },
      actor,
    ),
  );
  return channelId;
}

async function createTab(channelId: string) {
  const topicId = randomUUID();
  await runCauseEffect(
    app.service.channels.command({ type: "topic-create", operationId: randomUUID(), channelId, topicId }, actor),
  );
  return topicId;
}

async function send(channelId: string, agentId: string, text: string, topicId?: string) {
  await runCauseEffect(
    app.service.channels.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId,
        ...(topicId ? { topicId } : {}),
        text,
        recipientAgentId: agentId,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
}

function tasks(channelId: string): ChannelTask[] {
  return app.service.channels.store.tasks(channelId);
}
function taskOf(channelId: string, mark: string): ChannelTask | undefined {
  const named = new RegExp(`${mark}(?![\\w-])`, "u");
  return tasks(channelId).find((task) => named.test(task.instruction) && task.parentTaskId === null);
}
/** The task as the screen reads it, with the wait of its assignment (`startRetry`). */
function shown(channelId: string, mark: string): ChannelTask | undefined {
  const topicId = app.service.channels.store.firstTopic(channelId)?.id ?? `openbot-topic-${channelId}`;
  const named = new RegExp(`${mark}(?![\\w-])`, "u");
  return app.service.channels.store
    .page(channelId, topicId)
    .tasks.find((task) => named.test(task.instruction) && task.parentTaskId === null);
}
const resuming = (channelId: string, mark: string) => {
  const task = shown(channelId, mark);
  return task?.startRetry?.phase === "resuming" ? task : null;
};
const settled = (task: ChannelTask | undefined) =>
  task && (task.state === "completed" || task.state === "failed" || task.state === "paused") ? task : null;

/** The provider error banners of an agent: a resumed failure shows none. */
const banners = (agentId: string) =>
  app.events.filter((event) => event.type === "error" && "agentId" in event && event.agentId === agentId).length;

/** Each stored delivery and channel record, to check that none keeps the provider's text or the request. */
function storedRows(deliveryId?: string): string[] {
  const rows: unknown[] = deliveryId
    ? app.database.connection
        .prepare("SELECT delivery_json AS json FROM projection_deliveries WHERE delivery_id = ?")
        .all(deliveryId)
    : app.database.connection.prepare("SELECT delivery_json AS json FROM projection_deliveries").all();
  return rows.flatMap((row) => (isDynamicRecord(row) && typeof row.json === "string" ? [row.json] : []));
}

const gaps = (rows: LogEntry[]) => rows.slice(1).map((row, index) => row.at - (rows[index]?.at ?? row.at));

async function runCase(id: string, name: string, check: (facts: CaseReport["facts"]) => Promise<void>) {
  if (ONLY && !ONLY.includes(id)) return;
  const result: CaseReport = { name: `${id}: ${name}`, passed: false, facts: {} };
  report.cases.push(result);
  try {
    await check(result.facts);
    result.passed = true;
    process.stdout.write(`PASS ${result.name}\n`);
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(`FAIL ${result.name}\n${result.error}\n`);
  }
}

try {
  await runCauseEffect(app.service.initialize());
  const helper = await createAgent("Helper");

  await runCase("off", "switch off: the task fails as before", async (facts) => {
    switches.delete("safe-resume");
    try {
      const agent = await createAgent("Off");
      const channelId = await createChannel("off", [agent]);
      script("off", [{ do: "read" }, { do: "fail", message: OVERLOADED }]);
      const before = banners(agent);
      await send(channelId, agent, `case:off ${SECRET}`);
      const task = await waitFor("the task to stop", () => settled(taskOf(channelId, "case:off")));
      await new Promise((done) => setTimeout(done, 2_500));
      facts.state = task.state;
      facts.turns = turns("off").length;
      assert.equal(task.state, "failed");
      assert.ok(task.error?.includes("529"), `The provider's text stays, as before: ${task.error}`);
      assert.equal(turns("off").length, 1, "No second turn.");
      assert.equal(banners(agent) - before, 1, "The error banner shows, as before.");
    } finally {
      switches.add("safe-resume");
    }
  });

  await runCase("a", "only reads: the turn continues in the same session", async (facts) => {
    const agent = await createAgent("Reads");
    const channelId = await createChannel("reads", [agent]);
    script("a", [{ do: "read" }, { do: "read" }, { do: "fail", message: OVERLOADED }], []);
    resumeDelays = [3, 3, 3];
    const before = banners(agent);
    await send(channelId, agent, `case:a ${SECRET}`);
    const waiting = await waitFor("the task to show the wait", () => resuming(channelId, "case:a"));
    resumeDelays = [1, 1, 1];
    facts.wait = JSON.stringify(waiting.startRetry);
    assert.equal(waiting.state, "queued");
    assert.equal(waiting.error, null, "No card while it waits.");
    assert.equal(app.service.channels.queuedHolds().get(waiting.id), "retrying", "The reviewer's hold.");
    const task = await waitFor("the task to end", () => settled(taskOf(channelId, "case:a")));
    const rows = turns("a");
    facts.turns = rows.length;
    facts.note = rows[1]?.note ?? null;
    assert.equal(task.state, "completed", task.error ?? "");
    assert.equal(rows.length, 2, "One turn again.");
    assert.equal(rows[0]?.threadId, rows[1]?.threadId, "The same provider thread.");
    assert.equal(rows[0]?.note, null);
    assert.ok(rows[1]?.note?.includes("Check the current state"), "The note asks to check before acting.");
    assert.equal(banners(agent) - before, 0, "No error banner for a failure that the app resumed.");
  });

  await runCase("b", "a local file change before an ECONNRESET: it continues", async (facts) => {
    const agent = await createAgent("Writes");
    const channelId = await createChannel("writes", [agent]);
    script("b", [{ do: "read" }, { do: "write" }, { do: "fail", message: RESET }], []);
    await send(channelId, agent, `case:b ${SECRET}`);
    const task = await waitFor("the task to end", () => settled(taskOf(channelId, "case:b")));
    facts.turns = turns("b").length;
    facts.note = turns("b")[1]?.note ?? null;
    assert.equal(task.state, "completed", task.error ?? "");
    assert.equal(turns("b").length, 2);
    assert.ok(turns("b")[1]?.note?.includes("file change"), "The note lists the file change as done.");
  });

  const assign = (caseId: string) => ({
    do: "tool",
    tool: "channel_assign",
    arguments: {
      recipientAgentId: helper,
      task: `Summarize the notes for ${caseId}.`,
      expectedResult: "A short summary.",
      sourceMessageIds: ["$request"],
    },
  });
  const subtasks = (channelId: string, parentId: string) =>
    tasks(channelId).filter((task) => task.parentTaskId === parentId).length;

  await runCase("c1", "an assign that ended with a result: the obedient model does not repeat it", async (facts) => {
    const agent = await createAgent("Assigns");
    const channelId = await createChannel("assigns", [agent, helper]);
    script(
      "c1",
      [assign("c1"), { do: "fail", message: OVERLOADED }],
      [{ ...assign("c1"), unlessNoted: "channel_assign" }],
    );
    await send(channelId, agent, `case:c1 ${SECRET}`);
    await waitFor("the second turn to end", () => ends("c1").length >= 2);
    const parent = taskOf(channelId, "case:c1");
    assert.ok(parent);
    facts.subtasks = subtasks(channelId, parent.id);
    facts.note = turns("c1")[1]?.note ?? null;
    assert.ok(turns("c1")[1]?.note?.includes("openbot.channel_assign"), "The note lists the assign as done.");
    assert.equal(entries("c1").filter((entry) => entry.kind === "skipped").length, 1, "The model skipped it.");
    assert.equal(entries("c1").filter((entry) => entry.kind === "tool").length, 1, "One assign call in all.");
    assert.equal(subtasks(channelId, parent.id), 1, "One subtask.");
  });

  await runCase(
    "c2",
    "a model that calls the assign again gets 'already done', and no second assign runs",
    async (facts) => {
      const agent = await createAgent("Repeats");
      const channelId = await createChannel("repeats", [agent, helper]);
      script(
        "c2",
        [assign("c2"), { do: "fail", message: OVERLOADED }],
        [assign("c2"), { do: "tool", tool: "channel_result", arguments: { text: "The summary is assigned." } }],
      );
      await send(channelId, agent, `case:c2 ${SECRET}`);
      await waitFor("the second turn to end", () => ends("c2").length >= 2);
      const parent = taskOf(channelId, "case:c2");
      assert.ok(parent);
      const calls = entries("c2").filter((entry) => entry.kind === "tool");
      facts.calls = calls.map((entry) => `${entry.tool} ${entry.ok ? "ok" : "failed"}: ${entry.text ?? ""}`);
      assert.equal(calls.length, 3, "assign, assign again, result");
      assert.ok(
        calls[1]?.text?.includes('"alreadyDone":true'),
        `The second assign is answered as done: ${calls[1]?.text}`,
      );
      assert.equal(subtasks(channelId, parent.id), 1, "One subtask: the handler did not run again.");
      const results = app.service.channels.store
        .messages(channelId, parent.topicId ?? `openbot-topic-${channelId}`)
        .filter((entry) => entry.id.startsWith("channel-result-"));
      assert.equal(results.length, 1, "One result message.");
    },
  );

  await runCase("d", "an outside post with no result: no second turn, the person decides", async (facts) => {
    const agent = await createAgent("Posts");
    const channelId = await createChannel("posts", [agent]);
    script("d", [
      { do: "read" },
      { do: "started", server: "slack", tool: "post_message" },
      { do: "fail", message: OVERLOADED },
    ]);
    await send(channelId, agent, `case:d ${SECRET}`);
    const task = await waitFor("the task to stop", () => settled(taskOf(channelId, "case:d")));
    await new Promise((done) => setTimeout(done, 2_500));
    facts.state = task.state;
    facts.error = task.error;
    assert.equal(turns("d").length, 1, "No second turn.");
    assert.equal(task.state, "failed");
    assert.equal(
      task.error,
      sourceText("error.backend.channelTaskMayBeDone", { actions: "MCP slack.post_message" }),
      "The card says what may already be done.",
    );
    assert.ok(!task.error?.includes(SECRET), "No provider text or request text on the card.");
    const plan = planOf(task.id);
    facts.plan = JSON.stringify(plan);
    assert.equal(plan?.state, "needs-you", "The load panel leaves it to the person: no resume, no other agent.");
  });

  await runCase("d2", "with the uncertain option on, it continues and checks first", async (facts) => {
    settings = { ...settings, resumeUncertainActions: true };
    try {
      const agent = await createAgent("Checks");
      const channelId = await createChannel("checks", [agent]);
      script(
        "d2",
        [
          { do: "started", server: "slack", tool: "post_message" },
          { do: "fail", message: OVERLOADED },
        ],
        [{ do: "shell", command: "slack-cli history --limit 5" }],
      );
      await send(channelId, agent, `case:d2 ${SECRET}`);
      const task = await waitFor("the task to end", () => settled(taskOf(channelId, "case:d2")));
      const note = turns("d2")[1]?.note ?? "";
      facts.note = note;
      assert.equal(task.state, "completed", task.error ?? "");
      assert.ok(note.includes("MCP slack.post_message"), "The note names the uncertain post.");
      assert.ok(note.includes("may already have happened"), "The note marks it as uncertain.");
      assert.ok(!note.includes(SECRET), "The note has no argument text.");
    } finally {
      settings = { ...settings, resumeUncertainActions: false };
    }
  });

  // Commands that read as outside actions only when the journal fails closed (`command-effects.ts`).
  const hidden = [
    {
      id: "x1",
      step: { do: "shell", command: `curl -sXPOST ${"https://x.test"}/hook`, open: true },
      label: "curl (sends data)",
    },
    { id: "x2", step: { do: "shell", command: "git push origin main", exitCode: 128 }, label: "git push" },
    { id: "x3", step: { do: "shell", command: "git --git-dir /r/.git push", open: true }, label: "git push" },
  ] as const;
  for (const entry of hidden)
    await runCase(entry.id, `a hidden outside command (${entry.step.command}): the person decides`, async (facts) => {
      const agent = await createAgent(`Hidden ${entry.id}`);
      const channelId = await createChannel(`hidden-${entry.id}`, [agent]);
      script(entry.id, [{ do: "read" }, { ...entry.step }, { do: "fail", message: OVERLOADED }], []);
      await send(channelId, agent, `case:${entry.id} ${SECRET}`);
      const task = await waitFor("the task to stop", () => settled(taskOf(channelId, `case:${entry.id}`)));
      await new Promise((done) => setTimeout(done, 2_500));
      facts.error = task.error;
      assert.equal(turns(entry.id).length, 1, "No second turn.");
      assert.equal(task.state, "failed");
      assert.equal(task.error, sourceText("error.backend.channelTaskMayBeDone", { actions: entry.label }));
    });

  await runCase("own", "an own tool call that never reached the app: the app's record clears it", async (facts) => {
    const agent = await createAgent("Announces");
    const channelId = await createChannel("announces", [agent, helper]);
    script(
      "own",
      [
        { do: "own-started", tool: "channel_assign" },
        { do: "fail", message: OVERLOADED },
      ],
      [],
    );
    await send(channelId, agent, `case:own ${SECRET}`);
    const task = await waitFor("the task to end", () => settled(taskOf(channelId, "case:own")));
    facts.turns = turns("own").length;
    assert.equal(task.state, "completed", task.error ?? "");
    assert.equal(turns("own").length, 2);
  });

  await runCase("e", "a failure on every turn: 1 + 3 turns, then the task stops for the reviewer", async (facts) => {
    const agent = await createAgent("Fails");
    const channelId = await createChannel("fails", [agent]);
    resumeDelays = [1, 2, 3];
    const fail: Step[] = [{ do: "read" }, { do: "fail", message: OVERLOADED }];
    script("e", fail, fail, fail, fail, fail);
    await send(channelId, agent, `case:e ${SECRET}`);
    const task = await waitFor("the task to stop", () => settled(taskOf(channelId, "case:e")), 60_000);
    await new Promise((done) => setTimeout(done, 4_000));
    resumeDelays = [1, 1, 1];
    const rows = turns("e");
    facts.gaps = gaps(rows);
    facts.takes = budgetTakes.filter((id) => id === task.id).length;
    assert.equal(rows.length, 4, "One turn and 3 tries.");
    const waits = gaps(rows);
    assert.ok(waits[0] !== undefined && waits[0] >= 700 && waits[0] < 3_000, `First wait: ${waits[0]}`);
    assert.ok(waits[2] !== undefined && waits[2] >= 2_200 && waits[2] < 6_000, `Third wait: ${waits[2]}`);
    assert.equal(task.state, "failed", "The task stops as before, for the task reviewer.");
    assert.ok(task.error?.includes("529"));
    assert.equal(budgetTakes.filter((id) => id === task.id).length, 1, "One recovery in the ledger for the episode.");
    const plan = planOf(task.id);
    facts.plan = JSON.stringify(plan);
    assert.equal(plan?.tries, 1, "The load panel counts the episode as one try of the shared limit.");
    assert.equal(plan?.action, "resume", "Resume by itself still has one resume left for the task.");
  });

  await runCase("e2", "no recovery left in the ledger: the task stops as before", async (facts) => {
    const agent = await createAgent("Spent");
    const channelId = await createChannel("spent", [agent]);
    script("e2", [{ do: "read" }, { do: "fail", message: OVERLOADED }], []);
    // "Resume by itself" already resumed this task twice: spend the ledger as soon as the task exists.
    const spend = setInterval(() => {
      const task = taskOf(channelId, "case:e2");
      if (task && load?.takeSafeResume(channelId, task.id)) load.takeSafeResume(channelId, task.id);
    }, 1);
    await send(channelId, agent, `case:e2 ${SECRET}`);
    const task = await waitFor("the task to stop", () => settled(taskOf(channelId, "case:e2")));
    clearInterval(spend);
    await new Promise((done) => setTimeout(done, 2_500));
    facts.state = task.state;
    assert.equal(turns("e2").length, 1);
    assert.equal(task.state, "failed");
  });

  await runCase("f", "a person's Stop during the wait: no second turn", async (facts) => {
    const agent = await createAgent("Stops");
    const channelId = await createChannel("stops", [agent]);
    resumeDelays = [4, 4, 4];
    script("f", [{ do: "read" }, { do: "fail", message: OVERLOADED }], []);
    await send(channelId, agent, `case:f ${SECRET}`);
    const waiting = await waitFor("the wait", () => resuming(channelId, "case:f"));
    resumeDelays = [1, 1, 1];
    await runCauseEffect(
      app.service.channels.command(
        { type: "stop", operationId: randomUUID(), channelId, taskId: waiting.id, recipientAgentId: null },
        actor,
      ),
    );
    await new Promise((done) => setTimeout(done, 6_000));
    const task = taskOf(channelId, "case:f");
    facts.state = task?.state ?? null;
    assert.equal(turns("f").length, 1, "No second turn after the Stop.");
    assert.equal(task?.state, "paused");
  });

  await runCase("f2", "a deleted tab or channel during the wait: no second turn", async (facts) => {
    const agent = await createAgent("Deletes");
    const channelId = await createChannel("deletes", [agent]);
    const tab = await createTab(channelId);
    resumeDelays = [4, 4, 4];
    script("f2", [{ do: "read" }, { do: "fail", message: OVERLOADED }], []);
    await send(channelId, agent, `case:f2 ${SECRET}`, tab);
    await waitFor("the wait", () => {
      const task = tasks(channelId).find((item) => item.instruction.includes("case:f2"));
      return task?.state === "queued" && turns("f2").length === 1 && ends("f2").length === 1;
    });
    await runCauseEffect(
      app.service.channels.command({ type: "topic-delete", operationId: randomUUID(), channelId, topicId: tab }, actor),
    );
    const other = await createAgent("Gone");
    const otherChannel = await createChannel("deleted", [other]);
    script("f3", [{ do: "read" }, { do: "fail", message: OVERLOADED }], []);
    await send(otherChannel, other, `case:f3 ${SECRET}`);
    await waitFor("the second wait", () => resuming(otherChannel, "case:f3"));
    // An agent with a queued request is deleted only after a Stop, which the case f checks: here the channel goes.
    await runCauseEffect(app.service.channels.deleteChannel(otherChannel));
    resumeDelays = [1, 1, 1];
    await new Promise((done) => setTimeout(done, 6_000));
    facts.turns = [turns("f2").length, turns("f3").length];
    assert.equal(turns("f2").length, 1, "No turn after the tab was deleted.");
    assert.equal(turns("f3").length, 1, "No turn after the channel was deleted.");
  });

  await runCase("g", "a restart during the wait: one turn again, and no provider text stored", async (facts) => {
    const agent = await createAgent("Restarts");
    const channelId = await createChannel("restarts", [agent]);
    resumeDelays = [4, 4, 4];
    script("g", [{ do: "read" }, { do: "fail", message: OVERLOADED }], []);
    await send(channelId, agent, `case:g ${SECRET}`);
    const waiting = await waitFor("the wait", () => resuming(channelId, "case:g"));
    const deliveryId = app.service.channels.store
      .assignments(channelId)
      .find((assignment) => assignment.taskId === waiting.id)?.deliveryId;
    assert.ok(deliveryId, "The task keeps its delivery.");
    await runCauseEffect(app.service.stop());
    const row = storedRows(deliveryId)[0] ?? "";
    app.database.close();
    app = startService();
    const stored = JSON.parse(row || "{}");
    facts.stored = JSON.stringify(stored.turnResume ?? null);
    assert.equal(stored.status, "queued");
    assert.equal(stored.turnResume?.attempt, 1, "The stored delivery keeps the wait.");
    assert.ok(!row.includes("Overloaded"), "No provider text in the stored wait.");
    await runCauseEffect(app.service.initialize());
    resumeDelays = [1, 1, 1];
    const task = await waitFor("the task to end after the restart", () => settled(taskOf(channelId, "case:g")));
    facts.turns = turns("g").length;
    assert.equal(task.state, "completed", task.error ?? "");
    assert.equal(turns("g").length, 2, "One turn again, not two.");
  });

  await runCase("h", "two tabs of one agent: only the tab that failed waits", async (facts) => {
    const agent = await createAgent("Tabs");
    const channelId = await createChannel("tabs", [agent]);
    const other = await createTab(channelId);
    // Long enough that the other tab's whole request ends inside it, also on a busy computer.
    resumeDelays = [12, 12, 12];
    script("h", [{ do: "read" }, { do: "fail", message: OVERLOADED }], []);
    script("h-other", []);
    await send(channelId, agent, `case:h ${SECRET}`);
    await waitFor("the wait", () => resuming(channelId, "case:h"));
    resumeDelays = [1, 1, 1];
    await send(channelId, agent, "case:h-other a short request", other);
    const otherEnd = await waitFor("the other tab to end", () => ends("h-other")[0]);
    const stillWaiting = resuming(channelId, "case:h") !== null;
    const task = await waitFor("the failed tab to end", () => settled(taskOf(channelId, "case:h")));
    const resumed = turns("h")[1];
    facts.otherEndedWhileWaiting = stillWaiting;
    assert.ok(stillWaiting, "The other tab ran while the failed tab waited.");
    assert.ok(resumed && otherEnd.at < resumed.at, "The failed tab continued after.");
    assert.equal(task.state, "completed", task.error ?? "");
  });

  await runCase("text", "no stored record keeps the request or the provider's text", async () => {
    for (const row of storedRows()) {
      const delivery = JSON.parse(row);
      if (delivery.turnResume) assert.ok(!JSON.stringify(delivery.turnResume).includes(SECRET));
    }
    for (const channelId of channelIds)
      for (const assignment of app.service.channels.store.assignments(channelId))
        assert.ok(!JSON.stringify(assignment.startRetry ?? {}).includes(SECRET));
  });

  report.passed = report.cases.every((entry) => entry.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(app.service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  app.database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ...report, turns: entries() }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
