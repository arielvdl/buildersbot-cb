/**
 * Drives the real Native Messaging host (`native/chrome-host/main.swift`, E2E build) as Chrome does,
 * with a stand-in app on its socket, and checks its framing and its barriers:
 *
 * - the origin check (exit 2), its own frames (`hello`, then `status`), whole frames in both directions
 *   across random chunk boundaries, the caps (a header above 16 MiB from Chrome and an empty frame exit 4
 *   without the memory of the announced size; an app frame above 1 MB or not shaped as a handshake or
 *   sealed frame closes the app connection), frames from Chrome while the app is away are dropped,
 *   backpressure with a stalled app (the host stops reading Chrome and its memory stays bounded);
 * - the peer checks: the host passes no byte to a listener that is not the pinned app process
 *   (a `perl` listener), and it does not connect through a socket folder that others can open.
 *
 *   bun scripts/chrome-host-framing-fuzz.ts [--seed <n>]
 *
 * The host's socket is in the per-user temporary folder (`bb-e2e`), never in the app's folder, and
 * the folder is removed at the end. Report: `.buildersbot-build/chrome-extension/host-framing-fuzz.json`.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { bridgeSocket } from "../src/main/chrome-bridge/bridge-paths";
import { buildChromeHost, codeHash } from "./build-chrome-host";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT = join(ROOT, ".buildersbot-build/chrome-extension/host-framing-fuzz.json");
const seedIndex = process.argv.indexOf("--seed");
let seed = seedIndex === -1 ? Date.now() % 2 ** 31 : Number(process.argv[seedIndex + 1]);
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`,
  );
};

const frame = (body: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
};

/** Collects whole frames from a byte stream. */
class FrameCollector {
  #buffer = Buffer.alloc(0);
  readonly frames: Buffer[] = [];
  #waiters: { count: number; resolve: () => void }[] = [];
  push(chunk: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < 4 + length) break;
      this.frames.push(this.#buffer.subarray(4, 4 + length));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
    this.#waiters = this.#waiters.filter((waiter) => {
      if (this.frames.length < waiter.count) return true;
      waiter.resolve();
      return false;
    });
  }
  /** Waits until `count` frames have come, or fails after `ms`. */
  waitFor(count: number, ms = 5000): Promise<void> {
    if (this.frames.length >= count) return Promise.resolve();
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`waited for ${count} frames, got ${this.frames.length}`)), ms);
      this.#waiters.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          done();
        },
      });
    });
  }
  texts() {
    return this.frames.map((body) => body.toString("utf8"));
  }
}

interface Host {
  child: ChildProcessWithoutNullStreams;
  out: FrameCollector;
  exit: Promise<number | null>;
}

function startHost(binary: string, origin: string): Host {
  const child = spawn(binary, [origin], { stdio: ["pipe", "pipe", "pipe"] });
  const out = new FrameCollector();
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stdin.on("error", () => undefined);
  const exit = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  return { child, out, exit };
}

/** The stand-in app: a listener in this process, which the host's requirement pins by code hash. */
class StandInApp {
  server: Server | null = null;
  peers: Socket[] = [];
  received = new FrameCollector();
  listen(path: string): Promise<number> {
    rmSync(path, { force: true });
    return new Promise((done) => {
      this.server = createServer((peer) => {
        this.peers.push(peer);
        peer.on("data", (chunk: Buffer) => this.received.push(chunk));
        peer.on("error", () => undefined);
      });
      this.server.listen(path, () => {
        chmodSync(path, 0o600);
        done(performance.now());
      });
    });
  }
  async close() {
    for (const peer of this.peers) peer.destroy();
    this.peers = [];
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
    this.server = null;
  }
  waitPeer(ms = 5000): Promise<Socket> {
    const started = Date.now();
    return new Promise((done, fail) => {
      const tick = () => {
        const peer = this.peers.at(-1);
        if (peer && !peer.destroyed) done(peer);
        else if (Date.now() - started > ms) fail(new Error("the host did not connect"));
        else setTimeout(tick, 10);
      };
      tick();
    });
  }
}

const rssKb = (pid: number) =>
  Number(spawnSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) || 0;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const appRequirement = `cdhash H"${codeHash(process.execPath)}"`;
  const build = buildChromeHost({ channel: "e2e", appRequirement });
  const socket = bridgeSocket("e2e");
  rmSync(socket.folder, { recursive: true, force: true });
  mkdirSync(socket.folder, { mode: 0o700 });
  chmodSync(socket.folder, 0o700);
  const report: { [key: string]: string | number | boolean | object | null } = {
    seed,
    host: { cdhash: build.cdhash, version: build.version },
    appRequirement,
  };
  const app = new StandInApp();
  try {
    // Origin.
    const wrong = startHost(build.binary, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
    check("a wrong origin exits with code 2", (await wrong.exit) === 2);

    // App away, then present.
    const host = startHost(build.binary, build.origin);
    await host.out.waitFor(2);
    const [hello, offline] = host.out.texts();
    const helloValue = JSON.parse(hello ?? "{}");
    check(
      "the host says hello first, with its version, pid and parent",
      helloValue.h === "hello" &&
        helloValue.hostVersion === build.version &&
        helloValue.pid === host.child.pid &&
        ["google-chrome", "other", "unknown"].includes(helloValue.parent),
      helloValue,
    );
    check("with no app, the host reports it offline", offline === '{"h":"status","app":"offline"}', offline);
    const listenedAt = await app.listen(socket.path);
    await host.out.waitFor(3, 15_000);
    const onlineMs = performance.now() - listenedAt;
    check(
      "the host sees the app at once (folder watch), below 1 s",
      host.out.texts()[2] === '{"h":"status","app":"online"}' && onlineMs < 1000,
      { onlineMs },
    );
    report.reconnectMs = Math.round(onlineMs);
    const peer = await app.waitPeer();

    // Whole frames across random chunk boundaries, Chrome to app.
    const toApp: Buffer[] = [];
    for (let index = 0; index < 40; index += 1) {
      const size = 2 + Math.floor(random() ** 3 * 900_000);
      toApp.push(Buffer.from(`{"v":1,"c":${index},"d":"${"A".repeat(Math.max(0, size - 30))}"}`));
    }
    const stream = Buffer.concat(toApp.map(frame));
    for (let offset = 0; offset < stream.length; ) {
      const step = 1 + Math.floor(random() * 70_000);
      host.child.stdin.write(stream.subarray(offset, offset + step));
      offset += step;
    }
    await app.received.waitFor(40, 20_000);
    check(
      "40 frames from Chrome reach the app whole and in order, from random chunks",
      app.received.frames.every((body, index) => body.equals(toApp[index] ?? Buffer.alloc(0))),
    );

    // App to Chrome, and the shapes the host refuses from the app.
    const before = host.out.frames.length;
    const fromApp = [Buffer.from('{"k":"welcome","x":1}'), Buffer.from(`{"v":1,"c":0,"d":"${"B".repeat(999_000)}"}`)];
    for (const body of fromApp) peer.write(frame(body));
    await host.out.waitFor(before + 2);
    check(
      "handshake and sealed frames from the app reach Chrome whole",
      host.out.frames.slice(before, before + 2).every((body, index) => body.equals(fromApp[index] ?? Buffer.alloc(0))),
    );
    peer.write(frame(Buffer.from('{"h":"status","app":"online"}')));
    await host.out.waitFor(before + 3);
    check(
      "an app frame shaped as the host's own frame closes the app connection",
      host.out.texts()[before + 2] === '{"h":"status","app":"offline"}',
      host.out.texts()[before + 2],
    );
    await host.out.waitFor(before + 4, 15_000);
    const peer2 = await app.waitPeer();
    const head = Buffer.alloc(4);
    head.writeUInt32LE(1_000_001, 0);
    peer2.write(head);
    await host.out.waitFor(before + 5);
    check(
      "an app frame above 1 MB closes the app connection",
      host.out.texts()[before + 4] === '{"h":"status","app":"offline"}',
    );
    await host.out.waitFor(before + 6, 15_000);
    const peer3 = await app.waitPeer();

    // Backpressure: the app stops reading; Chrome keeps writing.
    peer3.pause();
    const received = app.received.frames.length;
    const big = Buffer.from(`{"v":1,"c":1,"d":"${"C".repeat(520_000)}"}`);
    const count = 120;
    const rssBefore = rssKb(host.child.pid ?? 0);
    for (let index = 0; index < count; index += 1) host.child.stdin.write(frame(big));
    await sleep(1500);
    const rssStalled = rssKb(host.child.pid ?? 0);
    const stalledAt = app.received.frames.length;
    check(
      "with the app stalled, the host stops reading Chrome and its memory stays bounded",
      rssStalled - rssBefore < 16 * 1024 && stalledAt - received < count,
      {
        rssBeforeKb: rssBefore,
        rssStalledKb: rssStalled,
        framesThroughWhileStalled: stalledAt - received,
        sent: count,
      },
    );
    peer3.resume();
    await app.received.waitFor(received + count, 30_000);
    check("when the app reads again, every frame arrives", app.received.frames.length === received + count);
    report.hostRssKb = { idle: rssBefore, stalled: rssStalled };

    // The other way: Chrome stops reading. The host stops reading the app, without spinning.
    host.child.stdout.pause();
    const outStalled = host.out.frames.length;
    const fromAppMany = Buffer.from(`{"v":1,"c":2,"d":"${"D".repeat(600_000)}"}`);
    for (let index = 0; index < 60; index += 1) peer3.write(frame(fromAppMany));
    await sleep(1500);
    const cpu = Number(
      spawnSync("/bin/ps", ["-o", "%cpu=", "-p", String(host.child.pid ?? 0)], { encoding: "utf8" }).stdout.trim(),
    );
    const rssChromeStalled = rssKb(host.child.pid ?? 0);
    host.child.stdout.resume();
    await host.out.waitFor(outStalled + 60, 30_000);
    check(
      "with Chrome stalled, the host holds one frame, does not spin, and delivers all 60 afterwards",
      rssChromeStalled - rssBefore < 16 * 1024 &&
        cpu < 50 &&
        host.out.frames.slice(outStalled).every((body) => body.equals(fromAppMany)),
      { rssKb: rssChromeStalled, cpuPercent: cpu },
    );

    // App leaves: frames from Chrome are dropped, and the host reports it.
    const outBefore = host.out.frames.length;
    await app.close();
    await host.out.waitFor(outBefore + 1);
    check("the app leaving gives status offline", host.out.texts()[outBefore] === '{"h":"status","app":"offline"}');
    const beforeAway = app.received.frames.length;
    host.child.stdin.write(frame(Buffer.from('{"v":1,"c":9,"d":"x"}')));
    await sleep(100);
    const relisten = await app.listen(socket.path);
    await host.out.waitFor(outBefore + 2, 15_000);
    report.secondReconnectMs = Math.round(performance.now() - relisten);
    await app.waitPeer();
    await sleep(200);
    check(
      "a frame written while the app was away never reaches the new connection",
      app.received.frames.length === beforeAway,
      { late: app.received.frames.length - beforeAway },
    );

    // Chrome sends a header above the cap: exit 4, without the announced allocation.
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(0xffff_fff0, 0);
    host.child.stdin.write(huge);
    const code = await host.exit;
    check("a header above 16 MiB from Chrome exits with code 4", code === 4, { code });

    // The app listens, so a new host says hello and goes online at once: two frames.
    const empty = startHost(build.binary, build.origin);
    await empty.out.waitFor(2, 15_000);
    check(
      "a host that starts with the app listening goes online at once",
      empty.out.texts()[1] === '{"h":"status","app":"online"}',
    );
    empty.child.stdin.write(Buffer.alloc(4));
    check("an empty frame from Chrome exits with code 4", (await empty.exit) === 4);

    const closing = startHost(build.binary, build.origin);
    await closing.out.waitFor(2, 15_000);
    closing.child.stdin.end();
    check("Chrome closing the port ends the host with code 0", (await closing.exit) === 0);
    await app.close();

    // A listener that is not the pinned app: perl on the same socket.
    rmSync(socket.path, { force: true });
    const marker = join(socket.folder, "perl-received.txt");
    const perl = spawn("/usr/bin/perl", [
      "-MIO::Socket::UNIX",
      "-e",
      `my $s = IO::Socket::UNIX->new(Type => SOCK_STREAM(), Local => $ARGV[0], Listen => 5) or die; chmod 0600, $ARGV[0]; open(my $m, ">", $ARGV[1]); $| = 1; print "ready\\n"; while (my $c = $s->accept) { my $n = sysread($c, my $b, 65536); print $m (defined $n ? $n : -1), "\\n"; close $c; }`,
      socket.path,
      marker,
    ]);
    await new Promise<void>((done) => perl.stdout.once("data", () => done()));
    const intruded = startHost(build.binary, build.origin);
    await intruded.out.waitFor(2, 5000);
    intruded.child.stdin.write(frame(Buffer.from('{"k":"commit","digest":"x"}')));
    await sleep(1500);
    const perlLog = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    check(
      "a listener that is not the pinned app gets no byte, and the host stays offline",
      intruded.out.texts().every((text) => text !== '{"h":"status","app":"online"}') && !/^[1-9]/mu.test(perlLog),
      { frames: intruded.out.texts(), perlReads: perlLog.trim().split("\n").filter(Boolean) },
    );
    intruded.child.kill();
    perl.kill();
    await intruded.exit;

    // A socket folder that others can open: the host does not connect through it.
    rmSync(socket.path, { force: true });
    chmodSync(socket.folder, 0o755);
    await app.listen(socket.path);
    const shared = startHost(build.binary, build.origin);
    await shared.out.waitFor(2, 5000);
    await sleep(1200);
    check(
      "the host does not connect through a socket folder that others can open",
      shared.out.texts().every((text) => text !== '{"h":"status","app":"online"}') && app.peers.length === 0,
    );
    shared.child.kill();
    await shared.exit;
    await app.close();
    chmodSync(socket.folder, 0o700);
    const diagnostics = join(socket.folder, "host-diagnostics.log");
    report.hostDiagnostics = existsSync(diagnostics)
      ? readFileSync(diagnostics, "utf8").split("\n").filter(Boolean).slice(-40)
      : [];
  } finally {
    await app.close();
    rmSync(socket.folder, { recursive: true, force: true });
  }
  const passed = results.every((result) => result.ok);
  mkdirSync(join(ROOT, ".buildersbot-build/chrome-extension"), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify({ passed, ...report, results }, null, 2)}\n`);
  process.stdout.write(
    `${passed ? "PASSED" : "FAILED"} ${results.filter((r) => r.ok).length}/${results.length} → ${REPORT}\n`,
  );
  process.exit(passed ? 0 : 1);
}

await main();
