// E2E of the Builders Bot Chrome extension (DESIGN §13.3), in a pinned Chrome for Testing with a new
// profile that the script makes and deletes. It never starts, reads or changes the person's own Chrome,
// its profile or its folders: the Native Messaging manifest goes into the test profile
// (`<profile>/NativeMessagingHosts`, Chrome's user-level folder for a `--user-data-dir`).
//
// The script plays the app: it listens on a private Unix socket and runs the app side of the real
// channel (`AppHandshake`, `SealedChannel` from contracts), and it checks every message of the extension
// with the real decoders (`decodeToApp`). Between Chrome and that socket runs a stand-in for the native
// host (`chrome-extension-e2e-relay.ts`), because the signed host is another part of Phase 2.
//
// Chrome is driven through `--remote-debugging-pipe` with a small CDP client of its own, not
// Playwright: Playwright attaches to every service worker, and an attached debugger keeps a worker from
// ever stopping, which would hide what the reconnection cases test.
//
// Cases: pairing by the choice of words; the group named after the project (and a person's group of
// the same name left alone); no focus taken; the same tab across turns; closed method, parameter and
// event lists; the site floor (gate, page navigation, redirect, frame, app blocks) with a control host;
// a tab closed by the person and a crashed tab; the secret check; the security review of 02/11 (page
// code only as engine functions, the guard world, clipboard keys, closed results, `secret.fill` only into
// a secret field, a typed field that changes its type, a password in a shadow root); Stop all and
// Resume from the popup; N agents at once
// (latency, throughput, memory); the worker idle with the port open; and a reconnect after Chrome stops
// the worker, by a browser event and by the watchdog alarm.
//
//   bun scripts/chrome-extension-e2e.ts [--headed] [--loads 10,25,50] [--load-seconds 8] [--skip-alarm-wake]
//                                       [--only <text in a case name>] [--process-per-site]
//
// Run it under the heavy-command mutex. It refuses to start with swap above 9 GB or free memory below
// 20 %; with swap above 6 GB it runs only the loads up to 25 agents; and it stops a load step when swap
// passes 9 GB or free memory drops below 20 %. Writes
// .buildersbot-build/chrome-extension-e2e/report.json.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { ENGINE_FUNCTIONS } from "@openbot/contracts/chrome-bridge/cdp-functions";
import {
  AppHandshake,
  type Established,
  generateChannelKey,
  type PairingCode,
  randomBase64Url,
} from "@openbot/contracts/chrome-bridge/channel";
import { EXTENSION_IDS, extensionOrigin } from "@openbot/contracts/chrome-bridge/extension-ids";
import {
  type AppMessageHandlers,
  CHROME_BRIDGE_FEATURES,
  type ChromeBridgeErrorCode,
  type ChromeBridgeEvent,
  type ChromeBridgeOperation,
  decodeOperationBody,
  decodeToApp,
  NATIVE_HOST_NAMES,
  type OperationBodies,
} from "@openbot/contracts/chrome-bridge/protocol";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { buildChromeExtension } from "./build-chrome-extension";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".buildersbot-build/chrome-extension-e2e");
const CFT = {
  version: "156.0.8078.80",
  platform: "mac-arm64",
  sha256: "8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1",
};
const CFT_DIR = join(ROOT, ".buildersbot-build/chrome-extension/cft", CFT.version);
const CFT_BINARY = join(
  CFT_DIR,
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
/** Above this swap at the start, the run measures only the smaller loads (10 and 25 agents). */
const HIGH_SWAP_MB = 6 * 1024;
const MAX_SWAP_MB = 9 * 1024;
const MIN_FREE_PERCENT = 20;
const EXTENSION_ID = EXTENSION_IDS.e2e ?? "";

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const headed = argv.includes("--headed");
let loads = (option("--loads") ?? "10,25,50")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);
const loadSeconds = Number(option("--load-seconds") ?? 8);
const skipAlarmWake = argv.includes("--skip-alarm-wake");
/** Runs only the cases whose name holds this text (pairing always runs). */
const only = option("--only");
/**
 * Tabs of one site share a renderer process. It uses far less memory, so the 50-agent load can run on a
 * computer with high swap; the commands of all tabs then share one process, which is a harder case for
 * latency, not an easier one. The report says which mode ran.
 */
const processPerSite = argv.includes("--process-per-site");

// ---------------------------------------------------------------------------------------------------
// Report

interface CaseResult {
  name: string;
  ok: boolean;
  ms: number;
  evidence: unknown;
  error?: string;
}

interface Notes {
  [key: string]: unknown;
}

interface Report {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  headed: boolean;
  processPerSite: boolean;
  cft: typeof CFT;
  extension: { id: string; channel: "e2e"; features: string[] };
  machine: Notes;
  cases: CaseResult[];
  load: Notes[];
  notMeasured: string[];
  protocolViolations: string[];
  networkEventsSeen: number;
}

const report: Report = {
  startedAt: new Date().toISOString(),
  finishedAt: "",
  ok: false,
  headed,
  processPerSite,
  cft: CFT,
  extension: { id: EXTENSION_ID, channel: "e2e", features: [] },
  machine: {},
  cases: [],
  load: [],
  notMeasured: [],
  protocolViolations: [],
  networkEventsSeen: 0,
};

async function writeReport(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

class Failed extends Error {}
function expect(condition: boolean, message: string, detail?: unknown): void {
  if (!condition) throw new Failed(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
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
    report.cases.push({ name, ok: false, ms: Math.round(performance.now() - started), evidence: null, error: message });
    process.stdout.write(`FAIL ${name}: ${message}\n`);
    return false;
  } finally {
    await writeReport();
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function stats(values: readonly number[]) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

// ---------------------------------------------------------------------------------------------------
// The machine

function swapMb(): number {
  const text = execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" });
  return Number(/used = ([\d.]+)M/u.exec(text)?.[1] ?? Number.POSITIVE_INFINITY);
}

function freePercent(): number {
  const text = execFileSync("memory_pressure", [], { encoding: "utf8" });
  return Number(/free percentage: (\d+)%/u.exec(text)?.[1] ?? 0);
}

function machine() {
  const load = execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).match(/[\d.]+/gu) ?? [];
  return { swapMb: Math.round(swapMb()), freePercent: freePercent(), loadAverage1m: Number(load[0] ?? 0) };
}

/** RSS of the Chrome for Testing processes that this run started: all of them, and the extension's. */
function chromeMemory(browserPid: number | undefined) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).split("\n");
  const parsed = rows.flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] ?? "" }]
      : [];
  });
  const ours = parsed.filter((row) => row.pid === browserPid || row.ppid === browserPid);
  const mb = (kb: number) => Math.round(kb / 1024);
  return {
    totalMb: mb(ours.reduce((sum, row) => sum + row.rssKb, 0)),
    processes: ours.length,
    extensionProcessMb: mb(
      ours.filter((row) => row.command.includes("--extension-process")).reduce((sum, row) => sum + row.rssKb, 0),
    ),
  };
}

// ---------------------------------------------------------------------------------------------------
// Chrome for Testing, pinned by version and SHA-256

async function ensureChromeForTesting(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("The E2E pins Chrome for Testing for macOS arm64 (DESIGN v1 scope).");
  try {
    await stat(CFT_BINARY);
    return;
  } catch {
    // Download below.
  }
  await mkdir(CFT_DIR, { recursive: true });
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CFT.version}/${CFT.platform}/chrome-${CFT.platform}.zip`;
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== CFT.sha256) throw new Error(`Chrome for Testing SHA-256 is ${digest}, not ${CFT.sha256}`);
  const zip = join(CFT_DIR, "chrome.zip");
  await writeFile(zip, bytes);
  execFileSync("ditto", ["-x", "-k", zip, CFT_DIR]);
  await rm(zip);
}

// ---------------------------------------------------------------------------------------------------
// A small CDP client over --remote-debugging-pipe

interface CdpEvent {
  method: string;
  params: DynamicRecord;
  sessionId?: string;
}

class Cdp {
  readonly #write: Writable;
  #next = 1;
  readonly #pending = new Map<number, { resolve: (value: DynamicRecord) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();

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
      if (!waiter) return;
      if (isDynamicRecord(message.error)) waiter.reject(new Error(String(message.error.message)));
      else waiter.resolve(isDynamicRecord(message.result) ? message.result : {});
      return;
    }
    if (!isString(message.method)) return;
    const event: CdpEvent = {
      method: message.method,
      params: isDynamicRecord(message.params) ? message.params : {},
      ...(isString(message.sessionId) ? { sessionId: message.sessionId } : {}),
    };
    for (const listener of this.#listeners) listener(event);
  }

  /** Sends one command; no answer in `timeoutMs` rejects, so a target that died never hangs the run. */
  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<DynamicRecord> {
    const id = this.#next;
    this.#next += 1;
    const message = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
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

  on(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

// ---------------------------------------------------------------------------------------------------
// The app's side of the channel

class AppError extends Error {
  readonly code: ChromeBridgeErrorCode;
  constructor(code: ChromeBridgeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

interface SeenEvent {
  op: ChromeBridgeEvent;
  body: DynamicRecord;
  at: number;
}

class TestApp {
  readonly #path: string;
  #server: Server | null = null;
  #socket: Socket | null = null;
  #session: Established | null = null;
  #staticKey: Awaited<ReturnType<typeof generateChannelKey>> | null = null;
  #pinned: { installId: string; key: string } | null = null;
  #next = 1;
  readonly #pending = new Map<
    number,
    { op: ChromeBridgeOperation; resolve: (value: DynamicRecord) => void; reject: (error: Error) => void }
  >();
  readonly events: SeenEvent[] = [];
  readonly #eventWaiters = new Set<() => void>();
  connections = 0;
  closes = 0;
  framesIn = 0;
  framesOut = 0;
  bytesIn = 0;
  bytesOut = 0;
  codes: { chrome: PairingCode; app: PairingCode } | null = null;
  features: readonly string[] = [];

  constructor(path: string) {
    this.#path = path;
  }

  async listen(): Promise<void> {
    this.#staticKey = await generateChannelKey(true);
    this.#server = createServer((socket) => void this.#accept(socket));
    await new Promise<void>((done) => this.#server?.listen(this.#path, done));
    await chmod(this.#path, 0o600);
  }

  close(): void {
    this.#socket?.destroy();
    this.#server?.close();
  }

  /** Keeps the extension's key, as the app does after the person chose the words in the app. */
  pin(): void {
    const session = this.#session;
    if (session) this.#pinned = { installId: "", key: session.peerKey };
  }

  get open(): boolean {
    return this.#session !== null;
  }

  async #accept(socket: Socket): Promise<void> {
    this.#socket?.destroy();
    this.#socket = socket;
    this.#session = null;
    this.connections += 1;
    const staticKey = this.#staticKey;
    if (!staticKey) throw new Error("not listening");
    const handshake = await AppHandshake.create({
      staticKey,
      appVersion: "0.1.0",
      appInstanceId: randomBase64Url(16),
      features: CHROME_BRIDGE_FEATURES,
      pairing: this.#pinned ? "known" : "new",
    });
    let stage: "commit" | "hello" | "confirm" | "open" = "commit";
    let chain: Promise<void> = Promise.resolve();
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        this.framesIn += 1;
        this.bytesIn += 4 + length;
        const frame = JSON.parse(body.toString("utf8"));
        chain = chain.then(async () => {
          if (stage === "commit") {
            this.#send(socket, handshake.onCommit(frame));
            stage = "hello";
          } else if (stage === "hello") {
            const answer = await handshake.onHello(frame, (_installId, key) =>
              this.#pinned?.key === key ? "known" : "unknown",
            );
            if ("reject" in answer) {
              this.#send(socket, answer.reject);
              socket.end();
              return;
            }
            this.#send(socket, answer.confirm);
            stage = "confirm";
          } else if (stage === "confirm") {
            this.#session = await handshake.onConfirm(frame);
            this.codes = this.#session.codes;
            this.features = this.#session.features;
            stage = "open";
          } else {
            const session = this.#session;
            if (!session) return;
            const opened = await session.channel.open(frame);
            if (opened) this.#onMessage(opened.message);
          }
        });
        chain = chain.catch((error: unknown) => {
          report.protocolViolations.push(`app side: ${error instanceof Error ? error.message : String(error)}`);
          socket.destroy();
        });
      }
    });
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#session = null;
        this.closes += 1;
        for (const [id, waiter] of this.#pending) {
          waiter.reject(new AppError("chrome_not_connected", "the connection closed"));
          this.#pending.delete(id);
        }
        this.#notify();
      }
    });
    socket.on("error", () => undefined);
  }

  #send(socket: Socket, value: object): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.framesOut += 1;
    this.bytesOut += 4 + body.length;
    socket.write(Buffer.concat([head, body]));
  }

  #record(op: ChromeBridgeEvent, body: unknown): void {
    const value = isDynamicRecord(body) ? body : {};
    if (op === "cdp.event" && isString(value.method) && value.method.startsWith("Network."))
      report.networkEventsSeen += 1;
    this.events.push({ op, body: value, at: performance.now() });
    if (this.events.length > 20_000) this.events.splice(0, 10_000);
    this.#notify();
  }

  #notify(): void {
    for (const waiter of this.#eventWaiters) waiter();
  }

  #onMessage(message: unknown): void {
    const session = this.#session;
    if (!session) return;
    const record = (op: ChromeBridgeEvent) => (body: unknown) => this.#record(op, body);
    const resolve = (body: unknown, id: number) => {
      const waiter = this.#pending.get(id);
      this.#pending.delete(id);
      waiter?.resolve(isDynamicRecord(body) ? body : {});
    };
    const handlers: AppMessageHandlers<void> = {
      event: {
        ready: record("ready"),
        "cdp.event": record("cdp.event"),
        "tab.created": record("tab.created"),
        "tab.updated": record("tab.updated"),
        "tab.removed": record("tab.removed"),
        "tab.detached": record("tab.detached"),
        "tab.viewed": record("tab.viewed"),
        "tab.candidate": record("tab.candidate"),
        "tab.handed": record("tab.handed"),
        "tab.taken": record("tab.taken"),
        "tab.blocked": record("tab.blocked"),
        "tab.quarantined": record("tab.quarantined"),
        "tab.secret-present": record("tab.secret-present"),
        "group.removed": record("group.removed"),
        "group.moved": record("group.moved"),
        "group.renamed": record("group.renamed"),
        "group.shared": record("group.shared"),
        "user.stop": record("user.stop"),
        "user.resume": record("user.resume"),
        "user.unblock": record("user.unblock"),
        "pair.chrome-ok": record("pair.chrome-ok"),
        "ext.updating": record("ext.updating"),
        audit: record("audit"),
      },
      result: {
        "session.configure": resolve,
        "group.ensure": resolve,
        "group.update": resolve,
        "group.release": resolve,
        "lease.open": resolve,
        "lease.close": resolve,
        "tab.create": resolve,
        "tab.claim": resolve,
        "tab.release": resolve,
        "tab.close": resolve,
        "tab.activate": resolve,
        "tab.history": resolve,
        "tab.zoom": resolve,
        "tab.discard": resolve,
        "tab.mark": resolve,
        "cdp.send": resolve,
        "cdp.batch": resolve,
        "script.run": resolve,
        "secret.fill": resolve,
        "project.pause": resolve,
        "project.resume": resolve,
        "stop.all": resolve,
        resync: resolve,
        ping: resolve,
        "pair.done": resolve,
      },
      error: (error, id) => {
        const waiter = this.#pending.get(id);
        this.#pending.delete(id);
        waiter?.reject(new AppError(error.code, error.message));
      },
    };
    const decoded = decodeToApp(message, session.features, (id) => this.#pending.get(id)?.op, handlers);
    if (!decoded.ok) report.protocolViolations.push(`extension sent: ${decoded.error}`);
  }

  request<O extends ChromeBridgeOperation>(
    op: O,
    body: OperationBodies[O],
    timeoutMs = 45_000,
  ): Promise<DynamicRecord> {
    const session = this.#session;
    const socket = this.#socket;
    if (!session || !socket) return Promise.reject(new AppError("chrome_not_connected", "no session"));
    const checked = decodeOperationBody(op, body);
    if (!checked.ok) return Promise.reject(new Error(`the test sent a bad body: ${checked.error}`));
    const id = this.#next;
    this.#next += 1;
    return new Promise<DynamicRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppError("timeout", `${op} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        op,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      session.channel.seal({ t: "req", id, op, body }).then(
        (frames) => {
          for (const frame of frames) this.#send(socket, frame);
        },
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  /** Waits for an event after `since` that matches. */
  async waitEvent(op: ChromeBridgeEvent, match: (body: DynamicRecord) => boolean, timeoutMs: number, since = 0) {
    const found = () => this.events.find((event) => event.at >= since && event.op === op && match(event.body));
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const event = found();
      if (event) return event;
      const left = deadline - performance.now();
      if (left <= 0) throw new Failed(`no ${op} event in ${timeoutMs} ms`);
      await new Promise<void>((done) => {
        const wake = () => {
          this.#eventWaiters.delete(wake);
          clearTimeout(timer);
          done();
        };
        const timer = setTimeout(wake, left);
        this.#eventWaiters.add(wake);
      });
    }
  }

  async waitClosed(timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (this.#socket !== null) {
      if (performance.now() > deadline) throw new Failed("the extension did not close its connection");
      await sleep(25);
    }
  }
}

async function denied(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "allowed";
  } catch (error) {
    return error instanceof AppError ? error.code : `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const opaque = () => randomBase64Url(16);

// ---------------------------------------------------------------------------------------------------
// The run

async function main(): Promise<void> {
  const start = machine();
  report.machine = {
    ...start,
    ramGb: Math.round(Number(execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" })) / 1024 ** 3),
  };
  if (start.swapMb > MAX_SWAP_MB || start.freePercent < MIN_FREE_PERCENT) {
    report.notMeasured.push(
      `everything: swap ${start.swapMb} MB or free memory ${start.freePercent}% is past the limit`,
    );
    await writeReport();
    process.stdout.write("Refused to start: swap above 9 GB or free memory below 20%.\n");
    process.exit(2);
  }
  if (start.swapMb > HIGH_SWAP_MB && !processPerSite) {
    for (const size of loads.filter((size) => size > 25))
      report.notMeasured.push(
        `load ${size}: swap was ${start.swapMb} MB at the start (above 6 GB), so only loads up to 25 ran`,
      );
    loads = loads.filter((size) => size <= 25);
  }
  expect(EXTENSION_ID !== "", "contracts have no E2E extension id");
  await ensureChromeForTesting();
  const extensionDir = await buildChromeExtension("e2e");

  const work = await mkdtemp(join(tmpdir(), "bb-chrome-e2e-"));
  await chmod(work, 0o700);
  const profile = join(work, "profile");
  if (profile.includes("Library/Application Support"))
    throw new Error("The test profile must be a new temporary folder.");
  const socketPath = join(work, "app.sock");
  const relay = join(work, "relay.sh");
  await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
  await writeFile(
    relay,
    `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "scripts/chrome-extension-e2e-relay.ts")}" --socket "${socketPath}" --origin "${extensionOrigin(EXTENSION_ID)}" "$@"\n`,
  );
  await chmod(relay, 0o700);
  await writeFile(
    join(profile, "NativeMessagingHosts", `${NATIVE_HOST_NAMES.e2e}.json`),
    JSON.stringify({
      name: NATIVE_HOST_NAMES.e2e,
      description: "Builders Bot E2E stand-in host",
      path: relay,
      type: "stdio",
      allowed_origins: [extensionOrigin(EXTENSION_ID)],
    }),
  );

  // Local pages, 127.0.0.1 only. Hosts of the floor and a control host resolve to it inside the test
  // Chrome only (--host-resolver-rules), so a request that is not blocked reaches this server.
  const hits: { host: string; path: string }[] = [];
  const page = (body: string) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`,
      {
        headers: { "content-type": "text/html" },
      },
    );
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      hits.push({ host: request.headers.get("host") ?? "", path: url.pathname + url.search });
      const bank = `http://www.itau.com.br:${port}`;
      switch (url.pathname) {
        case "/many":
          return page(Array.from({ length: 200 }, (_, index) => `<button>Button ${index}</button>`).join(""));
        case "/bank-redirect":
          return new Response(null, { status: 302, headers: { location: `${bank}/after-redirect` } });
        case "/bank-frame":
          return page(`<p>frame</p><iframe src="${bank}/in-frame"></iframe>`);
        case "/bank-sub-frame":
          return page(`<p>frame</p><iframe src="http://sub.itau.com.br:${port}/in-frame"></iframe>`);
        case "/pw":
          // A filled password, as Chrome's password manager leaves it.
          return page(
            `<input type="password" id="p"><script>document.getElementById("p").value = "s3cret-e2e"</script>`,
          );
        case "/pw-frame":
          return page(`<p>shop</p><iframe src="http://control.test:${port}/pw"></iframe>`);
        case "/plain-frame":
          return page(`<p>shop</p><iframe src="http://control.test:${port}/page?frame=1"></iframe>`);
        case "/secure":
          return page(
            `<input type="password" id="pw" autocomplete="current-password"><input id="plain" aria-label="Name"><p>secure page</p>`,
          );
        case "/shadow-pw":
          // A password inside an open shadow root, as a web component login form holds it.
          return page(
            `<div id="host"></div><script>const root = document.getElementById("host").attachShadow({ mode: "open" }); root.innerHTML = '<input type="password">'; root.querySelector("input").value = "s3cret-shadow"</script>`,
          );
        case "/same-site-frames":
          return page(
            `<input type="password" id="p"><script>document.getElementById("p").value = "s3cret-e2e"</script>` +
              `<iframe src="/f"></iframe><iframe src="/f"></iframe><iframe src="/f"></iframe>`,
          );
        default:
          return page(`<p>${url.pathname}</p>`);
      }
    },
  });
  port = server.port ?? 0;
  const base = `http://127.0.0.1:${port}`;
  const bankHits = () => hits.filter((hit) => hit.host.includes("itau.com.br")).length;

  const app = new TestApp(socketPath);
  await app.listen();

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
    "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,MediaRouter,OptimizationHints",
    "--host-resolver-rules=MAP itau.com.br 127.0.0.1, MAP *.itau.com.br 127.0.0.1, MAP control.test 127.0.0.1, MAP blocked-by-app.test 127.0.0.1",
    ...(headed ? [] : ["--headless=new"]),
    ...(processPerSite ? ["--process-per-site"] : []),
    "about:blank",
  ];
  await mkdir(OUT, { recursive: true });
  const chrome: ChildProcess = spawn(CFT_BINARY, chromeArgs, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  // An interrupted run still stops its Chrome and deletes its profile.
  const abort = () => {
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
    process.exit(130);
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const chromeLog: string[] = [];
  chrome.stderr?.setEncoding("utf8");
  chrome.stderr?.on("data", (text: string) => {
    chromeLog.push(text);
    if (chromeLog.length > 400) chromeLog.splice(0, 200);
  });
  const [, , , pipeIn, pipeOut] = chrome.stdio;
  if (!pipeIn || !pipeOut || !("write" in pipeIn) || !("setEncoding" in pipeOut))
    throw new Error("Chrome has no debugging pipe");
  const cdp = new Cdp(pipeIn, pipeOut);

  const targets = new Map<string, { type: string; url: string }>();
  const extensionUrl = `chrome-extension://${EXTENSION_ID}/`;
  /** Stops of the extension's own worker, as Chrome reports its target gone. */
  const workerDestroyed: { targetId: string; at: number }[] = [];
  cdp.on((event) => {
    const info = isDynamicRecord(event.params.targetInfo) ? event.params.targetInfo : null;
    if ((event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") && info) {
      if (isString(info.targetId) && isString(info.type) && isString(info.url))
        targets.set(info.targetId, { type: info.type, url: info.url });
    }
    if (event.method === "Target.targetDestroyed" && isString(event.params.targetId)) {
      const gone = targets.get(event.params.targetId);
      if (gone?.type === "service_worker" && gone.url.startsWith(extensionUrl))
        workerDestroyed.push({ targetId: event.params.targetId, at: performance.now() });
      targets.delete(event.params.targetId);
    }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const workerTarget = () =>
    [...targets.entries()].find(([, info]) => info.type === "service_worker" && info.url.startsWith(extensionUrl))?.[0];
  const waitFor = async <T>(read: () => T | undefined, ms: number, what: string): Promise<T> => {
    const deadline = performance.now() + ms;
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (performance.now() > deadline) throw new Failed(`${what} did not happen in ${ms} ms`);
      await sleep(50);
    }
  };

  const attach = async (targetId: string) => {
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    if (!isString(attached.sessionId)) throw new Error("no session");
    return attached.sessionId;
  };
  /** Runs an expression in a page; each expression of this script gives an object. */
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

  const stopChrome = async () => {
    await cdp.send("Browser.close").catch(() => undefined);
    await sleep(500);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  };

  try {
    let worker = await waitFor(workerTarget, 10_000, "the extension worker").catch(() => undefined);
    if (worker === undefined) {
      await cdp.send("Extensions.loadUnpacked", { path: extensionDir });
      worker = await waitFor(workerTarget, 10_000, "the extension worker");
    }
    report.machine.chromeStarted = machine();

    // An extension page, to read Chrome's state through `chrome.*` without touching the worker.
    const created = await cdp.send("Target.createTarget", { url: `${extensionUrl}popup.html`, background: true });
    if (!isString(created.targetId)) throw new Error("no inspector page");
    const inspectorTarget = created.targetId;
    let inspector = await attach(inspectorTarget);
    const inspect = (code: string) => evaluate(inspector, `(async () => { ${code} })()`);
    await sleep(300);

    // Page code reaches a tab only as an engine function, whose digest is in `cdp-functions.ts`. These
    // are the engine's own declarations (`src/backend/browser-cdp-values.ts`), and the run checks that
    // the table holds them.
    const READY = "function() { return document.readyState !== 'loading'; }";
    const ENGINE_WORLD = "openbot-browser-automation";
    const resultOf = (answer: DynamicRecord): DynamicRecord => (isDynamicRecord(answer.result) ? answer.result : {});
    /** A command that reaches the tab and changes nothing. */
    const probe = (handle: string) => app.request("cdp.send", { handle, method: "Target.getTargetInfo", params: {} });
    /** The tab's address and title, from Chrome. */
    const tabInfo = async (handle: string) => {
      const info = resultOf(await probe(handle)).targetInfo;
      const record = isDynamicRecord(info) ? info : {};
      return { url: isString(record.url) ? record.url : "", title: isString(record.title) ? record.title : "" };
    };
    /** The engine's world in the top frame of the tab, as `automationContextId` makes it. */
    const engineWorld = async (handle: string): Promise<number> => {
      const tree = resultOf(await app.request("cdp.send", { handle, method: "Page.getFrameTree", params: {} }));
      const frame =
        isDynamicRecord(tree.frameTree) && isDynamicRecord(tree.frameTree.frame) ? tree.frameTree.frame : {};
      const world = resultOf(
        await app.request("cdp.send", {
          handle,
          method: "Page.createIsolatedWorld",
          params: { frameId: String(frame.id), worldName: ENGINE_WORLD },
        }),
      );
      if (!isNumber(world.executionContextId)) throw new Failed("no engine world");
      return world.executionContextId;
    };
    /** The engine's `READY` function in a context of the tab: whether the document has parsed. */
    const engineReady = async (handle: string, contextId: number): Promise<boolean> => {
      const answer = resultOf(
        await app.request("cdp.send", {
          handle,
          method: "Runtime.callFunctionOn",
          params: { functionDeclaration: READY, executionContextId: contextId, arguments: [], returnByValue: true },
        }),
      );
      return isDynamicRecord(answer.result) && answer.result.value === true;
    };
    /**
     * The page itself runs a script, outside the gate (a page that navigates or changes a field by
     * itself). The extension page sends it on the extension's own debugger session of that tab.
     */
    const pageRuns = (urlPart: string, expression: string) =>
      inspect(`
        const [tab] = (await chrome.tabs.query({})).filter((t) => (t.url ?? "").includes(${JSON.stringify(urlPart)}));
        if (!tab) throw new Error("no tab for ${urlPart}");
        const answer = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: ${JSON.stringify(expression)}, returnByValue: true });
        return { value: answer?.result?.value ?? null };`);

    const project = { a: opaque(), b: opaque(), c: opaque() };
    const lease = { one: opaque(), two: opaque(), three: opaque(), four: opaque() };
    const handles: string[] = [];
    let h1 = "";
    let hBeta = "";

    // ---------------------------------------------------------------------------------------------
    await testCase("pairing: words chosen in the welcome page; nothing typed; ops refused before", async () => {
      await waitFor(() => (app.open ? true : undefined), 15_000, "the handshake");
      const codes = app.codes;
      expect(codes !== null, "no pairing codes");
      const refusedBefore = await denied(
        app.request("session.configure", {
          limits: { tabsPerLease: 4, tabsPerProject: 12, tabsTotal: 12 },
          ratePerOrigin: { perOriginPerMinute: 30, perProjectPerMinute: 120 },
          policyAdd: [],
          projects: [],
        }),
      );
      expect(refusedBefore === "consent_required", "an op was accepted before the pairing", refusedBefore);
      const welcomeId = await waitFor(
        () =>
          [...targets.entries()].find(
            ([, info]) => info.type === "page" && info.url.startsWith(`${extensionUrl}welcome.html`),
          )?.[0],
        10_000,
        "the welcome page",
      );
      const welcome = await attach(welcomeId);
      const appWords = codes?.app.join(" · ") ?? "";
      const chromeWords = codes?.chrome.join(" · ") ?? "";
      let page: unknown = null;
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        page = await evaluate(
          welcome,
          `({ words: document.querySelector(".words")?.textContent ?? "", options: [...document.querySelectorAll("button.choice")].map((b) => b.textContent) })`,
        );
        if (isDynamicRecord(page) && Array.isArray(page.options) && page.options.length === 3) break;
        await sleep(200);
      }
      expect(
        isDynamicRecord(page) && page.words === chromeWords,
        "the welcome shows other words than the app computed",
        page,
      );
      const options = isDynamicRecord(page) && Array.isArray(page.options) ? page.options : [];
      expect(options.includes(appWords), "the right words are not among the options", { options, appWords });
      const since = performance.now();
      await evaluate(
        welcome,
        `[...document.querySelectorAll("button.choice")].find((b) => b.textContent === ${JSON.stringify(appWords)}).click()`,
      );
      await app.waitEvent("pair.chrome-ok", () => true, 5_000, since);
      const ready = await app.waitEvent("ready", () => true, 5_000, since);
      app.pin();
      await app.request("pair.done", {});
      report.extension.features = [...app.features];
      return {
        chromeWords,
        options,
        appWords,
        readyMs: Math.round(ready.at - since),
        refusedBefore,
        features: app.features,
      };
    });

    await app.request("session.configure", {
      limits: { tabsPerLease: 4, tabsPerProject: 12, tabsTotal: 12 },
      ratePerOrigin: { perOriginPerMinute: 600, perProjectPerMinute: 2400 },
      policyAdd: ["blocked-by-app.test"],
      projects: [
        { projectKey: project.a, title: "Projeto Alfa", color: "green" },
        { projectKey: project.b, title: "Cliente Beta‮ · site", color: "purple" },
        { projectKey: project.c, title: "Projeto Alfa", color: "cyan" },
      ],
    });

    await testCase(
      "group: named after the project, in its color; a person's group of the same name is left alone; no focus taken",
      async () => {
        const person = await inspect(`
        const tab = await chrome.tabs.create({ url: "about:blank", active: false });
        const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(groupId, { title: "Projeto Alfa", color: "red" });
        return { groupId, tabId: tab.id };`);
        expect(isDynamicRecord(person) && isNumber(person.groupId), "could not make the person's group");
        const personGroup = isDynamicRecord(person) && isNumber(person.groupId) ? person.groupId : -1;
        const focusBefore = await inspect(`
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const windows = await chrome.windows.getAll({});
        return { activeTab: active?.id ?? null, focused: windows.filter((w) => w.focused).map((w) => w.id) };`);
        await app.request("lease.open", {
          leaseId: lease.one,
          projectKey: project.a,
          agentLabel: "Agente Um",
          initials: "A1",
        });
        const started = performance.now();
        const createdTab = await app.request("tab.create", { leaseId: lease.one, url: `${base}/page?i=1` });
        const createMs = Math.round(performance.now() - started);
        expect(isString(createdTab.handle), "no handle");
        h1 = String(createdTab.handle);
        handles.push(h1);
        await app.request("lease.open", {
          leaseId: lease.two,
          projectKey: project.b,
          agentLabel: "Agente Dois",
          initials: "B2",
        });
        const beta = await app.request("tab.create", { leaseId: lease.two, url: `${base}/page?i=beta` });
        hBeta = String(beta.handle);
        handles.push(hBeta);
        await app.request("lease.open", {
          leaseId: lease.three,
          projectKey: project.c,
          agentLabel: "Agente Três",
          initials: "C3",
        });
        const gamma = await app.request("tab.create", { leaseId: lease.three, url: `${base}/page?i=gamma` });
        handles.push(String(gamma.handle));
        await sleep(300);
        const groups = await inspect(`
        const groups = await chrome.tabGroups.query({});
        const out = [];
        for (const g of groups) out.push({ id: g.id, title: g.title, color: g.color, tabs: (await chrome.tabs.query({ groupId: g.id })).map((t) => t.url) });
        return { groups: out };`);
        const list = Array.isArray(groups.groups) ? groups.groups.filter(isDynamicRecord) : [];
        const ours = list.filter((group) => group.id !== personGroup);
        const alpha = ours.find((group) => group.title === "Projeto Alfa");
        const betaGroup = ours.find((group) => isString(group.title) && group.title.startsWith("Cliente Beta"));
        const gammaGroup = ours.find((group) => group.title === "Projeto Alfa (2)");
        const personNow = list.find((group) => group.id === personGroup);
        expect(alpha?.color === "green", "the project group has another title or color", list);
        expect(
          Array.isArray(alpha?.tabs) && alpha.tabs.length === 1,
          "the project group does not hold exactly the agent tab",
          alpha,
        );
        expect(
          betaGroup?.color === "purple" && betaGroup.title === "Cliente Beta · site",
          "the bidi control was not removed from the title",
          betaGroup,
        );
        expect(gammaGroup?.color === "cyan", "two projects with the same name are not told apart", list);
        expect(
          personNow?.title === "Projeto Alfa" &&
            personNow.color === "red" &&
            Array.isArray(personNow.tabs) &&
            personNow.tabs.length === 1,
          "the person's group changed",
          personNow,
        );
        const focusAfter = await inspect(`
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const windows = await chrome.windows.getAll({});
        return { activeTab: active?.id ?? null, focused: windows.filter((w) => w.focused).map((w) => w.id) };`);
        expect(
          JSON.stringify(focusAfter) === JSON.stringify(focusBefore),
          "the active tab or the focused window changed",
          { focusBefore, focusAfter },
        );
        return { createMs, groups: list, focusBefore, focusAfter };
      },
    );

    await testCase("turns: the same tab and group across turns, no new tab, debugger kept within a turn", async () => {
      const tabsBefore = await inspect(`return { count: (await chrome.tabs.query({})).length };`);
      const groupBefore = await inspect(
        `return { id: (await chrome.tabGroups.query({})).find((g) => g.title === "Projeto Alfa" && g.color === "green")?.id ?? null };`,
      );
      const first = await tabInfo(h1);
      const since = performance.now();
      await app.request("lease.close", { leaseId: lease.one });
      await app.waitEvent("tab.detached", (body) => body.handle === h1 && body.reason === "lease_end", 5_000, since);
      await app.request("lease.open", {
        leaseId: lease.one,
        projectKey: project.a,
        agentLabel: "Agente Um",
        initials: "A1",
      });
      const startedTurn = performance.now();
      const secondInfo = await tabInfo(h1);
      const firstCommandMs = Math.round(performance.now() - startedTurn);
      const secondUrl = new URL(secondInfo.url);
      const second = secondUrl.pathname + secondUrl.search;
      const warmWorld = await engineWorld(h1);
      const warm: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const at = performance.now();
        await engineReady(h1, warmWorld);
        warm.push(performance.now() - at);
      }
      const detachesWithinTurn = app.events.filter(
        (event) => event.at > startedTurn && event.op === "tab.detached" && event.body.handle === h1,
      ).length;
      const tabsAfter = await inspect(`return { count: (await chrome.tabs.query({})).length };`);
      const groupAfter = await inspect(
        `return { id: (await chrome.tabGroups.query({})).find((g) => g.title === "Projeto Alfa" && g.color === "green")?.id ?? null };`,
      );
      expect(tabsBefore.count === tabsAfter.count, "a turn made a new tab", { tabsBefore, tabsAfter });
      expect(isNumber(groupBefore.id) && groupBefore.id === groupAfter.id, "the group changed between turns", {
        groupBefore,
        groupAfter,
      });
      expect(second === "/page?i=1", "the next turn did not reach the same page", second);
      expect(detachesWithinTurn === 0, "the debugger left the tab inside a turn");
      return {
        firstTitle: first.title,
        secondTurnPage: second,
        firstCommandOfTurnMs: firstCommandMs,
        warmCommandMs: stats(warm),
        tabsBefore,
        tabsAfter,
        groupBefore,
        groupAfter,
      };
    });

    await testCase(
      "closed lists: methods, parameters, scopes and limits are refused; no Network event leaves",
      async () => {
        const results = {
          getAllCookies: await denied(
            app.request("cdp.send", { handle: h1, method: "Network.getAllCookies", params: {} }),
          ),
          storage: await denied(app.request("cdp.send", { handle: h1, method: "Storage.getCookies", params: {} })),
          fetchEnable: await denied(app.request("cdp.send", { handle: h1, method: "Fetch.enable", params: {} })),
          networkOutsideNavigation: await denied(
            app.request("cdp.send", { handle: h1, method: "Network.enable", params: {} }),
          ),
          pasteCommand: await denied(
            app.request("cdp.send", {
              handle: h1,
              method: "Input.dispatchKeyEvent",
              params: { type: "keyDown", commands: ["paste"] },
            }),
          ),
          commandLineApi: await denied(
            app.request("cdp.send", {
              handle: h1,
              method: "Runtime.evaluate",
              params: { expression: "1", includeCommandLineAPI: true },
            }),
          ),
          autoAttachNoFilter: await denied(
            app.request("cdp.send", {
              handle: h1,
              method: "Target.setAutoAttach",
              params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            }),
          ),
          unknownParameter: await denied(
            app.request("cdp.send", { handle: h1, method: "Page.reload", params: { scriptToEvaluateOnLoad: "1" } }),
          ),
          prototypeKey: await denied(
            app.request("cdp.send", { handle: h1, method: "Page.reload", params: { constructor: 1 } }),
          ),
          strangerSession: await denied(
            app.request("cdp.send", {
              handle: h1,
              method: "Runtime.evaluate",
              params: { expression: "1" },
              session: "ABCDEF0123456789",
            }),
          ),
          unknownHandle: await denied(
            app.request("cdp.send", { handle: opaque(), method: "Runtime.evaluate", params: { expression: "1" } }),
          ),
          navigateFrameId: await denied(
            app.request("cdp.send", {
              handle: h1,
              method: "Page.navigate",
              params: { url: `${base}/x`, frameId: "1" },
            }),
          ),
          pasteKey: await denied(
            app.request("cdp.send", {
              handle: h1,
              method: "Input.dispatchKeyEvent",
              params: { type: "keyDown", key: "v", code: "KeyV", modifiers: 4 },
            }),
          ),
        };
        const expected: { [key in keyof typeof results]: string } = {
          getAllCookies: "method_denied",
          storage: "method_denied",
          fetchEnable: "method_denied",
          networkOutsideNavigation: "method_denied",
          pasteCommand: "param_denied",
          commandLineApi: "param_denied",
          autoAttachNoFilter: "param_denied",
          unknownParameter: "param_denied",
          prototypeKey: "param_denied",
          strangerSession: "out_of_scope",
          unknownHandle: "out_of_scope",
          navigateFrameId: "param_denied",
          pasteKey: "param_denied",
        };
        expect(JSON.stringify(results) === JSON.stringify(expected), "a denial differs", { results, expected });
        // Navigation inside a batch may enable the network domain, with no buffer, and its events stay inside.
        const batch = await app.request("cdp.batch", {
          handle: h1,
          commands: [
            { method: "Network.enable", params: { maxTotalBufferSize: 0 } },
            { method: "Network.setCacheDisabled", params: { cacheDisabled: true } },
            { method: "Page.navigate", params: { url: `${base}/page?i=1&network=1` } },
            { method: "Network.disable", params: {} },
          ],
        });
        await sleep(800);
        expect(report.networkEventsSeen === 0, "a Network event reached the app");
        // A fragment can carry a token: results name the document URL without it.
        await app.request("cdp.send", {
          handle: h1,
          method: "Page.navigate",
          params: { url: `${base}/page?i=1#access_token=not-for-agents` },
        });
        const documentAnswer = await app.request("cdp.send", {
          handle: h1,
          method: "DOM.getDocument",
          params: { depth: 0 },
        });
        const root =
          isDynamicRecord(documentAnswer.result) && isDynamicRecord(documentAnswer.result.root)
            ? documentAnswer.result.root
            : {};
        expect(
          isString(root.documentURL) && !root.documentURL.includes("#"),
          "a document URL left with its fragment",
          root.documentURL,
        );
        // The per-agent limit: 4 tabs for one lease, the fifth is refused at once.
        await app.request("lease.open", {
          leaseId: lease.four,
          projectKey: project.b,
          agentLabel: "Agente Quatro",
          initials: "D4",
        });
        const made: string[] = [];
        for (let index = 0; index < 4; index += 1)
          made.push(String((await app.request("tab.create", { leaseId: lease.four, url: "about:blank" })).handle));
        const fifthStarted = performance.now();
        const fifth = await denied(app.request("tab.create", { leaseId: lease.four, url: "about:blank" }));
        const fifthMs = Math.round(performance.now() - fifthStarted);
        for (const handle of made) await app.request("tab.close", { handle });
        expect(fifth === "limit", "the fifth tab of one agent was not refused", fifth);
        return {
          results,
          batch,
          networkEventsSeen: report.networkEventsSeen,
          fifthTab: fifth,
          fifthRefusedMs: fifthMs,
        };
      },
    );

    await testCase(
      "floor: a bank is blocked by the gate, in page navigations, redirects and frames; the control host is not",
      async () => {
        const bank = `http://www.itau.com.br:${port}`;
        const tabsBefore = await inspect(`return { count: (await chrome.tabs.query({})).length };`);
        const createBank = await denied(app.request("tab.create", { leaseId: lease.one, url: `${bank}/` }));
        const tabsAfterCreate = await inspect(`return { count: (await chrome.tabs.query({})).length };`);
        const navigateBank = await denied(
          app.request("cdp.send", { handle: h1, method: "Page.navigate", params: { url: `${bank}/login` } }),
        );
        const navigateAppBlock = await denied(
          app.request("cdp.send", {
            handle: h1,
            method: "Page.navigate",
            params: { url: `http://blocked-by-app.test:${port}/` },
          }),
        );
        const control = await app.request("cdp.send", {
          handle: h1,
          method: "Page.navigate",
          params: { url: `http://control.test:${port}/control` },
        });
        await sleep(500);
        const controlHits = hits.filter((hit) => hit.host.startsWith("control.test")).length;
        const redirect = await app.request("cdp.send", {
          handle: h1,
          method: "Page.navigate",
          params: { url: `${base}/bank-redirect` },
        });
        const redirectError = isDynamicRecord(redirect.result) ? redirect.result.errorText : null;
        await app.request("cdp.send", { handle: h1, method: "Page.navigate", params: { url: `${base}/control-back` } });
        const frame = await app.request("cdp.send", {
          handle: h1,
          method: "Page.navigate",
          params: { url: `${base}/bank-frame` },
        });
        await sleep(800);
        const since = performance.now();
        await pageRuns("/bank-frame", `location.href = ${JSON.stringify(`${bank}/by-page`)}; 1`);
        const blocked = await app.waitEvent("tab.blocked", (body) => body.handle === h1, 5_000, since);
        const afterBlock = await denied(probe(h1));
        // The way out of quarantine: back in history, or, when Chrome has no entry to go back to (its
        // history intervention skips an entry left without a user gesture), close and open a new tab.
        const back = await denied(app.request("tab.history", { handle: h1, action: "back" }));
        let exit = "back";
        if (back !== "allowed") {
          exit = `closed (back: ${back})`;
          await app.request("tab.close", { handle: h1 });
          h1 = String((await app.request("tab.create", { leaseId: lease.one, url: `${base}/page?i=1` })).handle);
          handles.push(h1);
        }
        await sleep(800);
        const afterBack = await denied(probe(h1));
        const appBlockedByPage = hits.filter((hit) => hit.host.startsWith("blocked-by-app.test")).length;
        const rules = await inspect(
          `return { rules: (await chrome.declarativeNetRequest.getSessionRules()).map((r) => ({ id: r.id, action: r.action.type, tabs: r.condition.tabIds?.length ?? 0, domains: r.condition.requestDomains?.length ?? 0 })) };`,
        );
        expect(
          createBank === "site_blocked" && tabsBefore.count === tabsAfterCreate.count,
          "a tab was made for the bank",
          {
            createBank,
            tabsBefore,
            tabsAfterCreate,
          },
        );
        expect(
          navigateBank === "site_blocked" && navigateAppBlock === "site_blocked",
          "a navigation to the floor passed the gate",
          { navigateBank, navigateAppBlock },
        );
        expect(controlHits > 0, "the control host was not reached, so the absence of bank requests proves nothing");
        expect(
          redirectError === "net::ERR_BLOCKED_BY_CLIENT",
          "the redirect to the bank was not blocked by the rule",
          redirect,
        );
        expect(
          bankHits() === 0,
          "a request reached the bank host",
          hits.filter((hit) => hit.host.includes("itau")),
        );
        expect(afterBlock === "site_blocked", "the tab on the bank page still took commands", afterBlock);
        expect(afterBack === "allowed", "the tab did not come back after it left the bank page", afterBack);
        expect(appBlockedByPage === 0, "an app-added block was reached");
        return {
          createBank,
          navigateBank,
          navigateAppBlock,
          control: control.result,
          controlHits,
          redirectError,
          frame: frame.result,
          pageNavigation: blocked.body,
          afterBlock,
          exit,
          afterBack,
          bankRequestsThatReachedTheServer: bankHits(),
          rules,
        };
      },
    );

    await testCase(
      "floor per project: the popup allows a blocked site for one project only, then blocks it again",
      async () => {
        const bank = `http://www.itau.com.br:${port}`;
        await cdp.send("Page.reload", {}, inspector).catch(() => undefined);
        await sleep(600);
        const offered = await evaluate(
          inspector,
          `(async () => {
          const row = [...document.querySelectorAll("section.floor .row")].find((r) => r.querySelector("span")?.textContent === ${JSON.stringify(bank)});
          const allow = row?.querySelector("button");
          if (!allow) return { found: false };
          allow.click();
          await new Promise((done) => setTimeout(done, 300));
          return { found: true, options: [...document.querySelectorAll("button.choice")].map((b) => b.textContent) };
        })()`,
        );
        expect(offered.found === true, "the popup shows no blocked site to allow", offered);
        const options = Array.isArray(offered.options) ? offered.options.filter(isString) : [];
        expect(
          options.length === 3 && options.includes(bank),
          "the popup does not offer the site among three",
          options,
        );
        const since = performance.now();
        await evaluate(
          inspector,
          `[...document.querySelectorAll("button.choice")].find((b) => b.textContent === ${JSON.stringify(bank)}).click()`,
        );
        const unblock = await app.waitEvent("user.unblock", (body) => body.origin === bank, 5_000, since);
        const hitsBefore = bankHits();
        const allowed = await denied(
          app.request("cdp.send", { handle: h1, method: "Page.navigate", params: { url: `${bank}/allowed` } }),
        );
        await sleep(500);
        const reached = bankHits() - hitsBefore;
        // The unlock is for one origin: a subdomain of the same bank in a frame stays blocked before it leaves.
        const subHits = () => hits.filter((hit) => hit.host.startsWith("sub.itau.com.br")).length;
        const subBefore = subHits();
        await app.request("cdp.send", {
          handle: h1,
          method: "Page.navigate",
          params: { url: `${base}/bank-sub-frame` },
        });
        await sleep(800);
        const subdomainHits = subHits() - subBefore;
        const otherProject = await denied(
          app.request("cdp.send", { handle: hBeta, method: "Page.navigate", params: { url: `${bank}/other` } }),
        );
        await app.request("cdp.send", { handle: h1, method: "Page.navigate", params: { url: `${base}/page?i=1` } });
        await cdp.send("Page.reload", {}, inspector).catch(() => undefined);
        await sleep(600);
        await evaluate(
          inspector,
          `[...document.querySelectorAll("section.floor .row")].find((r) => r.querySelector("span")?.textContent === ${JSON.stringify(bank)}).querySelector("button").click()`,
        );
        await sleep(300);
        const blockedAgain = await denied(
          app.request("cdp.send", { handle: h1, method: "Page.navigate", params: { url: `${bank}/again` } }),
        );
        expect(allowed === "allowed" && reached > 0, "the allowed site was not reached", { allowed, reached });
        expect(subdomainHits === 0, "a subdomain of the allowed origin was reached", { subdomainHits });
        expect(
          otherProject === "site_blocked",
          "another project reached the site that one project allowed",
          otherProject,
        );
        expect(blockedAgain === "site_blocked", "Block again did not block", blockedAgain);
        return {
          options,
          unblock: unblock.body,
          allowed,
          requestsThatReachedTheSite: reached,
          subdomainHits,
          otherProject,
          blockedAgain,
        };
      },
    );

    await testCase("tab closed by the person and a crashed tab are reported", async () => {
      const second = String((await app.request("tab.create", { leaseId: lease.one, url: `${base}/page?i=2` })).handle);
      await sleep(300);
      const since = performance.now();
      await inspect(
        `const [tab] = (await chrome.tabs.query({})).filter((t) => (t.url ?? "").includes("page?i=2")); await chrome.tabs.remove(tab.id); return { id: tab.id };`,
      );
      const removed = await app.waitEvent("tab.removed", (body) => body.handle === second, 5_000, since);
      const afterClose = await denied(probe(second));
      const third = String((await app.request("tab.create", { leaseId: lease.one, url: `${base}/page?i=3` })).handle);
      await probe(third);
      const crashTarget = await waitFor(
        () => [...targets.entries()].find(([, info]) => info.type === "page" && info.url.includes("page?i=3"))?.[0],
        5_000,
        "the target of the third tab",
      );
      const crashSession = await attach(crashTarget);
      const crashSince = performance.now();
      // The renderer dies before it can answer: send and do not wait.
      void cdp.send("Page.crash", {}, crashSession, 2_000).catch(() => undefined);
      const crashed = await app.waitEvent(
        "tab.detached",
        (body) => body.handle === third && body.reason === "target_closed",
        5_000,
        crashSince,
      );
      const unloaded = app.events.find(
        (event) =>
          event.at >= crashSince &&
          event.op === "tab.updated" &&
          event.body.handle === third &&
          event.body.status === "unloaded",
      );
      await app.request("tab.close", { handle: third });
      expect(removed.body.by === "person", "the close was not put on the person", removed.body);
      expect(afterClose === "out_of_scope", "a closed tab still took commands", afterClose);
      return {
        removed: removed.body,
        afterClose,
        crashed: crashed.body,
        crashReportedAsUnloaded: unloaded !== undefined,
      };
    });

    await testCase(
      "secret check: a password in a frame of another site, and after a navigation to another site, blocks reads",
      async () => {
        await app.request("lease.open", {
          leaseId: lease.one,
          projectKey: project.a,
          agentLabel: "Agente Um",
          initials: "A1",
        });
        const secretTab = String(
          (await app.request("tab.create", { leaseId: lease.one, url: `${base}/page?secret=1` })).handle,
        );
        // A clean read first: the check runs here, on this site.
        await sleep(800);
        const clean = await app.request("cdp.send", {
          handle: secretTab,
          method: "Page.captureScreenshot",
          params: { format: "jpeg", quality: 10 },
        });
        expect(isDynamicRecord(clean.result), "a clean page refused the screenshot", clean);
        // A frame of another site with no secret: the check reaches it, and the reads pass.
        await app.request("cdp.send", {
          handle: secretTab,
          method: "Page.navigate",
          params: { url: `${base}/plain-frame` },
        });
        await sleep(1_500);
        const plainShot = await denied(
          app.request("cdp.send", {
            handle: secretTab,
            method: "Page.captureScreenshot",
            params: { format: "jpeg", quality: 10 },
          }),
        );
        const plainTree = await denied(
          app.request("cdp.send", { handle: secretTab, method: "Accessibility.getFullAXTree", params: {} }),
        );
        await app.request("cdp.send", {
          handle: secretTab,
          method: "Page.navigate",
          params: { url: `${base}/pw-frame` },
        });
        await sleep(1_500);
        const inFrameShot = await denied(
          app.request("cdp.send", {
            handle: secretTab,
            method: "Page.captureScreenshot",
            params: { format: "jpeg", quality: 10 },
          }),
        );
        const inFrameTree = await denied(
          app.request("cdp.send", { handle: secretTab, method: "Accessibility.getFullAXTree", params: {} }),
        );
        // Another site, with frames of its own site: a context id from before names another document.
        await app.request("cdp.send", {
          handle: secretTab,
          method: "Page.navigate",
          params: { url: `http://control.test:${port}/same-site-frames` },
        });
        await sleep(1_500);
        const afterNavigation = await denied(
          app.request("cdp.send", {
            handle: secretTab,
            method: "Page.captureScreenshot",
            params: { format: "jpeg", quality: 10 },
          }),
        );
        await app.request("tab.close", { handle: secretTab });
        expect(
          plainShot === "allowed" && plainTree === "allowed",
          "a page with a frame of another site and no secret was refused",
          { plainShot, plainTree },
        );
        expect(inFrameShot === "secret_present", "a screenshot showed a password of a frame", inFrameShot);
        expect(inFrameTree === "secret_present", "the tree of a page with a filled frame was read", inFrameTree);
        expect(
          afterNavigation === "secret_present",
          "the check ran in an old world after a navigation",
          afterNavigation,
        );
        return { plainShot, plainTree, inFrameShot, inFrameTree, afterNavigation };
      },
    );

    await testCase(
      "security review 02/11: engine code only, the guard world, clipboard keys, closed results, secret.fill",
      async () => {
        await app.request("lease.open", {
          leaseId: lease.one,
          projectKey: project.a,
          agentLabel: "Agente Um",
          initials: "A1",
        });
        const tab = String(
          (await app.request("tab.create", { leaseId: lease.one, url: `${base}/secure#access_token=frag-secret` }))
            .handle,
        );
        await sleep(600);
        const send = (method: string, params: DynamicRecord = {}) =>
          app.request("cdp.send", { handle: tab, method, params });
        const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
        const found: { [key: string]: unknown } = {};
        // 1. Page code: only the engine's own functions, by digest. The agent's own code waits for scripts.
        found.readyIsEngine = ENGINE_FUNCTIONS.has(digest(READY));
        found.ownExpression = await denied(
          send("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
        );
        const world = await engineWorld(tab);
        found.ownFunction = await denied(
          send("Runtime.callFunctionOn", {
            functionDeclaration: "function() { return document.cookie; }",
            executionContextId: world,
            returnByValue: true,
          }),
        );
        found.engineFunction = await engineReady(tab, world).catch((error: unknown) =>
          error instanceof AppError ? error.code : "error",
        );
        // 6. The guard world: no command makes it, and no event names its context.
        await send("Page.captureScreenshot", { format: "jpeg", quality: 10 });
        found.guardWorld = await denied(
          send("Page.createIsolatedWorld", { frameId: String(world), worldName: "builders-bot-guard" }),
        );
        const tree = resultOf(await send("Page.getFrameTree"));
        const mainFrame =
          isDynamicRecord(tree.frameTree) && isDynamicRecord(tree.frameTree.frame) ? tree.frameTree.frame : {};
        found.guardWorldInFrame = await denied(
          send("Page.createIsolatedWorld", { frameId: String(mainFrame.id), worldName: "builders-bot-guard" }),
        );
        found.agentWorld = await denied(
          send("Page.createIsolatedWorld", { frameId: String(mainFrame.id), worldName: "builders-bot-agent" }),
        );
        const enabledSince = performance.now();
        await send("Runtime.enable");
        await sleep(300);
        const contexts = app.events
          .filter((event) => event.at >= enabledSince && event.op === "cdp.event" && event.body.handle === tab)
          .filter((event) => event.body.method === "Runtime.executionContextCreated")
          .map((event) => (isDynamicRecord(event.body.params) ? event.body.params.context : null))
          .filter(isDynamicRecord);
        // The page's world and the engine's world only: the guard world of the screenshot is not listed.
        found.contextsListed = contexts.length;
        found.isolatedContextsListed = contexts.filter(
          (context) => !(isDynamicRecord(context.auxData) && context.auxData.isDefault === true),
        ).length;
        // 3. Copy, cut and paste keys, in each spelling.
        const keys: Record<string, DynamicRecord> = {
          cmdC: { type: "rawKeyDown", key: "c", code: "KeyC", modifiers: 4 },
          ctrlX: { type: "rawKeyDown", windowsVirtualKeyCode: 88, modifiers: 2 },
          cmdVByMacCode: { type: "rawKeyDown", nativeVirtualKeyCode: 9, modifiers: 4 },
          shiftInsert: { type: "rawKeyDown", code: "Insert", modifiers: 8 },
          ctrlInsert: { type: "rawKeyDown", key: "Insert", modifiers: 2 },
          pasteKey: { type: "rawKeyDown", key: "Paste" },
        };
        const keyResults: { [key: string]: string } = {};
        for (const [name, params] of Object.entries(keys))
          keyResults[name] = await denied(send("Input.dispatchKeyEvent", params));
        found.keys = keyResults;
        // 6. A made-up object id: V8 writes `<isolate>.<context>.<object>`, and a context next to the
        // engine's is likely the guard world's. Only an object of a context that the tab may name passes.
        const documentNode = resultOf(await send("DOM.getDocument", { depth: 0 })).root;
        const resolved = resultOf(
          await send("DOM.resolveNode", {
            backendNodeId:
              isDynamicRecord(documentNode) && isNumber(documentNode.backendNodeId) ? documentNode.backendNodeId : 0,
            executionContextId: world,
          }),
        );
        const realObject =
          isDynamicRecord(resolved.object) && isString(resolved.object.objectId) ? resolved.object.objectId : "";
        const objectParts = /^(-?\d+)\.(\d+)\.(\d+)$/u.exec(realObject);
        found.objectIdForm = objectParts !== null && Number(objectParts[2]) === world;
        found.realObject = await denied(send("Runtime.getProperties", { objectId: realObject, ownProperties: true }));
        const forged: string[] = [];
        const listed = new Set([world, ...contexts.map((context) => context.id).filter(isNumber)]);
        for (let context = 1; context <= world + 4; context += 1)
          if (!listed.has(context))
            forged.push(await denied(send("Runtime.getProperties", { objectId: `${objectParts?.[1]}.${context}.1` })));
        found.forgedObjects = [...new Set(forged)];
        // 2. Results: no history, no fragment, closed fields.
        found.history = await denied(send("Page.getNavigationHistory"));
        const frameText = JSON.stringify(tree);
        found.frameTreeFragment = frameText.includes("frag-secret") || frameText.includes("urlFragment");
        found.targetInfoFragment = JSON.stringify(await probe(tab)).includes("frag-secret");
        found.axFragment = JSON.stringify(await send("Accessibility.getFullAXTree")).includes("frag-secret");
        // 5. `secret.fill` types only into a secret field that holds focus.
        const documentRoot = resultOf(await send("DOM.getDocument", { depth: -1 })).root;
        /** The node id of the element with this id attribute, from the DOM tree. */
        const nodeIdOf = (id: string): number => {
          const pending: unknown[] = [documentRoot];
          while (pending.length > 0) {
            const node = pending.pop();
            if (!isDynamicRecord(node)) continue;
            const attributes = Array.isArray(node.attributes) ? node.attributes : [];
            for (let index = 0; index + 1 < attributes.length; index += 2)
              if (attributes[index] === "id" && attributes[index + 1] === id && isNumber(node.nodeId))
                return node.nodeId;
            if (Array.isArray(node.children)) pending.push(...node.children);
            if (node.contentDocument !== undefined) pending.push(node.contentDocument);
          }
          return 0;
        };
        found.fieldNodes = { plain: nodeIdOf("plain"), pw: nodeIdOf("pw") };
        const origin = new URL(base).origin;
        found.fillPlain = await denied(
          app.request("secret.fill", {
            handle: tab,
            expectOrigin: origin,
            nodeId: nodeIdOf("plain"),
            text: "not-here",
          }),
        );
        found.plainValue = (await pageRuns("/secure", `document.getElementById("plain").value`)).value;
        found.fillPassword = await denied(
          app.request("secret.fill", {
            handle: tab,
            expectOrigin: origin,
            nodeId: nodeIdOf("pw"),
            text: "typed-secret",
          }),
        );
        // 4. A password that `secret.fill` typed: a masked read passes, a read of page values does not.
        found.screenshotAfterFill = await denied(send("Page.captureScreenshot", { format: "jpeg", quality: 10 }));
        found.engineReadAfterFill = await denied(
          send("Runtime.callFunctionOn", {
            functionDeclaration: READY,
            executionContextId: await engineWorld(tab),
            returnByValue: true,
          }),
        );
        found.domReadAfterFill = await denied(send("DOM.getDocument", { depth: 1 }));
        // 5. The page turns the typed field into a text field: a screenshot would show the value.
        await pageRuns("/secure", `document.getElementById("pw").type = "text"; 1`);
        // A change that the page makes by itself is seen once the last clean result (1 s) ends.
        await sleep(1_200);
        found.screenshotAfterTypeChange = await denied(send("Page.captureScreenshot", { format: "jpeg", quality: 10 }));
        // A password in an open shadow root counts too.
        await send("Page.navigate", { url: `${base}/shadow-pw` });
        await sleep(1_000);
        found.shadowPassword = await denied(send("Page.captureScreenshot", { format: "jpeg", quality: 10 }));
        await app.request("tab.close", { handle: tab });
        const expected: DynamicRecord = {
          readyIsEngine: true,
          ownExpression: "scripts_disabled",
          ownFunction: "scripts_disabled",
          engineFunction: true,
          guardWorld: "param_denied",
          guardWorldInFrame: "param_denied",
          agentWorld: "param_denied",
          isolatedContextsListed: 1,
          objectIdForm: true,
          realObject: "allowed",
          forgedObjects: ["param_denied"],
          keys: Object.fromEntries(Object.keys(keys).map((name) => [name, "param_denied"])),
          history: "method_denied",
          frameTreeFragment: false,
          targetInfoFragment: false,
          axFragment: false,
          fillPlain: "out_of_scope",
          plainValue: "",
          fillPassword: "allowed",
          screenshotAfterFill: "allowed",
          engineReadAfterFill: "secret_present",
          domReadAfterFill: "secret_present",
          screenshotAfterTypeChange: "secret_present",
          shadowPassword: "secret_present",
        };
        const differs = Object.entries(expected).filter(
          ([key, value]) => JSON.stringify(found[key]) !== JSON.stringify(value),
        );
        expect(differs.length === 0, "a security check differs", { differs: Object.fromEntries(differs), found });
        return found;
      },
    );

    await testCase("discard: a tab that Chrome discarded loads again before the next command reads it", async () => {
      await app.request("lease.open", {
        leaseId: lease.one,
        projectKey: project.a,
        agentLabel: "Agente Um",
        initials: "A1",
      });
      const discardTab = String(
        (await app.request("tab.create", { leaseId: lease.one, url: `${base}/discard-me` })).handle,
      );
      await probe(discardTab);
      // The end of the turn: the debugger leaves the tab, which can then be discarded.
      await app.request("lease.close", { leaseId: lease.one });
      await sleep(300);
      const discarded = await inspect(`
        const [tab] = (await chrome.tabs.query({})).filter((t) => (t.url ?? "").includes("/discard-me"));
        await chrome.tabs.discard(tab.id).catch(() => undefined);
        await new Promise((done) => setTimeout(done, 300));
        const now = await chrome.tabs.get(tab.id);
        return { discarded: now.discarded, status: now.status ?? null };`);
      expect(discarded.discarded === true, "Chrome did not discard the test tab", discarded);
      await app.request("lease.open", {
        leaseId: lease.one,
        projectKey: project.a,
        agentLabel: "Agente Um",
        initials: "A1",
      });
      // The document itself, not what the tab strip keeps of a discarded tab: its text and its title.
      const read = JSON.stringify(
        resultOf(
          await app.request("cdp.send", { handle: discardTab, method: "DOM.getDocument", params: { depth: -1 } }),
        ),
      );
      const info = await tabInfo(discardTab);
      const value = `${read.includes('"nodeValue":"/discard-me"') ? new URL(info.url).pathname : ""}|${info.title}`;
      await app.request("tab.close", { handle: discardTab });
      expect(value === "/discard-me|t", "the discarded tab answered with an empty page", { value, discarded });
      return { discarded, value };
    });

    await testCase(
      "Stop all in the popup: every agent stops, the app cannot undo it, Resume in the popup can",
      async () => {
        await cdp.send("Page.reload", {}, inspector).catch(() => undefined);
        await sleep(600);
        inspector = await attach(inspectorTarget).catch(() => inspector);
        const since = performance.now();
        await evaluate(inspector, `document.querySelector("button.danger").click()`);
        const stopped = await app.waitEvent(
          "user.stop",
          (body) => body.scope === "all" && body.source === "popup",
          5_000,
          since,
        );
        const whileStopped = await denied(probe(h1));
        const appResume = await denied(app.request("project.resume", { projectKey: project.a }));
        const stillStopped = await denied(probe(h1));
        const greyGroups = await inspect(
          `return { count: (await chrome.tabGroups.query({})).filter((g) => g.color === "grey").length };`,
        );
        await cdp.send("Page.reload", {}, inspector).catch(() => undefined);
        await sleep(600);
        const resumeSince = performance.now();
        await evaluate(inspector, `document.querySelector("button.primary").click()`);
        await app.waitEvent("user.resume", (body) => body.source === "popup", 5_000, resumeSince);
        const afterResume = await denied(probe(h1));
        expect(whileStopped === "paused_by_user" && stillStopped === "paused_by_user", "a command ran while stopped", {
          whileStopped,
          stillStopped,
        });
        expect(afterResume === "allowed", "Resume did not let commands run again", afterResume);
        expect(isNumber(greyGroups.count) && greyGroups.count >= 3, "the stopped groups are not grey", greyGroups);
        return { stopped: stopped.body, whileStopped, appResume, stillStopped, greyGroups, afterResume };
      },
    );

    // ---------------------------------------------------------------------------------------------
    // Many agents at once over the one connection

    for (const handle of handles) await app.request("tab.close", { handle }).catch(() => undefined);
    for (const id of Object.values(lease)) await app.request("lease.close", { leaseId: id }).catch(() => undefined);
    const loadProjects = Array.from({ length: 5 }, (_, index) => ({
      projectKey: opaque(),
      title: `Carga ${index + 1}`,
      color: (["blue", "red", "yellow", "green", "orange"] as const)[index] ?? "blue",
    }));
    await app.request("session.configure", {
      limits: { tabsPerLease: 2, tabsPerProject: 32, tabsTotal: 40 },
      ratePerOrigin: { perOriginPerMinute: 600, perProjectPerMinute: 2400 },
      policyAdd: ["blocked-by-app.test"],
      projects: loadProjects,
    });
    for (const sessions of loads) {
      const before = machine();
      if (before.swapMb > MAX_SWAP_MB || before.freePercent < MIN_FREE_PERCENT) {
        report.notMeasured.push(`load ${sessions}: swap ${before.swapMb} MB, free ${before.freePercent}%`);
        break;
      }
      await testCase(`load: ${sessions} agents at once on one connection`, async () => {
        const leases = Array.from({ length: sessions }, (_, index) => ({
          leaseId: opaque(),
          project: loadProjects[index % loadProjects.length] ?? loadProjects[0],
        }));
        await Promise.all(
          leases.map((entry, index) =>
            app.request("lease.open", {
              leaseId: entry.leaseId,
              projectKey: entry.project?.projectKey ?? "",
              agentLabel: `Agente ${index + 1}`,
              initials: `L${index % 100}`,
            }),
          ),
        );
        const createMs: number[] = [];
        const refusals: { [code: string]: number } = {};
        const served: { leaseId: string; handle: string }[] = [];
        await Promise.all(
          leases.map(async (entry, index) => {
            const at = performance.now();
            try {
              const answer = await app.request("tab.create", {
                leaseId: entry.leaseId,
                url: `${base}/many?i=${sessions}-${index}`,
              });
              createMs.push(performance.now() - at);
              served.push({ leaseId: entry.leaseId, handle: String(answer.handle) });
            } catch (error) {
              const code = error instanceof AppError ? error.code : "other";
              refusals[code] = (refusals[code] ?? 0) + 1;
            }
          }),
        );
        const sendMs: number[] = [];
        const batchMs: number[] = [];
        const errors: { [code: string]: number } = {};
        let commands = 0;
        const framesBefore = { in: app.framesIn, out: app.framesOut, bytesIn: app.bytesIn, bytesOut: app.bytesOut };
        const until = performance.now() + loadSeconds * 1000;
        let memory: DynamicRecord = {};
        const sampler = (async () => {
          await sleep((loadSeconds * 1000) / 2);
          const swTarget = workerTarget();
          let heap: DynamicRecord = {};
          if (swTarget) {
            const sw = await attach(swTarget);
            heap = await cdp.send("Runtime.getHeapUsage", {}, sw).catch(() => ({}));
            await cdp.send("Target.detachFromTarget", { sessionId: sw }).catch(() => undefined);
          }
          memory = {
            workerHeapUsedMb: isNumber(heap.usedSize) ? Math.round((heap.usedSize / 1024 / 1024) * 10) / 10 : null,
            workerHeapTotalMb: isNumber(heap.totalSize) ? Math.round((heap.totalSize / 1024 / 1024) * 10) / 10 : null,
            chrome: chromeMemory(chrome.pid),
            machine: machine(),
          };
        })();
        const started = performance.now();
        await Promise.all(
          served.map(async (entry, index) => {
            let round = index;
            const world = await engineWorld(entry.handle).catch(() => 0);
            const ready = {
              method: "Runtime.callFunctionOn",
              params: { functionDeclaration: READY, executionContextId: world, arguments: [], returnByValue: true },
            };
            while (performance.now() < until) {
              round += 1;
              const at = performance.now();
              try {
                if (round % 4 === 0) {
                  await app.request("cdp.batch", {
                    handle: entry.handle,
                    commands: [
                      ready,
                      { method: "Target.getTargetInfo", params: {} },
                      { method: "Page.getLayoutMetrics", params: {} },
                      { method: "DOM.getDocument", params: { depth: 1 } },
                      ready,
                      ready,
                      { method: "Page.getFrameTree", params: {} },
                      ready,
                    ],
                  });
                  batchMs.push(performance.now() - at);
                  commands += 8;
                } else {
                  await app.request("cdp.send", { handle: entry.handle, ...ready });
                  sendMs.push(performance.now() - at);
                  commands += 1;
                }
              } catch (error) {
                const code = error instanceof AppError ? error.code : "other";
                errors[code] = (errors[code] ?? 0) + 1;
                await sleep(20);
              }
            }
          }),
        );
        const seconds = (performance.now() - started) / 1000;
        await sampler;
        const requests = sendMs.length + batchMs.length;
        const frames = app.framesIn + app.framesOut - framesBefore.in - framesBefore.out;
        const closeStarted = performance.now();
        await Promise.all(
          served.map((entry) => app.request("tab.close", { handle: entry.handle }).catch(() => undefined)),
        );
        const closeAllMs = Math.round(performance.now() - closeStarted);
        await Promise.all(
          leases.map((entry) => app.request("lease.close", { leaseId: entry.leaseId }).catch(() => undefined)),
        );
        const expectedServed = Math.min(sessions, 40);
        const result = {
          sessions,
          served: served.length,
          refused: refusals,
          createMs: stats(createMs),
          sendMs: stats(sendMs),
          batchOf8Ms: stats(batchMs),
          seconds: Math.round(seconds * 10) / 10,
          requestsPerSecond: Math.round(requests / seconds),
          cdpCommandsPerSecond: Math.round(commands / seconds),
          framesPerSecond: Math.round(frames / seconds),
          megabytesPerSecond:
            Math.round(
              ((app.bytesIn + app.bytesOut - framesBefore.bytesIn - framesBefore.bytesOut) / 1024 / 1024 / seconds) *
                10,
            ) / 10,
          errors,
          closeAllMs,
          memory,
        };
        report.load.push(result);
        expect(
          served.length === expectedServed,
          `served ${served.length} agents, expected ${expectedServed}`,
          refusals,
        );
        expect(
          (refusals.limit ?? 0) === sessions - expectedServed,
          "agents over the total limit were not all refused with `limit`",
          refusals,
        );
        expect(Object.keys(errors).length === 0, "commands failed under load", errors);
        return result;
      });
    }

    // ---------------------------------------------------------------------------------------------
    // The worker: idle with the port open, then stopped by Chrome and back

    const reconnectLease = opaque();
    await app.request("lease.open", {
      leaseId: reconnectLease,
      projectKey: project.a,
      agentLabel: "Agente Um",
      initials: "A1",
    });
    const keep = String(
      (await app.request("tab.create", { leaseId: reconnectLease, url: `${base}/page?i=keep` })).handle,
    );
    await app.request("lease.close", { leaseId: reconnectLease });

    /** Idles for `seconds` and records what the worker did meanwhile, from Chrome's targets and the app side. */
    const idle = async (seconds: number) => {
      const worker = workerTarget();
      const connections = app.connections;
      const closes = app.closes;
      const destroyedBefore = workerDestroyed.length;
      const since = performance.now();
      await sleep(seconds * 1000);
      const at = performance.now();
      const ping = await denied(app.request("ping", {}));
      const stops = workerDestroyed.slice(destroyedBefore).map((entry) => Math.round((entry.at - since) / 100) / 10);
      const readies = app.events
        .filter((event) => event.at >= since && event.op === "ready")
        .map((event) => Math.round((event.at - since) / 100) / 10);
      return {
        idleSeconds: seconds,
        sameWorker: workerTarget() === worker && stops.length === 0,
        workerStoppedAtSeconds: stops,
        connectionClosed: app.closes - closes,
        reconnects: app.connections - connections,
        readyAtSeconds: readies,
        ping,
        pingMs: Math.round(performance.now() - at),
      };
    };

    await testCase(
      "worker: 35 s idle in the middle of work (debugger attached) stays alive, no reconnect",
      async () => {
        await app.request("lease.open", {
          leaseId: reconnectLease,
          projectKey: project.a,
          agentLabel: "Agente Um",
          initials: "A1",
        });
        await probe(keep);
        const result = await idle(35);
        await app.request("lease.close", { leaseId: reconnectLease }).catch(() => undefined);
        expect(
          result.sameWorker && result.reconnects === 0 && result.ping === "allowed",
          "the worker stopped in the middle of work",
          result,
        );
        return result;
      },
    );

    await testCase("worker: 35 s idle between turns (no debugger), with only the port open", async () => {
      const result = await idle(35);
      // Chrome stops an idle worker after 30 s unless something holds it; here only the open port does.
      expect(
        result.sameWorker && result.reconnects === 0 && result.ping === "allowed",
        "the worker stopped while its port was open",
        result,
      );
      return result;
    });

    await testCase("worker: stopped by Chrome, back on the next browser event, with its tabs", async () => {
      const worker = workerTarget();
      expect(worker !== undefined, "no worker");
      // The tab is attached when Chrome stops the worker, so the new worker must drop that session.
      await app.request("lease.open", {
        leaseId: reconnectLease,
        projectKey: project.a,
        agentLabel: "Agente Um",
        initials: "A1",
      });
      await probe(keep);
      const closesBefore = app.closes;
      await cdp.send("Target.closeTarget", { targetId: worker ?? "" });
      await waitFor(() => (app.closes > closesBefore ? true : undefined), 10_000, "the connection to close");
      await waitFor(() => (workerTarget() === undefined ? true : undefined), 10_000, "the worker to stop");
      const since = performance.now();
      await cdp.send("Target.createTarget", { url: "about:blank", background: true });
      const ready = await app.waitEvent("ready", () => true, 15_000, since);
      const reconnectMs = Math.round(ready.at - since);
      const handlesBack = Array.isArray(ready.body.handles)
        ? ready.body.handles.filter(isDynamicRecord).map((entry) => entry.handle)
        : [];
      await app.request("lease.open", {
        leaseId: reconnectLease,
        projectKey: project.a,
        agentLabel: "Agente Um",
        initials: "A1",
      });
      const at = performance.now();
      const again = { result: { search: new URL((await tabInfo(keep)).url).search } };
      const firstCommandMs = Math.round(performance.now() - at);
      await app.request("lease.close", { leaseId: reconnectLease });
      expect(handlesBack.includes(keep), "the tab handle did not come back after the restart", ready.body);
      expect(
        Array.isArray(ready.body.attached) && ready.body.attached.length === 0,
        "stale debugger sessions were reported as attached",
        ready.body,
      );
      return {
        trigger: "a new tab (tabs.onCreated)",
        reconnectMs,
        firstCommandAfterMs: firstCommandMs,
        handlesBack: handlesBack.length,
        result: again.result,
      };
    });

    if (skipAlarmWake) report.notMeasured.push("reconnect with no browser event (--skip-alarm-wake)");
    else
      await testCase(
        "worker: stopped by Chrome, back with no browser event (Chrome restarts it, or the watchdog alarm)",
        async () => {
          const worker = workerTarget();
          const closesBefore = app.closes;
          await cdp.send("Target.closeTarget", { targetId: worker ?? "" });
          await waitFor(() => (app.closes > closesBefore ? true : undefined), 10_000, "the connection to close");
          const since = performance.now();
          const ready = await app.waitEvent("ready", () => true, 75_000, since);
          await app.request("ping", {});
          // What woke the new worker, from the E2E build's own record.
          const fresh = workerTarget();
          let woke: unknown = null;
          if (fresh) {
            const session = await attach(fresh);
            woke = (await evaluate(session, "globalThis.buildersBotTimings ?? {}")).firstEvents ?? null;
            await cdp.send("Target.detachFromTarget", { sessionId: session }).catch(() => undefined);
          }
          return {
            reconnectMs: Math.round(ready.at - since),
            wokeBy: woke,
            note: "wokeBy lists the listeners that ran first; empty means Chrome started the worker by itself. The watchdog alarm bounds the wait at 60 s when it does not.",
          };
        },
      );

    await testCase(
      "update: with its session storage empty (as after an update), the extension gives its tabs back with the same handles",
      async () => {
        const groupsBefore = await inspect(`return { count: (await chrome.tabGroups.query({})).length };`);
        // An update or a reload empties storage.session and starts a new worker. In this harness
        // chrome.runtime.reload() leaves an extension loaded by --load-extension without its APIs, so
        // the test empties the session storage and stops the worker, which is the state an update leaves.
        await inspect(`await chrome.storage.session.clear(); return {};`);
        const worker = workerTarget();
        expect(worker !== undefined, "no worker");
        const closesBefore = app.closes;
        const since = performance.now();
        await cdp.send("Target.closeTarget", { targetId: worker ?? "" });
        await waitFor(() => (app.closes > closesBefore ? true : undefined), 15_000, "the connection to close");
        // A browser event wakes the next worker, if Chrome has not started it already.
        await cdp.send("Target.createTarget", { url: "about:blank", background: true });
        const ready = await app.waitEvent("ready", () => true, 30_000, since);
        const handlesBack = Array.isArray(ready.body.handles)
          ? ready.body.handles.filter(isDynamicRecord).map((entry) => entry.handle)
          : [];
        await app.request("lease.open", {
          leaseId: reconnectLease,
          projectKey: project.a,
          agentLabel: "Agente Um",
          initials: "A1",
        });
        const again = { result: { search: new URL((await tabInfo(keep)).url).search } };
        await app.request("tab.create", { leaseId: reconnectLease, url: `${base}/page?after=update` });
        const groupsAfter = await inspect(`return { count: (await chrome.tabGroups.query({})).length };`);
        await app.request("lease.close", { leaseId: reconnectLease });
        expect(handlesBack.includes(keep), "the tab handle did not come back after the update", ready.body);
        expect(groupsAfter.count === groupsBefore.count, "a group was made again after the update", {
          groupsBefore,
          groupsAfter,
        });
        return { handlesBack: handlesBack.length, groupsBefore, groupsAfter, result: again.result };
      },
    );

    report.machine.end = { ...machine(), chrome: chromeMemory(chrome.pid) };
    await stopChrome();
  } finally {
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    app.close();
    server.stop(true);
    await writeFile(join(OUT, "chrome-stderr.log"), chromeLog.join("")).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  report.cases.push({
    name: "run",
    ok: false,
    ms: 0,
    evidence: null,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
}
report.ok =
  report.cases.length > 0 && report.cases.every((entry) => entry.ok) && report.protocolViolations.length === 0;
report.finishedAt = new Date().toISOString();
await writeReport();
process.stdout.write(
  `${report.ok ? "PASSED" : "FAILED"} ${report.cases.filter((entry) => entry.ok).length}/${report.cases.length}; report: ${join(OUT, "report.json")}\n`,
);
process.exit(report.ok ? 0 : 1);
