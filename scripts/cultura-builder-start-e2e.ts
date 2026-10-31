// Checks the Cultura Builder provider end to end on the real driver and `ProviderRuntime`, with a fake
// bundled Builders CLI and a fake Hub. The provider check that runs when the app opens, and each new
// check, starts the client as a turn does: an access token that expired is refreshed and saved before
// the spawn, so the row stays connected and the spawn carries the new token. Before, the check spawned
// with the expired token, the gateway refused it, and the row asked for a new sign-in although the
// refresh token was good. It also checks that a missing session, a refresh token that the Hub refuses,
// a token that the gateway refuses and an account without the LLM each give "sign-in required" with
// their own message, and never count toward the failed starts that stop the provider.
// `bun run test:cultura-builder-start`. Writes .openbot-build/cultura-builder-start-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import { AgentStore } from "../src/backend/agent-store";
import {
  CULTURA_BUILDER_GATEWAY,
  CULTURA_BUILDER_HUB,
  readCulturaBuilderSession,
  serializeCulturaBuilderSession,
} from "../src/backend/cultura-builder-auth";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { BuildersBotDatabase } from "../src/backend/openbot-database";
import { BUILT_IN_PROVIDER_DRIVERS, NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import { installFakeAgent, readJsonl } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/cultura-builder-start-e2e");
const TOKEN_URL = `${CULTURA_BUILDER_HUB}/api/mcp-oauth/token`;
const SESSION_URL = `${CULTURA_BUILDER_GATEWAY}/session`;
/** More checks than the limit of failed starts (3), so a counted failure would stop the provider. */
const CHECKS = 5;
const COMPANY = "Ariel Lab";

/** The access tokens of the fake Hub, by what the gateway answers to each. */
const ACCESS = {
  /** What the refresh gives. The gateway accepts it. */
  renewed: "access-renewed",
  /** The gateway refuses it, as it refuses a token that the Hub revoked. */
  refused: "access-refused",
  /** The gateway accepts it for an account that has no access to the LLM. */
  noLlm: "access-no-llm",
  /** It expired, so the gateway refuses it. */
  expired: "access-expired",
} as const;
const REFRESH_GOOD = "refresh-good";
const REFRESH_REVOKED = "refresh-revoked";

interface SpawnEntry {
  event: "spawn";
  token: string | null;
}

interface HubCall {
  url: string;
  grant: string | null;
  bearer: string | null;
}

interface Row {
  state: string | undefined;
  message: string | null | undefined;
  email: string | null | undefined;
}

interface Report {
  passed: boolean;
  expiredSession?: { row: Row; spawnTokens: (string | null)[]; storedAccess: string | null; refreshes: number };
  missingSession?: { checks: number; spawns: number; rows: Row[] };
  refusedRefresh?: { row: Row; spawns: number };
  refusedToken?: { checks: number; spawns: number; rows: Row[] };
  accountWithoutLlm?: { row: Row; spawns: number };
}

const root = await mkdtemp(join(tmpdir(), "openbot-cultura-builder-start-e2e-"));
const log = join(root, "builders.jsonl");
const report: Report = { passed: false };
const hubCalls: HubCall[] = [];
let stored: string | null = null;
process.env.FAKE_LOG = log;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The Hub and its gateway. A request to any other address fails, so the test never reaches the network. */
async function fakeHub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const form = init?.body instanceof URLSearchParams ? init.body : null;
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? null;
  hubCalls.push({ url, grant: form?.get("grant_type") ?? null, bearer });
  if (url === TOKEN_URL && form?.get("grant_type") === "refresh_token") {
    return form.get("refresh_token") === REFRESH_GOOD
      ? json(200, { access_token: ACCESS.renewed, refresh_token: `${REFRESH_GOOD}-2`, expires_in: 900 })
      : json(400, { error: "invalid_grant" });
  }
  if (url === SESSION_URL) {
    if (bearer === ACCESS.renewed) return json(200, { active: true, empresa: COMPANY });
    if (bearer === ACCESS.noLlm) return json(200, { active: false, empresa: COMPANY });
    return json(401, {});
  }
  throw new Error(`The test reached the network: ${url}`);
}

globalThis.fetch = Object.assign(fakeHub, { preconnect: () => undefined });

function runtime(executable: string): ProviderRuntime {
  const store = new AgentStore(
    join(root, "profile"),
    join(root, "home"),
    new BuildersBotDatabase(join(root, "profile")),
  );
  return new ProviderRuntime({
    offProviders: BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id).filter((id) => id !== "cultura-builder"),
    conversation: new ConversationRuntime(
      store,
      () => undefined,
      () => store.list(),
    ),
    hooks: {
      bindClient: () => undefined,
      onProvidersReady: () => Effect.void,
      onProviderLost: () => undefined,
      onClientStopped: () => Effect.void,
      isStopping: () => false,
      isProviderBusy: () => false,
      isAgentBusy: () => false,
      isProviderAssigned: () => true,
      onAgentClientLost: () => Effect.void,
      sharedRoot: () => join(root, "shared"),
      onProviderResumed: () => undefined,
      onProviderActivated: () => Effect.void,
      captureConfigRevision: () => 0,
    },
    emit: () => undefined,
    emitError: () => undefined,
    requestTimeoutMs: 10_000,
    preferredProvider: "cultura-builder",
    clientFactory: null,
    // Cultura Builder runs the bundled Builders CLI, which the runtime finds under `opencode`.
    bundledExecutables: { opencode: executable },
    credentials: {
      ...NO_PROVIDER_CREDENTIALS,
      apiKey: (provider) => (provider === "cultura-builder" ? stored : null),
      saveApiKey: (provider, value) =>
        Effect.sync(() => {
          if (provider === "cultura-builder") stored = value;
        }),
    },
    redactMcp: (text) => text,
  });
}

/** `dispose` hands the running clients to its caller, which stops them, as `AgentService` does. */
async function stopAll(providers: ProviderRuntime): Promise<void> {
  for (const client of await runCauseEffect(providers.dispose())) await runCauseEffect(client.stop());
}

function row(providers: ProviderRuntime): Row {
  const status = providers.status().providers?.find((candidate) => candidate.id === "cultura-builder");
  return { state: status?.state, message: status?.message, email: status?.email };
}

const spawns = async (): Promise<SpawnEntry[]> =>
  (await readJsonl<SpawnEntry>(log)).filter((entry) => entry.event === "spawn");

/** Starts each case with an empty log and no Hub calls. */
async function reset(session: string | null): Promise<void> {
  await rm(log, { force: true });
  hubCalls.length = 0;
  stored = session;
}

const session = (access: string, refresh: string, expires: number) =>
  serializeCulturaBuilderSession({ access, refresh, expires, empresa: COMPANY });

/** Runs the automatic check `CHECKS` times, as the renderer does after an error, and keeps each row. */
async function checkRepeatedly(providers: ProviderRuntime): Promise<Row[]> {
  const rows: Row[] = [];
  for (let check = 0; check < CHECKS; check += 1) {
    await runCauseEffect(providers.refreshProviders({ automatic: true }).pipe(Effect.ignore));
    rows.push(row(providers));
  }
  return rows;
}

try {
  const executable = join(root, "builders", "bin", "opencode");
  await mkdir(join(root, "profile"), { recursive: true });
  await installFakeAgent(executable, "cultura-builder");
  const loginRequired = sourceText("error.provider.culturaLoginRequired");

  // 1. The app opens with a session whose access token expired and whose refresh token is good. The
  // check refreshes and saves the token before the spawn, and the row is connected with no sign-in.
  await reset(session(ACCESS.expired, REFRESH_GOOD, Date.now() - 60_000));
  const opened = runtime(executable);
  await runCauseEffect(opened.start());
  const openedRow = row(opened);
  const spawnTokens = (await spawns()).map((entry) => entry.token);
  report.expiredSession = {
    row: openedRow,
    spawnTokens,
    storedAccess: readCulturaBuilderSession(stored)?.access ?? null,
    refreshes: hubCalls.filter((call) => call.grant === "refresh_token").length,
  };
  await stopAll(opened);
  assert.equal(openedRow.state, "available", "an expired access token with a good refresh token stays connected");
  assert.equal(openedRow.email, COMPANY);
  assert.deepEqual(spawnTokens, [ACCESS.renewed], "the spawn carries the refreshed token, not the expired one");
  assert.equal(report.expiredSession.storedAccess, ACCESS.renewed, "the refreshed token is saved before the spawn");
  assert.equal(report.expiredSession.refreshes, 1);

  // 2. No session: each check asks for a sign-in, starts no process, and counts no failure.
  await reset(null);
  const signedOut = runtime(executable);
  const signedOutRows = await checkRepeatedly(signedOut);
  report.missingSession = { checks: CHECKS, spawns: (await spawns()).length, rows: signedOutRows };
  await stopAll(signedOut);
  for (const checked of signedOutRows) {
    assert.equal(checked.state, "sign-in-required", "a missing session is a sign-in to do");
    assert.equal(checked.message, loginRequired, "and not the message of a provider that stopped");
  }
  assert.equal(report.missingSession.spawns, 0, "a missing session starts no process");

  // 3. The Hub refuses the refresh token: the session ended, so the row asks for a new sign-in.
  await reset(session(ACCESS.expired, REFRESH_REVOKED, Date.now() - 60_000));
  const revoked = runtime(executable);
  await runCauseEffect(revoked.refreshProviders({ automatic: false }).pipe(Effect.ignore));
  report.refusedRefresh = { row: row(revoked), spawns: (await spawns()).length };
  await stopAll(revoked);
  assert.equal(report.refusedRefresh.row.state, "sign-in-required");
  assert.equal(report.refusedRefresh.row.message, sourceText("error.provider.culturaSessionExpired"));
  assert.equal(report.refusedRefresh.spawns, 0);

  // 4. The gateway refuses a token that has not expired: the authenticate hook of the ACP client fails
  // with a sign-in error. Each check starts the process, gives "sign-in required", and counts nothing.
  await reset(session(ACCESS.refused, REFRESH_GOOD, Date.now() + 600_000));
  const refused = runtime(executable);
  const refusedRows = await checkRepeatedly(refused);
  report.refusedToken = { checks: CHECKS, spawns: (await spawns()).length, rows: refusedRows };
  await stopAll(refused);
  for (const checked of refusedRows) {
    assert.equal(checked.state, "sign-in-required", "a refused token is a sign-in to do");
    assert.equal(checked.message, loginRequired);
  }
  assert.equal(report.refusedToken.spawns, CHECKS, "a sign-in error does not stop the provider");

  // 5. An account without the LLM: the row says so, and asks for a sign-in with another account.
  await reset(session(ACCESS.noLlm, REFRESH_GOOD, Date.now() + 600_000));
  const noLlm = runtime(executable);
  await runCauseEffect(noLlm.refreshProviders({ automatic: false }).pipe(Effect.ignore));
  report.accountWithoutLlm = { row: row(noLlm), spawns: (await spawns()).length };
  await stopAll(noLlm);
  assert.equal(report.accountWithoutLlm.row.state, "sign-in-required");
  assert.equal(report.accountWithoutLlm.row.message, sourceText("error.provider.culturaNoAccess"));

  report.passed = true;
} finally {
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
