// Runs the real `opencode` provider driver and the real OpenCode binary with a global OpenCode config
// that names two local MCP servers: `playwright`, as the person's own file does, and `control`. Each
// server writes a marker file when it starts. Builders Bot turns `playwright` off on
// `OPENCODE_CONFIG_CONTENT`, so the `control` marker must appear and the `playwright` marker must not.
// OpenCode 2 drops an entry that has only `enabled`, and the server of the file then started in each
// `opencode serve` of the app.
//
// The shared browser broker reaches the agent over ACP `mcpServers` with the same name, `playwright`
// (`applyBrowserAccess`). The test hands over an http stand-in for the broker in that form, and the
// stand-in must get a request: a config entry that wins over the ACP server would take the browser
// from every OpenCode and Cultura Builder agent.
// `OPENCODE_CLI=<opencode> bun run test:opencode-own-playwright`.
// Writes .openbot-build/opencode-own-playwright/report.json.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { applyBrowserAccess, BROWSER_BROKER_MCP_SERVER_ID } from "../src/backend/agent/playwright-browser-access";
import type { AgentClient } from "../src/backend/agent-client";
import { resolveOpencodeCli } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { type CustomProviderConfig, openCodeConfigEnv } from "../src/backend/opencode-config";
import { getArray, getRecord, getString, isRecord } from "../src/backend/protocol";
import { requireProviderDriver } from "../src/backend/provider-drivers";
import { runTurn, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/opencode-own-playwright");
const ENDPOINT = "spark";
const MODEL = "agent-model";
/** How long the `control` server may take to start after the turn. */
const START_WAIT_MS = 60_000;
/** How long the broker stand-in may take to get its first request after the `control` server started. */
const BROKER_WAIT_MS = 30_000;

interface Report {
  passed: boolean;
  openCodeVersion?: string;
  /** The `mcp` block of the Builders Bot layer, as `opencode debug config` reads it. */
  layerMcp?: unknown;
  controlStarted?: boolean;
  playwrightStarted?: boolean;
  /** Requests that the broker stand-in, handed over ACP as `playwright`, got. */
  brokerRequests?: number;
  turn?: { reply: string; error: string | null; status: string | null };
  error?: string;
}

const report: Report = { passed: false };
const root = await mkdtemp(join(tmpdir(), "openbot-opencode-own-playwright-e2e-"));
const clients: AgentClient[] = [];
const run = promisify(execFile);

function chunk(content: string | null): string {
  const choice = content
    ? { index: 0, delta: { role: "assistant", content }, finish_reason: null }
    : { index: 0, delta: {}, finish_reason: "stop" };
  const value = { id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [choice] };
  return `data: ${JSON.stringify(value)}\n\n`;
}

/** An OpenAI-compatible endpoint that answers every chat request with one streamed word. */
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  void (async () => {
    for await (const _part of request) {
      // The request body is not needed.
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(chunk("done"));
    response.write(chunk(null));
    response.end("data: [DONE]\n\n");
  })().catch((error: unknown) => {
    response.writeHead(500);
    response.end(String(error));
  });
});

let brokerRequests = 0;
/**
 * Stands in for the shared browser broker. It counts each request and refuses it: the test needs only
 * the proof that OpenCode connected to the server that ACP handed over under the name `playwright`.
 */
const broker = createServer((request: IncomingMessage, response: ServerResponse) => {
  brokerRequests += 1;
  void (async () => {
    for await (const _part of request) {
      // The request body is not needed.
    }
    response.writeHead(500);
    response.end("broker stand-in");
  })().catch(() => response.destroy());
});

/** Waits until `check` is true, or until the deadline. */
async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((next) => setTimeout(next, 250));
  return check();
}

/** A free TCP port for OpenCode's managed service, so the test does not meet a running Builders Bot's. */
async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((listening) => probe.listen(0, "127.0.0.1", listening));
  const address = probe.address();
  await new Promise<void>((closed) => probe.close(() => closed()));
  if (!address || typeof address === "string") throw new Error("The port probe has no port.");
  return address.port;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Waits until `path` exists, or until the deadline. */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return true;
    await new Promise((next) => setTimeout(next, 250));
  }
  return exists(path);
}

/** A local MCP server command that writes `marker` and ends. */
function markerServer(marker: string): { type: "local"; command: string[]; enabled: true } {
  return {
    type: "local",
    command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv.at(-1), 'started')", marker],
    enabled: true,
  };
}

let cliPath: string | null = null;
try {
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake endpoint has no port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await new Promise<void>((listening) => broker.listen(0, "127.0.0.1", listening));
  const brokerAddress = broker.address();
  if (!brokerAddress || typeof brokerAddress === "string") throw new Error("The broker stand-in has no port.");
  // The entry that the gateway hands over for the Marketplace row of Playwright when the broker runs.
  const brokerServers = applyBrowserAccess(
    [
      {
        id: "playwright",
        name: "playwright",
        transport: "stdio",
        enabled: true,
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.83"],
        env: [],
        envPassthrough: [],
        workingDirectory: "",
        url: "",
        headers: [],
      },
    ],
    false,
    { url: `http://127.0.0.1:${brokerAddress.port}/mcp`, bearer: "e2e-bearer" },
  );
  assert.deepEqual(
    brokerServers.map((config) => [config.id, config.name, config.transport]),
    [[BROWSER_BROKER_MCP_SERVER_ID, "playwright", "http"]],
    "The broker must reach the agent as an http server named playwright.",
  );

  // OpenCode must not read the developer's own config, keys or sessions.
  for (const [name, folder] of [
    ["HOME", "home"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_DATA_HOME", "data"],
    ["XDG_STATE_HOME", "state"],
    ["XDG_CACHE_HOME", "cache"],
  ] as const) {
    process.env[name] = join(root, folder);
    await mkdir(join(root, folder), { recursive: true });
  }
  const playwrightMarker = join(root, "playwright-started");
  const controlMarker = join(root, "control-started");
  await mkdir(join(root, "config", "opencode"), { recursive: true });
  await writeFile(
    join(root, "config", "opencode", "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: { playwright: markerServer(playwrightMarker), control: markerServer(controlMarker) },
      },
      null,
      2,
    )}\n`,
  );
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const endpoint: CustomProviderConfig = {
    id: ENDPOINT,
    name: "Spark",
    baseUrl,
    apiKey: null,
    headers: [],
    models: [{ id: MODEL, name: "Agent model" }],
  };

  const cli = await runCauseEffect(resolveOpencodeCli({ bundledExecutable: process.env.OPENCODE_CLI }));
  report.openCodeVersion = cli.version;
  cliPath = cli.executable;
  await run(cli.executable, ["service", "set", "port", String(await freePort())], { env: process.env });

  // The layer as OpenCode reads it: a layer that OpenCode dropped reads as `{}`.
  const layer = openCodeConfigEnv({}, () => [endpoint], null);
  const debug = await run(cli.executable, ["debug", "config"], { cwd: workspace, env: { ...process.env, ...layer } });
  const documents = JSON.parse(debug.stdout.slice(debug.stdout.indexOf("[")));
  // The layer from `OPENCODE_CONFIG_CONTENT` is the only document without a path.
  const content = (Array.isArray(documents) ? documents : []).find(
    (document: unknown) => isRecord(document) && document.type === "document" && getString(document, "path") === null,
  );
  const layerMcp = getRecord(getRecord(content, "info"), "mcp");
  report.layerMcp = layerMcp;
  assert.equal(
    getRecord(getRecord(layerMcp, "servers"), "playwright")?.disabled,
    true,
    "OpenCode must read the playwright entry of the Builders Bot layer as disabled.",
  );

  const client = requireProviderDriver("opencode").createClient(cli, 60_000, {
    apiKey: () => null,
    customProviders: () => [endpoint],
    mcpServers: () => brokerServers,
    providerStateDirectory: join(root, "provider-state"),
  });
  clients.push(client);
  client.start();
  const listed = await runCauseEffect(client.request("model/list", {}, (value) => value));
  const models = getArray(listed, "data").flatMap((model) => getString(model, "model") ?? []);
  assert.ok(models.includes(`${ENDPOINT}/${MODEL}`), "OpenCode must list the agent's model.");

  const thread = await startThread(client, { cwd: workspace, model: `${ENDPOINT}/${MODEL}` });
  report.turn = await runTurn(client, thread, { text: "Say one word.", timeoutMs: 120_000 });

  // The two servers start together, so the control marker is the event that the start happened.
  report.controlStarted = await waitForFile(controlMarker, START_WAIT_MS);
  report.playwrightStarted = await exists(playwrightMarker);
  await waitUntil(() => brokerRequests > 0, BROKER_WAIT_MS);
  report.brokerRequests = brokerRequests;
  assert.equal(report.controlStarted, true, "The control server of the person's file must start.");
  assert.equal(report.playwrightStarted, false, "The playwright server of the person's file must not start.");
  assert.ok(
    brokerRequests > 0,
    "The broker that ACP hands over under the name playwright must get a request: the config entry must not replace it.",
  );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await stopClients(clients);
  if (cliPath) await run(cliPath, ["service", "stop"], { env: process.env }).catch(() => undefined);
  server.close();
  broker.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "failed"}: ${join(OUT, "report.json")}\n`);
}
