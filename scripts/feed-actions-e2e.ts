// Checks the actions on the cards of the feed (`src/main/feed/feed-actions.ts`) against the real agent
// service. The service runs on a temporary profile with the real `CodexAppServerClient`, which talks to
// a stand-in `codex` app-server, as `safe-turn-resume-e2e.ts` does. The real `FeedService` gets every
// event of the service, as `forwardAgentEvent` gives it in the app, and reads the load of the real
// `WorkControl`. The real `FeedActions` is wired as in `application-services.ts`: the same operations
// as the conversation (`respondToApproval`, `respondToPrompt`) and the load panel (`stopWork`,
// `bulkStopped`). The stand-in logs each turn, each answer it gets and each end.
// Checks:
//   approve. An approval of a command waits; "approve" on the card answers it, and the turn goes on.
//            Two approvals at the same time and one after: one answer reaches the provider.
//   inflight. With an answer that takes time (as a hosted-site change does), a second approval while
//            the first runs is a duplicate, and one answer reaches the provider.
//   deny.    "deny" on the card: the turn gets the refusal and goes on.
//   deputy.  A forged card, a card of another agent with the request of this one, a request id of
//            another type, a card of a joined server with the same request id, and an answered card:
//            each is refused, and no answer reaches the provider.
//   risk.    A request for more access is `high` risk: an approval without the confirmation is
//            refused, with it the provider gets the answer.
//   answer.  A question with choices: the card answers with the index of a choice, the provider gets
//            the label. A question with no choice takes typed text. Two questions: the card does not
//            offer "answer" and main refuses it.
//   stop.    "stop" with another start time is refused; with the start of the run, the turn stops.
//   resume.  A channel task that stopped because an outside post may already have happened: "resume"
//            on its card starts the run again, and the new turn reads the note of what was done.
//   bulk.    Two stopped tasks and a forged card in one "resume": the two run again, the forged one
//            is refused, and a second "resume" finds them gone.
//   reassign. A stopped task goes to the other member of its channel; an agent that is not a
//            candidate is refused.
// `bun scripts/feed-actions-e2e.ts [--only=approve,stop]`. Writes .openbot-build/feed-actions-e2e/report.json.
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
  type FeedActionInput,
  type FeedActionResult,
  type FeedDelta,
  type FeedItem,
  type OptimizationId,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { TURN_RESUME_NOTE_END, TURN_RESUME_NOTE_START } from "../src/backend/agent/turn-resume";

const ONLY = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",");
const OUT = resolve(import.meta.dirname, "../.openbot-build/feed-actions-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-feed-actions-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const codexExecutable = join(root, "codex");
const controlFile = join(root, "control.json");
const logFile = join(root, "turns.jsonl");
const MODEL = defaultProviderModel("codex");
// A planted provider key in the reason of an approval. It is joined at run time, so a secret scanner of
// the repository does not take the fixture for a real key.
const PROVIDER_KEY = ["sk", "test", "FEEDACTIONS0123456789abcdefABCDEF"].join("-");
const OVERLOADED = `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;

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
const { FeedService } = await import("../src/main/feed/feed-service");
const { FeedActions } = await import("../src/main/feed/feed-actions");

/**
 * The stand-in Codex app-server. `control.json`: { "<case>": [steps of turn 0, steps of turn 1, …] }.
 * A turn with no script answers "Done.". A step:
 *   { do: "read" }: a command that reads and ends.
 *   { do: "approve", method?, command?, permissions? }: asks for an approval and waits for the answer.
 *   { do: "ask", questions }: asks the person and waits for the answer.
 *   { do: "started", server, tool }: an outside MCP call that starts and never ends.
 *   { do: "fail", message }: the provider error, and the turn ends failed.
 *   { do: "wait" }: the turn waits for an interrupt.
 * Each answer of the app to a request is logged with the request id, so the check counts them.
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
const run = (turn) => {
  if (!active.has(turn.id)) return;
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
    case "read": {
      const command = "cat README.md";
      const id = randomUUID();
      const actions = [{ type: "read", command, name: "README.md", path: "README.md" }];
      item("item/started", { type: "commandExecution", id, command, cwd: "/", status: "inProgress", commandActions: actions });
      item("item/completed", { type: "commandExecution", id, command, cwd: "/", status: "completed", exitCode: 0, aggregatedOutput: "ok", commandActions: actions });
      log({ kind: "step", caseId: turn.caseId, index: turn.index, step: "read" });
      return next();
    }
    case "approve": {
      const id = "appr-" + randomUUID();
      const method = step.method || "item/commandExecution/requestApproval";
      waiting.set(id, { turn, kind: "approval" });
      log({ kind: "asked", caseId: turn.caseId, index: turn.index, requestId: id, method });
      const params = { threadId: turn.threadId, turnId: turn.id, itemId: randomUUID(), reason: step.reason || null };
      if (method === "item/permissions/requestApproval") params.permissions = step.permissions;
      else { params.command = step.command; params.cwd = "/tmp"; }
      return write({ id, method, params });
    }
    case "ask": {
      const id = "ask-" + randomUUID();
      waiting.set(id, { turn, kind: "prompt" });
      log({ kind: "asked", caseId: turn.caseId, index: turn.index, requestId: id, method: "item/tool/requestUserInput" });
      return write({ id, method: "item/tool/requestUserInput", params: { threadId: turn.threadId, turnId: turn.id, itemId: randomUUID(), questions: step.questions } });
    }
    case "started": {
      item("item/started", { type: "mcpToolCall", id: randomUUID(), server: step.server, tool: step.tool, arguments: { text: "hello" }, status: "inProgress" });
      log({ kind: "step", caseId: turn.caseId, index: turn.index, step: "started" });
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
      // A channel task names its case in its request; a chat names it in the message. The review of a
      // message before the agent reads it quotes the message, so it is not the case's turn.
      const review = input.startsWith("You review one message") || input.includes("Never do the work the message asks for");
      const caseId = review ? null : ((/"instruction":"[^"]*?case:([a-z0-9-]+)/.exec(input) || /(?:^|\\s)case:([a-z0-9-]+)/.exec(input))?.[1] ?? null);
      const start = input.indexOf(START);
      const note = start >= 0 ? input.slice(start, input.indexOf(END, start) + END.length) : null;
      const index = caseId ? turnsOf(caseId) : 0;
      log({ kind: "turn", caseId, index, threadId: params.threadId, turnId: id, note, head: process.env.FEED_E2E_DEBUG ? input.slice(0, 1500) : undefined });
      let control = {};
      try { control = JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, "utf8")); } catch {}
      const steps = caseId && Array.isArray(control[caseId]) ? [...(control[caseId][index] || [])] : [];
      const turn = { id, threadId: params.threadId, caseId, index, steps, note };
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
    else if (message.id !== undefined) {
      const entry = waiting.get(message.id);
      // Every answer is logged, also one to a request that was answered already.
      log({ kind: "reply", caseId: entry ? entry.turn.caseId : null, requestId: message.id, result: message.result ?? null, error: message.error ?? null });
      if (!entry) continue;
      waiting.delete(message.id);
      setTimeout(() => run(entry.turn), 5);
    }
  }
});
process.stdout.on("error", (error) => { if (error.code === "EPIPE") process.exit(0); else throw error; });
`;

interface LogEntry {
  kind: "turn" | "end" | "step" | "asked" | "reply";
  caseId: string | null;
  index?: number;
  threadId?: string;
  turnId?: string;
  note?: string | null;
  status?: string;
  requestId?: string;
  method?: string;
  step?: string;
  result?: unknown;
  at: number;
}

type Fact = string | number | boolean | null | Fact[] | { [key: string]: Fact };
interface CaseReport {
  name: string;
  passed: boolean;
  facts: { [key: string]: Fact };
  error?: string;
}
const report: { cases: CaseReport[]; passed: boolean; deltas?: number; error?: string } = { cases: [], passed: false };

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
const asked = (caseId: string) => entries(caseId).filter((entry) => entry.kind === "asked");
/** Every answer that reached the provider for one request, also a late or a repeated one. */
const replies = (requestId: string) =>
  entries().filter((entry) => entry.kind === "reply" && entry.requestId === requestId);

type Step = { [key: string]: Fact; do: string };
const control: Record<string, Step[][]> = {};
function script(caseId: string, ...turnSteps: Step[][]) {
  control[caseId] = turnSteps;
  writeFileSync(controlFile, JSON.stringify(control));
}

const switches = new Set<OptimizationId>(["safe-resume"]);
const database = new BuildersBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
let load: InstanceType<typeof WorkControl> | null = null;
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  clientFactory: (_provider, cli) => new CodexAppServerClient(cli.executable, 30000),
  channelTabLimit: () => 2,
  startRetry: {
    settings: () => ({ ...DEFAULT_START_RETRY_SETTINGS, firstDelaySeconds: 1, maxDelaySeconds: 2 }),
    breakers: { read: () => [], write: () => {} },
  },
  optimizations: { optimizationEnabled: (id) => switches.has(id), onOptimizationChange: () => () => {} },
  safeResume: {
    delaysSeconds: () => [1, 1, 1],
    recoveryBudget: { take: (channelId, taskId) => load?.takeSafeResume(channelId, taskId) ?? true },
  },
});
const workControl = new WorkControl({
  service,
  agentLimit: () => ({ enabled: false, max: 10 }),
  channelActor: () => ({ id: "person", name: "Person" }),
  // "Resume by itself" is off and its timer never starts: only the person resumes here.
  preference: () => ({ enabled: false, intervalMinutes: 30, reassign: false }),
  onFailure: () => {},
});
load = workControl;
const feed = new FeedService({
  readLoad: () => {
    const work = workControl.overview();
    return { running: work.running, stopped: work.stopped };
  },
  readLocalRuntime: () => service.getRuntimeSnapshot(),
});
const failures: string[] = [];
const actions = new FeedActions({
  feed,
  pendingRequest: (kind, requestId) => service.pendingRequest(kind, requestId),
  respondToApproval: (input) => runCauseEffect(service.respondToApproval(input)),
  respondToPrompt: (input) => runCauseEffect(service.respondToPrompt(input)),
  stopWork: (input) => workControl.stopWork(input),
  bulkStopped: (input) => workControl.bulkStopped(input),
  onFailure: (action, cause) => failures.push(`${action}: ${cause instanceof Error ? cause.name : typeof cause}`),
});
const events: AgentEvent[] = [];
service.on("event", (event: AgentEvent) => {
  events.push(event);
  feed.ingest("local", event);
});
// One window watches, as the page does: it keeps every delta.
const deltas: FeedDelta[] = [];
feed.setWatching(
  {
    id: 1,
    send: (delta) => {
      deltas.push(structuredClone(delta));
      return true;
    },
  },
  true,
);

/** The action as the window sends it: through a structured clone, as IPC copies it. */
const act = (input: FeedActionInput): Promise<FeedActionResult> => actions.act(structuredClone(input));
const actor = { id: "person", name: "Person" };

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks the feed actions.",
      avatarSeed: randomUUID(),
      avatarHue: null,
      provider: "codex",
      model: MODEL,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the first turn to end", () =>
    service.listQueue(agent.id).deliveries.every((delivery) => delivery.status === "completed"),
  );
  return agent.id;
}

async function say(agentId: string, text: string) {
  await runCauseEffect(service.sendMessage({ agentId, text }));
}

/** The chat card of an agent: a copy of the card as main holds it now, as a window has it. */
function chatCard(agentId: string): FeedItem | undefined {
  const threadId = store.list().find((agent) => agent.id === agentId)?.threadId;
  const card = threadId ? feed.card(`local:t:${agentId}:${threadId}`) : undefined;
  return card ? structuredClone(card) : undefined;
}

async function createChannel(name: string, memberIds: string[]) {
  const channelId = randomUUID();
  await runCauseEffect(
    service.channels.command(
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

async function post(channelId: string, agentId: string, text: string) {
  await runCauseEffect(
    service.channels.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId,
        text,
        recipientAgentId: agentId,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
}

function taskOf(channelId: string, mark: string): ChannelTask | undefined {
  const named = new RegExp(`${mark}(?![\\w-])`, "u");
  return service.channels.store
    .tasks(channelId)
    .find((task) => named.test(task.instruction) && task.parentTaskId === null);
}
const settled = (task: ChannelTask | undefined) =>
  task && (task.state === "completed" || task.state === "failed" || task.state === "paused") ? task : null;

/** A copy of the card of a stopped task, after a read of the load, as the page reads it while it is open. */
async function stoppedCard(taskId: string): Promise<FeedItem> {
  return waitFor(`the stopped card of ${taskId}`, () => {
    feed.refreshLoad();
    const card = feed.card(`local:task:${taskId}`);
    return card?.state === "stopped" ? structuredClone(card) : null;
  });
}

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

const failureOf = (result: FeedActionResult) => result.failed[0]?.reason ?? null;
/** Gives the provider time to log an answer that should not come. */
const settle = () => new Promise((done) => setTimeout(done, 400));

try {
  await writeFile(codexExecutable, STAND_IN_CODEX, { mode: 0o755 });
  writeFileSync(controlFile, "{}");
  await runCauseEffect(service.initialize());

  await runCase("approve", "approve on the card answers once, and the turn goes on", async (facts) => {
    const agent = await createAgent("Approver");
    script("approve", [{ do: "approve", command: "git push origin main" }, { do: "read" }]);
    await say(agent, "case:approve");
    const card = await waitFor("the card to wait for an approval", () =>
      chatCard(agent)?.need?.kind === "approval" ? chatCard(agent) : null,
    );
    const need = card.need;
    assert.ok(need);
    facts.label = need.label;
    facts.actions = [...card.actions];
    assert.equal(need.label, "git", "The card shows the program name only.");
    assert.equal(need.risk, undefined, "A command that the Guard did not mark is not high risk.");
    assert.ok(card.actions.includes("approve") && card.actions.includes("deny"), "The card offers approve and deny.");
    const requestId = asked("approve")[0]?.requestId;
    assert.ok(requestId);
    const input: FeedActionInput = { v: 1, action: "approve", itemId: card.id, requestId: need.requestId };
    // Two clicks at the same time: one runs. The other finds the request running ("duplicate") or
    // already answered ("stale"): the answer of the service is synchronous, so the card can change first.
    const [first, second] = await Promise.all([act(input), act(input)]);
    facts.first = JSON.stringify(first);
    facts.second = JSON.stringify(second);
    assert.equal(first.done + second.done, 1, "Only one of two approvals at the same time is done.");
    const refusal = first.done === 1 ? failureOf(second) : failureOf(first);
    assert.ok(refusal === "duplicate" || refusal === "stale", `The other approval is refused: ${refusal}.`);
    await waitFor("the turn to end", () => ends("approve").length >= 1);
    // A third approval after the answer: the card waits for nothing now.
    const third = await act(input);
    facts.third = JSON.stringify(third);
    assert.equal(third.done, 0, "An approval of an answered request does nothing.");
    assert.ok(["stale", "duplicate"].includes(failureOf(third) ?? ""), `Refused: ${failureOf(third)}.`);
    await settle();
    const answers = replies(requestId);
    facts.replies = answers.length;
    facts.decision = JSON.stringify(answers[0]?.result ?? null);
    assert.equal(answers.length, 1, "Exactly one answer reached the provider.");
    assert.deepEqual(answers[0]?.result, { decision: "accept" }, "The provider got the approval.");
    assert.ok(
      entries("approve").some((entry) => entry.kind === "step" && entry.step === "read"),
      "The turn went on after the approval.",
    );
    assert.equal(ends("approve")[0]?.status, "completed");
    const after = await waitFor("the card to end", () => (chatCard(agent)?.state === "done" ? chatCard(agent) : null));
    assert.equal(after.need, null);
    assert.ok(!after.actions.includes("approve"), "The ended card offers no approval.");
  });

  await runCase("inflight", "a second approval while the first runs is a duplicate", async (facts) => {
    const agent = await createAgent("Slow approver");
    script("inflight", [{ do: "approve", command: "git tag v1" }, { do: "read" }]);
    await say(agent, "case:inflight");
    const card = await waitFor("the card to wait for an approval", () =>
      chatCard(agent)?.need?.kind === "approval" ? chatCard(agent) : null,
    );
    // The same wiring, with an answer that waits for a gate before it reaches the service.
    let open = () => {};
    const gate = new Promise<void>((done) => {
      open = done;
    });
    const slow = new FeedActions({
      feed,
      pendingRequest: (kind, requestId) => service.pendingRequest(kind, requestId),
      respondToApproval: async (input) => {
        await gate;
        await runCauseEffect(service.respondToApproval(input));
      },
      respondToPrompt: (input) => runCauseEffect(service.respondToPrompt(input)),
      stopWork: (input) => workControl.stopWork(input),
      bulkStopped: (input) => workControl.bulkStopped(input),
      onFailure: () => {},
    });
    const input: FeedActionInput = { v: 1, action: "approve", itemId: card.id, requestId: card.need?.requestId ?? "" };
    const first = slow.act(structuredClone(input));
    const second = await slow.act(structuredClone(input));
    facts.second = failureOf(second);
    assert.equal(failureOf(second), "duplicate", "The second approval while the first runs is a duplicate.");
    open();
    assert.equal((await first).done, 1);
    await waitFor("the turn to end", () => ends("inflight").length >= 1);
    await settle();
    const requestId = asked("inflight")[0]?.requestId ?? "";
    facts.replies = replies(requestId).length;
    assert.equal(replies(requestId).length, 1, "One answer reached the provider.");
  });

  await runCase("deny", "deny on the card: the turn gets the refusal and goes on", async (facts) => {
    const agent = await createAgent("Denier");
    script("deny", [{ do: "approve", command: "rm -rf build" }, { do: "read" }]);
    await say(agent, "case:deny");
    const card = await waitFor("the card to wait for an approval", () =>
      chatCard(agent)?.need?.kind === "approval" ? chatCard(agent) : null,
    );
    const result = await act({ v: 1, action: "deny", itemId: card.id, requestId: card.need?.requestId ?? "" });
    facts.result = JSON.stringify(result);
    assert.equal(result.done, 1, "The refusal was given.");
    await waitFor("the turn to end", () => ends("deny").length >= 1);
    const requestId = asked("deny")[0]?.requestId ?? "";
    await settle();
    facts.decision = JSON.stringify(replies(requestId)[0]?.result ?? null);
    assert.equal(replies(requestId).length, 1);
    assert.deepEqual(replies(requestId)[0]?.result, { decision: "decline" }, "The provider got the refusal.");
    assert.ok(
      entries("deny").some((entry) => entry.kind === "step" && entry.step === "read"),
      "The turn went on.",
    );
  });

  await runCase("deputy", "a forged, crossed, retyped, remote or old card approves nothing", async (facts) => {
    const first = await createAgent("Deputy A");
    const second = await createAgent("Deputy B");
    script("deputy-a", [{ do: "approve", command: "git status" }]);
    script("deputy-b", [{ do: "approve", command: "npm publish" }]);
    await say(first, "case:deputy-a");
    await say(second, "case:deputy-b");
    const cardA = await waitFor("A to wait", () =>
      chatCard(first)?.need?.kind === "approval" ? chatCard(first) : null,
    );
    const cardB = await waitFor("B to wait", () =>
      chatCard(second)?.need?.kind === "approval" ? chatCard(second) : null,
    );
    const requestA = cardA.need?.requestId ?? "";
    const requestB = cardB.need?.requestId ?? "";
    const forged = await act({
      v: 1,
      action: "approve",
      itemId: `local:t:${first}:forged-thread`,
      requestId: requestA,
    });
    // The card of A with the request of B: main checks the request against the card it names.
    const crossed = await act({ v: 1, action: "approve", itemId: cardA.id, requestId: requestB });
    // The same id with another type is another request.
    const retyped = await act({ v: 1, action: "approve", itemId: cardA.id, requestId: 0 });
    // A joined server's card that names the request of B: refused before any check of the request.
    feed.ingest("remote-e2e", {
      type: "approval",
      approval: {
        requestId: requestB,
        agentId: second,
        threadId: cardB.threadId ?? "",
        turnId: "remote-turn",
        kind: "command",
        command: "npm publish",
        cwd: "/",
        reason: null,
        grantRoot: null,
        permissions: null,
      },
    });
    const remoteId = `remote-e2e:t:${second}:${cardB.threadId}`;
    const remote = await waitFor("the remote card", () => feed.card(remoteId));
    facts.remoteActions = [...remote.actions];
    assert.deepEqual(remote.actions, ["open"], "A joined server's card offers only open.");
    const remoteTry = await act({ v: 1, action: "approve", itemId: remoteId, requestId: requestB });
    await settle();
    const tries = { forged, crossed, retyped, remote: remoteTry };
    for (const [name, result] of Object.entries(tries)) facts[name] = failureOf(result);
    assert.equal(failureOf(forged), "gone");
    assert.equal(failureOf(crossed), "stale");
    assert.equal(failureOf(retyped), "stale");
    assert.equal(failureOf(remoteTry), "remote");
    assert.ok(
      Object.values(tries).every((result) => result.done === 0),
      "None of them did anything.",
    );
    assert.equal(replies(String(requestA)).length, 0, "A got no answer.");
    assert.equal(replies(String(requestB)).length, 0, "B got no answer.");
    assert.ok(service.pendingRequest("approval", requestA), "A still waits.");
    assert.ok(service.pendingRequest("approval", requestB), "B still waits.");
    // The person answers both; then the old cards approve nothing.
    assert.equal((await act({ v: 1, action: "deny", itemId: cardA.id, requestId: requestA })).done, 1);
    assert.equal((await act({ v: 1, action: "deny", itemId: cardB.id, requestId: requestB })).done, 1);
    const old = await act({ v: 1, action: "approve", itemId: cardA.id, requestId: requestA });
    facts.old = failureOf(old);
    assert.equal(old.done, 0, "An old card approves nothing.");
    await settle();
    assert.equal(replies(String(requestA)).length, 1, "A got one answer, the refusal.");
    assert.deepEqual(replies(String(requestA))[0]?.result, { decision: "decline" });
  });

  await runCase("risk", "a high risk approval needs the confirmation", async (facts) => {
    const agent = await createAgent("Risky");
    script("risk", [
      {
        do: "approve",
        method: "item/permissions/requestApproval",
        reason: `Needs the network to install the packages with ${PROVIDER_KEY}.`,
        permissions: { network: { enabled: true }, fileSystem: { read: [], write: ["/tmp/feed-e2e"] } },
      },
      { do: "read" },
    ]);
    await say(agent, "case:risk");
    const card = await waitFor("the card to wait", () =>
      chatCard(agent)?.need?.kind === "approval" ? chatCard(agent) : null,
    );
    const need = card.need;
    assert.ok(need);
    facts.need = JSON.stringify(need);
    assert.equal(need.risk, "high", "More access is high risk.");
    assert.deepEqual(need.access, { network: true, write: 1 }, "The card says what is asked, with no path.");
    assert.ok(need.reason?.startsWith("Needs the network to install the packages with"), "The card shows the reason.");
    assert.ok(!JSON.stringify(need).includes(PROVIDER_KEY), "The key in the reason is masked.");
    assert.ok(!JSON.stringify(need).includes("/tmp/feed-e2e"), "No path on the card.");
    const unconfirmed = await act({ v: 1, action: "approve", itemId: card.id, requestId: need.requestId });
    facts.unconfirmed = failureOf(unconfirmed);
    assert.equal(failureOf(unconfirmed), "unconfirmed", "Without the confirmation, main refuses.");
    await settle();
    const requestId = asked("risk")[0]?.requestId ?? "";
    assert.equal(replies(requestId).length, 0, "No answer reached the provider.");
    const confirmed = await act({
      v: 1,
      action: "approve",
      itemId: card.id,
      requestId: need.requestId,
      confirmed: true,
    });
    assert.equal(confirmed.done, 1, "With the confirmation, the approval is given.");
    await waitFor("the turn to end", () => ends("risk").length >= 1);
    assert.equal(replies(requestId).length, 1);
    facts.reply = JSON.stringify(replies(requestId)[0]?.result ?? null);
  });

  await runCase("answer", "the card answers a simple question, and only a simple one", async (facts) => {
    const agent = await createAgent("Asker");
    script("answer", [
      {
        do: "ask",
        questions: [
          {
            id: "pick",
            header: "Thumbnail",
            question: "Which thumbnail goes up?",
            options: [
              { label: "Blue", description: "" },
              { label: "Red", description: "" },
            ],
          },
        ],
      },
      { do: "ask", questions: [{ id: "name", header: "Name", question: "What is the title?", options: null }] },
      {
        do: "ask",
        questions: [
          { id: "one", header: "One", question: "First?", options: null },
          { id: "two", header: "Two", question: "Second?", options: null },
        ],
      },
      { do: "read" },
    ]);
    await say(agent, "case:answer");
    const choiceCard = await waitFor("the first question", () =>
      chatCard(agent)?.need?.kind === "prompt" ? chatCard(agent) : null,
    );
    facts.form = JSON.stringify(choiceCard.need?.form ?? null);
    assert.deepEqual(choiceCard.need?.form, { choices: ["Blue", "Red"], text: true });
    assert.ok(choiceCard.actions.includes("answer"), "The card offers an answer.");
    const picked = await act({
      v: 1,
      action: "answer",
      itemId: choiceCard.id,
      requestId: choiceCard.need?.requestId ?? "",
      choice: 1,
    });
    assert.equal(picked.done, 1);
    const firstId = asked("answer")[0]?.requestId ?? "";
    await waitFor("the answer of the choice", () => replies(firstId).length > 0);
    facts.choiceReply = JSON.stringify(replies(firstId)[0]?.result ?? null);
    assert.deepEqual(replies(firstId)[0]?.result, { answers: { pick: { answers: ["Red"] } } });
    const again = await act({
      v: 1,
      action: "answer",
      itemId: choiceCard.id,
      requestId: choiceCard.need?.requestId ?? "",
      choice: 0,
    });
    assert.equal(again.done, 0, "A second answer to the same question does nothing.");

    const textCard = await waitFor("the second question", () =>
      chatCard(agent)?.need?.kind === "prompt" && chatCard(agent)?.need?.requestId !== choiceCard.need?.requestId
        ? chatCard(agent)
        : null,
    );
    assert.deepEqual(textCard.need?.form, { choices: [], text: true });
    const typed = await act({
      v: 1,
      action: "answer",
      itemId: textCard.id,
      requestId: textCard.need?.requestId ?? "",
      text: "  Feed de ações  ",
    });
    assert.equal(typed.done, 1);
    const secondId = asked("answer")[1]?.requestId ?? "";
    await waitFor("the typed answer", () => replies(secondId).length > 0);
    assert.deepEqual(replies(secondId)[0]?.result, { answers: { name: { answers: ["Feed de ações"] } } });

    const twoCard = await waitFor("the two questions", () =>
      chatCard(agent)?.need?.questionCount === 2 ? chatCard(agent) : null,
    );
    facts.twoActions = [...twoCard.actions];
    assert.equal(twoCard.need?.form, undefined, "Two questions are for the conversation.");
    assert.ok(!twoCard.actions.includes("answer"), "The card does not offer an answer.");
    const refused = await act({
      v: 1,
      action: "answer",
      itemId: twoCard.id,
      requestId: twoCard.need?.requestId ?? "",
      text: "yes",
    });
    facts.twoRefused = failureOf(refused);
    assert.equal(failureOf(refused), "not-allowed");
    const thirdId = asked("answer")[2]?.requestId ?? "";
    await settle();
    assert.equal(replies(thirdId).length, 0, "No answer reached the provider.");
    // The conversation answers it, as before.
    await runCauseEffect(
      service.respondToPrompt({ requestId: twoCard.need?.requestId ?? "", answers: { one: ["a"], two: ["b"] } }),
    );
    await waitFor("the turn to end", () => ends("answer").length >= 1);
  });

  await runCase("stop", "stop on the card stops the run that the person saw", async (facts) => {
    const agent = await createAgent("Stopper");
    script("stop", [{ do: "read" }, { do: "wait" }]);
    await say(agent, "case:stop");
    const card = await waitFor("the card to work", () =>
      chatCard(agent)?.actions.includes("stop") && entries("stop").some((entry) => entry.kind === "step")
        ? chatCard(agent)
        : null,
    );
    const wrong = await act({ v: 1, action: "stop", itemId: card.id, startedAt: "2020-01-01T00:00:00.000Z" });
    facts.wrongStart = failureOf(wrong);
    assert.equal(failureOf(wrong), "stale", "Another start time is another run.");
    await settle();
    assert.equal(ends("stop").length, 0, "The run goes on.");
    const stopped = await act({ v: 1, action: "stop", itemId: card.id, startedAt: card.startedAt });
    facts.stopped = JSON.stringify(stopped);
    assert.equal(stopped.done, 1);
    await waitFor("the turn to stop", () => ends("stop").length >= 1);
    assert.equal(ends("stop")[0]?.status, "interrupted");
    const after = await waitFor("the card to show the stop", () =>
      chatCard(agent)?.state === "stopped" ? chatCard(agent) : null,
    );
    assert.equal(after.stop?.source, "interrupted");
    assert.ok(!after.actions.includes("stop"), "A stopped card offers no stop.");
    const again = await act({ v: 1, action: "stop", itemId: card.id, startedAt: card.startedAt });
    facts.again = failureOf(again);
    assert.equal(again.done, 0, "A second stop does nothing.");
  });

  await runCase("resume", "resume on the card: the new turn reads what was already done", async (facts) => {
    const agent = await createAgent("Poster");
    const channelId = await createChannel("posts", [agent]);
    script(
      "resume",
      [{ do: "read" }, { do: "started", server: "slack", tool: "post_message" }, { do: "fail", message: OVERLOADED }],
      [],
    );
    await post(channelId, agent, "case:resume");
    const task = await waitFor("the task to stop", () => settled(taskOf(channelId, "case:resume")));
    await new Promise((done) => setTimeout(done, 2_500));
    assert.equal(turns("resume").length, 1, "No second turn by itself.");
    const card = await stoppedCard(task.id);
    facts.actions = [...card.actions];
    facts.reason = card.stop?.reason ?? null;
    assert.ok(card.actions.includes("resume"), "The stopped task offers resume.");
    const result = await act({ v: 1, action: "resume", itemIds: [card.id] });
    facts.result = JSON.stringify(result);
    assert.equal(result.done, 1);
    await waitFor("the resumed turn to end", () => ends("resume").length >= 2);
    const note = turns("resume")[1]?.note ?? "";
    facts.note = note.slice(0, 400);
    assert.ok(note.includes("the person resumed the task"), "The resumed turn reads the note of the stopped turn.");
    assert.ok(note.includes("MCP slack.post_message"), "The note names the step that may already have happened.");
    await waitFor("the card to leave", () => {
      feed.refreshLoad();
      return !feed.card(card.id);
    });
    const again = await act({ v: 1, action: "resume", itemIds: [card.id] });
    facts.again = failureOf(again);
    assert.equal(again.done, 0, "A second resume does nothing.");
    assert.equal(turns("resume").length, 2, "No third turn.");
  });

  await runCase("bulk", "one resume for many cards; a forged card is refused", async (facts) => {
    const agent = await createAgent("Bulk");
    const channelA = await createChannel("bulk a", [agent]);
    const channelB = await createChannel("bulk b", [agent]);
    script("bulk-a", [{ do: "fail", message: "fatal: the request was refused" }], []);
    script("bulk-b", [{ do: "fail", message: "fatal: the request was refused" }], []);
    await post(channelA, agent, "case:bulk-a");
    const taskA = await waitFor("task A to stop", () => settled(taskOf(channelA, "case:bulk-a")));
    await post(channelB, agent, "case:bulk-b");
    const taskB = await waitFor("task B to stop", () => settled(taskOf(channelB, "case:bulk-b")));
    const cardA = await stoppedCard(taskA.id);
    const cardB = await stoppedCard(taskB.id);
    const forged = "local:task:forged-task";
    const result = await act({ v: 1, action: "resume", itemIds: [cardA.id, cardB.id, forged, cardA.id] });
    facts.result = JSON.stringify(result);
    assert.equal(result.done, 2, "Both tasks start again.");
    assert.deepEqual(result.failed, [{ itemId: forged, reason: "gone" }], "Only the forged card is refused.");
    await waitFor("both to run again", () => ends("bulk-a").length >= 2 && ends("bulk-b").length >= 2);
    const again = await act({ v: 1, action: "resume", itemIds: [cardA.id, cardB.id] });
    facts.again = JSON.stringify(again);
    assert.equal(again.done, 0, "A second resume does nothing.");
    assert.equal(turns("bulk-a").length, 2);
    assert.equal(turns("bulk-b").length, 2);
  });

  await runCase("reassign", "reassign on the card gives the task to the other member", async (facts) => {
    const owner = await createAgent("Owner");
    const helper = await createAgent("Helper");
    const outsider = await createAgent("Outsider");
    const channelId = await createChannel("handoff", [owner, helper]);
    script("reassign", [{ do: "fail", message: "fatal: the request was refused" }], []);
    await post(channelId, owner, "case:reassign");
    const task = await waitFor("the task to stop", () => settled(taskOf(channelId, "case:reassign")));
    const card = await stoppedCard(task.id);
    facts.candidates = JSON.stringify(card.reassignTo ?? null);
    assert.ok(card.actions.includes("reassign"), "The card offers reassign.");
    assert.deepEqual(
      card.reassignTo?.map((candidate) => candidate.agentId),
      [helper],
      "The other member is the candidate.",
    );
    const refused = await act({ v: 1, action: "reassign", itemIds: [card.id], recipientAgentId: outsider });
    facts.refused = failureOf(refused);
    assert.equal(failureOf(refused), "not-member");
    const result = await act({ v: 1, action: "reassign", itemIds: [card.id], recipientAgentId: helper });
    facts.result = JSON.stringify(result);
    assert.equal(result.done, 1);
    await waitFor("the helper to run it", () => ends("reassign").length >= 2);
    const after = service.channels.store.tasks(channelId).find((entry) => entry.id === task.id);
    facts.owner = after?.ownerAgentId ?? null;
    assert.equal(after?.ownerAgentId, helper, "The helper owns the task now.");
  });

  const sent = JSON.stringify(deltas);
  report.deltas = deltas.length;
  assert.ok(!sent.includes(PROVIDER_KEY), "No delta holds the planted key.");
  report.passed = report.cases.length > 0 && report.cases.every((entry) => entry.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  feed.dispose();
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ ...report, failures }, null, 2)}\n`);
  if (process.env.FEED_E2E_DEBUG) writeFileSync(join(OUT, "turns.jsonl"), readFileSync(logFile, "utf8"));
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  process.exit(process.exitCode ?? 0);
}
