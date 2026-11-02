// Checks the routing of channel requests with the "routing" optimization off and on. Runs the real
// agent service, channel service, mailbox and drain on a temporary profile, with a fake Codex
// app-server. The fake answers a routing generation with the member that the request names
// ("route:<name>"), after a delay that the check sets; a member turn whose message names a held mark
// runs until the mark is released; any other turn ends at once. Each case runs with the switch off,
// where the behavior must stay as it was, and then on:
// 1. The routing generation runs on the lead's model. Off: at the lead's reasoning effort. On: at the
//    lowest effort that the model takes.
// 2. A follow-up in Portuguese or Spanish to a stopped task of the tab. Off: a new task and a routing
//    generation. On: the stopped task continues, with no routing generation.
// 3. Tabs: "continue" in a tab with no open task, while another tab has a stopped one. Off: the task
//    of the other tab continues. On: the tab gets a new task. "Also ..." in a tab with one stopped
//    task, while another tab has one too. Off: a routing generation. On: the task of its own tab.
// 4. Changes during a routing generation. In another tab: off, each change discards the answer and
//    the lead routes again; on, the answer stands. In the same tab: on, at most 2 routes are discarded.
// `bun scripts/channel-routing-e2e.ts`. Writes .openbot-build/channel-routing-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ChannelTask, type OptimizationId } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { HostMemory } from "../src/backend/host-memory";
import type { OptimizationPort } from "../src/backend/optimizations";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-routing-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-routing-"));
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

const ROUTING_PREFIX = "Select the channel members who respond.";

/**
 * A Codex app-server with the methods that the service calls. `control.json` holds `hold`, the marks
 * whose member turns keep running, and `routeDelayMs`, how long a routing generation takes.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const ROUTING_PREFIX = ${JSON.stringify(ROUTING_PREFIX)};
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const control = () => {
  try {
    return JSON.parse(fs.readFileSync(process.env.OPENBOT_FAKE_CODEX_CONTROL, "utf8"));
  } catch {
    return { hold: [], routeDelayMs: 0 };
  }
};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
const efforts = ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
let buffer = "";
let threads = 0;
let turns = 0;
/** turnId -> { threadId, texts, marks } of each member turn that runs. */
const running = new Map();
/** A mark holds only the first turn that gets it; a later turn sees the request again in its history. */
const claimed = new Set();
const ephemeral = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
process.on("SIGTERM", () => process.exit(0));
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (threadId, turnId, text, status) => {
  if (status === "completed") {
    const item = { type: "agentMessage", id: "message-" + turnId, text, phase: "final_answer" };
    write({ method: "item/completed", params: { threadId, turnId, item } });
  }
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
};
const finish = (turnId, status) => {
  const turn = running.get(turnId);
  if (turn === undefined) return;
  running.delete(turnId);
  log({ turnEnded: turnId, threadId: turn.threadId, status });
  reply(turn.threadId, turnId, "Done.", status);
};
setInterval(() => {
  if (running.size === 0) return;
  const hold = control().hold || [];
  for (const [turnId, turn] of [...running]) if (!hold.some((mark) => turn.marks.includes(mark))) finish(turnId, "completed");
}, 25);
const texts = (input) =>
  (Array.isArray(input) ? input : []).flatMap((item) => (item && typeof item.text === "string" ? [item.text] : []));
/** The routing answer: the member that the request names with "route:<name>", else the first one. */
const route = (prompt) => {
  const data = JSON.parse(prompt.slice(prompt.indexOf("\\n") + 1));
  const named = /route:([a-z]+)/.exec(data.task.instruction);
  const agent = (named && data.agents.find((item) => item.name.toLowerCase() === named[1])) || data.agents[0];
  return { data, answer: JSON.stringify({ agentIds: [agent.id] }) };
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5", defaultReasoningEffort: "medium", supportedReasoningEfforts: efforts }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": {
      // Each agent has its own process, so an id names its process too: two processes log to one file.
      const threadId = "thread-" + process.pid + "-" + (++threads);
      if (params.ephemeral) ephemeral.set(threadId, { effort: params.effort ?? null, model: params.model ?? null });
      return write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    }
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const turnTexts = texts(params.input);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const generation = ephemeral.get(params.threadId);
      if (generation) {
        const prompt = turnTexts.find((text) => text.startsWith(ROUTING_PREFIX));
        if (!prompt) return reply(params.threadId, turnId, "Done.", "completed");
        const { data, answer: text } = route(prompt);
        log({
          routing: turnId,
          instruction: data.task.instruction,
          taskCount: data.tasks.length,
          effort: params.effort ?? null,
          threadEffort: generation.effort,
          model: params.model ?? null,
        });
        const delay = Number(control().routeDelayMs) || 0;
        return setTimeout(() => {
          log({ routingEnded: turnId });
          reply(params.threadId, turnId, text, "completed");
        }, delay);
      }
      // One mark per turn, the first one in the order the check held them: a later request of the tab
      // is in this turn's channel history too, and must not hold this turn.
      const mark = (control().hold || []).find((item) => !claimed.has(item) && turnTexts.some((text) => text.includes(item)));
      const marks = mark ? [mark] : [];
      if (mark) claimed.add(mark);
      running.set(turnId, { threadId: params.threadId, texts: turnTexts, marks });
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
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

interface Control {
  hold: string[];
  routeDelayMs: number;
}

/** One line of the fake Codex log. */
interface ProtocolLine {
  index: number;
  /** The turn of a routing generation, else null. */
  routing: string | null;
  instruction: string;
  effort: string | null;
  threadEffort: string | null;
  model: string | null;
  turnStarted: string | null;
  turnEnded: string | null;
  texts: string[];
}

/** What a case saw, as the report keeps it in JSON. */
type Fact = string | number | boolean | null | Fact[] | { [key: string]: Fact };

interface CaseReport {
  name: string;
  mode: "off" | "on";
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

function protocol(): ProtocolLine[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => protocolLine(JSON.parse(line), index));
  } catch {
    return [];
  }
}

function protocolLine(value: unknown, index: number): ProtocolLine {
  const entry = isRecord(value) ? value : {};
  return {
    index,
    routing: getString(entry, "routing"),
    instruction: getString(entry, "instruction") ?? "",
    effort: getString(entry, "effort"),
    threadEffort: getString(entry, "threadEffort"),
    model: getString(entry, "model"),
    turnStarted: getString(entry, "turnStarted"),
    turnEnded: getString(entry, "turnEnded"),
    texts: Array.isArray(entry.texts) ? entry.texts.filter((text): text is string => typeof text === "string") : [],
  };
}

/** The routing generations whose request holds this mark, in order. */
const routings = (mark: string) => protocol().filter((line) => line.routing && line.instruction.includes(mark));
/** The start of the member turn that carries this mark, or undefined. */
const started = (mark: string) =>
  protocol().find((line) => line.turnStarted && line.texts.some((text) => text.includes(mark)));
/** The end of the member turn that carries this mark, or undefined. */
function ended(mark: string): ProtocolLine | undefined {
  const turnId = started(mark)?.turnStarted;
  return turnId ? protocol().find((line) => line.turnEnded === turnId) : undefined;
}

/** Waits for a state of the service or of the fake Codex. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const control: Control = { hold: [], routeDelayMs: 0 };
const writeControl = () => writeFile(controlPath, JSON.stringify(control));
const hold = async (...marks: string[]) => {
  control.hold.push(...marks);
  await writeControl();
};
const release = async (...marks: string[]) => {
  control.hold = control.hold.filter((mark) => !marks.includes(mark));
  await writeControl();
};

const memoryPressure: HostMemory = {
  level: () => "ok",
  turnLimit: () => 64,
  reserveTurn: () => () => {},
  subscribe: () => () => {},
  hostedPlan: false,
  kind: "desktop",
};

await writeControl();
await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });

/** The optimizations that are on. The check moves "routing" between its phases. */
const optimizations = new Set<OptimizationId>();
const optimizationPort: OptimizationPort = {
  optimizationEnabled: (id) => optimizations.has(id),
  onOptimizationChange: () => () => {},
};

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
  channelTabLimit: () => 2,
  optimizations: optimizationPort,
});
const actor = { id: "local", name: "Alex" };

async function createAgent(name: string, reasoningEffort: "medium" | "xhigh"): Promise<string> {
  const first = `${name}-hello-${randomUUID()}`;
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: `Checks the routing of channels as ${name}.`,
      avatarSeed: name,
      avatarHue: null,
      initialMessage: first,
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort,
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

const firstTab = (channelId: string) => `openbot-topic-${channelId}`;

async function createTab(channelId: string): Promise<string> {
  const topicId = randomUUID();
  await runCauseEffect(
    agents.channels.command({ type: "topic-create", operationId: randomUUID(), channelId, topicId }, actor),
  );
  return topicId;
}

async function send(channelId: string, topicId: string, text: string, agentId: string | null = null): Promise<void> {
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

async function stop(channelId: string, taskId: string): Promise<void> {
  await runCauseEffect(
    agents.channels.command(
      { type: "stop", operationId: randomUUID(), channelId, taskId, recipientAgentId: null },
      actor,
    ),
  );
}

/** The task whose instruction holds this mark, in a tab. */
const taskIn = (channelId: string, topicId: string, mark: string): ChannelTask | undefined =>
  agents.channels.page(channelId, topicId).tasks.find((item) => item.instruction.includes(mark));

/** The id of the message of a tab whose text holds this mark. */
const messageIn = (channelId: string, topicId: string, mark: string) =>
  agents.channels.page(channelId, topicId).messages.find((item) => item.message.text.includes(mark));

/** Whether no task of the channel waits or runs. A stopped task can stay. */
const idle = (channelId: string) =>
  agents.channels.store.tasks(channelId).every((item) => item.state !== "queued" && item.state !== "running");

/** A request of one member, routed by the lead, that runs until its mark is released, then stopped. */
async function stoppedTask(channelId: string, topicId: string, mark: string): Promise<ChannelTask> {
  await hold(mark);
  await send(channelId, topicId, `route:bob ${mark}: write a long report`);
  await waitFor(`${mark}: the member turn starts`, () => started(mark));
  const running = await waitFor(`${mark}: the task runs`, () => taskIn(channelId, topicId, mark));
  await stop(channelId, running.id);
  // The stop ends the turn, and the end of the turn ends its assignment a moment later.
  const paused = await waitFor(`${mark}: the task stops`, () => {
    const current = taskIn(channelId, topicId, mark);
    const settled = agents.channels.store
      .assignments(channelId)
      .every((item) => item.state !== "queued" && item.state !== "starting" && item.state !== "running");
    return current?.state === "paused" && ended(mark) && settled ? current : null;
  });
  await release(mark);
  return paused;
}

/** How a follow-up was taken: the task it belongs to, and the routing generations its own text got. */
async function followUp(channelId: string, topicId: string, text: string) {
  const sentAt = Date.now();
  await send(channelId, topicId, text);
  const message = await waitFor(`"${text}" is stored`, () => messageIn(channelId, topicId, text));
  // The follow-up settles when its task has an owner: a continued task has one at once, a new one after
  // the lead routes it.
  const settled = await waitFor(`"${text}": its task has an owner`, () => {
    const owned = agents.channels.store.tasks(channelId).find((item) => item.id === message.taskId);
    return owned?.ownerAgentId ? owned : null;
  });
  return { message, task: settled, ms: Date.now() - sentAt, routings: routings(text).length };
}

let ada = "";
let bob = "";
const LEAD_EFFORT = "xhigh";

async function runCase(name: string, mode: "off" | "on", check: (facts: CaseReport["facts"]) => Promise<void>) {
  if (mode === "on") optimizations.add("routing");
  else optimizations.delete("routing");
  const result: CaseReport = { name, mode, facts: {}, passed: false };
  report.cases.push(result);
  try {
    await check(result.facts);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    control.hold = [];
    control.routeDelayMs = 0;
    await writeControl();
  }
}

try {
  await runCauseEffect(agents.initialize());
  ada = await createAgent("ada", LEAD_EFFORT);
  bob = await createAgent("bob", "medium");

  for (const mode of ["off", "on"] as const) {
    await runCase("the routing generation runs at the lowest effort of the lead's model", mode, async (facts) => {
      const channelId = await createChannel(`routing-1-${mode}`, [ada, bob]);
      const mark = `effort-1-${mode}`;
      const sentAt = Date.now();
      await send(channelId, firstTab(channelId), `route:bob ${mark}: reply ready`);
      const routed = await waitFor("the lead gives the request to bob", () => {
        const current = taskIn(channelId, firstTab(channelId), mark);
        return current?.ownerAgentId ? current : null;
      });
      facts.msToOwner = Date.now() - sentAt;
      const generations = routings(mark);
      facts.routingGenerations = generations.length;
      facts.owner = routed.ownerAgentId === bob ? "bob" : (routed.ownerAgentId ?? null);
      facts.leadEffort = LEAD_EFFORT;
      facts.effort = generations[0]?.effort ?? null;
      facts.threadEffort = generations[0]?.threadEffort ?? null;
      facts.model = generations[0]?.model ?? null;
      await waitFor("bob's turn ends", () => ended(mark));
      assert.equal(facts.routingGenerations, 1);
      assert.equal(facts.owner, "bob");
      assert.equal(facts.model, "gpt-5.5", "the routing keeps the lead's model");
      assert.equal(facts.effort, mode === "on" ? "low" : LEAD_EFFORT);
      assert.equal(facts.threadEffort, mode === "on" ? "low" : LEAD_EFFORT);
    });

    await runCase("a follow-up in Portuguese or Spanish continues the stopped task of its tab", mode, async (facts) => {
      const phrases = [
        "continua de onde parou",
        "na verdade, use só as datas",
        "sim, pode seguir",
        "continúa, por favor",
        "sí, hazlo así",
        "en realidad, usa solo las fechas",
      ];
      const results: Fact[] = [];
      // "No relatório, ..." is "In the report, ...": a new request. Off, the English "no" took it as a
      // follow-up; on, only a "no" before a punctuation mark answers.
      const notFollowUp = "No relatório de vendas, some os totais";
      phrases.push(notFollowUp);
      // Each phrase has a channel of its own, so the stopped task is the one open task of the channel.
      for (const [index, phrase] of phrases.entries()) {
        const channelId = await createChannel(`routing-2-${index}-${mode}`, [ada, bob]);
        const topicId = firstTab(channelId);
        const paused = await stoppedTask(channelId, topicId, `stop-2-${index}-${mode}`);
        const text = `${phrase} (2-${index}-${mode})`;
        const taken = await followUp(channelId, topicId, text);
        results.push({
          phrase,
          continued: taken.task.id === paused.id,
          routingGenerations: taken.routings,
          ms: taken.ms,
        });
        await waitFor(`${text}: the work ends`, () => idle(channelId));
      }
      facts.phrases = results;
      for (const entry of results) {
        assert.ok(isRecord(entry));
        if (entry.phrase === notFollowUp) {
          assert.equal(entry.continued, mode === "off", `${notFollowUp}: continued only off`);
          assert.equal(entry.routingGenerations, mode === "on" ? 1 : 0, `${notFollowUp}: routed only on`);
          continue;
        }
        assert.equal(entry.continued, mode === "on", `${String(entry.phrase)}: continued`);
        // Off, the stop can still change the tab while the lead routes, so the lead can route twice.
        if (mode === "on") assert.equal(entry.routingGenerations, 0, `${String(entry.phrase)}: no routing`);
        else assert.ok(Number(entry.routingGenerations) >= 1, `${String(entry.phrase)}: off, the lead routes it`);
      }
    });

    await runCase("the continue shortcut counts only the tasks of its own tab", mode, async (facts) => {
      const channelId = await createChannel(`routing-3-${mode}`, [ada, bob]);
      // "continue" in a tab with no open work, while another tab has a stopped task.
      const other = firstTab(channelId);
      const stoppedElsewhere = await stoppedTask(channelId, other, `stop-3a-${mode}`);
      const empty = await createTab(channelId);
      const continueText = `continue with the summary (3a-${mode})`;
      const crossTab = await followUp(channelId, empty, continueText);
      const otherAfter = agents.channels.page(channelId, other).tasks.find((item) => item.id === stoppedElsewhere.id);
      const tabs = {
        tookTaskOfOtherTab: crossTab.task.id === stoppedElsewhere.id,
        taskTab: crossTab.task.topicId === empty ? "own" : "other",
        otherTaskState: otherAfter?.state ?? null,
        routingGenerations: crossTab.routings,
      };
      facts.crossTab = tabs;
      await waitFor("the work of 3a ends", () => idle(channelId));
      // "Also ..." in a tab with one stopped task, while another tab has one too.
      const second = await createTab(channelId);
      const third = await createTab(channelId);
      const own = await stoppedTask(channelId, second, `stop-3b-${mode}`);
      await stoppedTask(channelId, third, `stop-3c-${mode}`);
      const alsoText = `also add the dates (3b-${mode})`;
      const also = await followUp(channelId, second, alsoText);
      const sameTab = { continued: also.task.id === own.id, routingGenerations: also.routings, ms: also.ms };
      facts.sameTab = sameTab;
      if (mode === "on") {
        assert.equal(tabs.tookTaskOfOtherTab, false, "a tab does not continue the task of another tab");
        assert.equal(tabs.taskTab, "own");
        assert.equal(tabs.otherTaskState, "paused", "the task of the other tab stays stopped");
        assert.equal(sameTab.continued, true, "the one stopped task of the tab continues");
        assert.equal(sameTab.routingGenerations, 0);
      } else {
        assert.equal(tabs.tookTaskOfOtherTab, true, "off: as before, the task of the other tab continues");
        assert.equal(sameTab.continued, false, "off: as before, the open work of every tab counts");
        assert.ok(sameTab.routingGenerations >= 1, "off: as before, the lead routes it");
      }
    });

    await runCase("changes during a routing generation", mode, async (facts) => {
      const channelId = await createChannel(`routing-4-${mode}`, [ada, bob]);
      control.routeDelayMs = 2_500;
      await writeControl();
      /**
       * Bob runs held requests in `busyTab`, one after the other. Each time the lead starts a routing
       * generation for the request with `mark`, the next held request ends, so the tab changes while
       * the lead routes. Returns how many generations the request took, and how long it waited.
       */
      const contended = async (busyTab: string, requestTab: string, mark: string, holds: string[]) => {
        await hold(...holds);
        for (const held of holds) await send(channelId, busyTab, `${held}: keep working`, bob);
        const firstHeld = holds[0] ?? "";
        await waitFor(`${firstHeld}: bob works`, () => started(firstHeld));
        const sentAt = Date.now();
        await send(channelId, requestTab, `route:bob ${mark}: reply ready`);
        let released = 0;
        const routed = await waitFor(
          `${mark}: the lead gives the request to bob`,
          () => {
            const seen = routings(mark).length;
            while (released < Math.min(seen, holds.length)) {
              const next = holds[released];
              released += 1;
              if (next) void release(next);
            }
            const current = taskIn(channelId, requestTab, mark);
            return current?.ownerAgentId ? current : null;
          },
          60_000,
        );
        const result = { generations: routings(mark).length, msToOwner: Date.now() - sentAt, released };
        await release(...holds);
        assert.equal(routed.ownerAgentId, bob);
        await waitFor(`${mark}: the work ends`, () => ended(mark) && holds.every((held) => ended(held)), 30_000);
        return result;
      };
      const busyTab = await createTab(channelId);
      const requestTab = await createTab(channelId);
      const otherTab = await contended(busyTab, requestTab, `other-4-${mode}`, [
        `busy-4a1-${mode}`,
        `busy-4a2-${mode}`,
        `busy-4a3-${mode}`,
      ]);
      facts.otherTab = otherTab;
      const shared = await createTab(channelId);
      const sameTab = await contended(shared, shared, `same-4-${mode}`, [
        `busy-4b1-${mode}`,
        `busy-4b2-${mode}`,
        `busy-4b3-${mode}`,
        `busy-4b4-${mode}`,
      ]);
      facts.sameTab = sameTab;
      facts.counts = { ...agents.channels.routingCounts() };
      if (mode === "on") {
        assert.equal(otherTab.generations, 1, "a change in another tab does not discard the routing");
        assert.ok(sameTab.generations <= 3, "at most 2 routings of one request are discarded");
      } else {
        assert.ok(otherTab.generations > 1, "off: as before, a change in another tab discards the routing");
        assert.ok(sameTab.generations > 3, "off: as before, there is no limit");
      }
    });
  }

  report.passed = report.cases.length === 8 && report.cases.every((entry) => entry.passed);
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
