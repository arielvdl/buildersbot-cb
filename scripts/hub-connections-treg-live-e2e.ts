// Checks "treg live" end to end: the tool catalog of the Cultura Builder Hub works for the person's
// account. It runs the real Cultura Builder sign-in functions, the real agent service, tool router,
// approval cards and Hub client, a fake Codex app-server that calls the tools as a model does, and
// the fake Hub of scripts/fake-hub with a fake vendor behind it. Nothing reaches the network.
//
// (a) The sign-in uses the fixed public client of Builders Bot and never registers a new client, so
//     the Hub gives the refresh family that proxy tokens need.
// (b) The catalog's `platforms` reach the view of the Marketplace through main, the IPC contract and
//     the preload decoder: valid rows only, an unknown group as `other`. An account without the
//     capability gets no connection (and the app reads no catalog for it). The tiles that the Apps tab
//     makes of them, in their categories, are checked on the stories by
//     scripts/hub-connections-surfaces-e2e.ts: their modules import JSX components, which the Node
//     type project does not compile.
// (c) A cost approval happens on the Hub: Allow opens the Hub page of the confirmation (only that
//     URL), the app reads the status, and sends the call once after `approved`. `denied`, `expired`,
//     `used` and a Hub that refuses the call (`not_allowed`) send nothing more.
// (d) The consent action opens the fixed consent page of the Hub.
//
// `bun scripts/hub-connections-treg-live-e2e.ts`. Writes .buildersbot-build/hub-connections/treg-live.json.
// `HUB_E2E_KEEP_GOING=1` runs every step after a failure too, and fails at the end.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeHubConnectionCatalog, type HubJsonObject } from "@openbot/contracts/hub-connections";
import { type HubConnectionsView, IPC_ENDPOINTS, isHubConnectionsView } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { decodeHubConnectionsView } from "../src/preload/hub-connection-decoding";
import { type Call, type Seen, startAgentHarness, waitFor } from "./fake-hub/agent-harness";
import { FAKE_HUB_CLIENT_ID, fakeHubFetch, startFakeHub } from "./fake-hub/fake-hub";

const OUT = resolve(import.meta.dirname, "../.buildersbot-build/hub-connections");
const root = await mkdtemp(join(tmpdir(), "buildersbot-treg-live-"));
const MARK = "HUB-TREG-LIVE";
const HUB = "https://hub.culturabuilder.com";
const APPROVAL_PAGE = `${HUB}/builder-ai/conexoes/aprovar/`;
const CONSENT_PAGE = `${HUB}/builder-ai/conexoes`;

const report: { steps: Array<{ step: string; result: unknown }>; passed: boolean; error?: string } = {
  steps: [],
  passed: false,
};
const KEEP_GOING = process.env.HUB_E2E_KEEP_GOING === "1";
const failedSteps: string[] = [];

async function step(name: string, run: () => unknown): Promise<void> {
  try {
    report.steps.push({ step: name, result: (await run()) ?? "ok" });
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.steps.push({ step: name, result: { failed: message } });
    process.stdout.write(`not ok - ${name}\n  ${message.split("\n")[0]}\n`);
    failedSteps.push(name);
    if (!KEEP_GOING) throw new Error(`${name}: ${message}`);
  }
}

const hub = await startFakeHub();
let storedSession: string | null = null;
/** What the person answers on the next Hub cards (payer and cost), in order. The Guard's cards are allowed. */
const cardPlan: Array<"accept" | "decline"> = [];
const cards: Array<{ reason: string; decision: "accept" | "decline" }> = [];
const HUB_CARD = /^(?:An agent wants to run|Who pays for|Pay for)/u;
/** Every page of the Hub that the app opened in the browser, in order. */
const opened: string[] = [];
/** What the person does on the Hub page after the app opens it. */
let onHubPage: (url: string) => void = () => undefined;

const harness = await startAgentHarness({
  root,
  mark: MARK,
  hubFetch: fakeHubFetch(hub),
  session: () => storedSession,
  saveSession: (value) => {
    storedSession = value;
  },
  decide: (card) => {
    const decision = HUB_CARD.test(card.reason) ? (cardPlan.shift() ?? "decline") : "accept";
    if (HUB_CARD.test(card.reason)) cards.push({ reason: card.reason, decision });
    return decision;
  },
  openHub: async (url) => {
    opened.push(url);
    onHubPage(url);
  },
});
// After the harness: the service modules read the home folder that it set.
const auth = await import("../src/backend/cultura-builder-auth");
const { agents, turn, runCauseEffect } = harness;
const seenTexts: string[] = [];

const call = (endpointId: string, input: HubJsonObject): Call => ({
  tool: "openbot_connections.call",
  arguments: { connection: "tool-catalog", operation: "call", input: { endpointId, ...input } },
});
const hubCalls = () => hub.requests.filter((request) => request.path.endsWith("/tool-catalog/call"));
const statusReads = () => hub.requests.filter((request) => request.path.includes("/tool-catalog/confirmations/"));

async function run(calls: Call[], options: { routine?: boolean } = {}): Promise<Seen[]> {
  const seen = await turn(calls, options);
  for (const item of seen) seenTexts.push(item.text);
  return seen;
}

/** The view as the Marketplace gets it: through main, the IPC contract and the preload decoder. */
async function view(fresh: boolean): Promise<HubConnectionsView> {
  const value = await runCauseEffect(agents.hubConnectionsView(fresh));
  assert.ok(isHubConnectionsView(value), `the view breaks the contract: ${JSON.stringify(value).slice(0, 300)}`);
  return decodeHubConnectionsView(value);
}

/** The id of the confirmation in a Hub page URL. */
const confirmationOf = (url: string) => decodeURIComponent(url.slice(APPROVAL_PAGE.length));

/** On the Hub page: waits until the app read the status once, then does `decide` for the id. */
function personOnHub(decide: (id: string) => void): void {
  onHubPage = (url) => {
    const id = confirmationOf(url);
    // With no status read (a gateway that has the connections off), the person never decides.
    void waitFor("a status read of the confirmation", () => hub.confirmationReads.some((read) => read.id === id)).then(
      () => decide(id),
      () => undefined,
    );
  };
}

try {
  // --- (a) Sign-in ---------------------------------------------------------------------------------
  await step("sign-in: the device flow uses the fixed client id and never calls /register", async () => {
    const fetcher = fakeHubFetch(hub);
    const flow = await Effect.runPromise(auth.startCulturaBuilderSignIn(fetcher));
    assert.equal(
      hub.requests.filter((request) => request.path === "/api/mcp-oauth/register").length,
      0,
      "the sign-in registered a new OAuth client",
    );
    assert.equal(flow.clientId, FAKE_HUB_CLIENT_ID);
    const device = hub.requests.find((request) => request.path === "/api/mcp-oauth/device");
    assert.equal(new URLSearchParams(device?.body ?? "").get("client_id"), FAKE_HUB_CLIENT_ID);
    let session: { access: string; refresh: string; expires: number; empresa: string | null } | null = null;
    for (let attempt = 0; attempt < 3 && !session; attempt += 1) {
      const outcome = await Effect.runPromise(auth.pollCulturaBuilderToken(flow, fetcher));
      if (outcome.status === "ready") session = { ...outcome.session };
    }
    assert.ok(session, "the device code grant did not give a session");
    const grant = hub.requests.find(
      (request) =>
        request.path === "/api/mcp-oauth/token" &&
        new URLSearchParams(request.body).get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code",
    );
    assert.equal(new URLSearchParams(grant?.body ?? "").get("client_id"), FAKE_HUB_CLIENT_ID);
    // The Hub gives the refresh family only to its listed client: proxy tokens need it.
    assert.notEqual(session.refresh, "", "the session has no refresh token, so connections stay signed out");
    storedSession = auth.serializeCulturaBuilderSession({ ...session, empresa: "Empresa A" });
    return { clientId: flow.clientId, registerRequests: 0 };
  });

  await step("sign-in: the new session opens the connections (a proxy token reads the catalog)", async () => {
    const current = await view(true);
    assert.equal(current.status, "ready", JSON.stringify(current).slice(0, 300));
    const tokenRequest = hub.requests.find(
      (request) => request.path === "/api/mcp-oauth/token" && request.body.includes("scope=builder-proxy"),
    );
    assert.ok(tokenRequest, "no proxy token request");
    return { status: current.status };
  });

  // The later checks each need a session with a refresh token. When (a) failed, they get the one that
  // the Hub has for the person, so each check shows its own result.
  if (!auth.readCulturaBuilderSession(storedSession)?.refresh) {
    const live = hub.sessionOf("a");
    storedSession = JSON.stringify({ ...live, expires: Date.now() + 3_600_000, empresa: "Empresa A" });
  }

  // --- (b) Apps tab: one tile per platform ------------------------------------------------------
  await step("platforms: the contract decoder keeps valid rows and drops bad ones", () => {
    const platformsOf = (platforms: unknown) =>
      decodeHubConnectionCatalog({
        catalogVersion: "v",
        ttlSeconds: 60,
        connections: [{ id: "tool-catalog", name: "Catálogo", operations: [], access: [], platforms }],
      })?.connections[0]?.platforms;
    const good = { id: "google-ads", name: "Google Ads", group: "seo", endpoints: 4 };
    assert.deepEqual(
      platformsOf([
        good,
        { id: "web", name: "Web", group: "unknown-group", endpoints: 2 },
        { id: "Bad Id", name: "Bad", group: "seo", endpoints: 1 },
        { id: "markup", name: "<b>Markup</b>", group: "seo", endpoints: 1 },
        { id: "long", name: "x".repeat(61), group: "seo", endpoints: 1 },
        { id: "blank", name: "   ", group: "seo", endpoints: 1 },
        { id: "zero", name: "Zero", group: "seo", endpoints: 0 },
        { id: "half", name: "Half", group: "seo", endpoints: 1.5 },
        { id: "google-ads", name: "Twice", group: "seo", endpoints: 9 },
        "not an object",
      ]),
      [good, { id: "web", name: "Web", group: "other", endpoints: 2 }],
    );
    const many = Array.from({ length: 45 }, (_, index) => ({
      id: `p${index}`,
      name: `P ${index}`,
      group: "other",
      endpoints: 1,
    }));
    assert.equal(platformsOf(many)?.length, 40);
    assert.deepEqual(platformsOf(undefined), []);
    assert.deepEqual(platformsOf("text"), []);
    return { kept: 2, dropped: 8 };
  });

  await step("the view of the Marketplace carries each platform of the Hub, as the Apps tiles read them", async () => {
    const current = await view(true);
    assert.deepEqual(
      current.connections.map((connection) => connection.id),
      ["tool-catalog"],
    );
    const [connection] = current.connections;
    assert.ok(connection?.enabled, "the connection is not on");
    const platforms = hub.platforms();
    assert.ok(platforms.length >= 3, "the fake Hub has too few platforms for this check");
    assert.deepEqual(connection.platforms, platforms);
    return { platforms: platforms.map((platform) => `${platform.id} (${platform.group})`) };
  });

  await step("malformed platforms over the wire are dropped; valid ones stay", async () => {
    const derived = hub.platforms();
    hub.setPlatforms([
      ...derived,
      { id: "social-x", name: "Social X", group: "social", endpoints: 3 },
      { id: "new-kind", name: "New kind", group: "a-group-of-a-later-hub", endpoints: 2 },
      { id: "Bad Id", name: "Bad", group: "seo", endpoints: 1 },
      { id: "html", name: "<img src=x>", group: "seo", endpoints: 1 },
      { id: "none", name: "None", group: "seo", endpoints: 0 },
    ]);
    try {
      const current = await view(true);
      const platforms = current.connections[0]?.platforms ?? [];
      assert.deepEqual(platforms, [
        ...derived,
        { id: "social-x", name: "Social X", group: "social", endpoints: 3 },
        { id: "new-kind", name: "New kind", group: "other", endpoints: 2 },
      ]);
      assert.ok(!JSON.stringify(current).includes("<img"), "markup reached the view");
      return { platforms: platforms.length };
    } finally {
      hub.setPlatforms("derived");
    }
  });

  await step("every provider on: 120 platforms over the wire give the first 40, in the Hub's order", async () => {
    const groups = ["seo", "enrichment", "reviews", "market", "research", "developer", "community", "commerce"];
    const all = Array.from({ length: 120 }, (_, index) => ({
      id: `provider-${String(index).padStart(3, "0")}`,
      name: `Provider ${index}`,
      group: groups[index % groups.length] ?? "other",
      endpoints: 240 - index,
    }));
    hub.setPlatforms(all);
    try {
      const startedAt = Date.now();
      const current = await view(true);
      const ms = Date.now() - startedAt;
      const catalog = hub.requests.findLast((request) => request.path.endsWith("/proxy/v1/connections"));
      assert.equal(catalog?.status, 200);
      assert.deepEqual(current.connections[0]?.platforms, all.slice(0, 40));
      return { platformsSent: all.length, platformsKept: 40, viewMs: ms };
    } finally {
      hub.setPlatforms("derived");
    }
  });

  await step("an older Hub with no platforms: the connection with none, so no tile", async () => {
    hub.setPlatforms(null);
    try {
      const current = await view(true);
      assert.deepEqual(
        current.connections.map((connection) => [connection.id, connection.platforms]),
        [["tool-catalog", []]],
      );
    } finally {
      hub.setPlatforms("derived");
    }
  });

  await step("an account without the capability: no connection, so no row and no tile", async () => {
    hub.setCapabilities(false);
    try {
      const catalogReads = hub.requests.filter((request) => request.path.endsWith("/proxy/v1/connections")).length;
      const current = await view(true);
      assert.deepEqual(current, { status: "off", connections: [], readAt: null });
      assert.equal(
        hub.requests.filter((request) => request.path.endsWith("/proxy/v1/connections")).length,
        catalogReads,
        "the app read the catalog for an account without the capability",
      );
    } finally {
      // The app keeps `/session` for 5 minutes: read it again, so the next checks have the tools.
      hub.setCapabilities(true);
      assert.equal((await view(true)).status, "ready");
    }
  });

  // --- (c) Cost approval on the Hub -----------------------------------------------------------------
  await step(
    "confirm_cost: Allow opens exactly the Hub approval page; after approved, one call with the id",
    async () => {
      // The first card asks who pays (Empresa A), the second is the cost.
      cardPlan.push("accept", "accept");
      personOnHub((id) => hub.decideConfirmation(id, "approved"));
      const callsBefore = hubCalls().length;
      const vendorBefore = hub.treg.requests.length;
      const openedBefore = opened.length;
      const [done] = await run([call("market.quote-pro", { body: { symbol: "PETR4" } })]);
      assert.ok(done?.success, done?.text);
      assert.equal(done.fields.chargedMicros, 400_000);
      const id = hub.issuedConfirmations.at(-1);
      assert.ok(id);
      assert.deepEqual(opened.slice(openedBefore), [`${APPROVAL_PAGE}${encodeURIComponent(id)}`]);
      const card = cards.at(-1);
      assert.ok(card, "no cost card");
      assert.ok(card.reason.includes("Cultura Builder Hub"), `the card does not say where to approve: ${card.reason}`);
      assert.ok(!card.reason.includes(id), "the card shows the confirmation id");
      const sent = hubCalls()
        .slice(callsBefore)
        .map((request) => JSON.parse(request.body));
      assert.equal(sent.length, 2, "the app did not send the call exactly once after the approval");
      assert.equal(sent[0].confirmationId, undefined);
      assert.equal(sent[1].confirmationId, id);
      assert.equal(sent[1].maxCostMicros, 400_000);
      assert.equal(hub.treg.requests.length, vendorBefore + 1);
      // The status reads use the payer's proxy token, and the call comes after the read that said approved.
      const reads = hub.confirmationReads.filter((read) => read.id === id);
      assert.ok(reads.length >= 2, `${reads.length} status reads`);
      assert.deepEqual([...new Set(reads.map((read) => read.state))], ["pending", "approved"], JSON.stringify(reads));
      assert.ok(reads.every((read) => read.orgId === "org_a"));
      const requests = hub.requests;
      const lastRead = requests.findLastIndex((request) => request.path.endsWith(`/confirmations/${id}`));
      const confirmed = requests.findLastIndex((request) => request.path.endsWith("/tool-catalog/call"));
      assert.ok(lastRead >= 0 && confirmed > lastRead, "the call went before the read that said approved");
      assert.ok(requests[lastRead]?.headers.authorization?.startsWith("Bearer cbp_"));
      return { page: opened.at(-1)?.replace(id, "<id>"), reads: reads.length, card: card.reason };
    },
  );

  const refusedOnHub = async (label: string, decide: (id: string) => void, calls: number) => {
    cardPlan.push("accept");
    personOnHub(decide);
    const callsBefore = hubCalls().length;
    const vendorBefore = hub.treg.requests.length;
    const openedBefore = opened.length;
    const [refused] = await run([call("market.quote-pro", { body: { symbol: label } })]);
    assert.ok(refused && !refused.success, refused?.text);
    assert.equal(opened.length, openedBefore + 1, "the app did not open the Hub page");
    assert.equal(hubCalls().length, callsBefore + calls, "the app sent a call that the Hub did not approve");
    assert.equal(hub.treg.requests.length, vendorBefore, "the vendor got a call");
    return refused;
  };

  await step("confirm_cost: denied on the Hub sends nothing", async () => {
    const refused = await refusedOnHub("VALE3", (id) => hub.decideConfirmation(id, "denied"), 1);
    assert.equal(refused.fields.declined, true, refused.text);
    return { message: refused.fields.message };
  });

  await step("confirm_cost: expired on the Hub sends nothing", async () => {
    const refused = await refusedOnHub("ITUB4", (id) => hub.expireConfirmation(id), 1);
    assert.equal(refused.fields.expired, true, refused.text);
    return { message: refused.fields.message };
  });

  await step("confirm_cost: an id that the Hub says is used sends nothing", async () => {
    const refused = await refusedOnHub("BBDC4", (id) => hub.sayConfirmationState(id, "used"), 1);
    assert.equal(refused.fields.needsPerson, "confirm_cost", refused.text);
    return { message: refused.fields.message };
  });

  await step(
    "confirm_cost: a call that the Hub answers not_allowed/confirmation_not_approved is a refusal",
    async () => {
      // The status route says approved, but the Hub has no approval: the call is refused.
      const refused = await refusedOnHub("ABEV3", (id) => hub.sayConfirmationState(id, "approved"), 2);
      const last = JSON.parse(hubCalls().at(-1)?.body ?? "{}");
      assert.ok(last.confirmationId, "the app did not send the id after the approved read");
      assert.equal(refused.fields.needsPerson, "confirm_cost", refused.text);
      assert.ok(!String(refused.fields.message).includes("not_allowed"));
      return { message: refused.fields.message };
    },
  );

  await step("confirm_cost: the Hub's limit of status reads (429) waits, then one call after approved", async () => {
    hub.limitConfirmationReads(1, 1);
    cardPlan.push("accept");
    personOnHub((id) => hub.decideConfirmation(id, "approved"));
    const callsBefore = hubCalls().length;
    const readsBefore = statusReads().length;
    const [done] = await run([call("market.quote-pro", { body: { symbol: "PETR3" } })]);
    assert.ok(done?.success, done?.text);
    const reads = statusReads().slice(readsBefore);
    assert.equal(reads[0]?.status, 429, "the first status read was not limited");
    assert.ok(
      reads.slice(1).some((read) => read.status === 200),
      "the app did not read again after the limit",
    );
    assert.equal(hubCalls().length, callsBefore + 2, "the app did not send the call once after the approval");
    return { reads: reads.map((read) => read.status) };
  });

  await step("confirm_cost: a gateway with the connections off (plain-text 404) ends the wait", async () => {
    hub.setConfirmationRouteOff(true);
    try {
      const readsBefore = statusReads().length;
      const refused = await refusedOnHub("GGBR4", () => undefined, 1);
      assert.equal(refused.fields.needsPerson, "confirm_cost", refused.text);
      assert.equal(statusReads().length, readsBefore + 1, "the app read the status again after a plain 404");
      return { message: refused.fields.message };
    } finally {
      hub.setConfirmationRouteOff(false);
    }
  });

  await step("confirm_cost: Deny on the card opens no page and sends nothing more", async () => {
    cardPlan.push("decline");
    onHubPage = () => undefined;
    const callsBefore = hubCalls().length;
    const openedBefore = opened.length;
    const readsBefore = statusReads().length;
    const [refused] = await run([call("market.quote-pro", { body: { symbol: "WEGE3" } })]);
    assert.ok(refused && !refused.success);
    assert.equal(refused.fields.declined, true);
    assert.equal(opened.length, openedBefore);
    assert.equal(hubCalls().length, callsBefore + 1);
    assert.equal(statusReads().length, readsBefore);
  });

  await step("confirm_cost: a routine run gets a refusal, no card and no page", async () => {
    const cardsBefore = cards.length;
    const openedBefore = opened.length;
    const [refused] = await run([call("market.quote-pro", { body: { symbol: "RENT3" } })], { routine: true });
    assert.ok(refused && !refused.success);
    assert.equal(refused.fields.refused, true);
    assert.equal(cards.length, cardsBefore);
    assert.equal(opened.length, openedBefore);
  });

  await step("no confirmation id and no Hub page URL reach the agent", () => {
    const text = seenTexts.join("\n");
    for (const id of hub.issuedConfirmations) assert.ok(!text.includes(id), "a confirmation id reached the agent");
    assert.ok(!text.includes("/builder-ai/conexoes"), "a Hub page URL reached the agent");
    assert.ok(!/cbp_/u.test(text), "a proxy token reached the agent");
    return { confirmations: hub.issuedConfirmations.length };
  });

  // --- (d) Consent on the Hub ---------------------------------------------------------------------
  await step("consent: the page action opens the fixed consent page of the Hub", async () => {
    assert.equal(IPC_ENDPOINTS.hubConnections.openConsent.channel, "hub-connections:open-consent");
    const openedBefore = opened.length;
    await runCauseEffect(agents.openHubConsent());
    assert.deepEqual(opened.slice(openedBefore), [CONSENT_PAGE]);
  });

  report.passed = failedSteps.length === 0;
  if (failedSteps.length > 0) throw new Error(`Failed steps: ${failedSteps.join("; ")}`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "treg-live.json"), `${JSON.stringify(report, null, 2)}\n`);
  await harness.stop();
  await hub.close();
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} - ${join(OUT, "treg-live.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
