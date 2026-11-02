// E2E of the agents in the person's Chrome (DESIGN §13.3, Phase 3): stand-in agents call the
// `openbot_chrome` tools of the real `ChromeTabsHost`, which drives the real engine over the real
// `ChromeBridgeService`, the real signed native host and the real Builders Bot extension, in a pinned
// Chrome for Testing with a new profile that the script makes and deletes. It never starts, reads or
// changes the person's own Chrome, its profile or its folders: the Native Messaging manifest goes into
// the test profile only.
//
// Cases: pairing by the words (a real click in the welcome page and a choice in the app); a local test
// site opened by an agent, in a tab group named after its project, without focus; two conversations of
// different projects in two groups; the same tab in the next turn; the result format of each tool
// against the Builders Bot browser's; the limits (4 for an agent, 12 in all); the site floor; the gates
// (turn origin, also along a chain that a routine or a webhook started; scripts; a message send, also
// the ways around its card; a sensitive site's consent); and the messages that cross the bridge.
//
//   bun scripts/chrome-agents-e2e.ts [--headed] [--only <text in a case name>]
//
// Run it under the heavy-command mutex. It refuses to start with swap above 9 GB or free memory below
// 20 %. Writes .buildersbot-build/chrome-agents-e2e/report.json.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { PairingCode } from "@openbot/contracts/chrome-bridge/channel";
import { EXTENSION_IDS } from "@openbot/contracts/chrome-bridge/extension-ids";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { Effect, ManagedRuntime } from "effect";
import { BROWSER_TOOL_DEFINITIONS } from "../src/backend/browser-tools";
import type { MessageSendCard } from "../src/backend/chrome-message-send";
import {
  ChromeBridgeCallError,
  type ChromeBridgePort,
  type ChromeCallContext,
  type ChromeProject,
  ChromeTabsHost,
  type SiteAccessCard,
} from "../src/backend/chrome-tabs-host";
import { CHROME_DYNAMIC_TOOLS, OPENBOT_CHROME_NAMESPACE } from "../src/backend/chrome-tools";
import { CHROME_TURN_ORIGINS, chromeTurnOrigin } from "../src/backend/chrome-turn-origin";
import {
  CONNECTION_ORIGINS,
  type HubDeliveryOrigin,
  type HubTurnOrigin,
  hubConnectionOrigin,
  hubTurnOrigin,
  routineOriginOf,
  sentOrigin,
} from "../src/backend/hub-connections/turn-origin";
import type { DynamicToolResult } from "../src/backend/protocol";
import { bridgeSocket } from "../src/main/chrome-bridge/bridge-paths";
import { loadPeerChecker } from "../src/main/chrome-bridge/bridge-peer";
import type { KeySealer } from "../src/main/chrome-bridge/bridge-state";
import {
  ChromeBridgeService,
  type ChromeBridgeShape,
  type ConnectedBrowser,
} from "../src/main/chrome-bridge/chrome-bridge-service";
import type { PairingPrompt, PairingRequest } from "../src/main/chrome-bridge/host-connection";
import { buildChromeExtension } from "./build-chrome-extension";
import { buildChromeHost, codeHash } from "./build-chrome-host";
import { buildChromePeer } from "./build-chrome-peer";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".buildersbot-build/chrome-agents-e2e");
const CFT = {
  version: "156.0.8078.80",
  platform: "mac-arm64",
  sha256: "8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1",
};
const CFT_BINARY = join(
  ROOT,
  ".buildersbot-build/chrome-extension/cft",
  CFT.version,
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const MAX_SWAP_MB = 9 * 1024;
const MIN_FREE_PERCENT = 20;
const EXTENSION_ID = EXTENSION_IDS.e2e ?? "";

const argv = process.argv.slice(2);
const headed = argv.includes("--headed");
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex === -1 ? undefined : argv[onlyIndex + 1];

// ---------------------------------------------------------------------------------------------------
// Report

interface CaseResult {
  name: string;
  ok: boolean;
  ms: number;
  evidence: unknown;
  error?: string;
}

interface Report {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  headed: boolean;
  cft: typeof CFT;
  machine: DynamicRecord;
  cases: CaseResult[];
  bridge: DynamicRecord;
  notCovered: string[];
}

const report: Report = {
  startedAt: new Date().toISOString(),
  finishedAt: "",
  ok: false,
  headed,
  cft: CFT,
  machine: {},
  cases: [],
  bridge: {},
  notCovered: [],
};

async function writeReport(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

class Failed extends Error {}
function expect(condition: boolean, message: string, detail?: unknown): asserts condition {
  if (!condition)
    throw new Failed(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 1500)}`}`);
}

async function testCase(name: string, run: () => Promise<unknown>): Promise<boolean> {
  if (only !== undefined && !name.startsWith("pairing") && !name.includes(only)) return true;
  const started = performance.now();
  try {
    const evidence = await run();
    report.cases.push({ name, ok: true, ms: Math.round(performance.now() - started), evidence });
    process.stdout.write(`PASS ${name}\n`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.cases.push({
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      evidence: { lastBridgeRequests: lastRequests() },
      error: message,
    });
    process.stdout.write(`FAIL ${name}: ${message}\n`);
    return false;
  } finally {
    await writeReport();
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The last bridge requests of the run; `main` sets it. */
let lastRequests: () => string[] = () => [];

function swapMb(): number {
  const text = execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" });
  return Number(/used = ([\d.]+)M/u.exec(text)?.[1] ?? Number.POSITIVE_INFINITY);
}

function freePercent(): number {
  const text = execFileSync("memory_pressure", [], { encoding: "utf8" });
  return Number(/free percentage: (\d+)%/u.exec(text)?.[1] ?? 0);
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Failed(`${what} did not happen in ${ms} ms`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------------
// A small CDP client over --remote-debugging-pipe, for the test's own reads of Chrome. It attaches only
// to the pages it reads (the welcome page and one extension page), never to an agent tab.

class Cdp {
  readonly #write: Writable;
  #next = 1;
  readonly #pending = new Map<number, { resolve: (value: DynamicRecord) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Set<(method: string, params: DynamicRecord) => void>();

  constructor(write: Writable, read: Readable) {
    this.#write = write;
    let buffer = "";
    read.setEncoding("utf8");
    read.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\0"); end !== -1; end = buffer.indexOf("\0")) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        this.#dispatch(JSON.parse(raw));
      }
    });
  }

  #dispatch(message: unknown): void {
    if (!isDynamicRecord(message)) return;
    if (isNumber(message.id)) {
      const waiter = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (isDynamicRecord(message.error)) waiter?.reject(new Error(String(message.error.message)));
      else waiter?.resolve(isDynamicRecord(message.result) ? message.result : {});
    } else if (isString(message.method)) {
      for (const listener of this.#listeners)
        listener(message.method, isDynamicRecord(message.params) ? message.params : {});
    }
  }

  send(method: string, params: DynamicRecord = {}, sessionId?: string): Promise<DynamicRecord> {
    const id = this.#next;
    this.#next += 1;
    const message = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} got no answer`));
      }, 30_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#write.write(`${JSON.stringify(message)}\0`);
    });
  }

  on(listener: (method: string, params: DynamicRecord) => void): void {
    this.#listeners.add(listener);
  }
}

// ---------------------------------------------------------------------------------------------------
// The app's parts: a key store stand-in, and the person at the app's pairing card

function testSealer(): KeySealer {
  const key = randomBytes(32);
  return {
    seal: (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, body, cipher.getAuthTag()]);
    },
    open: (sealed) => {
      const data = Buffer.from(sealed);
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]);
    },
  };
}

/** The person at the app's card: the test gives the words that Chrome shows, and the card is tapped. */
class TestPrompt implements PairingPrompt {
  request: PairingRequest | null = null;
  #answer: ((index: number | null) => void) | null = null;
  ask(request: PairingRequest): Promise<number | null> {
    this.request = request;
    return new Promise((resolve) => {
      this.#answer = resolve;
    });
  }
  choose(chromeWords: string): number {
    const options = this.request?.options ?? [];
    const index = options.findIndex((option: PairingCode) => option.join(" · ") === chromeWords);
    this.#answer?.(index === -1 ? null : index);
    return index;
  }
}

// ---------------------------------------------------------------------------------------------------
// The run

interface Agent {
  readonly id: string;
  readonly name: string;
  readonly thread: string;
  turn: string;
}

function textOf(result: DynamicToolResult): string {
  const item = result.contentItems.find((entry) => entry.type === "inputText");
  return item && item.type === "inputText" ? item.text : "";
}

function recordOr(value: unknown): DynamicRecord {
  return isDynamicRecord(value) ? value : {};
}

function jsonOf(result: DynamicToolResult): DynamicRecord {
  try {
    return recordOr(JSON.parse(textOf(result)));
  } catch {
    return {};
  }
}

/** The CDP methods that a bridge request carries, for the evidence of a failed case. */
function methodsOf(body: unknown): string {
  if (!isDynamicRecord(body)) return "";
  if (isString(body.method)) return body.method;
  if (!Array.isArray(body.commands)) return "";
  return body.commands.map((command) => (isDynamicRecord(command) ? String(command.method) : "?")).join(",");
}

/** The errors of the commands of a `cdp.batch` answer. */
function batchErrors(answer: unknown): string[] {
  if (!isDynamicRecord(answer) || !Array.isArray(answer.results)) return [];
  return answer.results
    .map((entry) => (isDynamicRecord(entry) && isDynamicRecord(entry.err) ? String(entry.err.message) : ""))
    .filter(Boolean);
}

async function main(): Promise<void> {
  const start = { swapMb: Math.round(swapMb()), freePercent: freePercent() };
  report.machine = { ...start };
  if (start.swapMb > MAX_SWAP_MB || start.freePercent < MIN_FREE_PERCENT) {
    report.notCovered.push(
      `everything: swap ${start.swapMb} MB or free memory ${start.freePercent}% is past the limit`,
    );
    await writeReport();
    process.stdout.write("Refused to start: swap above 9 GB or free memory below 20%.\n");
    process.exit(2);
  }
  expect(EXTENSION_ID !== "", "contracts have no E2E extension id");
  expect(existsSync(CFT_BINARY), "the pinned Chrome for Testing is missing; run scripts/chrome-extension-e2e.ts once");
  await stat(CFT_BINARY);

  // The real parts: the extension, the signed host (it accepts only this process as the app), the addon.
  const extensionDir = await buildChromeExtension("e2e", join(OUT, "extension"));
  const host = buildChromeHost({ channel: "e2e", appRequirement: `cdhash H"${codeHash(process.execPath)}"` });
  const peer = buildChromePeer();
  const socket = bridgeSocket("e2e");
  rmSync(socket.folder, { recursive: true, force: true });

  const work = await mkdtemp(join(tmpdir(), "bb-chrome-agents-"));
  await chmod(work, 0o700);
  const profile = join(work, "profile");
  if (profile.startsWith(join(homedir(), "Library/Application Support")))
    throw new Error("The test profile must be a new temporary folder.");
  await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
  await mkdir(join(work, "app-state"), { recursive: true, mode: 0o700 });

  // Local pages on 127.0.0.1. Test hosts and a bank of the floor resolve to it inside the test Chrome only.
  const hits: { host: string; path: string; method: string }[] = [];
  const sent: { to: string; text: string }[] = [];
  const html = (title: string, body: string) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`,
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      hits.push({ host: request.headers.get("host") ?? "", path: url.pathname, method: request.method });
      switch (url.pathname) {
        case "/alpha":
          return html("Alpha", `<h1>Alpha page</h1><a href="/second">Second page</a>`);
        case "/second":
          return html("Second", `<h1>Second page</h1><p>Arrived</p>`);
        case "/form":
          return html(
            "Form",
            `<label>Name <input id="name" name="name"></label>
             <label>City <input id="city" name="city"></label>
             <label>Size <select id="size"><option value="s">Small</option><option value="l">Large</option></select></label>
             <label><input type="checkbox" id="agree"> Agree</label>
             <button id="show" onclick="document.getElementById('out').textContent='Hello ' + document.getElementById('name').value">Show</button>
             <button id="ask" onclick="document.getElementById('out').textContent = confirm('Proceed?') ? 'confirmed' : 'cancelled'">Ask</button>
             <p id="out"></p>
             <div style="height:2000px"></div><p>Bottom</p>`,
          );
        case "/compose":
          return html(
            "Compose",
            `<label>To <input aria-label="To" id="to"></label>
             <label>Message <textarea aria-label="Message" id="body"></textarea></label>
             <button id="send" onclick="fetch('/sent', { method: 'POST', body: JSON.stringify({ to: document.getElementById('to').value, text: document.getElementById('body').value }) }).then(() => { document.getElementById('state').textContent = 'Sent' })">Send</button>
             <button id="icon" onclick="fetch('/sent', { method: 'POST', body: JSON.stringify({ to: document.getElementById('to').value, text: document.getElementById('body').value }) })"><svg width="12" height="12"><rect width="12" height="12"></rect></svg></button>
             <p id="state"></p>`,
          );
        case "/compose2":
          // Other ways to send: a button named by a symbol, a button in French, Alt+S (as Outlook sends),
          // and a "Save draft" button that the page itself turns into "Send draft" after a while.
          return html(
            "Compose",
            `<label>To <input aria-label="To" id="to"></label>
             <label>Message <textarea aria-label="Message" id="body"></textarea></label>
             <button id="arrow" aria-label="➤" onclick="post()">➤</button>
             <button id="fr" onclick="post()">Envoyer</button>
             <span id="swap"><button>Save draft</button></span>
             <script>
               function post() { fetch('/sent', { method: 'POST', body: JSON.stringify({ to: document.getElementById('to').value, text: document.getElementById('body').value }) }); }
               document.addEventListener('keydown', (event) => { if (event.altKey && event.code === 'KeyS') post(); });
               setTimeout(() => { document.getElementById('swap').innerHTML = '<button onclick="post()">Send draft</button>'; }, 3000);
             </script>`,
          );
        case "/compose3":
          // Send buttons that a list of send words misses: other languages, a name that is not the visible
          // text, a shadow root and a frame; and actions that do not send (Cancel, Bold).
          return html(
            "Compose",
            `<label>To <input aria-label="To" id="to"></label>
             <label>Message <textarea aria-label="Message" id="body"></textarea></label>
             <button onclick="post()">送信</button>
             <button onclick="post()">Отправить</button>
             <button onclick="post()">إرسال</button>
             <button onclick="post()">भेजें</button>
             <button aria-label="Archive" onclick="post()">Send</button>
             <button id="cancel">Cancel</button>
             <button id="bold">Bold</button>
             <div id="host"></div>
             <iframe src="/send-frame" style="height:60px"></iframe>
             <script>
               function post() { fetch('/sent', { method: 'POST', body: JSON.stringify({ to: document.getElementById('to').value, text: document.getElementById('body').value }) }); }
               const root = document.getElementById('host').attachShadow({ mode: 'open' });
               root.innerHTML = '<button>Enviar agora</button>';
               root.querySelector('button').onclick = post;
             </script>`,
          );
        case "/send-frame":
          return html(
            "Frame",
            `<button onclick="fetch('/sent', { method: 'POST', body: JSON.stringify({ to: 'frame', text: 'frame' }) })">Enviar mensagem</button>`,
          );
        case "/to-bank":
          return new Response(null, {
            status: 302,
            headers: { location: `http://www.itau.com.br:${port}/after-redirect` },
          });
        case "/sent": {
          const body = recordOr(await request.json().catch(() => null));
          if (isString(body.to) && isString(body.text)) sent.push({ to: body.to, text: body.text });
          return new Response("ok");
        }
        default:
          return html("Page", `<p>${url.pathname}</p>`);
      }
    },
  });
  port = server.port ?? 0;
  const site = (host: string, path: string) => `http://${host}:${port}${path}`;
  const bankHits = () => hits.filter((hit) => hit.host.includes("itau.com.br")).length;

  // The app end of the bridge, as `application-services.ts` builds it.
  const prompt = new TestPrompt();
  let tabsHost: ChromeTabsHost | null = null;
  const connected: ConnectedBrowser[] = [];
  const runtime = ManagedRuntime.make(
    ChromeBridgeService.layer({
      channel: "e2e",
      stateFolder: join(work, "app-state"),
      sealer: testSealer(),
      // The host must be the signed one, and Chrome for Testing must have started it.
      peerChecker: loadPeerChecker(peer.addon, `cdhash H"${host.cdhash}"`, `cdhash H"${codeHash(CFT_BINARY)}"`),
      prompt,
      appVersion: host.version,
      nativeHost: {
        folder: join(profile, "NativeMessagingHosts"),
        hostPath: host.binary,
        extensionId: EXTENSION_ID,
        packaged: false,
        allowRealBrowser: false,
        inApplications: () => true,
      },
      onReady: (browser) => connected.push(browser),
      onEvent: (installId, event, body) => tabsHost?.receiveEvent(installId, event, body),
    }),
  );
  const bridge: ChromeBridgeShape = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ChromeBridgeService;
    }),
  );
  const requests = new Map<string, number>();
  /** The last bridge requests, for the evidence of a failed case: operation, CDP methods and outcome. */
  const recent: string[] = [];
  const note = (line: string) => {
    recent.push(line);
    if (recent.length > 120) recent.splice(0, recent.length - 120);
  };
  lastRequests = () => recent.slice(-40);
  // The same binding as `application-services.ts`, with a count of the requests by operation.
  const bridgePort: ChromeBridgePort = {
    connected: () => Effect.runSync(bridge.connected),
    request: (installId, op, body, options) => {
      requests.set(op, (requests.get(op) ?? 0) + 1);
      const methods = methodsOf(body);
      return bridge.request(installId, op, body, options).pipe(
        Effect.tap((answer) =>
          Effect.sync(() => {
            const errors = op === "cdp.batch" ? batchErrors(answer) : [];
            note(
              `${op} ${methods.slice(0, 200)} ok${errors.length > 0 ? ` errors: ${errors.join(" | ").slice(0, 400)}` : ""}`,
            );
          }),
        ),
        Effect.mapError((failure) => {
          note(`${op} ${methods.slice(0, 200)} ${failure.code}: ${failure.message.slice(0, 300)}`);
          return new ChromeBridgeCallError({ code: failure.code, message: failure.message });
        }),
      );
    },
  };
  await runtime.runPromise(bridge.connectChrome);

  const chromeArgs = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--process-per-site",
    "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,MediaRouter,OptimizationHints",
    "--host-resolver-rules=MAP alpha.test 127.0.0.1, MAP beta.test 127.0.0.1, MAP webmail.test 127.0.0.1, MAP router.local 127.0.0.1, MAP itau.com.br 127.0.0.1, MAP *.itau.com.br 127.0.0.1",
    ...(headed ? [] : ["--headless=new"]),
    "about:blank",
  ];
  const chrome: ChildProcess = spawn(CFT_BINARY, chromeArgs, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cleanup = () => {
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    server.stop(true);
    rmSync(work, { recursive: true, force: true });
    rmSync(socket.folder, { recursive: true, force: true });
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  const [, , , pipeIn, pipeOut] = chrome.stdio;
  if (!pipeIn || !pipeOut || !("write" in pipeIn) || !("setEncoding" in pipeOut)) throw new Error("Chrome has no pipe");
  const cdp = new Cdp(pipeIn, pipeOut);
  const targets = new Map<string, { type: string; url: string }>();
  cdp.on((method, params) => {
    const info = isDynamicRecord(params.targetInfo) ? params.targetInfo : null;
    if ((method === "Target.targetCreated" || method === "Target.targetInfoChanged") && info)
      if (isString(info.targetId) && isString(info.type) && isString(info.url))
        targets.set(info.targetId, { type: info.type, url: info.url });
    if (method === "Target.targetDestroyed" && isString(params.targetId)) targets.delete(params.targetId);
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const extensionUrl = `chrome-extension://${EXTENSION_ID}/`;
  const attach = async (targetId: string) => {
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    if (!isString(attached.sessionId)) throw new Error("no session");
    return attached.sessionId;
  };
  const evaluate = async (sessionId: string, expression: string): Promise<DynamicRecord> => {
    const answer = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (answer.exceptionDetails !== undefined)
      throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails).slice(0, 300)}`);
    const value = isDynamicRecord(answer.result) ? answer.result.value : undefined;
    return isDynamicRecord(value) ? value : {};
  };

  // The agents, their projects and the person at the app.
  const agents = {
    ana: { id: "agent-ana", name: "Ana Souza", thread: "thread-ana", turn: "turn-1" },
    bruno: { id: "agent-bruno", name: "Bruno Lima", thread: "thread-bruno", turn: "turn-1" },
    carla: { id: "agent-carla", name: "Carla Dias", thread: "thread-carla", turn: "turn-1" },
    davi: { id: "agent-davi", name: "Davi Reis", thread: "thread-davi", turn: "turn-1" },
    eva: { id: "agent-eva", name: "Eva Prado", thread: "thread-eva", turn: "turn-1" },
  } satisfies Record<string, Agent>;
  const projects: Record<string, ChromeProject> = {
    "agent-ana": { id: "section:alfa", title: "Projeto Alfa", color: "#16a34a" },
    "agent-bruno": { id: "section:alfa", title: "Projeto Alfa", color: "#16a34a" },
    "agent-carla": { id: "channel:beta", title: "Canal Beta" },
    "agent-davi": { id: "folder:davi:site", title: "site-da-loja" },
    "agent-eva": { id: "agent:agent-eva", title: "Eva Prado" },
  };
  const names = new Map<string, string>(Object.values(agents).map((agent) => [agent.id, agent.name]));
  let approveSends: boolean | "absent" = "absent";
  const cards: MessageSendCard[] = [];
  /** The person's answer to the consent card of a sensitive site; "absent" where nobody answers. */
  let approveSites: boolean | "absent" = true;
  const siteCards: SiteAccessCard[] = [];
  const context = (origin: HubTurnOrigin = "owner_ui"): ChromeCallContext => ({
    origin,
    ...(approveSends === "absent"
      ? {}
      : {
          approveMessageSend: (card: MessageSendCard) =>
            Effect.sync(() => {
              cards.push(card);
              return approveSends === true;
            }),
        }),
    ...(approveSites === "absent"
      ? {}
      : {
          approveSiteAccess: (card: SiteAccessCard) =>
            Effect.sync(() => {
              siteCards.push(card);
              return approveSites === true;
            }),
        }),
  });
  let callSeq = 0;
  const call = async (agent: Agent, tool: string, args: DynamicRecord, origin: HubTurnOrigin = "owner_ui") => {
    callSeq += 1;
    if (!tabsHost) throw new Error("no host");
    const result = await Effect.runPromise(
      tabsHost.handleDynamicTool(
        {
          threadId: agent.thread,
          turnId: agent.turn,
          callId: `call-${callSeq}`,
          ownerAgentId: agent.id,
          namespace: OPENBOT_CHROME_NAMESPACE,
          tool,
          arguments: args,
        },
        context(origin),
      ),
    );
    return { result, json: jsonOf(result), text: textOf(result) };
  };

  let inspector = "";
  const inspect = (code: string) => evaluate(inspector, `(async () => { ${code} })()`);
  const groups = async () => {
    const value = await inspect(`
      const groups = await chrome.tabGroups.query({});
      const out = [];
      for (const g of groups) out.push({ id: g.id, title: g.title, color: g.color, tabs: (await chrome.tabs.query({ groupId: g.id })).map((t) => ({ id: t.id, url: t.url, active: t.active })) });
      return { groups: out };`);
    return Array.isArray(value.groups) ? value.groups.filter(isDynamicRecord) : [];
  };
  const focus = () =>
    inspect(`
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return { activeTab: active?.id ?? null, url: active?.url ?? null };`);

  try {
    await testCase("pairing: one click in the welcome page and one choice in the app; nothing typed", async () => {
      const welcomeId = await waitFor(
        () =>
          [...targets.entries()].find(
            ([, info]) => info.type === "page" && info.url.startsWith(`${extensionUrl}welcome.html`),
          )?.[0],
        45_000,
        "the welcome page",
      );
      await waitFor(() => prompt.request ?? undefined, 45_000, "the pairing card in the app");
      const welcome = await attach(welcomeId);
      const page = await waitFor(
        async () => {
          const value = await evaluate(
            welcome,
            `({ words: document.querySelector(".words")?.textContent ?? "", options: [...document.querySelectorAll("button.choice")].map((b) => b.textContent) })`,
          );
          return Array.isArray(value.options) && value.options.length === 3 ? value : undefined;
        },
        15_000,
        "the words in the welcome page",
      );
      const chromeWords = String(page.words);
      const appWords = prompt.request?.appCode.join(" · ") ?? "";
      const started = performance.now();
      await evaluate(
        welcome,
        `[...document.querySelectorAll("button.choice")].find((b) => b.textContent === ${JSON.stringify(appWords)}).click()`,
      );
      const index = prompt.choose(chromeWords);
      expect(index >= 0, "the app card does not offer the words that Chrome shows", {
        chromeWords,
        options: prompt.request?.options,
      });
      await waitFor(() => (connected.length > 0 ? true : undefined), 15_000, "the paired connection");
      const created = await cdp.send("Target.createTarget", { url: `${extensionUrl}popup.html`, background: true });
      if (!isString(created.targetId)) throw new Error("no inspector page");
      inspector = await attach(created.targetId);
      await waitFor(
        async () =>
          (await evaluate(inspector, `({ ready: typeof chrome?.tabGroups?.query === "function" })`)).ready === true
            ? true
            : undefined,
        10_000,
        "the inspector page",
      );
      return {
        chromeWords,
        appWords,
        pairedMs: Math.round(performance.now() - started),
        features: connected[0]?.features,
      };
    });

    tabsHost = new ChromeTabsHost({
      bridge: bridgePort,
      projectOf: (agentId) => projects[agentId] ?? null,
      agentName: (agentId) => names.get(agentId) ?? null,
      secret: randomBytes(32),
    });
    // The extension's `ready` came before the host existed: the host learns of the connection at its first call.

    let anaTab = "";
    await testCase("open: a local site opens in a tab group named after the project, in the background", async () => {
      const before = await focus();
      const opened = await call(agents.ana, "open", { url: site("alpha.test", "/alpha") });
      expect(opened.result.success, "open failed", opened.text);
      const tab = isDynamicRecord(opened.json.tab) ? opened.json.tab : {};
      anaTab = String(tab.id);
      expect(tab.title === "Alpha" && String(tab.url).endsWith("/alpha"), "the tab does not show the page", tab);
      const list = await groups();
      const alpha = list.find((group) => group.title === "Projeto Alfa");
      expect(alpha !== undefined, "no group named after the project", list);
      expect(alpha.color === "green", "the group does not take the section's color", alpha);
      const tabs = Array.isArray(alpha.tabs) ? alpha.tabs.filter(isDynamicRecord) : [];
      expect(
        tabs.length === 1 && String(tabs[0]?.url).endsWith("/alpha"),
        "the group does not hold the agent's tab",
        alpha,
      );
      const after = await focus();
      expect(after.activeTab === before.activeTab, "the agent's tab took the focus", { before, after });
      return { tab, group: alpha, focus: { before, after } };
    });

    await testCase(
      "parity: snapshot, click, navigate, wait_for and history give the Builders Bot browser's format",
      async () => {
        const snapshot = await call(agents.ana, "snapshot", { tabId: anaTab, image: "never" });
        expect(snapshot.result.success, "snapshot failed", snapshot.text);
        const keys = Object.keys(snapshot.json).sort();
        for (const key of ["tabId", "revision", "title", "url", "loading", "viewport", "text", "elements", "truncated"])
          expect(keys.includes(key), `the snapshot has no ${key}`, keys);
        const elements = Array.isArray(snapshot.json.elements) ? snapshot.json.elements : [];
        const link = elements.find((line) => isString(line) && line.includes('"Second page"'));
        expect(isString(link), "the snapshot lines are not the compact element lines", elements);
        const ref = String(link).split(" ")[0] ?? "";
        const revision = Number(snapshot.json.revision);
        const clicked = await call(agents.ana, "click", { tabId: anaTab, target: { kind: "ref", ref, revision } });
        expect(clicked.result.success, "click failed", clicked.text);
        for (const key of ["tabId", "revision", "url", "title", "loading"])
          expect(key in clicked.json, `the action status has no ${key}`, clicked.json);
        const waited = await call(agents.ana, "wait_for", { tabId: anaTab, text: "Arrived", timeoutMs: 10_000 });
        expect(
          waited.result.success && String(waited.json.url).endsWith("/second"),
          "wait_for did not see the next page",
          waited.text,
        );
        const back = await call(agents.ana, "navigate", { tabId: anaTab, direction: "back" });
        expect(
          back.result.success && String(back.json.url).endsWith("/alpha") && back.json.title === "Alpha",
          "navigate back did not go back",
          back.text.slice(0, 400),
        );
        const reload = await call(agents.ana, "navigate", { tabId: anaTab, direction: "reload" });
        expect(reload.result.success && String(reload.json.url).endsWith("/alpha"), "reload failed", reload.text);
        const shot = await call(agents.ana, "screenshot", { tabId: anaTab });
        const image = shot.result.contentItems.find((item) => item.type === "inputImage");
        expect(
          shot.result.success && image?.type === "inputImage" && image.imageUrl.startsWith("data:image/jpeg;base64,"),
          "screenshot gave no image",
          shot.text,
        );
        return { snapshotKeys: keys, actionKeys: Object.keys(clicked.json).sort(), elements: elements.length };
      },
    );

    let formTab = "";
    await testCase("parity: typing, fields, select, checkbox, scroll, a page dialog and close_tab", async () => {
      const opened = await call(agents.ana, "open", { url: site("alpha.test", "/form") });
      expect(opened.result.success, "open failed", opened.text);
      formTab = String((isDynamicRecord(opened.json.tab) ? opened.json.tab : {}).id);
      const snapshot = await call(agents.ana, "snapshot", { tabId: formTab, image: "never" });
      const lines = (Array.isArray(snapshot.json.elements) ? snapshot.json.elements : []).map(String);
      const refOf = (text: string) => lines.find((line) => line.includes(text))?.split(" ")[0] ?? "";
      const revision = Number(snapshot.json.revision);
      const target = (text: string) => ({ kind: "ref", ref: refOf(text), revision });
      const typed = await call(agents.ana, "type", { tabId: formTab, target: target('"Name"'), text: "Maria" });
      expect(typed.result.success, "type failed", typed.text);
      const filled = await call(agents.ana, "fill_fields", {
        tabId: formTab,
        revision,
        fields: [{ ref: refOf('"City"'), text: "Lisboa" }],
      });
      expect(filled.result.success && filled.json.status === "completed", "fill_fields failed", filled.text);
      const selected = await call(agents.ana, "select_option", {
        tabId: formTab,
        target: { kind: "css", selector: "#size" },
        values: ["l"],
      });
      expect(selected.result.success, "select_option failed", selected.text);
      const checked = await call(agents.ana, "set_checked", {
        tabId: formTab,
        target: { kind: "css", selector: "#agree" },
        checked: true,
      });
      expect(checked.result.success, "set_checked failed", checked.text);
      const shown = await call(agents.ana, "click", {
        tabId: formTab,
        target: { kind: "role", role: "button", name: "Show" },
        snapshot: true,
      });
      expect(
        shown.result.success && String(shown.json.text).includes("Hello Maria"),
        "the click did not reach the page",
        shown.text,
      );
      const scrolled = await call(agents.ana, "scroll", { tabId: formTab, deltaY: 800 });
      expect(scrolled.result.success, "scroll failed", scrolled.text);
      const asked = await call(agents.ana, "click", {
        tabId: formTab,
        target: { kind: "role", role: "button", name: "Ask" },
      });
      const dialog = isDynamicRecord(asked.json.dialog) ? asked.json.dialog : {};
      expect(dialog.type === "confirm" && isString(dialog.id), "the page dialog did not come to the agent", asked.text);
      const answered = await call(agents.ana, "handle_dialog", { tabId: formTab, dialogId: dialog.id, accept: true });
      expect(answered.result.success && answered.json.answered === "accepted", "handle_dialog failed", answered.text);
      const after = await call(agents.ana, "wait_for", { tabId: formTab, text: "confirmed", timeoutMs: 5_000 });
      expect(after.result.success, "the page did not get the answer", after.text);
      const closed = await call(agents.ana, "close_tab", { tabId: formTab });
      expect(closed.result.success && closed.json.closed === true, "close_tab failed", closed.text);
      const list = await call(agents.ana, "list_tabs", {});
      const tabs = Array.isArray(list.json.tabs) ? list.json.tabs.filter(isDynamicRecord) : [];
      expect(tabs.length === 1 && tabs[0]?.id === anaTab, "the closed tab is still listed", list.json);
      return { dialog, tabs: tabs.length };
    });

    await testCase(
      "two conversations of different projects get two groups; a colleague's tab is not yours",
      async () => {
        const beta = await call(agents.carla, "open", { url: site("beta.test", "/alpha") });
        expect(beta.result.success, "open failed for the second project", beta.text);
        const colleague = await call(agents.bruno, "open", { url: site("alpha.test", "/second") });
        expect(colleague.result.success, "open failed for the colleague", colleague.text);
        const list = await groups();
        const alpha = list.find((group) => group.title === "Projeto Alfa");
        const betaGroup = list.find((group) => group.title === "Canal Beta");
        expect(
          alpha !== undefined && betaGroup !== undefined && alpha.id !== betaGroup.id,
          "the projects do not have two groups",
          list,
        );
        const alphaTabs = Array.isArray(alpha.tabs) ? alpha.tabs.length : 0;
        expect(alphaTabs === 2, "the colleague's tab is not in the same project group", alpha);
        const foreign = await call(agents.bruno, "snapshot", { tabId: anaTab });
        expect(
          !foreign.result.success && foreign.text.includes("Unknown browser tab"),
          "a colleague read another agent's tab",
          foreign.text,
        );
        const brunoList = await call(agents.bruno, "list_tabs", {});
        const brunoTabs = Array.isArray(brunoList.json.tabs) ? brunoList.json.tabs : [];
        expect(brunoTabs.length === 1, "list_tabs shows tabs of another agent", brunoList.json);
        return {
          groups: list.map((group) => ({
            title: group.title,
            color: group.color,
            tabs: Array.isArray(group.tabs) ? group.tabs.length : 0,
          })),
        };
      },
    );

    await testCase("the next turn finds the same tab, and no new tab or group is made", async () => {
      const groupsBefore = await groups();
      const tabsBefore = groupsBefore.reduce(
        (sum, group) => sum + (Array.isArray(group.tabs) ? group.tabs.length : 0),
        0,
      );
      agents.ana.turn = "turn-2";
      const list = await call(agents.ana, "list_tabs", {});
      const tabs = Array.isArray(list.json.tabs) ? list.json.tabs.filter(isDynamicRecord) : [];
      expect(
        tabs.length === 1 && tabs[0]?.id === anaTab && list.json.activeTabId === anaTab,
        "the tab of the last turn is not there",
        list.json,
      );
      const navigated = await call(agents.ana, "navigate", { tabId: anaTab, url: site("alpha.test", "/second") });
      expect(
        navigated.result.success && String(navigated.json.url).endsWith("/second"),
        "navigate failed",
        navigated.text,
      );
      const groupsAfterTurn = await groups();
      const tabsAfterTurn = groupsAfterTurn.reduce(
        (sum, group) => sum + (Array.isArray(group.tabs) ? group.tabs.length : 0),
        0,
      );
      expect(
        tabsAfterTurn === tabsBefore && groupsAfterTurn.length === groupsBefore.length,
        "the next turn made a tab or a group",
        { tabsBefore, tabsAfterTurn, groupsBefore: groupsBefore.length, groupsAfter: groupsAfterTurn.length },
      );
      // A blank tab of the agent is reused by open.
      const blank = await call(agents.davi, "open", { url: "about:blank" });
      const reused = await call(agents.davi, "open", { url: site("alpha.test", "/alpha") });
      expect(reused.json.reused === true, "open did not reuse the agent's blank tab", reused.json);
      const daviTabs = await call(agents.davi, "list_tabs", {});
      expect(
        Array.isArray(daviTabs.json.tabs) && daviTabs.json.tabs.length === 1,
        "open made a second tab",
        daviTabs.json,
      );
      const groupsAfter = await groups();
      const folderGroup = groupsAfter.find((group) => group.title === "site-da-loja");
      expect(folderGroup !== undefined, "the agent's single folder does not name its group", groupsAfter);
      return {
        nextTurn: { tabsBefore, tabsAfterTurn, groupsBefore: groupsBefore.length, groupsAfter: groupsAfterTurn.length },
        blankReused: { tabs: Array.isArray(daviTabs.json.tabs) ? daviTabs.json.tabs.length : 0, blank: blank.json.tab },
      };
    });

    await testCase("limits: 4 tabs for an agent, 12 in all, refused at once", async () => {
      const opened: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const result = await call(agents.eva, "open", { url: site("alpha.test", `/eva-${index}`) });
        if (result.result.success) opened.push(String((isDynamicRecord(result.json.tab) ? result.json.tab : {}).id));
        else throw new Failed(`tab ${index + 1} of 4 was refused: ${result.text}`);
      }
      const fifth = await call(agents.eva, "open", { url: site("alpha.test", "/eva-5") });
      expect(
        !fifth.result.success && fifth.text.includes("limit"),
        "a fifth tab for one agent was not refused",
        fifth.text,
      );
      // 1 (Ana) + 1 (Bruno) + 1 (Carla) + 1 (Davi) + 4 (Eva) = 8. Four more agents fill the 12.
      const extra: Agent[] = [];
      for (let index = 0; index < 4; index += 1) {
        const agent = { id: `agent-x${index}`, name: `Extra ${index}`, thread: `thread-x${index}`, turn: "turn-1" };
        names.set(agent.id, agent.name);
        extra.push(agent);
        const result = await call(agent, "open", { url: site("alpha.test", `/x-${index}`) });
        expect(result.result.success, `tab ${9 + index} of 12 was refused`, result.text);
      }
      const thirteenth = await call(agents.bruno, "open", { url: site("alpha.test", "/thirteen") });
      expect(
        !thirteenth.result.success && thirteenth.text.includes("limit"),
        "a thirteenth tab was not refused",
        thirteenth.text,
      );
      // Closing one gives the room back.
      await call(agents.eva, "close_tab", { tabId: opened[3] ?? "" });
      const again = await call(agents.bruno, "open", { url: site("alpha.test", "/thirteen") });
      expect(again.result.success, "a tab did not open after one closed", again.text);
      for (const agent of extra) {
        const list = await call(agent, "list_tabs", {});
        for (const tab of Array.isArray(list.json.tabs) ? list.json.tabs.filter(isDynamicRecord) : [])
          await call(agent, "close_tab", { tabId: String(tab.id) });
      }
      return { perAgent: fifth.text, total: thirteenth.text };
    });

    await testCase(
      "site floor: a bank is refused on open, on navigate and on a redirect; no request reaches it",
      async () => {
        const before = bankHits();
        const opened = await call(agents.ana, "open", { url: site("www.itau.com.br", "/") });
        expect(!opened.result.success && opened.text.includes("blocked for agents"), "the bank opened", opened.text);
        const navigated = await call(agents.ana, "navigate", { tabId: anaTab, url: site("www.itau.com.br", "/login") });
        expect(
          !navigated.result.success && navigated.text.includes("blocked"),
          "the bank was navigated to",
          navigated.text,
        );
        // A redirect to the bank, in a tab of its own: the extension's rule stops the request before it leaves.
        const floorAgent: Agent = { id: "agent-floor", name: "Floor Test", thread: "thread-floor", turn: "turn-1" };
        names.set(floorAgent.id, floorAgent.name);
        const start = await call(floorAgent, "open", { url: site("alpha.test", "/alpha") });
        const floorTab = String((isDynamicRecord(start.json.tab) ? start.json.tab : {}).id);
        const redirected = await call(floorAgent, "navigate", { tabId: floorTab, url: site("alpha.test", "/to-bank") });
        await sleep(500);
        const after = await call(floorAgent, "snapshot", { tabId: floorTab, image: "never" });
        expect(
          !redirected.result.success || !after.result.success || !String(after.json.url).includes("itau"),
          "the redirect reached the bank's page",
          { redirected: redirected.text, after: after.text.slice(0, 300) },
        );
        await call(floorAgent, "close_tab", { tabId: floorTab });
        expect(
          bankHits() === before,
          "a request reached the bank's host",
          hits.filter((hit) => hit.host.includes("itau")),
        );
        return {
          open: opened.text,
          navigate: navigated.text,
          redirect: redirected.text,
          bankHits: bankHits() - before,
        };
      },
    );

    await testCase("gates: scripts off, a turn from a team member or a chat app has no Chrome", async () => {
      const evaluated = await call(agents.ana, "evaluate", { tabId: anaTab, expression: "document.cookie" });
      expect(!evaluated.result.success && evaluated.text.includes("scripts"), "evaluate ran", evaluated.text);
      const script = await call(agents.ana, "run_script", { tabId: anaTab, script: "return 1" });
      expect(!script.result.success && script.text.includes("scripts"), "run_script ran", script.text);
      const refused: Record<string, string> = {};
      for (const origin of [
        "team_member",
        "messaging",
        "routine",
        "routine_agent",
        "unknown",
      ] satisfies HubTurnOrigin[]) {
        expect(!CHROME_TURN_ORIGINS.has(origin), `${origin} may use Chrome`);
        const result = await call(agents.ana, "list_tabs", {}, origin);
        expect(
          !result.result.success && result.text.includes("not available"),
          `a ${origin} turn reached Chrome`,
          result.text,
        );
        refused[origin] = result.text;
      }
      return refused;
    });

    await testCase(
      "turn origin: a channel is the owner's with no team member, and closed while one can write in it",
      () => {
        // The router's rule, on the delivery records that the mailbox stores for a turn.
        const owner: HubDeliveryOrigin = {
          sender: "user",
          messaging: false,
          channel: true,
          memberId: null,
          editorId: null,
          stamp: null,
        };
        const remote = (memberId: string) => memberId === "member-remote";
        const channelThread = { messaging: false, channel: true };
        const ownThread = { messaging: false, channel: false };
        const origins = {
          ownerInOwnThread: chromeTurnOrigin([{ ...owner, channel: false }], ownThread, remote, true),
          ownerInChannelNoTeam: chromeTurnOrigin([owner], channelThread, remote, false),
          ownerInChannelWithTeam: chromeTurnOrigin([owner], channelThread, remote, true),
          teamMemberInChannelNoTeamFlag: chromeTurnOrigin(
            [{ ...owner, memberId: "member-remote" }],
            channelThread,
            remote,
            false,
          ),
          teamMemberEditedOwnersMessage: chromeTurnOrigin(
            [{ ...owner, channel: false, editorId: "member-remote" }],
            ownThread,
            remote,
            false,
          ),
          chatApp: chromeTurnOrigin(
            [{ ...owner, channel: false, messaging: true }],
            { messaging: true, channel: false },
            remote,
            false,
          ),
          agentOfOwner: chromeTurnOrigin(
            [{ ...owner, sender: "agent", channel: false, stamp: "agent" }],
            ownThread,
            remote,
            true,
          ),
          routine: chromeTurnOrigin(
            [{ ...owner, sender: "routine", channel: false, stamp: "routine" }],
            ownThread,
            remote,
            false,
          ),
          agentWithNoStamp: chromeTurnOrigin([{ ...owner, sender: "agent", channel: false }], ownThread, remote, false),
          noDelivery: chromeTurnOrigin([], ownThread, remote, false),
          // The owner's turn sends to an agent (send_message, a task, an interrupt): the agent may use Chrome.
          ownerSentToAgent: chromeTurnOrigin(
            [{ ...owner, sender: "agent", channel: false, stamp: sentOrigin("owner_ui") }],
            ownThread,
            remote,
            false,
          ),
          // A routine's turn sends to an agent: no person watches, so the chain stays closed.
          routineSentToAgent: chromeTurnOrigin(
            [{ ...owner, sender: "agent", channel: false, stamp: sentOrigin("routine") }],
            ownThread,
            remote,
            false,
          ),
          // A routine (a webhook routine too) that an agent's turn saved runs closed.
          agentSavedRoutineRun: chromeTurnOrigin(
            [{ ...owner, sender: "routine", channel: false, stamp: routineOriginOf("agent") }],
            ownThread,
            remote,
            false,
          ),
          // A run of a routine that an agent saved before this change carries `agent`: still closed.
          olderAgentSavedRoutineRun: chromeTurnOrigin(
            [{ ...owner, sender: "routine", channel: false, stamp: "agent" }],
            ownThread,
            remote,
            false,
          ),
          // ...and what that run sends on stays closed at every step.
          chainFromRoutineRun: chromeTurnOrigin(
            [
              {
                ...owner,
                sender: "agent",
                channel: false,
                stamp: sentOrigin(
                  sentOrigin(
                    hubTurnOrigin([{ ...owner, sender: "routine", channel: false, stamp: "agent" }], ownThread, remote),
                  ),
                ),
              },
            ],
            ownThread,
            remote,
            false,
          ),
        } satisfies Record<string, HubTurnOrigin>;
        const open = Object.fromEntries(
          Object.entries(origins).map(([name, origin]) => [name, CHROME_TURN_ORIGINS.has(origin)]),
        );
        const openNames = ["ownerInOwnThread", "ownerInChannelNoTeam", "agentOfOwner", "ownerSentToAgent"];
        expect(
          Object.entries(open).every(([name, granted]) => granted === openNames.includes(name)),
          "the owner's Chrome opens for a turn that is not the owner's, or stays closed for the owner",
          { origins, open },
        );
        // The Hub connections read an agent turn that a routine started as before: an agent turn.
        const hub = {
          folded: hubConnectionOrigin("routine_agent"),
          connections: CONNECTION_ORIGINS.has("routine_agent"),
        };
        expect(hub.folded === "agent" && hub.connections, "the Hub connections changed for a routine chain", hub);
        return Promise.resolve({ origins, open, hub });
      },
    );

    await testCase(
      "message send: a card with the text and recipients before each send; a refusal sends nothing",
      async () => {
        const opened = await call(agents.carla, "open", { url: site("webmail.test", "/compose") });
        expect(opened.result.success, "open failed", opened.text);
        const tabId = String((isDynamicRecord(opened.json.tab) ? opened.json.tab : {}).id);
        await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#to" }, text: "ana@example.com" });
        await call(agents.carla, "type", {
          tabId,
          target: { kind: "css", selector: "#body" },
          text: "Olá, segue o relatório.",
        });
        const snapshot = await call(agents.carla, "snapshot", { tabId, image: "never" });
        const lines = (Array.isArray(snapshot.json.elements) ? snapshot.json.elements : []).map(String);
        const send = lines.find((line) => line.includes('"Send"'))?.split(" ")[0] ?? "";
        const target = { kind: "ref", ref: send, revision: Number(snapshot.json.revision) };
        approveSends = "absent";
        const noCard = await call(agents.carla, "click", { tabId, target });
        expect(
          !noCard.result.success && noCard.text.includes("approval"),
          "a send went out where nobody answers a card",
          noCard.text,
        );
        approveSends = false;
        const declined = await call(agents.carla, "click", { tabId, target });
        expect(
          !declined.result.success && declined.text.includes("did not approve"),
          "a declined send went out",
          declined.text,
        );
        await sleep(300);
        expect(sent.length < 1, "the page sent a message without approval", sent);
        approveSends = true;
        const approved = await call(agents.carla, "click", { tabId, target });
        expect(approved.result.success, "the approved send failed", approved.text);
        await call(agents.carla, "wait_for", { tabId, text: "Sent", timeoutMs: 5_000 });
        const card = cards.at(-1);
        expect(
          card?.text.includes("relatório") === true &&
            card.recipients.includes("ana@example.com") &&
            card.action === "Send",
          "the card does not show the text and the recipients",
          card,
        );
        expect(
          sent.length === 1 && sent[0]?.to === "ana@example.com",
          "the approved message did not go out once",
          sent,
        );
        // On a mail site, a click that the host cannot name (a selector) asks too: the rule fails closed.
        const fresh = async () => {
          const read = await call(agents.carla, "snapshot", { tabId, image: "never" });
          return {
            lines: (Array.isArray(read.json.elements) ? read.json.elements : []).map(String),
            revision: Number(read.json.revision),
          };
        };
        await fresh();
        approveSends = false;
        const cardsBefore = cards.length;
        await call(agents.carla, "click", { tabId, target: { kind: "css", selector: "#to" } });
        expect(cards.length === cardsBefore + 1, "a click by selector on a mail site did not ask (it fails closed)");

        // The ways around the card (review of 02/11), each with nobody to answer a card: all refused.
        approveSends = "absent";
        const around: Record<string, string> = {};
        // A recipient changed after the last snapshot: the card would show the old one.
        await call(agents.carla, "type", {
          tabId,
          target: { kind: "css", selector: "#to" },
          text: "atacante@example.com",
        });
        around.staleSnapshot = (await call(agents.carla, "click", { tabId, target })).text;
        // A carriage return in `type` is a new line, so it is a send.
        await fresh();
        around.carriageReturn = (
          await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#body" }, text: "dados\r" })
        ).text;
        // Space presses a focused button.
        await fresh();
        around.space = (await call(agents.carla, "press", { tabId, key: "Space" })).text;
        // The engine finds a role or a text by a part of the name.
        await fresh();
        around.partialRole = (
          await call(agents.carla, "click", { tabId, target: { kind: "role", role: "button", name: "Sen" } })
        ).text;
        await fresh();
        around.partialText = (await call(agents.carla, "click", { tabId, target: { kind: "text", text: "Sen" } })).text;
        // A button with only an icon has no name: it can be the send button.
        const iconRead = await fresh();
        const iconLine = iconRead.lines.find((line) => / button\b/u.test(line) && !/"[^"]+"/u.test(line));
        if (iconLine)
          around.iconButton = (
            await call(agents.carla, "click", {
              tabId,
              target: { kind: "ref", ref: iconLine.split(" ")[0] ?? "", revision: iconRead.revision },
            })
          ).text;
        for (const [name, text] of Object.entries(around)) {
          const expected = name === "staleSnapshot" ? "fresh snapshot" : "approval";
          expect(text.includes(expected), `a send went around the card: ${name}`, text);
        }
        await sleep(300);
        expect(sent.length === 1, "a message went out without the person's approval", sent);
        // With a fresh snapshot, the card shows the recipient that the page holds now.
        approveSends = false;
        await fresh();
        await call(agents.carla, "click", { tabId, target: { kind: "css", selector: "#send" } });
        const current = cards.at(-1);
        expect(
          current?.recipients.some((recipient) => recipient.includes("atacante@example.com")) === true,
          "the card does not show the recipient that the page holds now",
          current,
        );
        // More ways around the card (security review of 02/11, items 7 and 8), on a page of their own.
        approveSends = "absent";
        const sentBefore = sent.length;
        const more: Record<string, string> = {};
        // A target that is not exact: the snapshot shows "Save draft"; then the page by itself shows
        // "Send draft", with no action of the agent between.
        await call(agents.carla, "navigate", { tabId, url: site("webmail.test", "/compose2") });
        const swapRead = await fresh();
        const swapLine = swapRead.lines.find((line) => line.includes("Save draft"));
        await sleep(4_000);
        more.swappedByPage = (
          await call(agents.carla, "click", { tabId, target: { kind: "text", text: "draft" } })
        ).text;
        await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#to" }, text: "ana@example.com" });
        await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#body" }, text: "Olá" });
        const refOf = (read: { lines: string[]; revision: number }, text: string) => ({
          kind: "ref",
          ref: read.lines.find((line) => line.includes(text))?.split(" ")[0] ?? "",
          revision: read.revision,
        });
        let read = await fresh();
        // A key with a space after it, or an empty last part: the engine trims them to Enter.
        more.enterWithSpace = (
          await call(agents.carla, "press", { tabId, key: "Enter ", target: refOf(read, "Envoyer") })
        ).text;
        read = await fresh();
        more.enterWithPlus = (
          await call(agents.carla, "press", { tabId, key: "Enter+", target: refOf(read, "Envoyer") })
        ).text;
        // Alt+S sends in some mail sites.
        await fresh();
        more.altS = (await call(agents.carla, "press", { tabId, key: "Alt+s" })).text;
        // A send button named by a symbol, and one named in another language.
        read = await fresh();
        more.symbolName = (await call(agents.carla, "click", { tabId, target: refOf(read, "➤") })).text;
        read = await fresh();
        more.frenchName = (await call(agents.carla, "click", { tabId, target: refOf(read, "Envoyer") })).text;
        // Control characters that are not \r or \n.
        await fresh();
        more.lineSeparator = (
          await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#body" }, text: "dados\u2028" })
        ).text;
        await fresh();
        more.verticalTab = (
          await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#body" }, text: "dados\u000b" })
        ).text;
        // The review of 02/11, second batch: other languages, names, a shadow root, a frame, spaces.
        await call(agents.carla, "navigate", { tabId, url: site("webmail.test", "/compose3") });
        const lineRef = (read: { lines: string[]; revision: number }, text: string) => ({
          kind: "ref",
          ref: read.lines.find((line) => line.includes(text))?.split(" ")[0] ?? "",
          revision: read.revision,
        });
        const passes: Record<string, string> = {};
        // No composer yet: the name says "Archive", the visible text says "Send". The engine reads both
        // just before the click.
        let page3 = await fresh();
        const archive = (await call(agents.carla, "click", { tabId, target: lineRef(page3, '"Archive"') })).text;
        // A button has the focus; keys with no target go to it, and a space presses it.
        page3 = await fresh();
        await call(agents.carla, "press", { tabId, key: "Escape", target: lineRef(page3, '"Bold"') });
        for (const [name, text] of Object.entries({ space: " ", noBreakSpace: "\u00a0", tab: "\t", enter: "\n" })) {
          await fresh();
          more[`focusedButton.${name}`] = (await call(agents.carla, "type", { tabId, text })).text;
        }
        // A message being written: every control asks, unless it is on the list that does not send.
        await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#to" }, text: "ana@example.com" });
        await call(agents.carla, "type", { tabId, target: { kind: "css", selector: "#body" }, text: "Olá de novo" });
        for (const name of ["送信", "Отправить", "إرسال", "भेजें", "Enviar agora", "Enviar mensagem"]) {
          page3 = await fresh();
          more[`name.${name}`] = (
            await call(agents.carla, "click", { tabId, target: lineRef(page3, `"${name}"`) })
          ).text;
        }
        page3 = await fresh();
        passes.cancelNextToComposer = (
          await call(agents.carla, "click", { tabId, target: lineRef(page3, '"Cancel"') })
        ).text;
        // The focus on the text field: a space is only a space.
        page3 = await fresh();
        await call(agents.carla, "click", { tabId, target: lineRef(page3, '"Message"') }).catch(() => undefined);
        await fresh();
        passes.spaceInTextField = (await call(agents.carla, "type", { tabId, text: " e mais" })).text;
        await sleep(500);
        const sentAround = sent.slice(sentBefore);
        for (const [name, text] of Object.entries(more))
          expect(text.includes("approval"), `a send went around the card: ${name}`, { text, sentAround });
        expect(archive.includes("nothing was clicked"), "a send named as another action went out", {
          archive,
          sentAround,
        });
        for (const [name, text] of Object.entries(passes))
          expect(
            !text.includes("approval") && !text.includes("Error"),
            `an action that does not send asked: ${name}`,
            text,
          );
        expect(sentAround.length === 0, "a message went out without the person's approval", sentAround);
        approveSends = "absent";
        return {
          cards: cards.length,
          card,
          current,
          around,
          more,
          archive,
          passes,
          swapListed: swapLine !== undefined,
          iconButtonListed: iconLine !== undefined,
          sent,
        };
      },
    );

    await testCase(
      "sensitive site: an agent asks the person once per project; nobody to answer means no access",
      async () => {
        const site = (path: string) => `http://router.local:${port}${path}`;
        approveSites = "absent";
        const noCard = await call(agents.ana, "open", { url: site("/alpha") });
        expect(
          !noCard.result.success && noCard.text.includes("allows it"),
          "a sensitive site opened where nobody answers a card",
          noCard.text,
        );
        approveSites = false;
        const before = siteCards.length;
        const declined = await call(agents.ana, "open", { url: site("/alpha") });
        expect(
          !declined.result.success && declined.text.includes("did not allow") && siteCards.length === before + 1,
          "a declined sensitive site opened",
          declined.text,
        );
        approveSites = true;
        const allowed = await call(agents.ana, "open", { url: site("/alpha") });
        expect(allowed.result.success, "the allowed sensitive site did not open", allowed.text);
        const asked = siteCards.length;
        const allowedTab = String((isDynamicRecord(allowed.json.tab) ? allowed.json.tab : {}).id);
        await call(agents.ana, "snapshot", { tabId: allowedTab, image: "never" });
        expect(siteCards.length === asked, "the same project was asked again for the same site", siteCards);
        // Another project asks for itself.
        approveSites = "absent";
        const other = await call(agents.carla, "open", { url: site("/alpha") });
        expect(!other.result.success, "another project used the site that one project allowed", other.text);
        // A navigation from a plain page to the sensitive site waits for the consent too.
        const plain = await call(agents.carla, "open", { url: `http://alpha.test:${port}/alpha` });
        const plainTab = String((isDynamicRecord(plain.json.tab) ? plain.json.tab : {}).id);
        const navigated = await call(agents.carla, "navigate", { tabId: plainTab, url: site("/second") });
        expect(!navigated.result.success, "a navigation reached a sensitive site with no consent", navigated.text);
        await call(agents.ana, "close_tab", { tabId: allowedTab });
        await call(agents.carla, "close_tab", { tabId: plainTab });
        approveSites = true;
        return { card: siteCards.at(-1), noCard: noCard.text, declined: declined.text, other: other.text };
      },
    );

    await testCase("bridge: few messages; commands of one snapshot go in batches", async () => {
      const before = new Map(requests);
      await call(agents.ana, "snapshot", { tabId: anaTab, image: "never" });
      const delta = Object.fromEntries(
        [...requests.entries()]
          .map(([op, count]) => [op, count - (before.get(op) ?? 0)])
          .filter(([, count]) => Number(count) > 0),
      );
      report.bridge = { totals: Object.fromEntries(requests), oneSnapshot: delta };
      expect((delta["cdp.batch"] ?? 0) > 0, "a snapshot sent no batch", delta);
      return delta;
    });

    await testCase("catalog: openbot_chrome has the Builders Bot browser's schemas and no script tools", () => {
      const namespace = CHROME_DYNAMIC_TOOLS[0];
      expect(namespace?.name === OPENBOT_CHROME_NAMESPACE, "no openbot_chrome namespace");
      const toolNames = namespace.tools.map((tool) => tool.name);
      expect(
        !toolNames.includes("evaluate") && !toolNames.includes("run_script"),
        "script tools are in the catalog",
        toolNames,
      );
      for (const tool of namespace.tools) {
        const original = BROWSER_TOOL_DEFINITIONS.find((definition) => definition.name === tool.name);
        expect(original !== undefined, `${tool.name} is not a Builders Bot browser tool`);
      }
      return Promise.resolve({ tools: toolNames });
    });
  } finally {
    report.machine = { ...report.machine, end: { swapMb: Math.round(swapMb()), freePercent: freePercent() } };
    report.notCovered.push(
      "upload_files, submit_secret, fill_card, request_takeover, set_environment and recording are not in openbot_chrome yet",
      "a headed run (the debugging bar, focus with a visible window)",
    );
    await cdp.send("Browser.close").catch(() => undefined);
    await sleep(500);
    await runtime.dispose();
    cleanup();
    report.finishedAt = new Date().toISOString();
    report.ok = report.cases.length > 0 && report.cases.every((entry) => entry.ok);
    await writeReport();
  }
  process.stdout.write(
    `${report.ok ? "PASSED" : "FAILED"} ${report.cases.filter((entry) => entry.ok).length}/${report.cases.length} → ${join(OUT, "report.json")}\n`,
  );
  process.exit(report.ok ? 0 : 1);
}

await main();
