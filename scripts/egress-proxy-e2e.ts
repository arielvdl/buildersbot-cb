// Runs the real egress proxy of a server against a fake upstream proxy, a fake location service and
// a fake "internet" host, all on loopback: no real network and no real credential. It checks the
// pasted-line parser, the bypass rules, the option builders, the loopback gateway with a real
// child process (curl), the fetch of the main process, the spawn environment of the Codex
// app-server and of each stdio MCP server, the fail-closed rules, that a saved password never goes
// to another host, the encrypted store, the redaction of the secret, and the default that a new
// server takes, with no password in the environment of the new server. See
// docs/architecture/egress-proxy.md.
// `bun run test:egress-proxy` (Node with tsx: the main process runs on Node, and the fetch of the
// main process uses `undici`, which Bun replaces). Needs `curl` and `/bin/sh`. Writes
// .openbot-build/egress-proxy-e2e/report.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EGRESS_DEFAULT_BYPASS,
  type EgressProxyUpdate,
  type EgressProxyView,
  egressBypassMatches,
  type McpServerConfig,
  parseEgressProxyLine,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect, Result } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { acpMcpServers, claudeMcpServers, codexMcpServers, usableMcpServer } from "../src/backend/mcp-provider-shapes";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { EgressGateway } from "../src/main/egress-gateway";
import { checkEgressProxy } from "../src/main/egress-proxy-check";
import { EgressProxyDefault } from "../src/main/egress-proxy-default";
import {
  egressEnvironment,
  electronProxyOption,
  noProxyValue,
  playwrightProxyOption,
} from "../src/main/egress-proxy-options";
import {
  EgressProxyService,
  type EgressSessionPort,
  playwrightEgressConfig,
  writePlaywrightEgressConfig,
} from "../src/main/egress-proxy-service";
import { EGRESS_PROXY_FILE, EgressProxyStore } from "../src/main/egress-proxy-store";
import { LocalServers } from "../src/main/local-servers/local-servers";

const OUT = resolve(import.meta.dirname, "../.openbot-build/egress-proxy-e2e");
const FAKE_DOMAIN = ".egress-test.invalid";
// Fake values only: documentation address space and obviously fake credentials.
const USER = "demo-user";
const PASSWORD = "demo-pass-0451";

interface Report {
  passed: boolean;
  checks: string[];
  failure?: string;
}
const report: Report = { passed: false, checks: [] };
const pass = (name: string) => report.checks.push(name);

/** A reversible stand-in for `safeStorage`, so the store runs outside Electron. */
const fakeCipher = {
  encrypt: (value: string) => Buffer.from(`fake:${Buffer.from(value, "utf8").toString("base64")}`, "utf8"),
  decrypt: (value: Buffer) => {
    const text = value.toString("utf8");
    if (!text.startsWith("fake:")) throw new Error("Not encrypted by the fake cipher.");
    return Buffer.from(text.slice(5), "base64").toString("utf8");
  },
};
const brokenCipher = {
  encrypt: fakeCipher.encrypt,
  decrypt: (_value: Buffer): string => {
    throw new Error("The keychain refused.");
  },
};
const refusingCipher = {
  encrypt: (_value: string): Buffer => {
    throw new Error("The keychain refused.");
  },
  decrypt: fakeCipher.decrypt,
};

/**
 * A second proxy on loopback that counts the `Proxy-Authorization` headers it gets: the host that an
 * admin, or a typo, could name in place of the saved one.
 */
let otherAuthorizations = 0;
const otherProxy = createServer((request, response) => {
  if (request.headers["proxy-authorization"]) otherAuthorizations += 1;
  response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="other"' }).end();
});
otherProxy.on("connect", (request: IncomingMessage, client: Socket) => {
  if (request.headers["proxy-authorization"]) otherAuthorizations += 1;
  client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="other"\r\n\r\n');
});

function stdioServer(id: string): McpServerConfig {
  return {
    id,
    name: id,
    transport: "stdio",
    enabled: true,
    command: "/bin/sh",
    args: ["-c", "exit 0"],
    env: [{ key: "HTTPS_PROXY", value: "http://direct.example.test:3128" }],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
  };
}

/** Waits for a file that a child process writes. */
async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.includes("\nEND\n")) return text;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`No file at ${path}.`);
}

function listen(server: Server): Promise<number> {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port.");
      done(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

/** The fake "internet": it records each request and whether the fake proxy sent it. */
let targetHits: { viaProxy: boolean }[] = [];
const target = createServer((request, response) => {
  targetHits.push({ viaProxy: request.headers["x-via-fake-proxy"] === "1" });
  response.end("hello from the target");
});

/** The fake location service: the country the proxy address has. */
let geoCountry = "BR";
const geo = createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({ ip: "198.51.100.24", city: "Rio de Janeiro", region: "Rio de Janeiro", country: geoCountry }),
  );
});

/**
 * The fake upstream proxy. It resolves the fake domain to loopback itself, as a real proxy resolves
 * names, so a client that tried a direct connection would fail at DNS (`.invalid`).
 */
let upstreamPassword = PASSWORD;
let upstreamHits = 0;
function mapHost(host: string): string {
  return host.endsWith(FAKE_DOMAIN) ? "127.0.0.1" : host;
}
function authorized(request: IncomingMessage): boolean {
  return (
    request.headers["proxy-authorization"] ===
    `Basic ${Buffer.from(`${USER}:${upstreamPassword}`, "utf8").toString("base64")}`
  );
}
function createUpstream(): Server {
  const server = createServer((request, response) => {
    if (!authorized(request)) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="fake"' }).end();
      return;
    }
    upstreamHits += 1;
    const url = new URL(request.url ?? "");
    const outgoing = httpRequest(
      {
        host: mapHost(url.hostname),
        port: url.port,
        path: url.pathname,
        method: request.method,
        headers: { ...request.headers, "x-via-fake-proxy": "1" },
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    outgoing.on("error", () => response.writeHead(502).end());
    request.pipe(outgoing);
  });
  server.on("connect", (request: IncomingMessage, client: Socket) => {
    client.on("error", () => client.destroy());
    if (!authorized(request)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fake"\r\n\r\n');
      return;
    }
    upstreamHits += 1;
    const [host = "", port = "0"] = (request.url ?? "").split(":");
    const socket = connect(Number(port), mapHost(host), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(client);
      client.pipe(socket);
    });
    socket.on("error", () => client.destroy());
  });
  return server;
}

/** A browser session as `BrowserHost` gives it, which records what the service did. */
function fakeSession() {
  const calls: { proxyRules?: string; mode: string }[] = [];
  let gate: ((url: string) => Promise<boolean>) | null = null;
  const port: EgressSessionPort = {
    setProxy: async (option) => {
      calls.push({ mode: option.mode, ...(option.proxyRules ? { proxyRules: option.proxyRules } : {}) });
    },
    closeAllConnections: async () => undefined,
    clearAuthCache: async () => undefined,
    setGate: (next) => {
      gate = next;
    },
  };
  return { port, calls, gate: () => gate };
}

/** Runs curl as an agent tool runs: a child process with the agent environment. Async: the gateway runs here. */
function curl(
  environment: Record<string, string>,
  url: string,
  tunnel: boolean,
): Promise<{ status: number; body: string }> {
  return new Promise((done) => {
    const child = spawn(
      "curl",
      ["-sS", "--max-time", "10", ...(tunnel ? ["--proxytunnel"] : []), "-o", "-", "-w", "\n%{http_code}", url],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...environment } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      const lines = stdout.trimEnd().split("\n");
      const status = Number(lines.pop() ?? 0);
      done({ status: code === 0 ? status : -1, body: `${lines.join("\n")}${stderr}` });
    });
  });
}

function settings(port: number, password: string | undefined): EgressProxyUpdate {
  return {
    enabled: true,
    host: "127.0.0.1",
    port,
    username: USER,
    bypass: [...EGRESS_DEFAULT_BYPASS],
    expectedCountry: "BR",
    blockOtherCountry: true,
    ...(password === undefined ? {} : { password }),
  };
}

async function main(): Promise<void> {
  // 1. The pasted forms.
  const line = parseEgressProxyLine(`203.0.113.10:8080:${USER}:${PASSWORD}`);
  assert.deepEqual(line, { ok: true, value: { host: "203.0.113.10", port: 8080, username: USER, password: PASSWORD } });
  const url = parseEgressProxyLine(`http://${USER}:p%40ss%3Aword@proxy.example.test:12321`);
  assert.deepEqual(url, {
    ok: true,
    value: { host: "proxy.example.test", port: 12321, username: USER, password: "p@ss:word" },
  });
  assert.deepEqual(parseEgressProxyLine("proxy.example.test:12321:user:pa:ss"), {
    ok: true,
    value: { host: "proxy.example.test", port: 12321, username: "user", password: "pa:ss" },
  });
  assert.equal(parseEgressProxyLine("socks5://u:p@203.0.113.10:1080").ok, false);
  assert.deepEqual(parseEgressProxyLine("203.0.113.10:99999:u:p"), { ok: false, error: "port" });
  assert.deepEqual(parseEgressProxyLine("bad host:80:u:p"), { ok: false, error: "format" });
  assert.deepEqual(parseEgressProxyLine("203.0.113.10"), { ok: false, error: "format" });
  assert.equal(parseEgressProxyLine("http://u:p@[2001:db8::1]:8080").ok, true);
  pass("parser: host:port:user:password, the URL form, a password with ':', and refusals");

  // 2. The bypass rules.
  const rules = EGRESS_DEFAULT_BYPASS;
  for (const host of [
    "localhost",
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.0.10",
    "fe80::1",
    "hub.culturabuilder.com",
    "culturabuilder.com",
    "signal.openbot.run",
    "printer.local",
    "100.101.102.103",
    "fd7a:115c:a1e0::1",
    "openclaw-server.tailnet-name.ts.net",
  ])
    assert.equal(egressBypassMatches(host, rules), true, host);
  for (const host of [
    "example.com",
    "172.32.0.1",
    "8.8.8.8",
    "2001:db8::1",
    "culturabuilder.com.evil.test",
    "100.128.0.1",
    "ts.net.evil.test",
  ])
    assert.equal(egressBypassMatches(host, rules), false, host);
  // Loopback stays direct also when an admin removes it from the list.
  assert.equal(egressBypassMatches("127.0.0.1", []), true);
  assert.ok(noProxyValue(rules).split(",").includes(".ts.net"));
  pass("bypass: loopback, private ranges, the Tailscale network and the control plane go direct; public hosts do not");

  // 3. The option builders, as pure functions.
  const upstream = { host: "203.0.113.10", port: 8080, username: USER, password: PASSWORD };
  const gatewayAddress = { port: 41234, username: "builders-bot", token: "loopback-token-1234" };
  const proxyMode = { kind: "proxy" as const, upstream, bypass: rules };
  const environment = egressEnvironment(proxyMode, gatewayAddress);
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ])
    assert.ok(environment[name], name);
  assert.equal(environment.HTTPS_PROXY, "http://builders-bot:loopback-token-1234@127.0.0.1:41234");
  assert.ok(!JSON.stringify(environment).includes(PASSWORD), "The agent environment has no upstream password.");
  assert.ok(noProxyValue(rules).split(",").includes(".culturabuilder.com"));
  assert.deepEqual(egressEnvironment({ kind: "off" }, gatewayAddress), {});
  const electron = electronProxyOption(proxyMode);
  assert.equal(electron.proxyRules, "http://203.0.113.10:8080");
  assert.ok(!electron.proxyRules?.includes("direct"), "No direct fallback in the Chromium rules.");
  assert.ok(electron.proxyBypassRules?.includes("*.culturabuilder.com"));
  assert.ok(electron.proxyBypassRules?.includes("[::1]"));
  assert.equal(electronProxyOption({ kind: "blocked", bypass: rules }).proxyRules, "http://127.0.0.1:9");
  assert.deepEqual(electronProxyOption({ kind: "off" }), { mode: "system" });
  const playwright = playwrightProxyOption(proxyMode, gatewayAddress);
  assert.equal(playwright?.server, "http://127.0.0.1:41234");
  assert.equal(playwright?.password, "loopback-token-1234");
  assert.ok(!JSON.stringify(playwright).includes(PASSWORD), "The Playwright option has no upstream password.");
  assert.ok(playwright);
  const webRtc = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
  assert.deepEqual(playwrightEgressConfig(playwright).browser.launchOptions.args, [webRtc]);
  const playwrightFolder = mkdtempSync(join(tmpdir(), "egress-e2e-playwright-"));
  const launch = writePlaywrightEgressConfig(playwrightFolder, playwright);
  const written = JSON.parse(readFileSync(launch.configPath, "utf8"));
  assert.deepEqual(
    written.browser.launchOptions.args,
    [webRtc],
    "The Playwright browser sends no UDP outside the proxy.",
  );
  assert.equal(statSync(launch.configPath).mode & 0o777, 0o600);
  pass(
    "builders: environment, Electron and Playwright options with the WebRTC policy; no upstream password leaves main",
  );

  // 4. The real service, gateway and check against the fakes.
  const targetPort = await listen(target);
  const geoPort = await listen(geo);
  let upstreamServer = createUpstream();
  const upstreamPort = await listen(upstreamServer);
  const folder = mkdtempSync(join(tmpdir(), "egress-e2e-"));
  const store = new EgressProxyStore(join(folder, "egress.json"), fakeCipher);
  await runCauseEffect(store.load());
  const check = (proxy: typeof upstream) =>
    checkEgressProxy(proxy, { host: `geo${FAKE_DOMAIN}`, port: geoPort, path: "/json", secure: false }, 5_000);
  const gateway = new EgressGateway({
    route: () => service.gatewayRoute(),
    onResult: (result) => service.onTraffic(result),
    connectTimeoutMs: 5_000,
  });
  const service: EgressProxyService = new EgressProxyService({ store, gateway, check });
  await service.start();
  const session = fakeSession();
  service.attachSession(session.port);
  assert.deepEqual(service.environment(), {}, "Off changes nothing for the agents.");
  assert.equal(session.calls.length, 0, "Off changes nothing for the browser.");

  let view = await service.update(settings(upstreamPort, PASSWORD));
  assert.equal(view.state, "active");
  assert.equal(view.passwordSaved, true);
  assert.ok(!JSON.stringify(view).includes(PASSWORD), "The view has no password.");
  assert.equal(view.lastCheck?.country, "BR");
  assert.equal(view.lastCheck?.city, "Rio de Janeiro");
  assert.equal(session.calls.at(-1)?.proxyRules, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(session.gate(), null, "The gate goes once the proxy is set.");
  pass("service: a save turns the proxy on, the check reads IP, city and country, the browser gets the rule");

  const agentEnvironment = service.environment();
  targetHits = [];
  let before = upstreamHits;
  const plain = await curl(agentEnvironment, `http://target${FAKE_DOMAIN}:${targetPort}/`, false);
  assert.equal(plain.status, 200, plain.body);
  const tunnel = await curl(agentEnvironment, `http://target${FAKE_DOMAIN}:${targetPort}/`, true);
  assert.equal(tunnel.status, 200, tunnel.body);
  assert.equal(upstreamHits - before, 2, "Both requests went through the upstream.");
  assert.equal(targetHits.length, 2);
  before = upstreamHits;
  const direct = await curl(agentEnvironment, `http://127.0.0.1:${targetPort}/`, false);
  assert.equal(direct.status, 200, direct.body);
  assert.equal(upstreamHits, before, "A bypass host goes direct.");
  assert.equal(targetHits.at(-1)?.viaProxy, false);
  pass("agent process: plain HTTP and CONNECT go through gateway and upstream; a bypass host goes direct");

  // The fetch of the main process for the agents (MCP OAuth proxy, GitHub MCP proxy, MCP test).
  targetHits = [];
  before = upstreamHits;
  const fetched = await service.fetch(`http://target${FAKE_DOMAIN}:${targetPort}/`);
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), "hello from the target");
  // A tunnel, so the fake proxy adds no header; the `.invalid` name resolves only in the fake proxy.
  assert.equal(upstreamHits - before, 1, "The fetch of the main process went through the upstream.");
  assert.equal(targetHits.length, 1);
  before = upstreamHits;
  const bypassed = await service.fetch(`http://127.0.0.1:${targetPort}/`, { method: "POST", body: "{}" });
  assert.equal(bypassed.status, 200);
  assert.equal(upstreamHits, before, "A bypass host goes direct from the main process too.");
  pass("main process fetch: a request for the agents goes through gateway and upstream; a bypass host goes direct");

  // The spawn environment of the Codex app-server: its model calls and MCP clients use the gateway.
  const dump = join(folder, "codex-environment.txt");
  const fakeCodex = join(folder, "fake-codex");
  writeFileSync(
    fakeCodex,
    `#!/bin/sh\nenv > "${dump}.part"\necho END >> "${dump}.part"\nmv "${dump}.part" "${dump}"\ncat > /dev/null\n`,
    {
      mode: 0o755,
    },
  );
  const codex = requireProviderDriver("codex").createClient(
    { executable: fakeCodex, version: "0.160.1", source: "system" },
    5_000,
    { ...NO_PROVIDER_CREDENTIALS, egressEnvironment: () => service.environment() },
  );
  codex.start();
  const codexEnvironment = await waitForFile(dump);
  await Effect.runPromise(codex.stop());
  assert.ok(codexEnvironment.includes(`HTTPS_PROXY=${agentEnvironment.HTTPS_PROXY}\n`), "Codex gets HTTPS_PROXY.");
  assert.ok(codexEnvironment.includes(`NO_PROXY=${agentEnvironment.NO_PROXY}\n`), "Codex gets NO_PROXY.");
  assert.ok(!codexEnvironment.includes(PASSWORD), "Codex does not get the upstream password.");
  pass("Codex app-server: its spawn environment has the gateway variables while the switch is on");

  // Each stdio MCP server, for each provider shape: the gateway variables come last, so a configured
  // proxy cannot send a server's traffic past the egress proxy.
  const tools = { binDirectories: [], commandAliases: {}, launchEnvironment: service.environment() };
  const resolved = await Effect.runPromise(usableMcpServer(stdioServer("search"), tools));
  const codexEntry = codexMcpServers([resolved]).servers.search;
  assert.ok(codexEntry && "env" in codexEntry);
  assert.equal(codexEntry.env.HTTPS_PROXY, agentEnvironment.HTTPS_PROXY);
  assert.equal(codexEntry.env.NO_PROXY, agentEnvironment.NO_PROXY);
  const claudeEntry = claudeMcpServers([resolved]).servers.search;
  assert.ok(claudeEntry?.type === "stdio");
  assert.equal(claudeEntry.env.HTTP_PROXY, agentEnvironment.HTTP_PROXY);
  const acpEntry = acpMcpServers([resolved]).servers[0];
  assert.ok(acpEntry && "env" in acpEntry);
  assert.ok(acpEntry.env.some((pair) => pair.name === "HTTPS_PROXY" && pair.value === agentEnvironment.HTTPS_PROXY));
  const untouched = await Effect.runPromise(
    usableMcpServer(stdioServer("plain"), { binDirectories: [], commandAliases: {} }),
  );
  const plainEntry = codexMcpServers([untouched]).servers.plain;
  assert.ok(plainEntry && "env" in plainEntry);
  assert.equal(plainEntry.env.HTTPS_PROXY, "http://direct.example.test:3128", "Off changes nothing for a server.");
  pass("MCP stdio servers: Codex, Claude and ACP entries start with the gateway variables while the switch is on");

  // 5. Fail closed: the upstream is down.
  await close(upstreamServer);
  targetHits = [];
  const down = await curl(agentEnvironment, `http://target${FAKE_DOMAIN}:${targetPort}/`, true);
  assert.notEqual(down.status, 200, "No request passes while the upstream is down.");
  assert.equal(targetHits.length, 0, "The target got nothing: no direct fallback.");
  assert.equal(service.view().reason, "unreachable");
  view = await service.test();
  assert.equal(view.state, "error");
  pass("fail closed: an unreachable proxy refuses, the state says so, and nothing goes direct");

  // 6. Fail closed: the upstream refuses the credentials.
  upstreamServer = createUpstream();
  await new Promise<void>((done) => upstreamServer.listen(upstreamPort, "127.0.0.1", () => done()));
  upstreamPassword = "another-password";
  view = await service.test();
  assert.equal(view.reason, "auth");
  const refused = await curl(service.environment(), `http://target${FAKE_DOMAIN}:${targetPort}/`, false);
  assert.equal(refused.status, 502, refused.body);
  assert.ok(refused.body.includes("Network egress"), refused.body);
  assert.ok(!refused.body.includes(PASSWORD), "The refusal does not show the password.");
  // The browser answers a proxy challenge once per page, then cancels.
  assert.deepEqual(
    service.proxyLogin(1, "https://a.example/", { isProxy: true, host: "127.0.0.1", port: upstreamPort }),
    {
      username: USER,
      password: PASSWORD,
    },
  );
  assert.equal(
    service.proxyLogin(1, "https://a.example/", { isProxy: true, host: "127.0.0.1", port: upstreamPort }),
    "cancel",
  );
  assert.equal(service.proxyLogin(1, "https://a.example/", { isProxy: false, host: "a.example", port: 443 }), null);
  pass("fail closed: refused credentials answer 502, and the browser sign-in is cancelled, never shown");

  // Rotate the password: no agent restart, the next connection uses it.
  upstreamPassword = "rotated-pass-7781";
  view = await service.update({ ...settings(upstreamPort, "rotated-pass-7781") });
  assert.equal(view.state, "active");
  const rotated = await curl(agentEnvironment, `http://target${FAKE_DOMAIN}:${targetPort}/`, true);
  assert.equal(rotated.status, 200, rotated.body);
  pass("rotation: a new password applies at the next connection with the same agent environment");

  // A saved password never goes to another host, port or user: a typo, or an admin who names a host
  // of their choice, gets a request to type the password, and the other host gets nothing.
  const otherPort = await listen(otherProxy);
  const incomplete = sourceText("error.host.egressIncomplete");
  await assert.rejects(
    service.update({ ...settings(otherPort, undefined) }),
    (error: Error) => error.message === incomplete,
  );
  await assert.rejects(
    service.update({ ...settings(upstreamPort, undefined), username: "another-user" }),
    (error: Error) => error.message === incomplete,
  );
  assert.equal(store.password(), "rotated-pass-7781", "A refused save keeps the setting as it was.");
  // Off, the same change saves, and the saved password does not go with it.
  view = await service.update({ ...settings(otherPort, undefined), enabled: false });
  assert.equal(view.passwordSaved, false);
  assert.equal(store.password(), null);
  view = await service.test();
  assert.equal(otherAuthorizations, 0, "The other host got no Proxy-Authorization.");
  await assert.rejects(
    service.update({ ...settings(otherPort, undefined) }),
    (error: Error) => error.message === incomplete,
  );
  assert.equal(otherAuthorizations, 0, "The other host still got no Proxy-Authorization.");
  // The same host, port and user keep the saved password when the field is empty.
  view = await service.update(settings(upstreamPort, "rotated-pass-7781"));
  assert.equal(view.state, "active");
  view = await service.update({ ...settings(upstreamPort, undefined), blockOtherCountry: true });
  assert.equal(view.passwordSaved, true);
  assert.equal(view.state, "active");
  pass("password: a change of host, port or user without the password is refused or drops it; no other host gets it");

  // 7. Fail closed: another country blocks everything but the bypass hosts.
  geoCountry = "US";
  view = await service.test();
  assert.equal(view.reason, "country");
  assert.equal(view.lastCheck?.countryMatches, false);
  assert.equal(service.mode().kind, "blocked");
  const blocked = await curl(agentEnvironment, `http://target${FAKE_DOMAIN}:${targetPort}/`, false);
  assert.equal(blocked.status, 502, blocked.body);
  assert.notEqual((await curl(agentEnvironment, `http://target${FAKE_DOMAIN}:${targetPort}/`, true)).status, 200);
  const gate = session.gate();
  assert.ok(gate, "The browser session has a gate while blocked.");
  assert.equal(await gate("https://example.com/"), false);
  assert.equal(await gate("https://hub.culturabuilder.com/"), true);
  assert.equal(session.calls.at(-1)?.proxyRules, "http://127.0.0.1:9");
  targetHits = [];
  await assert.rejects(service.fetch(`http://target${FAKE_DOMAIN}:${targetPort}/`));
  assert.equal(targetHits.length, 0, "The main process fetch fails closed too.");
  geoCountry = "BR";
  view = await service.test();
  assert.equal(view.state, "active");
  assert.equal(session.gate(), null);
  pass("fail closed: another country blocks the browser and the tools; a passing check opens them again");

  // 8. The secret in logs and errors.
  const leaked = redactText(
    `failed: 127.0.0.1:${upstreamPort}:${USER}:rotated-pass-7781 and http://${USER}:rotated-pass-7781@127.0.0.1:${upstreamPort}`,
  );
  assert.ok(!leaked.includes("rotated-pass-7781"), leaked);
  assert.ok(!leaked.includes(`${USER}:`), leaked);
  pass("redaction: the password and the full line are masked in a log line");

  // 9. The store: encrypted at rest, and an unreadable password blocks.
  const reloaded = new EgressProxyStore(join(folder, "egress.json"), fakeCipher);
  await runCauseEffect(reloaded.load());
  assert.equal(reloaded.password(), "rotated-pass-7781");
  const unreadable = new EgressProxyStore(join(folder, "egress.json"), brokenCipher);
  await runCauseEffect(unreadable.load());
  assert.equal(unreadable.unreadable(), true);
  const blockedService = new EgressProxyService({
    store: unreadable,
    gateway: new EgressGateway({ route: () => ({ kind: "blocked" }) }),
    check,
  });
  assert.equal(blockedService.mode().kind, "blocked");
  assert.equal(blockedService.view().reason, "secret");
  assert.ok(
    blockedService.environment().HTTP_PROXY,
    "An unreadable password still gives the agents a proxy, never none.",
  );
  pass("store: the password is encrypted at rest; a password that cannot be decrypted blocks");

  // 10. A new server takes the app default: a file that this process writes before the first start
  // of the server, never the environment of the server.
  const defaultStore = new EgressProxyStore(join(folder, "default.json"), fakeCipher);
  await runCauseEffect(defaultStore.load());
  const defaults = new EgressProxyDefault({
    store: defaultStore,
    log: { warn: () => undefined },
    serverStore: (userData) => new EgressProxyStore(join(userData, EGRESS_PROXY_FILE), fakeCipher),
  });
  await defaults.set(settings(upstreamPort, PASSWORD));
  // The default follows the same password rule as a server.
  await assert.rejects(defaults.set(settings(otherPort, undefined)), (error: Error) => error.message === incomplete);
  assert.equal(defaultStore.settings().port, upstreamPort);
  const spawned: { env: NodeJS.ProcessEnv; seeded: boolean }[] = [];
  const localServers = (writeEgressDefault: (userData: string) => Promise<void>) =>
    new LocalServers({
      registryPath: join(folder, "local-servers.json"),
      userDataRoot: join(folder, "local-servers"),
      agentRoot: join(folder, "local-agents"),
      runtimeRoot: join(folder, "runtimes"),
      cipher: fakeCipher,
      remoteServers: {
        setThisComputerServers: () => undefined,
        attachLocalServer: () => Effect.die(new Error("A child that exits never attaches.")),
        detachLocalServer: () => Effect.void,
      },
      command: { executable: "/bin/sh", args: ["-c", "exit 3", "fake-server"] },
      trash: async () => undefined,
      log: { info: () => undefined, warn: () => undefined },
      platform: process.platform,
      spawn: (command, args, options) => {
        const userData = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? "";
        spawned.push({ env: { ...options.env }, seeded: existsSync(join(userData, EGRESS_PROXY_FILE)) });
        return spawn(command, args, { ...options, env: { PATH: process.env.PATH ?? "" } });
      },
      writeEgressDefault,
    });
  // The fake child exits at once, so the creation fails after the spawn; the spawn is what is checked.
  await Effect.runPromise(
    Effect.result(localServers((userData) => defaults.writeToNewServer(userData)).create("Marketing")),
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.seeded, true, "The setting file is there before the first start.");
  const childEnvironment = JSON.stringify(spawned[0]?.env ?? {});
  assert.ok(!childEnvironment.includes(PASSWORD), "The environment of the new server has no proxy password.");
  assert.ok(!childEnvironment.includes("OPENBOT_LOCAL_SERVER_EGRESS"));
  const seededFolder = join(folder, "local-servers");
  const seededFiles = readdirSync(seededFolder);
  const childStore = new EgressProxyStore(join(seededFolder, seededFiles[0] ?? "", EGRESS_PROXY_FILE), fakeCipher);
  await runCauseEffect(childStore.load());
  assert.equal(childStore.settings().enabled, true);
  assert.equal(childStore.settings().port, upstreamPort);
  assert.equal(childStore.password(), PASSWORD);
  assert.ok(!readFileSync(join(seededFolder, seededFiles[0] ?? "", EGRESS_PROXY_FILE), "utf8").includes(PASSWORD));
  // A default that cannot be written stops the creation before any start: no server without its proxy.
  const refusing = new EgressProxyDefault({
    store: defaultStore,
    log: { warn: () => undefined },
    serverStore: (userData) => new EgressProxyStore(join(userData, EGRESS_PROXY_FILE), refusingCipher),
  });
  const failed = await Effect.runPromise(
    Effect.result(localServers((userData) => refusing.writeToNewServer(userData)).create("Sales")),
  );
  assert.ok(Result.isFailure(failed));
  assert.equal(spawned.length, 1, "A server whose default was not written never starts.");
  pass(
    "default: a new local server finds it on disk before its first start; no password in its environment; a failed write stops the creation",
  );

  const sent: { serverId: string; update: EgressProxyUpdate }[] = [];
  await defaults.serverCreated("hosted-1");
  await defaults.serverCreated("hosted-2");
  const remoteViews: Record<string, EgressProxyView> = {
    "hosted-1": {
      ...view,
      enabled: false,
      host: "",
      port: null,
      username: "",
      passwordSaved: false,
      state: "off",
      reason: null,
    },
    "hosted-2": { ...view, enabled: false, host: "owner-proxy.example.test", port: 3128, state: "off", reason: null },
  };
  const remote = {
    supportsCapability: () => true,
    readView: (serverId: string) => Effect.sync(() => remoteViews[serverId] ?? view),
    sendUpdate: (serverId: string, update: EgressProxyUpdate) =>
      Effect.sync(() => {
        sent.push({ serverId, update });
      }),
  };
  // Not in the list yet: it keeps waiting.
  await defaults.reconcile([], remote);
  assert.deepEqual(defaultStore.pendingServers(), ["hosted-1", "hosted-2"]);
  // A joined server where the user is a member never takes it.
  await defaults.reconcile([{ id: "joined-1", kind: "remote", state: "online", role: "member" }], remote);
  await defaults.reconcile(
    [
      { id: "hosted-1", kind: "remote", state: "online", role: "owner" },
      { id: "hosted-2", kind: "remote", state: "online", role: "owner" },
    ],
    remote,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.serverId, "hosted-1");
  assert.deepEqual(defaultStore.pendingServers(), []);
  assert.equal(sent[0]?.update.password, PASSWORD);
  pass("default: a new hosted server takes it when online; a server whose owner set a proxy keeps it");

  await service.close();
  await Promise.all([close(target), close(geo), close(upstreamServer), close(otherProxy)]);
  report.passed = true;
}

main()
  .catch((error: unknown) => {
    report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  })
  .finally(async () => {
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.passed ? 0 : 1);
  });
