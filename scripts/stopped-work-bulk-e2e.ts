// Checks the stopped work of the load page of Settings and why deleted work stayed stopped for ever.
// Runs the real agent service, channel service, channel routines and `WorkControl` on a temporary
// profile with a fake Codex app-server, then starts the service again on the same profile, as the
// app does at each start. Fixtures: a channel with no lead, where each request with no member stops
// (56 of them, as the owner's "slop rotina" channel), routines of that channel, and a channel with a
// tab where the provider refuses to start some tasks (failed, with an agent, as "naia novas features").
// Checks:
// - the page lists every stopped run, past the 50 rows of the snapshot, with origin and orphan marks,
//   and the ring counts them all;
// - a deleted routine takes its stopped work with it;
// - a start of the app does not post the request of an open routine run again;
// - a filter selects rows (by origin, by channel, by orphan), and a bulk remove, an undo, a bulk
//   reassign and a bulk change of model apply to them, with a report of the rows that failed and why;
// - the stopped task of a deleted agent is marked, and removed in bulk.
// `bun scripts/stopped-work-bulk-e2e.ts`. Writes .openbot-build/stopped-work-bulk-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type ChannelTask, type StoppedWorkEntry } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { filterStoppedWork, type StoppedWorkFilter } from "../src/renderer/src/features/settings/stopped-work-filter";

const OUT = resolve(import.meta.dirname, "../.openbot-build/stopped-work-bulk-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-stopped-work-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { BuildersBotDatabase } = await import("../src/backend/openbot-database");
const { WorkControl } = await import("../src/main/work-control");

/** A turn whose input has this mark fails to start, as a provider that cannot start an assignment. */
const FAIL_MARK = "FAIL-START";

/** A Codex app-server that answers "Done." to each turn, and refuses a turn with `FAIL_MARK`. */
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }, { model: "gpt-6-sol", displayName: "GPT-6 Sol" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      if (text.includes(${JSON.stringify(FAIL_MARK)})) {
        return write({ id: message.id, error: { code: -32000, message: "The model is not available." } });
      }
      const turnId = "turn-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      return setTimeout(() => {
        const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 20);
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
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const PERSON = { id: "local", name: "Ariel" };
const report: { checks: { name: string; passed: boolean; detail?: unknown }[]; passed: boolean; error?: string } = {
  checks: [],
  passed: false,
};

function pass(name: string, condition: boolean, detail?: unknown) {
  report.checks.push({ name, passed: condition, ...(detail === undefined ? {} : { detail }) });
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
}

/** Waits for a state of the service. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
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

/** One start of the app on the profile: the database, the agent service and the control of the load page. */
async function start() {
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
  });
  await runCauseEffect(agents.initialize());
  const failures: string[] = [];
  const control = new WorkControl({
    service: agents,
    channelActor: () => PERSON,
    preference: () => ({ enabled: false, intervalMinutes: 30, reassign: false }),
    agentLimit: () => ({ enabled: false, max: 10 }),
    onFailure: (action) => failures.push(action),
    requestOrigins: (channelId, requests) => agents.channelRequestOrigins(channelId, requests),
    setAgentModel: (agentId, provider, model) =>
      runCauseEffect(agents.updateAgent({ agentId, provider, model })).then(() => undefined),
  });
  return { database, agents, control, failures };
}

type Started = Awaited<ReturnType<typeof start>>;
let current: Started | null = null;

const ALL: StoppedWorkFilter = { search: "", state: "all", agent: "all", place: "all", origin: "all", orphan: "all" };
const items = (rows: readonly StoppedWorkEntry[]) => rows.map(({ channelId, taskId }) => ({ channelId, taskId }));

try {
  await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
  current = await start();
  const { agents } = current;
  const channels = () => agents.channels;
  const create = async (name: string) => {
    const agent = await runCauseEffect(
      agents.createAgent({
        name,
        description: `${name} works in a channel.`,
        avatarSeed: name.toLowerCase().replace(/\s+/g, "-"),
        avatarHue: null,
        initialMessage: "Hello.",
      }),
    );
    await waitFor(`the first chat turn of ${name} to end`, () =>
      agents
        .listQueue(agent.id)
        .deliveries.every((delivery) => !["queued", "starting", "running"].includes(delivery.status)),
    );
    return agent;
  };
  const leader = await create("Lider Opus");
  const evals = await create("Evals Naia");
  const designer = await create("Design Advisor");
  const save = (channelId: string, name: string, members: string[], leadAgentId: string | null) =>
    runCauseEffect(
      channels().command(
        {
          type: "save",
          operationId: randomUUID(),
          channelId,
          draft: { name, title: "", instructions: "", members: members.map((agentId) => ({ agentId })), leadAgentId },
        },
        PERSON,
      ),
    );
  const send = (channelId: string, text: string, recipientAgentId: string | null, topicId?: string) =>
    runCauseEffect(
      channels().command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId,
          text,
          recipientAgentId,
          replyToMessageId: null,
          attachmentDraftIds: [],
          ...(topicId ? { topicId } : {}),
        },
        PERSON,
      ),
    );
  const stoppedIn = (channelId: string): ChannelTask[] =>
    channels()
      .store.tasks(channelId)
      .filter((task) => (task.state === "paused" || task.state === "failed") && Boolean(task.error));

  // Fixture 1: a channel with two members and no lead. A request that names no member stops.
  const slop = randomUUID();
  await save(slop, "slop rotina", [leader.id, evals.id], null);
  for (let index = 0; index < 50; index += 1) await send(slop, `Hourly check ${index + 1} of the campaign.`, null);
  await waitFor("50 stopped requests", () => stoppedIn(slop).length === 50);
  const hourly = agents.createChannelRoutine({
    channelId: slop,
    name: "slop.cash hourly",
    instruction: "Review the slop.cash campaign.",
    active: false,
    timezone: "UTC",
    schedule: { kind: "hourly", minute: 7 },
  });
  for (let index = 0; index < 3; index += 1) {
    await runCauseEffect(agents.testChannelRoutine({ channelId: slop, routineId: hourly.id }));
  }
  const gone = agents.createChannelRoutine({
    channelId: slop,
    name: "Old routine",
    instruction: "A routine that the person deletes.",
    active: false,
    timezone: "UTC",
    schedule: { kind: "daily", time: "09:00" },
  });
  const goneRun = await runCauseEffect(agents.testChannelRoutine({ channelId: slop, routineId: gone.id }));
  await waitFor("the stopped routine requests", () => stoppedIn(slop).length === 54);

  // Fixture 2: a channel with a lead and a tab, where the provider refuses two tasks.
  const naia = randomUUID();
  await save(naia, "naia novas features", [leader.id, evals.id, designer.id], leader.id);
  const tabId = randomUUID();
  await runCauseEffect(
    channels().command(
      { type: "topic-create", operationId: randomUUID(), channelId: naia, topicId: tabId, name: "cadastro" },
      PERSON,
    ),
  );
  await send(naia, `${FAIL_MARK} Package E4 of the sign-up in chat.`, evals.id, tabId);
  await send(naia, `${FAIL_MARK} Package D4 of the sign-up in chat.`, designer.id, tabId);
  await waitFor("two failed starts", () => stoppedIn(naia).filter((task) => task.state === "failed").length === 2);

  // 1. The ring counts every stopped run; the page lists all of them.
  const before = current.control.listStopped();
  const snapshot = current.control.overview();
  pass(
    "The snapshot keeps 50 rows and counts every stopped run",
    snapshot.stopped.length === 50 && snapshot.stoppedTotal === 56,
    {
      rows: snapshot.stopped.length,
      total: snapshot.stoppedTotal,
    },
  );
  pass("The page lists every stopped run", before.items.length === 56 && before.total === 56, before.total);
  const routineRows = filterStoppedWork(before.items, { ...ALL, origin: "routine" });
  pass(
    "The rows of a routine name it",
    routineRows.length === 4 && routineRows.filter((row) => row.routineName === "slop.cash hourly").length === 3,
    routineRows.map((row) => row.routineName),
  );
  const failedRows = filterStoppedWork(before.items, { ...ALL, state: "failed" });
  pass(
    "A failed start shows its agent and its tab",
    // The first message of a new tab names it, so the tab is checked by its id and a name.
    failedRows.length === 2 &&
      failedRows.every((row) => row.topicId === tabId && row.topicName !== null && row.agentId !== null),
    failedRows.map((row) => [row.agentName, row.topicName]),
  );

  // 2. Root cause: a deleted routine took nothing with it, so its stopped work stayed for ever.
  agents.deleteChannelRoutine({ channelId: slop, routineId: gone.id });
  const afterDelete = current.control.listStopped();
  pass(
    "A deleted routine takes its stopped work with it",
    afterDelete.total === 55 &&
      !channels()
        .store.tasks(slop)
        .some((task) => task.requestMessageId === goneRun.requestMessageId && task.state !== "cancelled"),
    afterDelete.total,
  );

  // 3. Root cause: an open run of a routine was posted again at each start of the app. The receipt of
  // its request is pruned with the older channel events, so the run reads as never posted.
  const runs = agents.listChannelRoutineRuns({ channelId: slop, routineId: hourly.id });
  current.database.connection
    .prepare("UPDATE projection_channel_routine_runs SET status = 'queued' WHERE routine_id = ?")
    .run(hourly.id);
  const tasksBefore = channels().store.tasks(slop).length;
  await runCauseEffect(agents.stop());
  current.database.close();
  // The start resumes the open runs before it answers, and each request command applies before it
  // answers, so a replay has made its task when `start` returns.
  current = await start();
  const tasksAfter = current.agents.channels.store.tasks(slop);
  pass(
    "A start of the app does not post an open routine run again",
    tasksAfter.length === tasksBefore &&
      runs.every((run) => tasksAfter.filter((task) => task.requestMessageId === run.requestMessageId).length === 1),
    { before: tasksBefore, after: tasksAfter.length },
  );
  const control = current.control;
  const live = current.agents;

  // 4. A filter selects the routine rows, and a bulk remove removes them; an undo puts them back.
  const list = control.listStopped();
  const routineSelection = filterStoppedWork(list.items, { ...ALL, origin: "routine" });
  const removed = await control.bulkStopped({ action: "remove", items: items(routineSelection) });
  pass(
    "A bulk remove of the rows that a filter selects",
    removed.done === 3 && removed.failed.length === 0 && removed.list.total === 52 && removed.undoId !== null,
    { done: removed.done, total: removed.list.total },
  );
  const undone = await control.bulkStopped({ action: "undo", undoId: removed.undoId ?? "" });
  pass("An undo puts the removed rows back", undone.done === 3 && undone.list.total === 55, undone.list.total);

  // 5. A bulk reassign: the rows of the channel with no lead go to one member; a row of the other
  // channel, where that agent is not a member, fails with its reason, and the others go on.
  const outsider = await live
    .createAgent({
      name: "Outsider",
      description: "Not a member.",
      avatarSeed: "outsider",
      avatarHue: null,
      initialMessage: "Hello.",
    })
    .pipe(runCauseEffect);
  await live.channels
    .command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId: slop,
        draft: {
          name: "slop rotina",
          title: "",
          instructions: "",
          members: [{ agentId: leader.id }, { agentId: evals.id }, { agentId: outsider.id }],
          leadAgentId: null,
        },
      },
      PERSON,
    )
    .pipe(runCauseEffect);
  const fresh = control.listStopped();
  const someOfSlop = filterStoppedWork(fresh.items, { ...ALL, place: slop, origin: "request" }).slice(0, 5);
  const oneOfNaia = filterStoppedWork(fresh.items, { ...ALL, place: naia }).slice(0, 1);
  const reassigned = await control.bulkStopped({
    action: "reassign",
    recipientAgentId: outsider.id,
    items: items([...someOfSlop, ...oneOfNaia]),
  });
  pass(
    "A bulk reassign gives the rows to the agent and reports the row it cannot take",
    reassigned.done === 5 &&
      reassigned.failed.length === 1 &&
      reassigned.failed[0]?.reason === "not-member" &&
      someOfSlop.every(
        (row) => live.channels.store.tasks(slop).find((task) => task.id === row.taskId)?.ownerAgentId === outsider.id,
      ),
    reassigned.failed,
  );

  // 6. A bulk change of model: each agent that had a selected row changes once; rows with no agent fail.
  const naiaRows = filterStoppedWork(control.listStopped().items, { ...ALL, place: naia });
  const noAgentRows = filterStoppedWork(control.listStopped().items, { ...ALL, agent: "none" }).slice(0, 2);
  const changed = await control.bulkStopped({
    action: "model",
    provider: "codex",
    model: "gpt-6-sol",
    items: items([...naiaRows, ...noAgentRows]),
  });
  const models = live.listAgents().filter((agent) => agent.id === evals.id || agent.id === designer.id);
  pass(
    "A bulk change of model changes the agents of the rows and reports the rows with no agent",
    changed.done === naiaRows.length &&
      changed.failed.length === 2 &&
      changed.failed.every((row) => row.reason === "no-agent") &&
      models.length === 2 &&
      models.every((agent) => agent.model === "gpt-6-sol"),
    { done: changed.done, failed: changed.failed, models: models.map((agent) => agent.model), agents: changed.agents },
  );

  // 7. The stopped task of a deleted agent is marked, and a filter by orphan removes it in bulk.
  await runCauseEffect(live.deleteAgent(designer.id));
  const orphans = filterStoppedWork(control.listStopped().items, { ...ALL, orphan: "orphan" });
  pass(
    "The stopped task of a deleted agent is marked",
    orphans.some((row) => row.orphan === "agent-deleted"),
    orphans.map((row) => row.orphan),
  );
  const cleared = await control.bulkStopped({ action: "remove", items: items(orphans) });
  pass(
    "A bulk remove of the orphans",
    cleared.done === orphans.length && filterStoppedWork(cleared.list.items, { ...ALL, orphan: "orphan" }).length === 0,
    cleared.done,
  );

  // 8. A partial failure: rows that are not stopped any more fail, the others are done.
  const last = control.listStopped();
  const sample = last.items.slice(0, 3);
  const mixed = await control.bulkStopped({
    action: "resume",
    items: [...items(sample), { channelId: slop, taskId: "forged" }],
  });
  pass(
    "A bulk resume reports the row that is not stopped",
    mixed.done === 3 && mixed.failed.length === 1 && mixed.failed[0]?.reason === "gone",
    mixed.failed,
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (current) {
    await runCauseEffect(current.agents.stop()).catch(() => {});
    current.database.close();
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
