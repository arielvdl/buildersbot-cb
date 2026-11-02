// Checks the feed of the main process (`src/main/feed/`) against the real agent service. The agent
// service runs on a temporary profile with the real `ClaudeAgentClient`, which the Claude Agent SDK
// connects to a stand-in `claude` executable, as `claude-late-steer-e2e.ts` does. Every event of the
// service goes to the real `FeedService`, as `forwardAgentEvent` sends it in the app. The events of a
// joined server are sent to the same `ingest`, as `remoteServers.on("agent")` does. It checks that:
// - a turn becomes a `working` card, gets steps, waits for the person on a question, goes back to
//   `working` when the question is answered, and ends `done`;
// - an approval of a joined server makes its card `needs-you` with the program name only, and its
//   answer takes the card back to `working`;
// - a burst of 2,000 steps in one second sends at most 10 deltas in any second, each card at most once
//   in a delta, and the cards end with the right last step and step count;
// - a planted provider key (`sk-test-…`), a GitHub token, the secret of an MCP server and an unlabelled
//   MCP value are in no field of any delta or snapshot, and neither is the text of the conversation;
// - with 6,000 runs the main process keeps 5,000 cards and drops the oldest ended ones;
// - with no window that watches, no delta is sent.
// `bun scripts/feed-aggregator-e2e.ts`. Writes .openbot-build/feed-aggregator-e2e/report.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentEvent,
  defaultProviderModel,
  FEED_DELTA_LIMIT,
  FEED_DELTAS_PER_SECOND,
  FEED_SNAPSHOT_LIMIT,
  type FeedDelta,
  type FeedItem,
  type McpServerConfig,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import type { ClaudeCliInfo } from "../src/backend/cli";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder } from "../src/backend/protocol";
import { providerSync } from "../src/backend/provider-client-effects";
import type { ReadProviderHistory } from "../src/backend/provider-history";

const OUT = resolve(import.meta.dirname, "../.openbot-build/feed-aggregator-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-feed-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const claudeConfig = join(home, ".claude");
const projectsDir = join(claudeConfig, "projects", "stand-in");
const claudeExecutable = join(root, "claude");
// The stand-in waits for these files, so the check sees each state of the turn on its own.
const askMarker = join(root, "ask");
const finishMarker = join(root, "finish");
const CLAUDE_MODEL = defaultProviderModel("claude");

// The secrets the check plants. None of them may reach a delta or a snapshot. They are joined at run
// time, so a secret scanner of the repository does not take the fixtures for real keys.
const PROVIDER_KEY = ["sk", "test", "FEEDE2E0123456789abcdefABCDEF"].join("-");
const GITHUB_TOKEN = ["ghp", "FEEDE2E0123456789abcdefABCDEFabcdef01"].join("_");
const MCP_HEADER_SECRET = "mcp-header-secret-FEEDE2E-4815162342";
const MCP_PLAIN_VALUE = "plainworkspace-FEEDE2E-778899";
const SECRETS = [PROVIDER_KEY, GITHUB_TOKEN, MCP_HEADER_SECRET, MCP_PLAIN_VALUE];
// The text of the conversation. The feed shows summaries only.
const USER_TEXT = "feed-ask USER-CONTENT-MARKER-31337";
const ANSWER_TEXT = `ANSWER-CONTENT-MARKER-42 ${PROVIDER_KEY}`;
const QUESTION_TEXT = `May I use ${PROVIDER_KEY} with ${MCP_HEADER_SECRET} and ${MCP_PLAIN_VALUE}?`;
const CONTENT_MARKERS = ["USER-CONTENT-MARKER-31337", "ANSWER-CONTENT-MARKER-42", "curl -H"];

process.env.HOME = home;
process.env.OPENBOT_CLAUDE_PATH = claudeExecutable;
process.env.CLAUDE_CONFIG_DIR = claudeConfig;
mkdirSync(projectsDir, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { ClaudeAgentClient } = await import("../src/backend/claude-client");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");
const { mcpSecretValues, registerMcpSecretValues } = await import("../src/backend/mcp-redaction");
const { FeedService } = await import("../src/main/feed/feed-service");

// The stand-in for the Claude CLI. A message with "feed-ask" runs a Bash step whose command holds a
// secret, then asks the person through AskUserQuestion, waits for the answer, and ends the turn.
const STAND_IN_CLAUDE = `#!${process.execPath}
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const until = (path) => new Promise((done) => {
  const look = () => (fs.existsSync(path) ? done() : setTimeout(look, 20));
  look();
});
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.302 (Claude Code)\\n");
  process.exit(0);
}
const option = (name) => {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(name + "="));
  if (index < 0) return null;
  return args[index] === name ? (args[index + 1] ?? null) : args[index].slice(name.length + 1);
};
const sessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
const model = ${JSON.stringify(CLAUDE_MODEL)};
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
// The Guard reviews each message with its own session, which has no tools. It gets a plain answer.
const review = args.some((arg) => arg.startsWith("--tools="));
const frame = (message) => ({ ...message, parent_tool_use_id: null, session_id: sessionId });
const usage = { input_tokens: 1, output_tokens: 1 };
const assistant = (message, content, stop) => write(frame({ type: "assistant", uuid: randomUUID(), user_message_uuid: message.uuid,
  message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model, content, stop_reason: stop, usage } }));
const toolResult = (id, text) => write(frame({ type: "user", uuid: randomUUID(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] } }));
const waiting = new Map();
const answered = (requestId) => new Promise((done) => waiting.set(requestId, done));
const turn = async (message) => {
  write(frame({ type: "stream_event", uuid: randomUUID(), user_message_uuid: message.uuid, user_message_uuids: [message.uuid],
    event: { type: "message_start", message: { id: "msg_" + message.uuid, type: "message", role: "assistant", content: [] } } }));
  if (!review && JSON.stringify(message.message).includes("feed-ask")) {
    const bash = "toolu_bash_" + randomUUID().slice(0, 8);
    assistant(message, [{ type: "tool_use", id: bash, name: "Bash",
      input: { command: ${JSON.stringify(`curl -H 'Authorization: Bearer ${PROVIDER_KEY}' -H 'X-Token: ${GITHUB_TOKEN}' https://example.invalid`)} } }], "tool_use");
    toolResult(bash, ${JSON.stringify(`ok ${PROVIDER_KEY}`)});
    await until(${JSON.stringify(askMarker)});
    const ask = "toolu_ask_" + randomUUID().slice(0, 8);
    const questions = [{ question: ${JSON.stringify(QUESTION_TEXT)}, header: "Token", multiSelect: false,
      options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }];
    assistant(message, [{ type: "tool_use", id: ask, name: "AskUserQuestion", input: { questions } }], "tool_use");
    const requestId = "perm-" + randomUUID().slice(0, 8);
    const reply = answered(requestId);
    write({ type: "control_request", request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions }, tool_use_id: ask } });
    await reply;
    toolResult(ask, "answered");
    const list = "toolu_list_" + randomUUID().slice(0, 8);
    assistant(message, [{ type: "tool_use", id: list, name: "Bash", input: { command: "ls" } }], "tool_use");
    await until(${JSON.stringify(finishMarker)});
    toolResult(list, "files");
  }
  const text = ${JSON.stringify(ANSWER_TEXT)};
  assistant(message, [{ type: "text", text }], "end_turn");
  write(frame({ type: "result", subtype: "success", is_error: false, result: text, uuid: randomUUID(),
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage, permission_denials: [] }));
};
let buffer = "";
let chain = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request")
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    else if (message.type === "control_response") waiting.get(message.response?.request_id)?.();
    else if (message.type === "user") chain = chain.then(() => turn(message));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

/** The real Claude client. Only the account, usage and model reads are answered here. */
class ClaudeStandIn extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "claude";
  readonly contextCompaction = "native";
  readonly #real: InstanceType<typeof ClaudeAgentClient>;
  readonly readHistory: ReadProviderHistory;

  constructor(cli: ClaudeCliInfo) {
    super();
    this.#real = new ClaudeAgentClient(cli);
    this.readHistory = this.#real.readHistory;
    this.#real.on("notification", (notification) => this.emit("notification", notification));
    this.#real.on("request", (request) => this.emit("request", request));
    this.#real.on("diagnostic", (message) => this.emit("diagnostic", message));
    this.#real.on("exit", (error) => this.emit("exit", error));
  }

  get running(): boolean {
    return this.#real.running;
  }

  start(): void {
    this.#real.start();
  }

  stop() {
    return this.#real.stop();
  }

  canReleaseProcess = () => this.#real.canReleaseProcess();

  releaseThread(externalThreadId: string) {
    return this.#real.releaseThread(externalThreadId);
  }

  releaseIdleThreads() {
    return this.#real.releaseIdleThreads();
  }

  request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>, timeoutMs?: number) {
    if (!this.#real.running) return this.#real.request(method, params, decoder, timeoutMs);
    switch (method) {
      case "account/read":
        return providerSync(() => decoder({ account: { type: "claude", email: "claude@example.com" } }));
      case "account/rateLimits/read":
        return providerSync(() => decoder({ rateLimits: null, rateLimitsByLimitId: null }));
      case "model/list":
        return providerSync(() => decoder({ data: [{ model: CLAUDE_MODEL, displayName: "Claude" }] }));
      default:
        return this.#real.request(method, params, decoder, timeoutMs);
    }
  }

  notify(): void {
    this.#real.notify();
  }

  respond(id: RequestId, result: unknown): void {
    this.#real.respond(id, result);
  }

  respondError(id: RequestId, error: Parameters<AgentClient["respondError"]>[1]): void {
    this.#real.respondError(id, error);
  }
}

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

/** Waits for a state of the service or of the feed. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** One window that watches the feed: it keeps every delta and applies it to its own copy of the cards. */
function createWindow() {
  const deltas: Array<{ at: number; delta: FeedDelta }> = [];
  const cards = new Map<string, FeedItem>();
  let cursor = 0;
  const gaps: number[] = [];
  const send = (delta: FeedDelta): boolean => {
    // A structured clone, as IPC copies it.
    const copy = structuredClone(delta);
    deltas.push({ at: performance.now(), delta: copy });
    if (cursor !== 0 && copy.cursor !== cursor + 1) gaps.push(copy.cursor);
    cursor = copy.cursor;
    for (const item of copy.upserts) cards.set(item.id, item);
    for (const id of copy.removes) cards.delete(id);
    return true;
  };
  return { id: 1, send, deltas, cards, gaps, setCursor: (value: number) => (cursor = value) };
}

/** The most deltas that any one-second window holds. */
function maxDeltasPerSecond(times: readonly number[]): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while ((times[end] ?? 0) - (times[start] ?? 0) >= 1_000) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

const report: {
  passed: boolean;
  error?: string;
  turn?: { states: string[]; steps: number; stepTexts: string[]; needLabel: string | null; title: string };
  remoteApproval?: { label: string; approvalKind: string | undefined; states: string[] };
  burst?: {
    events: number;
    cards: number;
    sentWithinMs: number;
    deltas: number;
    maxDeltasPerSecond: number;
    maxCardsInOneDelta: number;
    duplicateCardsInADelta: number;
    ingestCpuMs: number;
    ingestMicrosecondsPerEvent: number;
    processCpuMs: { user: number; system: number };
    deltaBytes: number;
  };
  window?: { runs: number; kept: number; firstKeptIndex: number; removedInDeltas: number; snapshotTruncated: boolean };
  idle?: { eventsWhileNotWatching: number; deltasWhileNotWatching: number };
  secrets?: { checkedBytes: number; leaked: string[]; contentLeaked: string[] };
  stats?: unknown;
  /** The cards of this computer when the check failed. */
  localCards?: FeedItem[];
  localEvents?: string[];
} = { passed: false };

const mcpConfig: McpServerConfig = {
  id: "mcp-e2e",
  name: "E2E server",
  enabled: true,
  transport: "http",
  url: "https://mcp.example.invalid/mcp",
  command: "",
  args: [],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  headers: [
    { key: "Authorization", value: MCP_HEADER_SECRET },
    { key: "X-Workspace", value: MCP_PLAIN_VALUE },
  ],
};

await writeFile(claudeExecutable, STAND_IN_CLAUDE, { mode: 0o755 });
const database = new BuildersBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "claude",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "claude"),
  busyMessageMode: () => "queue",
  clientFactory: (_provider, cli) => new ClaudeStandIn(cli),
});
// The labelled secret is in the process-wide mask, as the MCP store registers it; the unlabelled value
// is known only to the configuration, as `service.listMcpServers()` gives it to the feed in main.
registerMcpSecretValues(mcpConfig);
const feed = new FeedService({ secretValues: () => mcpSecretValues([mcpConfig]) });
const window = createWindow();
const seen: unknown[] = [];
const eventTypes: string[] = [];
const onEvent = (event: AgentEvent) => {
  eventTypes.push(event.type);
  feed.ingest("local", event);
};
agents.on("event", onEvent);

/** The states that one card went through, in the order the window saw them. */
function statesOf(id: string): string[] {
  const states: string[] = [];
  for (const { delta } of window.deltas) {
    const item = delta.upserts.find((entry) => entry.id === id);
    if (item && states.at(-1) !== item.state) states.push(item.state);
  }
  return states;
}

try {
  await runCauseEffect(agents.initialize());
  feed.setWatching(window, true);
  window.setCursor(feed.snapshot().cursor);

  // 1. A real turn: working, steps, a question, the answer, done.
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Feed check",
      description: "Checks the feed.",
      avatarSeed: "feed-check",
      avatarHue: null,
      initialMessage: USER_TEXT,
      provider: "claude",
      model: CLAUDE_MODEL,
    }),
  );
  const threadId = await waitFor(
    "the agent's thread",
    () => store.list().find((item) => item.id === agent.id)?.threadId,
  );
  const cardId = `local:t:${agent.id}:${threadId}`;
  const card = () => window.cards.get(cardId);
  await waitFor("the card to work with a step", () => card()?.state === "working" && (card()?.stepCount ?? 0) >= 1);
  await writeFile(askMarker, "");
  const asking = await waitFor("the card to wait for the person", () =>
    card()?.state === "needs-you" ? card() : null,
  );
  assert.equal(asking.need?.kind, "prompt", "The card waits for a question.");
  assert.equal(asking.need?.questionCount, 1, "The card counts the questions.");
  const prompt = agents.getRuntimeSnapshot().pendingPrompts.find((entry) => entry.agentId === agent.id);
  assert.ok(prompt, "The service has the question.");
  await runCauseEffect(
    agents.respondToPrompt({
      requestId: prompt.requestId,
      answers: { [prompt.questions[0]?.id ?? "question-0"]: ["Yes"] },
    }),
  );
  await waitFor("the card to work again", () => card()?.state === "working" && card()?.need === null);
  await writeFile(finishMarker, "");
  const done = await waitFor("the card to end", () => (card()?.state === "done" ? card() : null));
  const turnStates = statesOf(cardId);
  assert.deepEqual(
    turnStates,
    ["working", "needs-you", "working", "done"],
    `The card went through working, needs-you, working and done: ${turnStates.join(", ")}.`,
  );
  assert.equal(done.agentName, "Feed check", "The card names its agent.");
  assert.equal(done.need, null, "The ended card waits for nothing.");
  report.turn = {
    states: turnStates,
    steps: done.stepCount,
    stepTexts: done.steps.map((step) => step.text),
    needLabel: asking.need?.label ?? null,
    title: done.title,
  };

  // 2. An approval of a joined server: the program name only, and back to working when answered.
  const remote = "remote-e2e";
  const ingestRemote = (event: AgentEvent) => feed.ingest(remote, event);
  ingestRemote({ type: "turn-started", agentId: "builder", threadId: "remote-thread", turnId: "remote-turn" });
  ingestRemote({
    type: "approval",
    approval: {
      requestId: 7,
      agentId: "builder",
      threadId: "remote-thread",
      turnId: "remote-turn",
      kind: "command",
      command: `GITHUB_TOKEN=${GITHUB_TOKEN} /usr/bin/git push https://x:${GITHUB_TOKEN}@github.com/acme/app.git`,
      cwd: "/Users/demo/app",
      reason: `Push with ${PROVIDER_KEY}`,
      grantRoot: null,
      permissions: null,
    },
  });
  const remoteCard = `${remote}:t:builder:remote-thread`;
  const approval = await waitFor(
    "the remote card to wait for an approval",
    () => [...window.cards.values()].find((item) => item.id === remoteCard && item.state === "needs-you") ?? null,
  );
  assert.equal(approval.need?.label, "git", "An approval shows the program name only.");
  assert.equal(approval.need?.approvalKind, "command", "An approval says what it is for.");
  ingestRemote({ type: "agent-input-resolved", kind: "approval", requestId: 7, agentId: "builder" });
  await waitFor(
    "the remote card to work again",
    () => window.cards.get(remoteCard)?.state === "working" && window.cards.get(remoteCard)?.need === null,
  );
  report.remoteApproval = {
    label: approval.need?.label ?? "",
    approvalKind: approval.need?.approvalKind,
    states: statesOf(remoteCard),
  };

  // 3. A burst: 2,000 steps over 50 cards in one second.
  const burstServer = "burst";
  const burstCards = 50;
  const burstEvents = 2_000;
  for (let index = 0; index < burstCards; index += 1)
    feed.ingest(burstServer, {
      type: "turn-started",
      agentId: `a${index}`,
      threadId: `t${index}`,
      turnId: `u${index}`,
    });
  await feed.drain();
  const firstBurstDelta = window.deltas.length;
  const statsBefore = feed.stats();
  const cpuBefore = process.cpuUsage();
  const burstStart = performance.now();
  const lastText = new Map<string, string>();
  for (let index = 0; index < burstEvents; index += 1) {
    const card = index % burstCards;
    const detail = `Step ${index} of the burst`;
    feed.ingest(burstServer, {
      type: "turn-progress",
      agentId: `a${card}`,
      threadId: `t${card}`,
      turnId: `u${card}`,
      detail,
    });
    lastText.set(`${burstServer}:t:a${card}:t${card}`, detail);
    // Spread over one second, in 20 slices.
    if (index % 100 === 99) await new Promise((done) => setTimeout(done, 50));
  }
  const sentWithinMs = performance.now() - burstStart;
  await feed.drain();
  const cpu = process.cpuUsage(cpuBefore);
  const statsAfter = feed.stats();
  const burstDeltas = window.deltas.slice(firstBurstDelta);
  const perSecond = maxDeltasPerSecond(window.deltas.map((entry) => entry.at));
  const duplicates = burstDeltas.reduce(
    (count, { delta }) => count + delta.upserts.length - new Set(delta.upserts.map((item) => item.id)).size,
    0,
  );
  assert.ok(
    perSecond <= FEED_DELTAS_PER_SECOND,
    `At most ${FEED_DELTAS_PER_SECOND} deltas in a second, not ${perSecond}.`,
  );
  assert.equal(duplicates, 0, "A delta holds each card once.");
  assert.ok(
    burstDeltas.every(({ delta }) => delta.upserts.length <= FEED_DELTA_LIMIT),
    "A delta holds at most the delta limit.",
  );
  for (const [id, text] of lastText) {
    const card = window.cards.get(id);
    assert.equal(card?.lastStep?.text, text, `${id} ends on its last step.`);
    assert.equal(card?.stepCount, burstEvents / burstCards, `${id} counts every step.`);
  }
  assert.deepEqual(window.gaps, [], "The cursor of the deltas has no gap.");
  report.burst = {
    events: burstEvents,
    cards: burstCards,
    sentWithinMs: Math.round(sentWithinMs),
    deltas: burstDeltas.length,
    maxDeltasPerSecond: perSecond,
    maxCardsInOneDelta: Math.max(...burstDeltas.map(({ delta }) => delta.upserts.length)),
    duplicateCardsInADelta: duplicates,
    ingestCpuMs: Number((statsAfter.ingestMs - statsBefore.ingestMs).toFixed(2)),
    ingestMicrosecondsPerEvent: Number(
      (((statsAfter.ingestMs - statsBefore.ingestMs) * 1_000) / (statsAfter.ingested - statsBefore.ingested)).toFixed(
        2,
      ),
    ),
    processCpuMs: { user: Math.round(cpu.user / 1_000), system: Math.round(cpu.system / 1_000) },
    deltaBytes: burstDeltas.reduce((total, { delta }) => total + JSON.stringify(delta).length, 0),
  };

  // 4. The window of 5,000 cards: 6,000 runs that end, the oldest go first.
  const bulk = "bulk";
  const runs = 6_000;
  const removedBefore = window.deltas.reduce((total, { delta }) => total + delta.removes.length, 0);
  for (let index = 0; index < runs; index += 1) {
    const ids = { agentId: `b${index % 40}`, threadId: `bt${index}`, turnId: `bu${index}` };
    feed.ingest(bulk, { type: "turn-started", ...ids });
    feed.ingest(bulk, { type: "turn-completed", ...ids, status: "completed" });
    if (index % 500 === 499) await new Promise((done) => setTimeout(done, 0));
  }
  await feed.drain();
  const snapshot = feed.snapshot();
  assert.ok(snapshot.items.length <= FEED_SNAPSHOT_LIMIT, `The feed keeps at most ${FEED_SNAPSHOT_LIMIT} cards.`);
  const keptBulk = snapshot.items
    .filter((item) => item.serverId === bulk)
    .map((item) => Number(item.threadId?.slice(2)));
  const open = 1 + burstCards;
  const firstKept = Math.min(...keptBulk);
  assert.equal(snapshot.items.length, FEED_SNAPSHOT_LIMIT, "The window is full.");
  assert.equal(firstKept, runs - (FEED_SNAPSHOT_LIMIT - open), "The newest ended runs stay, the oldest go.");
  assert.equal(new Set(keptBulk).size, FEED_SNAPSHOT_LIMIT - open, "Each kept run shows once.");
  assert.ok(
    !snapshot.items.some((item) => item.id === cardId),
    "The card of the real turn, the oldest ended run, left first.",
  );
  assert.equal(
    snapshot.items.filter((item) => item.state === "working").length,
    open,
    "No running card leaves while an ended one can.",
  );
  const removedInDeltas = window.deltas.reduce((total, { delta }) => total + delta.removes.length, 0) - removedBefore;
  assert.ok(removedInDeltas >= runs + open + 1 - FEED_SNAPSHOT_LIMIT, "The window was told of each dropped card.");
  assert.equal(window.cards.size, FEED_SNAPSHOT_LIMIT, "The copy of the window has the same cards.");
  report.window = {
    runs,
    kept: snapshot.items.length,
    firstKeptIndex: firstKept,
    removedInDeltas,
    snapshotTruncated: snapshot.truncated,
  };

  // 5. No window watches: no delta goes out.
  feed.setWatching(window, false);
  const deltasBefore = window.deltas.length;
  const sentBefore = feed.stats().deltasSent;
  for (let index = 0; index < 300; index += 1)
    feed.ingest(burstServer, {
      type: "turn-progress",
      agentId: "a1",
      threadId: "t1",
      turnId: "u1",
      detail: `Unwatched step ${index}`,
    });
  await feed.drain();
  // Three batch periods: a delta that was due would have gone out by now.
  await new Promise((done) => setTimeout(done, 350));
  assert.equal(window.deltas.length, deltasBefore, "No delta reaches a window that does not watch.");
  assert.equal(feed.stats().deltasSent, sentBefore, "The feed sends nothing while no window watches.");
  report.idle = { eventsWhileNotWatching: 300, deltasWhileNotWatching: window.deltas.length - deltasBefore };

  // 6. No secret and no text of the conversation in anything the feed sent.
  const sent = JSON.stringify({ deltas: window.deltas.map((entry) => entry.delta), snapshot: feed.snapshot() });
  seen.push(sent.length);
  const leaked = SECRETS.filter((secret) => sent.includes(secret));
  const contentLeaked = CONTENT_MARKERS.filter((marker) => sent.includes(marker));
  report.secrets = { checkedBytes: sent.length, leaked, contentLeaked };
  assert.deepEqual(leaked, [], "No planted secret reaches the window.");
  assert.deepEqual(contentLeaked, [], "No text of the conversation reaches the window.");
  assert.ok(
    report.turn.needLabel?.includes("[redacted]") || report.turn.needLabel?.includes("•••"),
    `The question shows with its secrets masked: ${report.turn.needLabel}.`,
  );
  report.stats = feed.stats();
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.localCards = [...window.cards.values()].filter((item) => item.serverId === "local");
  report.localEvents = eventTypes;
  report.stats = feed.stats();
  process.exitCode = 1;
} finally {
  agents.off("event", onEvent);
  feed.dispose();
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (existsSync(OUT)) process.exit(process.exitCode ?? 0);
}
