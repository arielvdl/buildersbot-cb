// Checks that each tab of a channel is its own line of work for each agent (channel tab lanes). Runs
// the real agent service, channel service, mailbox and drain on a temporary profile, with a fake Codex
// app-server. A turn whose message names a held mark runs until the mark is released; a turn whose
// message names an ask mark asks the person a question and runs until the answer comes; any other
// turn ends at once. Cases:
// 1. A long request in one tab and a short one in another tab of the same agent: the short one
//    starts and ends while the long one runs.
// 2. Two requests in the same tab: the second one waits, with the reason "tab", and starts only
//    after the first one ended.
// 3. The limit of parallel tabs (2): a third tab waits with the reason "agent-tabs" and starts when
//    a place frees, before a newer request of the tab that freed it (no starvation).
// 4. A tab whose turn waits for the person, and a tab whose task waits for another agent, do not take
//    a place: a third tab starts.
// 5. A wait cycle through dependencies is refused when the agent makes it.
// 6. Low memory: a new tab of a working agent does not start, with the reason "memory", and starts
//    when the memory is back.
// 7. The agent's own chat behaves as before: it waits for the channel work and names the channel.
// 8. Deleting a tab stops only the turn of that tab. The other tab of the same agent keeps running.
// 9. A restart: the requests that waited in two tabs each start once, and the turn that ran at the
//    stop does not run again.
// 10. A start that the provider refuses (529) in one tab waits for its retry with its own marker. It
//    takes no place among the agent's tabs, so another tab starts during the wait, and it runs once.
// `bun scripts/channel-tab-lanes-e2e.ts`. Writes .openbot-build/channel-tab-lanes-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ChannelTask, DEFAULT_START_RETRY_SETTINGS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { StoredStartBreaker } from "../src/backend/agent/start-retry";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { HostMemory, HostMemoryLevel } from "../src/backend/host-memory";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-tab-lanes-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-tab-lanes-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
process.env.OPENBOT_FAKE_CODEX_CONTROL = controlPath;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A Codex app-server with the methods that the service calls. `control.json` holds `hold`, the marks
 * whose turns keep running, `ask`, the marks whose turns ask the person a question first, and
 * `refuse`, how many starts of the turn with a mark the fake refuses with a 529 before one runs.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const control = () => {
  try {
    return JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
  } catch {
    return { hold: [], ask: [] };
  }
};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
let asks = 0;
/** turnId -> { threadId, texts, marks, asked, answered } of each turn that runs. */
const running = new Map();
/**
 * The marks that a turn already took. A mark holds only the first turn that gets it: a later turn of
 * the same tab gets the earlier request again in its channel history, and must not be held by it.
 */
const claimed = new Set();
/** The starts that the fake refused, by mark. Kept here, so the check never writes over the count. */
const refused = new Map();
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
/** The id of each question this fake asked -> its turn. */
const questions = new Map();
const reviewThreads = new Set();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
process.on("SIGTERM", () => process.exit(0));
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turnId, status) => {
  const turn = running.get(turnId);
  if (turn === undefined) return;
  running.delete(turnId);
  log({ turnEnded: turnId, threadId: turn.threadId, status });
  if (status === "completed") {
    const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
    write({ method: "item/completed", params: { threadId: turn.threadId, turnId, item } });
  }
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turnId, status } } });
};
const marked = (turn, marks) => (marks || []).some((mark) => turn.marks.includes(mark));
setInterval(() => {
  if (running.size === 0) return;
  const current = control();
  for (const [turnId, turn] of [...running]) {
    if (marked(turn, current.hold)) continue;
    if (marked(turn, current.ask) && !turn.answered) {
      if (turn.asked) continue;
      turn.asked = true;
      const id = "ask-" + process.pid + "-" + (++asks);
      questions.set(id, turnId);
      log({ asked: turnId, threadId: turn.threadId });
      write({
        id,
        method: "item/tool/requestUserInput",
        params: {
          threadId: turn.threadId,
          turnId,
          itemId: "question-" + turnId,
          questions: [{ id: "go", header: "Go", question: "May I go on?", options: [{ label: "Yes", description: "" }] }],
        },
      });
      continue;
    }
    finish(turnId, "completed");
  }
}, 25);
const texts = (input) =>
  (Array.isArray(input) ? input : []).flatMap((item) => (item && typeof item.text === "string" ? [item.text] : []));
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": {
      // Each agent has its own process, so an id names its process too: two processes log to one file.
      const threadId = "thread-" + process.pid + "-" + (++threads);
      if (params.ephemeral) reviewThreads.add(threadId);
      return write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    }
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      if (reviewThreads.has(params.threadId)) {
        write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
        running.set(turnId, { threadId: params.threadId, texts: [], marks: [], asked: false, answered: true });
        return finish(turnId, "completed");
      }
      const turnTexts = texts(params.input);
      const current = control();
      const refuse = Object.entries(current.refuse || {}).find(
        ([mark, count]) => (refused.get(mark) || 0) < count && turnTexts.some((text) => text.includes(mark)),
      );
      if (refuse && params.clientUserMessageId) {
        refused.set(refuse[0], (refused.get(refuse[0]) || 0) + 1);
        log({ refused: refuse[0], threadId: params.threadId });
        return write({ id: message.id, error: { code: -32000, message: OVERLOADED } });
      }
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const marks = [...(current.hold || []), ...(current.ask || [])].filter(
        (mark) => !claimed.has(mark) && turnTexts.some((text) => text.includes(mark)),
      );
      for (const mark of marks) claimed.add(mark);
      running.set(turnId, { threadId: params.threadId, texts: turnTexts, marks, asked: false, answered: false });
      log({ turnStarted: turnId, threadId: params.threadId, texts: turnTexts });
      return;
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return finish(params.turnId, "interrupted");
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
      log({ method: message.method ?? null, id: message.id ?? null, params: message.params ?? null });
      if (message.method && message.id !== undefined) answer(message);
      else if (message.id !== undefined && questions.has(message.id)) {
        const turn = running.get(questions.get(message.id));
        questions.delete(message.id);
        if (turn) turn.answered = true;
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface Control {
  hold: string[];
  ask: string[];
  refuse: Record<string, number>;
}

interface ProtocolEntry {
  index: number;
  method: string | null;
  threadId: string | null;
  turnId: string | null;
  turnStarted: string | null;
  turnEnded: string | null;
  asked: string | null;
  refused: string | null;
  status: string | null;
  texts: string[];
}

/** What a case saw, as the report keeps it in JSON. */
type Fact = string | number | boolean | null | Fact[] | { [key: string]: Fact };

interface CaseReport {
  name: string;
  facts: { [key: string]: Fact };
  passed: boolean;
  error?: string;
}

const report: { cases: CaseReport[]; passed: boolean; error?: string } = { cases: [], passed: false };

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

function protocol(): ProtocolEntry[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => protocolEntry(JSON.parse(line), index));
  } catch {
    return [];
  }
}

function protocolEntry(value: unknown, index: number): ProtocolEntry {
  const entry = isRecord(value) ? value : {};
  const params = isRecord(entry.params) ? entry.params : {};
  return {
    index,
    method: getString(entry, "method"),
    threadId: getString(params, "threadId") ?? getString(entry, "threadId"),
    turnId: getString(params, "turnId"),
    turnStarted: getString(entry, "turnStarted"),
    turnEnded: getString(entry, "turnEnded"),
    asked: getString(entry, "asked"),
    refused: getString(entry, "refused"),
    status: getString(entry, "status"),
    texts: Array.isArray(entry.texts) ? entry.texts.filter((text): text is string => typeof text === "string") : [],
  };
}

/** The start of the turn that carries this mark, or undefined. */
const started = (mark: string) =>
  protocol().find((line) => line.turnStarted && line.texts.some((text) => text.includes(mark)));
/** The end of the turn that carries this mark, or undefined. */
function ended(mark: string): ProtocolEntry | undefined {
  const turnId = started(mark)?.turnStarted;
  return turnId ? protocol().find((line) => line.turnEnded === turnId) : undefined;
}

/** Waits for a state of the service or of the fake Codex. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const control: Control = { hold: [], ask: [], refuse: {} };
const writeControl = () => writeFile(controlPath, JSON.stringify(control));
const hold = async (...marks: string[]) => {
  control.hold.push(...marks);
  await writeControl();
};
const release = async (...marks: string[]) => {
  control.hold = control.hold.filter((mark) => !marks.includes(mark));
  control.ask = control.ask.filter((mark) => !marks.includes(mark));
  await writeControl();
};
const ask = async (mark: string) => {
  control.ask.push(mark);
  await writeControl();
};

/** The memory reading of this computer, which the check moves between ok and low. */
let memoryLevel: HostMemoryLevel = "ok";
const memoryListeners = new Set<() => void>();
const memoryPressure: HostMemory = {
  level: () => memoryLevel,
  turnLimit: () => 64,
  reserveTurn: () => () => {},
  subscribe: (listener) => {
    memoryListeners.add(listener);
    return () => memoryListeners.delete(listener);
  },
  hostedPlan: false,
  kind: "desktop",
};
const setMemory = (level: HostMemoryLevel) => {
  memoryLevel = level;
  for (const listener of memoryListeners) listener();
};

await writeControl();
await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
/** The most tabs of one agent that run a turn at the same time, as the person set it. */
const tabLimit = 2;

/** The breakers of the start retry, kept across a restart as the main process keeps its file. */
let storedBreakers: readonly StoredStartBreaker[] = [];

/** The services of one run of the app on the profile. A restart makes them again. */
function openServices() {
  const database = new BuildersBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const agents = new AgentService({
    store,
    mailbox,
    browser,
    preferredProvider: "codex",
    offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
    memoryPressure,
    channelTabLimit: () => tabLimit,
    // Short waits, so a start that the provider refuses tries again in a second or two.
    startRetry: {
      settings: () => ({ ...DEFAULT_START_RETRY_SETTINGS, firstDelaySeconds: 1, maxDelaySeconds: 2 }),
      breakers: {
        read: () => storedBreakers,
        write: (breakers) => {
          storedBreakers = breakers;
        },
      },
    },
  });
  return { database, mailbox, agents };
}

let { database, mailbox, agents } = openServices();
const actor = { id: "local", name: "Alex" };

async function createAgent(name: string): Promise<string> {
  const first = `${name}-hello-${randomUUID()}`;
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Checks the tab lanes of channels.",
      avatarSeed: name,
      avatarHue: null,
      initialMessage: first,
    }),
  );
  await waitFor(`${name}: the first turn ends`, () => ended(first));
  return agent.id;
}

async function createChannel(name: string, memberIds: string[]): Promise<string> {
  const channelId = randomUUID();
  await runCauseEffect(
    agents.channels.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId,
        draft: {
          name,
          title: "",
          instructions: "Answer each request.",
          members: memberIds.map((agentId) => ({ agentId })),
          leadAgentId: memberIds[0] ?? null,
        },
      },
      actor,
    ),
  );
  return channelId;
}

/** A new tab of the channel. The first tab of a channel has the id `openbot-topic-<channelId>`. */
async function createTab(channelId: string): Promise<string> {
  const topicId = randomUUID();
  await runCauseEffect(
    agents.channels.command({ type: "topic-create", operationId: randomUUID(), channelId, topicId }, actor),
  );
  return topicId;
}

async function send(channelId: string, topicId: string, text: string, agentId: string): Promise<void> {
  await runCauseEffect(
    agents.channels.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId,
        topicId,
        text,
        recipientAgentId: agentId,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
}

/** The task of the request with this mark, as the screen reads it. */
function task(channelId: string, topicId: string, mark: string): ChannelTask | undefined {
  return agents.channels.page(channelId, topicId).tasks.find((item) => item.instruction.includes(mark));
}

/** `TAB_LANES_CASES=1,4` runs only those cases, to look at one failure again. */
const onlyCases = process.env.TAB_LANES_CASES?.split(",").map((value) => Number(value.trim()));
let caseNumber = 0;

async function runCase(name: string, check: (facts: CaseReport["facts"]) => Promise<void>) {
  caseNumber += 1;
  if (onlyCases && !onlyCases.includes(caseNumber)) return;
  const result: CaseReport = { name, facts: {}, passed: false };
  report.cases.push(result);
  try {
    await check(result.facts);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    // A failed case lets its turns end, so the next case starts with an idle agent.
    control.hold = [];
    control.ask = [];
    control.refuse = {};
    await writeControl();
    setMemory("ok");
  }
}

try {
  await runCauseEffect(agents.initialize());
  const ada = await createAgent("ada");
  const bob = await createAgent("bob");

  await runCase("a short request in another tab does not wait for a long one", async (facts) => {
    const channelId = await createChannel("lanes-1", [ada]);
    const first = `openbot-topic-${channelId}`;
    const second = await createTab(channelId);
    await hold("long-1a");
    await send(channelId, first, "long-1a: write a long report", ada);
    await waitFor("the long turn starts", () => started("long-1a"));
    await send(channelId, second, "short-1b: reply ready", ada);
    const shortEnd = await waitFor("the short turn ends while the long one runs", () => ended("short-1b"));
    facts.longStillRunning = ended("long-1a") === undefined;
    facts.shortEndedAt = shortEnd.index;
    assert.equal(facts.longStillRunning, true, "the long turn still runs");
    await release("long-1a");
    await waitFor("the long turn ends", () => ended("long-1a"));
  });

  await runCase("two requests in one tab run in order", async (facts) => {
    const channelId = await createChannel("lanes-2", [ada]);
    const tab = await createTab(channelId);
    await hold("order-2a");
    await send(channelId, tab, "order-2a: first request", ada);
    await waitFor("the first turn starts", () => started("order-2a"));
    await send(channelId, tab, "order-2b: second request", ada);
    const waiting = await waitFor("the second request waits for the first one of its tab", () => {
      const second = task(channelId, tab, "order-2b");
      return second?.state === "queued" && second.wait?.reason === "tab" ? second : null;
    });
    facts.secondWait = waiting.wait?.reason ?? null;
    facts.secondStartedEarly = started("order-2b") !== undefined;
    assert.equal(facts.secondStartedEarly, false);
    await release("order-2a");
    const firstEnd = await waitFor("the first turn ends", () => ended("order-2a"));
    const secondStart = await waitFor("the second turn starts", () => started("order-2b"));
    facts.order = [firstEnd.index, secondStart.index];
    assert.ok(firstEnd.index < secondStart.index, "the second request starts after the first one ended");
    await waitFor("the second turn ends", () => ended("order-2b"));
  });

  await runCase("the limit of parallel tabs holds a third tab, without starvation", async (facts) => {
    const channelId = await createChannel("lanes-3", [ada]);
    const [one, two, three] = [await createTab(channelId), await createTab(channelId), await createTab(channelId)];
    await hold("cap-3a", "cap-3b");
    await send(channelId, one, "cap-3a: hold one", ada);
    await send(channelId, two, "cap-3b: hold two", ada);
    await waitFor("two tabs run", () => started("cap-3a") && started("cap-3b"));
    await send(channelId, three, "cap-3c: third tab", ada);
    const waiting = await waitFor("the third tab waits for a place", () => {
      const third = task(channelId, three, "cap-3c");
      return third?.state === "queued" && third.wait?.reason === "agent-tabs" ? third : null;
    });
    facts.thirdWait = {
      reason: waiting.wait?.reason ?? null,
      busy: waiting.wait?.busy ?? null,
      limit: waiting.wait?.limit ?? null,
    };
    // A newer request in the first tab waits behind its running turn. When that turn ends, the third
    // tab waited longer, so it takes the free place first.
    await send(channelId, one, "cap-3d: newer request of tab one", ada);
    await waitFor("the newer request waits in its tab", () => task(channelId, one, "cap-3d")?.state === "queued");
    await release("cap-3a");
    const third = await waitFor("the third tab starts", () => started("cap-3c"));
    const newer = await waitFor("the newer request starts", () => started("cap-3d"));
    facts.startOrder = { third: third.index, newer: newer.index };
    assert.ok(third.index < newer.index, "the tab that waited longer starts first");
    await release("cap-3b");
    await waitFor("every turn ends", () => ended("cap-3b") && ended("cap-3c") && ended("cap-3d"));
  });

  await runCase("a tab that waits for the person or for another agent takes no place", async (facts) => {
    const channelId = await createChannel("lanes-4", [ada, bob]);
    const [asking, holding, third, fourth] = [
      await createTab(channelId),
      await createTab(channelId),
      await createTab(channelId),
      await createTab(channelId),
    ];
    await ask("ask-4a");
    await send(channelId, asking, "ask-4a: ask me first", ada);
    await waitFor("the turn asks the person", () => protocol().some((line) => line.asked));
    await hold("hold-4b");
    await send(channelId, holding, "hold-4b: keep working", ada);
    await waitFor("the second tab runs", () => started("hold-4b"));
    await send(channelId, third, "free-4c: third tab", ada);
    await waitFor("the third tab runs while one tab waits for the person", () => ended("free-4c"));
    facts.thirdRanBesideQuestion = true;
    // A task that hands work to another agent ends its turn and waits with no assignment.
    await hold("parent-4d", "child-4d");
    await send(channelId, fourth, "parent-4d: hand work to bob", ada);
    const parentStart = await waitFor("the parent turn starts", () => started("parent-4d"));
    const parent = await waitFor("the parent task runs", () => {
      const current = task(channelId, fourth, "parent-4d");
      return current?.state === "running" ? current : null;
    });
    const turnId = parentStart.turnStarted ?? "";
    const handoff = await runCauseEffect(
      agents.channels.tool(channelId, ada, turnId, randomUUID(), "channel_assign", {
        recipientAgentId: bob,
        task: "child-4d: work for bob",
        expectedResult: "A report.",
        sourceMessageIds: [parent.requestMessageId],
      }),
    );
    facts.handoff = isRecord(handoff) ? Object.keys(handoff) : typeof handoff;
    await release("parent-4d");
    await waitFor("the parent waits for bob", () => task(channelId, fourth, "parent-4d")?.state === "waiting");
    await waitFor("bob works on the child", () => started("child-4d"));
    await send(channelId, fourth, "after-4e: another request in the waiting tab", ada);
    await waitFor("ada answers in the tab whose task waits for bob", () => ended("after-4e")).catch((error) => {
      const waiting = task(channelId, fourth, "after-4e");
      facts.afterTask = {
        state: waiting?.state ?? null,
        owner: waiting?.ownerAgentId === ada,
        wait: waiting?.wait?.reason ?? null,
        hold: waiting ? (agents.channels.queuedHolds().get(waiting.id) ?? null) : null,
        started: started("after-4e") !== undefined,
      };
      throw error;
    });
    facts.ranBesideHandoff = true;
    await release("ask-4a", "hold-4b", "child-4d");
    await runCauseEffect(
      agents.channels.command(
        {
          type: "stop",
          operationId: randomUUID(),
          channelId,
          taskId: task(channelId, asking, "ask-4a")?.id ?? "",
          recipientAgentId: null,
        },
        actor,
      ),
    );
    await waitFor("the asking turn ends", () => ended("ask-4a"));
    await waitFor("the other turns end", () => ended("hold-4b") && ended("child-4d"));
  });

  await runCase("a wait cycle through dependencies is refused", async (facts) => {
    const channelId = await createChannel("lanes-5", [ada, bob]);
    const tab = await createTab(channelId);
    await hold("cycle-5a");
    await send(channelId, tab, "cycle-5a: plan the work", ada);
    const start = await waitFor("the turn starts", () => started("cycle-5a"));
    const parent = await waitFor("the task runs", () => {
      const current = task(channelId, tab, "cycle-5a");
      return current?.state === "running" ? current : null;
    });
    const refused = await runCauseEffect(
      agents.channels.tool(channelId, ada, start.turnStarted ?? "", randomUUID(), "channel_assign", {
        recipientAgentId: bob,
        task: "cycle-5b: wait for my own task",
        expectedResult: "A report.",
        sourceMessageIds: [parent.requestMessageId],
        dependencies: [parent.id],
      }),
    ).then(
      () => null,
      (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
    );
    facts.refused = refused;
    assert.ok(refused, "a dependency on the calling task is refused");
    await release("cycle-5a");
    await waitFor("the turn ends", () => ended("cycle-5a"));
  });

  await runCase("low memory holds a new tab with a reason, and the memory return starts it", async (facts) => {
    const channelId = await createChannel("lanes-6", [ada]);
    const [one, two] = [await createTab(channelId), await createTab(channelId)];
    await hold("mem-6a");
    await send(channelId, one, "mem-6a: long work", ada);
    await waitFor("the first tab runs", () => started("mem-6a"));
    setMemory("low");
    await send(channelId, two, "mem-6b: second tab", ada);
    const waiting = await waitFor("the second tab waits for memory", () => {
      const second = task(channelId, two, "mem-6b");
      return second?.state === "queued" && second.wait?.reason === "memory" ? second : null;
    });
    facts.wait = waiting.wait?.reason ?? null;
    facts.startedDuringLowMemory = started("mem-6b") !== undefined;
    assert.equal(facts.startedDuringLowMemory, false);
    setMemory("ok");
    await waitFor("the second tab runs when the memory is back", () => ended("mem-6b"));
    facts.firstStillRunning = ended("mem-6a") === undefined;
    assert.equal(facts.firstStillRunning, true);
    await release("mem-6a");
    await waitFor("the first tab ends", () => ended("mem-6a"));
  });

  await runCase("the agent's own chat waits for its channel work, as before", async (facts) => {
    const channelId = await createChannel("lanes-7", [ada]);
    const tab = await createTab(channelId);
    await hold("chan-7a");
    await send(channelId, tab, "chan-7a: channel work", ada);
    await waitFor("the channel turn starts", () => started("chan-7a"));
    const receipt = await runCauseEffect(agents.sendMessage({ agentId: ada, text: "own-7b: a message to ada" }));
    const deliveryId = receipt.deliveries[0]?.id ?? "";
    const held = await waitFor("the own chat names the channel", () => {
      const queue = agents.listQueue(ada);
      return queue.hold?.channelId === channelId ? queue : null;
    });
    facts.hold = {
      channelId: held.hold?.channelId ?? null,
      topicName: held.hold?.topicName ?? null,
      tabs: held.hold?.tabs ?? null,
    };
    facts.ownStartedEarly = started("own-7b") !== undefined;
    assert.equal(facts.ownStartedEarly, false);
    await release("chan-7a");
    await waitFor("the own chat message runs after the channel turn", () => ended("own-7b"));
    facts.delivery = mailbox.getDelivery(deliveryId)?.delivery.status ?? null;
  });

  await runCase("deleting a tab stops only that tab's turn", async (facts) => {
    const channelId = await createChannel("lanes-8", [ada]);
    const [gone, kept] = [await createTab(channelId), await createTab(channelId)];
    await hold("gone-8a", "kept-8b");
    await send(channelId, gone, "gone-8a: work in the tab that goes", ada);
    await send(channelId, kept, "kept-8b: work in the tab that stays", ada);
    await waitFor("both tabs run", () => started("gone-8a") && started("kept-8b"));
    await runCauseEffect(
      agents.channels.command({ type: "topic-delete", operationId: randomUUID(), channelId, topicId: gone }, actor),
    );
    const stopped = await waitFor("the deleted tab's turn stops", () => ended("gone-8a"));
    facts.goneStatus = stopped.status;
    facts.keptRunning = ended("kept-8b") === undefined;
    assert.equal(stopped.status, "interrupted");
    assert.equal(facts.keptRunning, true, "the other tab keeps running");
    await send(channelId, kept, "kept-8c: next request in the tab that stays", ada);
    await release("gone-8a", "kept-8b");
    await waitFor("the kept tab ends its work", () => ended("kept-8b") && ended("kept-8c"));
    facts.keptTask = task(channelId, kept, "kept-8b")?.state ?? null;
  });

  await runCase("a restart starts each waiting request once and does not run a stopped turn again", async (facts) => {
    const channelId = await createChannel("lanes-9", [ada, bob]);
    const [running, first, second] = [
      await createTab(channelId),
      await createTab(channelId),
      await createTab(channelId),
    ];
    await hold("restart-9a");
    await send(channelId, running, "restart-9a: runs at the stop", ada);
    await waitFor("the turn that runs at the stop starts", () => started("restart-9a"));
    // No new turn starts while memory is low. Bob's request waits in the drain with its assignment,
    // and ada's second tab waits in its channel, as ada already works.
    setMemory("low");
    await send(channelId, first, "restart-9b: waits in the drain", bob);
    await send(channelId, second, "restart-9c: waits in the channel", ada);
    await waitFor("both requests wait for memory", () => {
      const one = task(channelId, first, "restart-9b");
      const two = task(channelId, second, "restart-9c");
      return one?.wait?.reason === "memory" && two?.wait?.reason === "memory";
    });
    await runCauseEffect(agents.stop());
    database.close();
    await release("restart-9a");
    setMemory("ok");
    ({ database, mailbox, agents } = openServices());
    await runCauseEffect(agents.initialize());
    await waitFor("both waiting requests run after the restart", () => ended("restart-9b") && ended("restart-9c"));
    const starts = (mark: string) =>
      protocol().filter((line) => line.turnStarted && line.texts.some((text) => text.includes(mark))).length;
    facts.starts = { running: starts("restart-9a"), first: starts("restart-9b"), second: starts("restart-9c") };
    facts.runningTask = task(channelId, running, "restart-9a")?.state ?? null;
    assert.deepEqual(facts.starts, { running: 1, first: 1, second: 1 }, "each request starts once");
    assert.notEqual(facts.runningTask, "running", "the stopped turn does not run again");
  });

  await runCase("a start retry in one tab takes no place, keeps its own marker, and runs once", async (facts) => {
    const channelId = await createChannel("lanes-10", [ada]);
    const [retrying, holding, free] = [
      await createTab(channelId),
      await createTab(channelId),
      await createTab(channelId),
    ];
    control.refuse = { "retry-10a": 2 };
    await hold("hold-10b");
    await send(channelId, holding, "hold-10b: keep working", ada);
    await waitFor("the second tab runs", () => started("hold-10b"));
    await send(channelId, retrying, "retry-10a: the provider refuses the first starts", ada);
    const waiting = await waitFor("the first tab waits for its retry", () => {
      const current = task(channelId, retrying, "retry-10a");
      return current?.state === "queued" && current.startRetry ? current : null;
    });
    facts.retry = { attempt: waiting.startRetry?.attempt ?? null, phase: waiting.startRetry?.phase ?? null };
    // With one tab at work and one that waits for its retry, the agent has a free place.
    await send(channelId, free, "free-10c: a third tab", ada);
    const freeStart = await waitFor("the third tab starts during the retry", () => started("free-10c"));
    const freeTask = task(channelId, free, "free-10c");
    facts.freeHadRetry = freeTask?.startRetry !== undefined;
    const retried = await waitFor("the first tab runs after its retries", () => ended("retry-10a"));
    const runs = protocol().filter((line) => line.turnStarted && line.texts.some((text) => text.includes("retry-10a")));
    const refusals = protocol().filter((line) => line.refused === "retry-10a").length;
    facts.order = { free: freeStart.index, retried: retried.index };
    facts.runs = runs.length;
    facts.refusals = refusals;
    assert.equal(facts.freeHadRetry, false, "the marker stays on its own delivery");
    assert.ok(
      freeStart.index < (runs[0]?.index ?? Number.POSITIVE_INFINITY),
      "the third tab started before the retry ran",
    );
    assert.equal(refusals, 2, "two starts were refused");
    assert.equal(runs.length, 1, "the retried request runs once");
    await release("hold-10b");
    await waitFor("every turn ends", () => ended("hold-10b") && ended("free-10c"));
  });

  report.passed = report.cases.length === (onlyCases?.length ?? 10) && report.cases.every((entry) => entry.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
