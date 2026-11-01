// Checks the surfaces of the Hub connections end to end, from main's side: the view that the
// Marketplace page reads, the person's own use for Usage › Connections, the payer that the person
// chooses, the requests to the admins ("Ask the admin" and "Ask the admin for more"), the cost lines
// that a paid call adds to the chat (the amount and who paid, the first call over 80 %, the call that
// the cap stopped), and the per-agent switch of the page. It runs the real agent service, tool router
// and Hub client with the fake Codex app-server and the fake Hub of scripts/fake-hub. Nothing reaches
// the network.
//
// Each value that main gives a window goes through the preload decoders and the contract decoders,
// and is searched for every secret that the fake Hub issued. The curation of the Apps list runs on the
// rows that the renderer builds from the view.
//
// `bun scripts/hub-connections-usage-e2e.ts`. Writes .buildersbot-build/hub-connections/usage.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HubJsonObject } from "@openbot/contracts/hub-connections";
import {
  type ConversationMessage,
  type HubConnectionChatEvent,
  type HubConnectionsView,
  hubConnectionChatEvent,
  isHubConnectionAccessRequestResult,
  isHubConnectionsView,
  isHubConnectionUsageView,
  parseHubConnectionAccessRequestInput,
  parseHubConnectionPayerInput,
} from "@openbot/contracts/ipc";
import { findSecretValue } from "@openbot/logging";
import { parseUpdateAgent } from "../src/main/ipc/agent-inputs";
import {
  decodeHubConnectionAccessRequestResult,
  decodeHubConnectionsView,
  decodeHubConnectionUsageView,
} from "../src/preload/hub-connection-decoding";
import { type Call, type Seen, startAgentHarness } from "./fake-hub/agent-harness";
import { fakeHubFetch, startFakeHub } from "./fake-hub/fake-hub";
import { FAKE_PROVIDER_KEY, FAKE_VENDOR_KEY } from "./fake-hub/fake-treg";

const OUT = resolve(import.meta.dirname, "../.buildersbot-build/hub-connections");
const root = await mkdtemp(join(tmpdir(), "buildersbot-hub-surfaces-"));
const MARK = "HUB-SURFACES";

const report: { steps: Array<{ step: string; result: unknown }>; passed: boolean; error?: string } = {
  steps: [],
  passed: false,
};

async function step(name: string, run: () => unknown): Promise<void> {
  try {
    report.steps.push({ step: name, result: (await run()) ?? "ok" });
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    report.steps.push({ step: name, result: { failed: error instanceof Error ? error.message : String(error) } });
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const hub = await startFakeHub();
let storedSession: string | null = null;
/** What the person answers on the next Hub cards, in order. Other cards (the Guard) are allowed. */
const cardPlan: Array<"accept" | "decline"> = [];
const HUB_CARD = /^(?:An agent wants to run|Who pays for|Pay for)/u;
const harness = await startAgentHarness({
  root,
  mark: MARK,
  hubFetch: fakeHubFetch(hub),
  session: () => storedSession,
  saveSession: (value) => {
    storedSession = value;
  },
  decide: (card) => (HUB_CARD.test(card.reason) ? (cardPlan.shift() ?? "decline") : "accept"),
});
const { agents, agentId, turn, runCauseEffect } = harness;

const call = (endpointId: string, input: HubJsonObject): Call => ({
  tool: "openbot_connections.call",
  arguments: { connection: "tool-catalog", operation: "call", input: { endpointId, ...input } },
});
const search = (query: string): Call => ({ tool: "tool_search", arguments: { query } });
const keywords = (...words: string[]) => call("seo.keyword-volume", { body: { keywords: words } });

/** Every secret that the fake Hub gave the app or the vendor. None may reach a window. */
function secrets(): string[] {
  return [
    hub.session.access,
    hub.session.refresh,
    FAKE_VENDOR_KEY,
    FAKE_PROVIDER_KEY,
    ...hub.issuedTokens,
    ...hub.issuedConfirmations,
  ];
}

/** A value that main gives a window: it carries no secret, no token prefix and no Hub URL. */
function assertClean(label: string, value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of secrets()) assert.ok(!text.includes(secret), `${label} carries a secret of the fake Hub`);
  assert.ok(!/cbp_|treg_|Bearer /u.test(text), `${label} carries a token prefix`);
  assert.ok(!text.includes("hub.culturabuilder.com"), `${label} carries a Hub URL`);
  assert.equal(findSecretValue(text), null, `${label} holds a value that the redaction knows as a secret`);
}

/** The view as the page gets it: through main, the preload decoder and the contract decoder. */
async function view(fresh = false): Promise<HubConnectionsView> {
  const value = await runCauseEffect(agents.hubConnectionsView(fresh));
  assert.ok(isHubConnectionsView(value), `the view breaks the contract: ${JSON.stringify(value).slice(0, 400)}`);
  assertClean("the connections view", value);
  return decodeHubConnectionsView(value);
}

async function usage() {
  const value = await runCauseEffect(agents.hubConnectionsUsage());
  assert.ok(isHubConnectionUsageView(value), `the usage breaks the contract: ${JSON.stringify(value).slice(0, 400)}`);
  assertClean("the usage view", value);
  return decodeHubConnectionUsageView(value);
}

async function request(orgId: string, kind: "access" | "more") {
  const value = await runCauseEffect(
    agents.requestHubConnectionAccess(
      parseHubConnectionAccessRequestInput({ connectionId: "tool-catalog", orgId, kind }),
    ),
  );
  assert.ok(isHubConnectionAccessRequestResult(value), JSON.stringify(value));
  assertClean("the request result", value);
  return decodeHubConnectionAccessRequestResult(value);
}

/** The cost lines of the chat, in order, as the screen reads them. */
async function costLines(): Promise<HubConnectionChatEvent[]> {
  const snapshot = await runCauseEffect(agents.readConversation(agentId));
  return snapshot.messages
    .map((message: ConversationMessage) => hubConnectionChatEvent(message))
    .filter((event): event is HubConnectionChatEvent => event !== null);
}

function hasTools(seen: Seen | undefined): boolean {
  return Boolean(seen?.text.includes("openbot_connections.call"));
}

try {
  await step("signed out: the view, the usage and a request say so, with no Hub request", async () => {
    const signedOut = await view();
    assert.deepEqual(signedOut, { status: "signed_out", connections: [], readAt: null });
    assert.deepEqual(await usage(), { status: "signed_out", orgs: [] });
    assert.deepEqual(await request("org_a", "more"), { status: "failed", requestedAt: null, failure: "signed_out" });
    assert.equal(hub.requests.length, 0, "the app called the Hub while signed out");
  });

  storedSession = JSON.stringify({
    access: hub.session.access,
    refresh: hub.session.refresh,
    expires: Date.now() + 3_600_000,
    empresa: "Empresa A",
  });

  await step("the page view: catalog, categories, price, data block and who pays", async () => {
    const current = await view();
    assert.equal(current.status, "ready");
    const [catalog] = current.connections;
    assert.ok(catalog && current.connections.length === 1);
    assert.equal(catalog.id, "tool-catalog");
    assert.equal(catalog.name, "Catálogo de ferramentas");
    assert.ok(catalog.description.startsWith("Dados externos pagos"));
    assert.deepEqual(catalog.dataPolicy, { vendor: "treg.to", region: "us", retentionDays: 0 });
    assert.equal(catalog.enabled, true);
    // Two organizations can pay and none was chosen: the person chooses.
    assert.equal(catalog.payer, "choose_org");
    assert.equal(catalog.payerOrgId, null);
    const rowA = catalog.access.find((row) => row.orgId === "org_a");
    assert.ok(rowA);
    assert.equal(rowA.orgName, "Empresa A");
    assert.deepEqual(rowA.categories, ["SEO e palavras-chave", "Dados de empresas", "Lojas de apps", "Avaliações"]);
    assert.equal(rowA.priceFromMicros, 5_000);
    assert.deepEqual(rowA.cap, { kind: "limited", amountMicros: 2_000_000 });
    assert.equal(rowA.confirmAboveMicros, 250_000);
    return { payer: catalog.payer, rows: catalog.access.length };
  });

  await step("a connection that is not on for the person: no payer, and the rows say why", async () => {
    const orgA = hub.orgs.get("org_a");
    const orgB = hub.orgs.get("org_b");
    assert.ok(orgA && orgB);
    orgA.orgState = "not_enabled";
    orgB.userState = "not_allowed";
    const locked = (await view(true)).connections[0];
    assert.ok(locked);
    assert.equal(locked.payer, "none");
    assert.equal(locked.payerOrgId, null);
    assert.deepEqual(
      locked.access.map((row) => [row.orgId, row.org, row.user]),
      [
        ["org_a", "not_enabled", "allowed"],
        ["org_b", "enabled", "not_allowed"],
      ],
    );
    orgA.orgState = "enabled";
    orgB.userState = "allowed";
  });

  await step(
    "Ask the admin: a request for access reaches the Hub once in 7 days, and the page shows its date",
    async () => {
      const orgB = hub.orgs.get("org_b");
      assert.ok(orgB);
      orgB.userState = "not_allowed";
      const first = await request("org_b", "access");
      assert.equal(first.status, "sent");
      assert.ok(first.requestedAt);
      const again = await request("org_b", "access");
      assert.equal(again.status, "already_sent");
      assert.equal(again.requestedAt, first.requestedAt);
      assert.deepEqual(
        hub.accessRequests.map(({ orgId, kind, repeated }) => ({ orgId, kind, repeated })),
        [
          { orgId: "org_b", kind: "access", repeated: false },
          { orgId: "org_b", kind: "access", repeated: true },
        ],
      );
      const row = (await view()).connections[0]?.access.find((access) => access.orgId === "org_b");
      assert.equal(row?.requestedAt, first.requestedAt, "the page does not show the request date");
      // Only an organization of the person's catalog, never the personal plan: nothing reaches the Hub.
      const before = hub.requests.length;
      assert.deepEqual(await request("org_zz", "access"), {
        status: "failed",
        requestedAt: null,
        failure: "unknown_org",
      });
      assert.deepEqual(await request("personal", "more"), {
        status: "failed",
        requestedAt: null,
        failure: "unknown_org",
      });
      assert.equal(hub.requests.length, before, "a request for an unknown organization reached the Hub");
      assert.throws(() =>
        parseHubConnectionAccessRequestInput({ connectionId: "tool-catalog", orgId: "org_b", kind: "all" }),
      );
      orgB.userState = "allowed";
      return { requestedAt: first.requestedAt };
    },
  );

  await step(
    "Who pays: the person's choice on the page sets the payer; an organization that cannot pay changes nothing",
    async () => {
      const chosen = await runCauseEffect(
        agents.chooseHubConnectionPayer(parseHubConnectionPayerInput({ connectionId: "tool-catalog", orgId: "org_a" })),
      );
      assert.ok(isHubConnectionsView(chosen));
      assert.equal(chosen.connections[0]?.payer, "pay");
      assert.equal(chosen.connections[0]?.payerOrgId, "org_a");
      const ignored = await runCauseEffect(
        agents.chooseHubConnectionPayer({ connectionId: "tool-catalog", orgId: "org_zz" }),
      );
      assert.equal(ignored.connections[0]?.payerOrgId, "org_a", "an unknown organization became the payer");
      assert.throws(() => parseHubConnectionPayerInput({ connectionId: "tool-catalog", orgId: "<script>" }));
      // The next call goes without a card: the person already chose.
      const [paid] = await turn([keywords("crm", "erp")]);
      assert.ok(paid?.success, paid?.text);
      assert.equal(hub.requests.filter((entry) => entry.path.endsWith("/call")).length, 1);
      return { payer: chosen.connections[0]?.payerOrgId };
    },
  );

  await step("chat: a paid call adds the line with the amount and who paid, as the agent got it", async () => {
    const lines = await costLines();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [line] = lines;
    assert.ok(line);
    assert.equal(line.kind, "paid");
    assert.equal(line.orgName, "Empresa A");
    assert.equal(line.orgId, "org_a");
    assert.equal(line.currency, "BRL");
    // 2 keywords at 10,000 micro-USD each, at 5 BRL per USD.
    assert.equal(line.amountMicros, 100_000);
    assert.equal(line.endpoint, "Keyword search volume");
    assert.equal(line.connectionName, "Catálogo de ferramentas");
    assertClean("the cost line", line);
    return line;
  });

  await step("usage: the person's own spend by platform, read again only after 30 seconds or a paid call", async () => {
    const before = hub.requests.filter((entry) => entry.path.endsWith("/usage")).length;
    const first = await usage();
    assert.equal(first.status, "ready");
    const orgA = first.orgs.find((org) => org.orgId === "org_a");
    assert.ok(orgA, JSON.stringify(first));
    assert.equal(orgA.orgName, "Empresa A");
    assert.equal(orgA.currency, "BRL");
    const [row] = orgA.connections;
    assert.ok(row);
    assert.equal(row.name, "Catálogo de ferramentas");
    assert.equal(row.settledMicros, 100_000);
    assert.equal(row.calls, 1);
    assert.deepEqual(row.cap, { kind: "limited", amountMicros: 2_000_000 });
    assert.deepEqual(row.platforms, [{ platform: "google-ads", settledMicros: 100_000, calls: 1 }]);
    await usage();
    const reads = hub.requests.filter((entry) => entry.path.endsWith("/usage")).length;
    assert.equal(reads, before + first.orgs.length, "a second read inside 30 seconds asked the Hub again");
    const [paid] = await turn([keywords("seo")]);
    assert.ok(paid?.success, paid?.text);
    const after = (await usage()).orgs.find((org) => org.orgId === "org_a")?.connections[0];
    assert.equal(after?.settledMicros, 150_000, "the usage did not follow the paid call");
    assert.equal(after?.calls, 2);
    return { orgs: first.orgs.length, platforms: row.platforms };
  });

  await step("80 %: the first call over the mark adds one notice line, and the next call adds none", async () => {
    const org = hub.orgs.get("org_a");
    assert.ok(org);
    // 150,000 settled; with a cap of 250,000 the next 50,000 call reaches 80 %.
    org.capMicros = 250_000;
    org.warned = false;
    const [crossed] = await turn([keywords("k1")]);
    assert.ok(crossed?.success, crossed?.text);
    const page = (await view(true)).connections[0]?.access.find((row) => row.orgId === "org_a");
    assert.equal(page?.state, "warning", "the page does not show the 80 % state");
    const [after] = await turn([keywords("k2")]);
    assert.ok(after?.success, after?.text);
    const warnings = (await costLines()).filter((line) => line.kind === "warning");
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    const [warning] = warnings;
    assert.ok(warning);
    assert.equal(warning.orgName, "Empresa A");
    assert.equal(warning.amountMicros, 50_000, "the notice does not say what is left");
    assert.equal(warning.resetsAt, "2026-11-01T03:00:00.000Z");
    return warning;
  });

  await step(
    "100 %: a call that the cap stopped adds one limit line per turn, and the page shows the cap",
    async () => {
      const vendorBefore = hub.treg.requests.length;
      const [over, again] = await turn([keywords("k3", "k4"), keywords("k5", "k6")]);
      assert.equal(over?.fields.needsPerson, "cap_reached", over?.text);
      assert.equal(again?.fields.needsPerson, "cap_reached", again?.text);
      assert.equal(hub.treg.requests.length, vendorBefore, "the vendor was called over the cap");
      const limits = (await costLines()).filter((line) => line.kind === "limit");
      assert.equal(limits.length, 1, `one limit line per turn: ${JSON.stringify(limits)}`);
      const [limit] = limits;
      assert.ok(limit);
      assert.equal(limit.scope, "user");
      assert.equal(limit.orgId, "org_a");
      assert.equal(limit.connectionId, "tool-catalog");
      assert.equal(limit.amountMicros, 0);
      const page = (await view(true)).connections[0]?.access.find((row) => row.orgId === "org_a");
      assert.equal(page?.state, "reached", "the page does not show the cap reached");
      return limit;
    },
  );

  await step("Ask the admin for more: from the limit line, once in 7 days, and the page shows the date", async () => {
    const first = await request("org_a", "more");
    assert.equal(first.status, "sent");
    const again = await request("org_a", "more");
    assert.equal(again.status, "already_sent");
    assert.equal(again.requestedAt, first.requestedAt);
    const sent = hub.accessRequests.filter((entry) => entry.orgId === "org_a" && entry.kind === "more");
    assert.deepEqual(
      sent.map((entry) => entry.repeated),
      [false, true],
    );
    const row = (await view()).connections[0]?.access.find((access) => access.orgId === "org_a");
    assert.equal(row?.moreRequestedAt, first.requestedAt);
    return { requestedAt: first.requestedAt };
  });

  await step("the per-agent switch: an agent with the connection off has no openbot_connections", async () => {
    // The page saves the switch through `agent.updateAgent`, as the IPC handler parses it.
    await runCauseEffect(agents.updateAgent(parseUpdateAgent({ agentId, connectionsOff: ["tool-catalog"] })));
    assert.deepEqual(agents.listAgents().find((agent) => agent.id === agentId)?.connectionsOff, ["tool-catalog"]);
    const [off] = await turn([search("paid data connections keyword")]);
    assert.equal(hasTools(off), false, "an agent that has the connection off finds openbot_connections");
    await runCauseEffect(agents.updateAgent(parseUpdateAgent({ agentId, connectionsOff: null })));
    const [on] = await turn([search("paid data connections keyword")]);
    assert.equal(hasTools(on), true, "the agent did not get the connection back");
    return { off: hasTools(off), on: hasTools(on) };
  });

  await step("the Hub decides: Usage › Connections is off until /session says connectionsUsage", async () => {
    hub.setConnectionsUsage(false);
    await view(true);
    assert.deepEqual(await usage(), { status: "off", orgs: [] });
    hub.setConnectionsUsage(true);
    await view(true);
    assert.equal((await usage()).status, "ready");
  });

  await step(
    "the kill switch and a Hub that does not answer: the page says so, and no agent has the tools",
    async () => {
      hub.setPaused(true);
      const paused = await view(true);
      assert.equal(paused.status, "ready");
      const [catalog] = paused.connections;
      assert.ok(catalog);
      assert.equal(catalog.enabled, false, "the page does not know that Cultura Builder paused the connection");
      assert.ok(catalog.access.every((row) => row.org === "paused"));
      // It has spend this month, so the curated list keeps it (scripts/hub-connections-surfaces-e2e.ts).
      assert.ok(catalog.access.some((row) => row.settledMicros > 0));
      const [found] = await turn([search("paid data connections keyword")]);
      assert.equal(hasTools(found), false, "an agent has the tools while the connection is paused");
      hub.setPaused(false);
      assert.equal((await view(true)).connections[0]?.enabled, true);
      hub.setDown("drop");
      assert.deepEqual(await view(true), { status: "unavailable", connections: [], readAt: null });
      hub.setDown(503);
      assert.equal((await view(true)).status, "unavailable");
      hub.setDown(null);
      assert.equal((await view(true)).status, "ready");
    },
  );

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.stderr.write(`not ok - ${report.error}\n`);
} finally {
  await harness.stop();
  await hub.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "usage.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${resolve(OUT, "usage.json")}\n`);
}
process.exit(report.passed ? 0 : 1);
