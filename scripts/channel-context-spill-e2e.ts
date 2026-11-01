// Checks the optimization `channel-context-spill` (inline and spill of the channel context). Runs the
// real agent service, channel service, mailbox and drain on a temporary profile, with a fake Codex
// app-server that calls the channel tools as a model would. The same flow runs twice, in its own
// channel: first with the optimization off, then on.
// 1. Worker posts three task results of 50,000 characters each with channel_result. Each one hides
//    one fact at character 25,000. The third has a code block across character 4,000. Before the
//    third, a message to Worker mentions Reader.
// 2. Reader gets "find fact 1". Reader never worked in the tab, so it gets the complete packet. The
//    fake reads the packet, calls channel_history with no arguments, follows each cut row of the
//    packet with channel_history {messageId, offset}, and reads the compact page ({limit: 20}).
// 3. Reader gets "find fact 2" in the same session: it gets the delta. The fake finds the fact from
//    the compact page and reads by id.
// Off, the packet, the delta and channel_history must be as before the optimization: the report keeps
// a hash of each one with ids and times replaced, to compare with a run on the code before it. On,
// the packet is smaller, cut rows carry chars and nextOffset, Reader finds fact 1 by the pointer of
// its packet, no summary is generated, the delta leaves out the parts that did not change, and the
// default channel_history page has no channel, no tasks and at most 20 short rows.
// `bun scripts/channel-context-spill-e2e.ts`. Writes .openbot-build/channel-context-spill-e2e/report.json.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { HostMemory } from "../src/backend/host-memory";
import { getString, isRecord } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-context-spill-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-context-spill-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");

const RESULT_CHARACTERS = 50_000;

/**
 * A Codex app-server with the methods that the service calls. A turn reads its request from the last
 * "Current assignment:" of its input: `SEED-<mode>-<n>` posts result n with channel_result, and
 * `FIND-<mode>-<n>` looks for fact n with channel_history. A summary or review turn on an ephemeral
 * thread answers at once. Each step goes to the log as sizes and found values, with the turn input.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const RESULT_CHARACTERS = ${RESULT_CHARACTERS};
const log = (entry) => fs.appendFileSync(process.env.OPENBOT_FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
let calls = 0;
const ephemeral = new Set();
/** Tool call id -> its turn. */
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
process.on("SIGTERM", () => process.exit(0));
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turn, text) => {
  log({ turnEnded: turn.turnId, threadId: turn.threadId, answer: text });
  const item = { type: "agentMessage", id: "message-" + turn.turnId, text, phase: "final_answer" };
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item } });
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
};
const resultText = (mode, n) => {
  const line = (index) => "Line " + index + ": a build log entry with nothing important in it.\\n";
  let text = "Result " + n + " of the " + mode + " run.\\n";
  let index = 0;
  let block = false;
  while (text.length < 25000) {
    if (n === 3 && !block && text.length >= 3500) {
      block = true;
      text += "\\u0060\\u0060\\u0060ts\\n";
      for (let step = 0; step < 30; step++) text += "const value" + step + " = compute(" + step + ");\\n";
      text += "\\u0060\\u0060\\u0060\\n";
    }
    text += line(++index);
  }
  text += "The hidden fact is FACT-" + mode + "-" + n + "=amber-" + mode + "-" + n + ".\\n";
  while (text.length < RESULT_CHARACTERS) text += line(++index);
  return text.slice(0, RESULT_CHARACTERS);
};
const call = (turn, kind, args) => {
  const id = "tool-" + turn.turnId + "-" + (++calls);
  waiting.set(id, { turn, kind, args });
  write({ id, method: "item/tool/call", params: {
    threadId: turn.threadId, turnId: turn.turnId, callId: id, namespace: "openbot", tool: "tool_call",
    arguments: { name: "openbot." + (kind === "result" ? "channel_result" : "channel_history"), arguments: args },
  } });
};
const factIn = (turn, text) => {
  const match = new RegExp("FACT-" + turn.mode + "-" + turn.n + "=[a-z0-9-]+").exec(text || "");
  return match ? match[0].replace(/[-.]+$/, "") : null;
};
/** The next step of a find turn, or its answer. */
const step = (turn) => {
  const next = turn.steps.shift();
  if (next) return call(turn, next.kind, next.args);
  const found = turn.found;
  const via = found.pointer ? "pointer" : found.listing ? "listing" : found.defaultHistory ? "default-history" : found.packet ? "packet" : "nothing";
  const value = found.pointer || found.listing || found.defaultHistory || found.packet || "none";
  log({ find: turn.mark, threadId: turn.threadId, inputCharacters: turn.text.length, found, via, sizes: turn.sizes, reads: turn.reads });
  finish(turn, "FOUND " + value + " via " + via);
};
const onResult = (entry, message) => {
  const { turn, kind, args } = entry;
  const text = message.result && Array.isArray(message.result.contentItems) ? message.result.contentItems.map((item) => item.text || "").join("") : "";
  if (kind === "result") return finish(turn, "Result posted.");
  let value = null;
  try { value = JSON.parse(text); } catch {}
  if (kind === "default") {
    turn.sizes.defaultHistory = text.length;
    turn.sizes.defaultHistoryKeys = value && typeof value === "object" ? Object.keys(value) : [];
    turn.sizes.defaultHistoryRows = value && Array.isArray(value.messages) ? value.messages.length : null;
    const fact = factIn(turn, text);
    if (fact) turn.found.defaultHistory = fact;
  } else if (kind === "listing") {
    turn.sizes.listing = text.length;
    turn.sizes.listingRows = value && Array.isArray(value.messages) ? value.messages.length : null;
    turn.sizes.listingLongestPreview = value && Array.isArray(value.messages) ? Math.max(0, ...value.messages.map((row) => (row.preview || "").length)) : null;
    if (!turn.found.pointer && value && Array.isArray(value.messages))
      for (const row of value.messages)
        if (typeof row.chars === "number" && row.chars > 1200) turn.steps.push({ kind: "listing-read", args: { messageId: row.id } });
  } else {
    const source = kind === "pointer-read" ? "pointer" : "listing";
    const page = value && typeof value.text === "string" ? value.text : "";
    turn.reads.push({ kind, characters: text.length, page: page.length, nextOffset: value ? value.nextOffset ?? null : null });
    const fact = factIn(turn, (turn.carry[args.messageId] || "") + page);
    turn.carry[args.messageId] = page.slice(-200);
    if (fact) {
      turn.found[source] = fact;
      turn.steps = turn.steps.filter((item) => item.kind !== kind);
    } else if (value && typeof value.nextOffset === "number")
      turn.steps.unshift({ kind, args: { messageId: args.messageId, offset: value.nextOffset } });
  }
  step(turn);
};
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
      const threadId = "thread-" + process.pid + "-" + (++threads);
      if (params.ephemeral) ephemeral.add(threadId);
      return write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    }
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = texts(params.input).join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const turn = { threadId: params.threadId, turnId, text, steps: [], found: {}, sizes: {}, reads: [], carry: {} };
      if (ephemeral.has(params.threadId)) {
        const summary = text.includes("Summarize shared facts") || text.includes("Shorten this channel summary");
        log({ ephemeral: turnId, summary, inputCharacters: text.length });
        return finish(turn, summary ? "Summary: Worker posted long results; the facts are in them." : "Done.");
      }
      const assignment = text.lastIndexOf("Current assignment:");
      const request = assignment < 0 ? "" : text.slice(assignment);
      log({ turnStarted: turnId, threadId: params.threadId, texts: [text] });
      const seed = /SEED-([a-z]+)-(\\d)/.exec(request);
      if (seed) return call(turn, "result", { text: resultText(seed[1], Number(seed[2])) });
      const find = /FIND-([a-z]+)-(\\d)/.exec(request);
      if (!find) return finish(turn, "Done.");
      Object.assign(turn, { mark: find[0], mode: find[1], n: Number(find[2]) });
      const packetFact = factIn(turn, text);
      if (packetFact) turn.found.packet = packetFact;
      for (const line of text.split("\\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const row = JSON.parse(line);
          if (typeof row.id === "string" && typeof row.nextOffset === "number")
            turn.steps.push({ kind: "pointer-read", args: { messageId: row.id, offset: row.nextOffset } });
        } catch {}
      }
      turn.steps.push({ kind: "default", args: {} }, { kind: "listing", args: { limit: 20 } });
      return step(turn);
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
        const entry = waiting.get(message.id);
        waiting.delete(message.id);
        onResult(entry, message);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

/** What a find turn of the fake measured. */
interface FindReport {
  /** The characters of the turn input: the complete packet or the delta, with its frame. */
  inputCharacters: number;
  via: string;
  found: { packet: string | null; pointer: string | null; listing: string | null; defaultHistory: string | null };
  /** channel_history with no arguments: its characters, its keys and its rows. */
  defaultHistory: { characters: number | null; keys: string[]; rows: number | null };
  /** channel_history {limit: 20}. */
  listing: { characters: number | null; rows: number | null; longestPreview: number | null };
  /** channel_history {messageId, offset}: how many reads, and the characters of the largest result. */
  reads: { count: number; largest: number };
}

interface LogLine {
  turnStarted: string | null;
  turnEnded: string | null;
  summary: boolean;
  texts: string[];
  find: string | null;
  value: DynamicRecord;
}

/** A row of the JSON lines of a packet, with the fields this check reads. */
interface PacketRow {
  text: string | null;
  chars: number | null;
  nextOffset: number | null;
  textInCurrentAssignment: boolean;
}

const asRecord = (value: unknown): DynamicRecord => (isRecord(value) ? value : {});

function numberAt(record: unknown, key: string): number | null {
  const value = isRecord(record) ? record[key] : undefined;
  return typeof value === "number" ? value : null;
}
function recordAt(record: unknown, key: string): DynamicRecord {
  const value = isRecord(record) ? record[key] : undefined;
  return isRecord(value) ? value : {};
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function findReport(line: LogLine): FindReport {
  const { value } = line;
  const found = recordAt(value, "found");
  const sizes = recordAt(value, "sizes");
  const reads = Array.isArray(value.reads) ? value.reads : [];
  return {
    inputCharacters: numberAt(value, "inputCharacters") ?? 0,
    via: getString(value, "via") ?? "",
    found: {
      packet: getString(found, "packet"),
      pointer: getString(found, "pointer"),
      listing: getString(found, "listing"),
      defaultHistory: getString(found, "defaultHistory"),
    },
    defaultHistory: {
      characters: numberAt(sizes, "defaultHistory"),
      keys: strings(sizes.defaultHistoryKeys),
      rows: numberAt(sizes, "defaultHistoryRows"),
    },
    listing: {
      characters: numberAt(sizes, "listing"),
      rows: numberAt(sizes, "listingRows"),
      longestPreview: numberAt(sizes, "listingLongestPreview"),
    },
    reads: {
      count: reads.length,
      largest: Math.max(0, ...reads.map((read) => numberAt(read, "characters") ?? 0)),
    },
  };
}

/** What one mode measured. Sizes are characters. No message text goes into the report. */
interface ModeReport {
  mode: "off" | "on";
  summaryGenerations: number;
  packet: { characters: number; hash: string; cutRows: number; requestRepeats: number };
  delta: { characters: number; hash: string; omitsFixedParts: boolean };
  find1: FindReport;
  find2: FindReport;
  checks: Record<string, boolean | number | string | null>;
}

const report: { modes: ModeReport[]; passed: boolean; error?: string } = { modes: [], passed: false };

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

function protocol(): LogLine[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value = asRecord(JSON.parse(line));
        return {
          turnStarted: getString(value, "turnStarted"),
          turnEnded: getString(value, "turnEnded"),
          summary: value.summary === true,
          texts: strings(value.texts),
          find: getString(value, "find"),
          value,
        };
      });
  } catch {
    return [];
  }
}

const startedTurn = (mark: string) =>
  protocol().find((line) => line.turnStarted && line.texts.some((text) => text.includes(mark)));
const endedTurn = (mark: string) => {
  const turnId = startedTurn(mark)?.turnStarted;
  return turnId ? protocol().find((line) => line.turnEnded === turnId) : undefined;
};
const findEntry = (mark: string) => {
  const line = protocol().find((entry) => entry.find === mark);
  return line ? findReport(line) : undefined;
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

/** Ids and times change from run to run; the hash of a packet without them does not. */
function stableHash(text: string, name: string): string {
  const stable = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<id>")
    .replace(/(thread|turn|message-turn|tool-turn)-\d+-\d+/gu, "$1-<n>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, "<time>");
  // `SPILL_E2E_DUMP=<folder>` keeps each text as hashed, to compare two runs line by line.
  const dump = process.env.SPILL_E2E_DUMP;
  if (dump) writeFileSync(join(dump, `${name}.txt`), stable);
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

const memoryPressure: HostMemory = {
  level: () => "ok",
  turnLimit: () => 64,
  reserveTurn: () => () => {},
  subscribe: () => () => {},
  hostedPlan: false,
  kind: "desktop",
};

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
/** The switch of Settings > Advanced optimizations that this check turns on for its second run. */
let spill = false;
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
  optimizations: {
    optimizationEnabled: (id) => spill && id === "channel-context-spill",
    onOptimizationChange: () => () => {},
  },
});
const actor = { id: "local", name: "Alex" };

async function createAgent(name: string): Promise<string> {
  const first = `${name}-hello-${randomUUID()}`;
  const agent = await runCauseEffect(
    agents.createAgent({
      name,
      description: "Checks the channel context.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: first,
    }),
  );
  await waitFor(`${name}: the first turn ends`, () => endedTurn(first));
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

async function send(channelId: string, text: string, agentId: string): Promise<void> {
  await runCauseEffect(
    agents.channels.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId,
        topicId: `openbot-topic-${channelId}`,
        text,
        recipientAgentId: agentId,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
}

/** Whether the task of the request with this mark is complete, as the screen reads it. */
const completed = (channelId: string, mark: string) =>
  agents.channels
    .page(channelId, `openbot-topic-${channelId}`)
    .tasks.some((task) => task.instruction.includes(mark) && task.state === "completed");

/** The rows of the JSON lines of a packet. */
function packetRows(text: string): PacketRow[] {
  return text.split("\n").flatMap((line) => {
    if (!line.startsWith('{"id"')) return [];
    const value = asRecord(JSON.parse(line));
    return [
      {
        text: getString(value, "text"),
        chars: numberAt(value, "chars"),
        nextOffset: numberAt(value, "nextOffset"),
        textInCurrentAssignment: value.textInCurrentAssignment === true,
      },
    ];
  });
}

const count = (text: string, part: string) => text.split(part).length - 1;

async function runMode(mode: "off" | "on", lead: string, worker: string, reader: string): Promise<ModeReport> {
  spill = mode === "on";
  const summariesBefore = protocol().filter((line) => line.summary).length;
  const channelId = await createChannel(`spill-${mode}`, [lead, worker, reader]);
  for (const n of [1, 2, 3]) {
    if (n === 3) {
      const note = `NOTE-REF-${mode}: @[Reader](agent:${reader}) keeps the release checklist. ${"Context for the release checklist. ".repeat(70)}`;
      await send(channelId, note, worker);
      await waitFor(`${mode}: the note task ends`, () => completed(channelId, `NOTE-REF-${mode}`));
    }
    await send(channelId, `SEED-${mode}-${n}: post the result of build ${n}.`, worker);
    await waitFor(`${mode}: result ${n} is posted`, () => completed(channelId, `SEED-${mode}-${n}`), 60_000);
  }
  const question = (n: number) => `FIND-${mode}-${n}: which value does fact ${n} of the ${mode} run have?`;
  await send(channelId, question(1), reader);
  const find1 = await waitFor(`${mode}: Reader finds fact 1`, () => findEntry(`FIND-${mode}-1`), 60_000);
  // The next request starts after this task ends, so its packet is the delta of the same session.
  await waitFor(`${mode}: the first find task ends`, () => completed(channelId, `FIND-${mode}-1`));
  await send(channelId, question(2), reader);
  const find2 = await waitFor(`${mode}: Reader finds fact 2`, () => findEntry(`FIND-${mode}-2`), 60_000);
  const packet = startedTurn(`FIND-${mode}-1`)?.texts.join("\n") ?? "";
  const delta = startedTurn(`FIND-${mode}-2`)?.texts.join("\n") ?? "";
  const rows = packetRows(packet);
  const cut = rows.filter((row) => typeof row.nextOffset === "number");
  const result1 = rows.find(
    (row) => row.chars === RESULT_CHARACTERS && typeof row.text === "string" && row.text.startsWith("Result 1"),
  );
  const result3 = rows.find((row) => typeof row.text === "string" && row.text.startsWith("Result 3"));
  const note = rows.find((row) => typeof row.text === "string" && row.text.startsWith(`NOTE-REF-${mode}`));
  const summaryGenerations = protocol().filter((line) => line.summary).length - summariesBefore;
  const expected = (n: number) => `FACT-${mode}-${n}=amber-${mode}-${n}`;
  return {
    mode,
    summaryGenerations,
    packet: {
      characters: packet.length,
      hash: stableHash(packet, `${mode}-packet`),
      cutRows: cut.length,
      requestRepeats: count(packet, `which value does fact 1 of the ${mode} run have?`),
    },
    delta: {
      characters: delta.length,
      hash: stableHash(delta, `${mode}-delta`),
      omitsFixedParts: delta.includes("Not repeated here because") && !delta.includes("You have one assignment"),
    },
    find1,
    find2,
    checks: {
      find1Answer: find1.found.pointer ?? find1.found.listing ?? find1.found.defaultHistory ?? null,
      find1Expected: expected(1),
      find2Answer: find2.found.listing ?? find2.found.pointer ?? find2.found.defaultHistory ?? null,
      find2Expected: expected(2),
      oldToolLine: packet.includes("channel_history takes beforeSequence and attachmentId, both optional."),
      result1Text: result1 ? String(result1.text).length : null,
      result1NextOffset: result1 ? Number(result1.nextOffset) : null,
      result3Text: result3 ? String(result3.text).length : null,
      result3Fences: result3 ? count(String(result3.text), "```") : null,
      noteRowCut: note ? typeof note.nextOffset === "number" : null,
      noteRowText: note ? String(note.text).length : null,
      requestInAssignment: rows.some((row) => row.textInCurrentAssignment === true),
    },
  };
}

try {
  await runCauseEffect(agents.initialize());
  const lead = await createAgent("Lead");
  const worker = await createAgent("Worker");
  const reader = await createAgent("Reader");

  const off = await runMode("off", lead, worker, reader);
  report.modes.push(off);
  const on = await runMode("on", lead, worker, reader);
  report.modes.push(on);

  // Off: as before the optimization.
  assert.equal(off.checks.oldToolLine, true, "off: the packet keeps the old channel_history line");
  assert.equal(off.packet.cutRows, 0, "off: no row of the packet is cut");
  assert.ok(off.summaryGenerations > 0, "off: the long results make the lead summarize");
  assert.ok(
    ["channel", "tasks", "messages"].every((key) => off.find1.defaultHistory.keys.includes(key)),
    "off: channel_history with no arguments gives the whole page",
  );
  assert.equal(off.checks.find1Answer, off.checks.find1Expected, "off: the fact is found");
  assert.equal(off.delta.omitsFixedParts, false, "off: the delta repeats the fixed parts");

  // On: the lean packet and the pointers.
  assert.equal(on.summaryGenerations, 0, "on: no summary is generated");
  assert.equal(on.checks.oldToolLine, false, "on: the packet names the new channel_history arguments");
  assert.ok(on.packet.cutRows >= 3, "on: the long rows are cut");
  assert.ok(on.packet.characters < off.packet.characters, "on: the packet is smaller");
  assert.ok(Number(on.checks.result1Text) <= 200, "on: a large result that is not kept gives a preview");
  assert.equal(on.checks.result1NextOffset, on.checks.result1Text, "on: the preview names where the rest starts");
  assert.ok(Number(on.checks.result3Text) <= 4_000, "on: a last message is cut at 4,000 characters");
  assert.equal(Number(on.checks.result3Fences) % 2, 0, "on: no cut ends inside a code block");
  assert.equal(on.checks.noteRowCut, false, "on: a message that mentions the agent is kept whole");
  assert.equal(on.checks.requestInAssignment, true, "on: the request text is given once");
  assert.equal(on.packet.requestRepeats, 1, "on: the instruction is in the packet once");
  assert.equal(on.find1.via, "pointer", "on: Reader found fact 1 by the pointer of its packet");
  assert.equal(on.checks.find1Answer, on.checks.find1Expected, "on: fact 1 is right");
  assert.equal(on.checks.find2Answer, on.checks.find2Expected, "on: fact 2 is found from the compact page");
  assert.equal(on.delta.omitsFixedParts, true, "on: the delta leaves out the fixed parts that did not change");
  assert.ok(on.delta.characters < off.delta.characters, "on: the delta is smaller");
  assert.ok(
    !on.find1.defaultHistory.keys.includes("channel") && !on.find1.defaultHistory.keys.includes("tasks"),
    "on: channel_history with no arguments has no channel and no tasks",
  );
  assert.ok((on.find1.defaultHistory.rows ?? 99) <= 20, "on: at most 20 rows");
  assert.ok((on.find1.listing.longestPreview ?? 999) <= 201, "on: each preview is short");
  assert.ok(
    Number(on.find1.defaultHistory.characters) < Number(off.find1.defaultHistory.characters),
    "on: the page is smaller",
  );
  report.passed = true;
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
