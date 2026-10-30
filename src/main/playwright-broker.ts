import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createBuildersBotLogger, toLogValue } from "@openbot/logging";
import { listenLoopback } from "./listen-loopback";
import { BROKER_TOKEN_ENV, BROKER_TOKEN_HEADER, guardNodeOptions } from "./playwright-broker-guard";
import {
  BrowserLedger,
  type BrowserLimits,
  DEFAULT_BROWSER_LIMITS,
  inspectRpc,
  type RpcEntry,
  refusalResult,
  tabsDelta,
} from "./playwright-broker-policy";
import { maskSecrets } from "./playwright-broker-runtime";

const logger = createBuildersBotLogger("playwright-broker");

const MAX_BODY_BYTES = 1_000_000;
/** The part of a response the broker reads to count tabs. A longer answer is passed on, not counted. */
const MAX_TEE_BYTES = 256_000;
const UPSTREAM_START_TIMEOUT_MS = 45_000;
const REAP_INTERVAL_MS = 30_000;
/** Forwarded as they are. Anything else, the `Authorization` of the agent above all, stays behind. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control", "mcp-protocol-version"];

/** How the Playwright MCP server is started: from the row the person saved, with the flags set below. */
export interface BrokerUpstreamSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A running upstream. */
export interface UpstreamProcess {
  /** Where to connect: the loopback address and the port the server printed. */
  url: string;
  /**
   * The `Host` header to send. The Playwright server refuses any host but the one it prints, which is
   * `localhost:PORT` even when it listens on 127.0.0.1, so it is not always the host of `url`.
   */
  hostHeader?: string;
  stop(): Promise<void>;
  /** Called once, when the process ends by itself. */
  onExit(listener: () => void): void;
}

export type UpstreamLauncher = (spec: BrokerUpstreamSpec) => Promise<UpstreamProcess>;

/** The port and bearer that stay the same across restarts, so a resumed provider session keeps its address. */
export interface BrokerIdentityStore {
  read(): { port: number | null; secret: string } | null;
  write(identity: { port: number; secret: string }): void;
}

export interface PlaywrightBrokerOptions {
  /**
   * The guard file that the Playwright process loads (`installGuard`). The process refuses every request
   * without the token that the broker makes for it, so the door is the only way in.
   */
  guardPath: string;
  /** The upstream to start, from the saved Playwright row, or null while no such row is enabled. */
  upstream: () => BrokerUpstreamSpec | null;
  identity: BrokerIdentityStore;
  limits?: BrowserLimits;
  launch?: UpstreamLauncher;
  /** A session with no request for this long is ended. */
  idleSessionMs?: number;
  /** With no session for this long the upstream stops, so the person's browser is free. */
  idleUpstreamMs?: number;
  now?: () => number;
}

export interface BrokerEndpoint {
  url: string;
  bearer: string;
}

function jsonRpcError(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * One Playwright MCP server for every agent, and a loopback door in front of it.
 *
 * Without this, each agent starts its own `@playwright/mcp`, and each of those starts its own
 * Chrome or asks the extension for the person's browser. A few at once use all the memory. Here,
 * one `@playwright/mcp --extension --shared-browser-context` talks to the extension once, and every
 * agent is a session of it. No browser is started by Builders Bot at any point.
 *
 * The door adds what the Playwright server has not: a bearer (the server has no sign-in, and its
 * browser holds the person's logged-in sites), a limit on agent sessions, and a limit on the tabs
 * that agents hold open. It starts the upstream only when the first agent asks, and stops it when
 * no agent has used it for a while.
 */
export class PlaywrightBroker {
  readonly #options: PlaywrightBrokerOptions;
  readonly #ledger: BrowserLedger;
  readonly #limits: BrowserLimits;
  readonly #launch: UpstreamLauncher;
  readonly #now: () => number;
  #server: Server | null = null;
  #port: number | null = null;
  #secret: string | null = null;
  #upstream: UpstreamProcess | null = null;
  /** The token of the running upstream. A new upstream has a new one. */
  #upstreamToken: string | null = null;
  #starting: Promise<UpstreamProcess> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #emptySince: number | null = null;

  constructor(options: PlaywrightBrokerOptions) {
    this.#options = options;
    this.#limits = options.limits ?? DEFAULT_BROWSER_LIMITS;
    this.#ledger = new BrowserLedger(this.#limits);
    this.#launch = options.launch ?? launchPlaywrightMcp;
    this.#now = options.now ?? Date.now;
  }

  /** The address and bearer that agents are given, or null before `start`. */
  endpoint(): BrokerEndpoint | null {
    if (this.#port === null || this.#secret === null) return null;
    return { url: `http://127.0.0.1:${this.#port}/mcp`, bearer: this.#secret };
  }

  /** Listens on the port it had, when it is free. Nothing else starts here: the upstream waits for an agent. */
  async start(): Promise<void> {
    if (this.#server) return;
    const saved = this.#options.identity.read();
    this.#secret = saved?.secret ?? randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        logger.warn("A browser request failed.", { cause: toLogValue(error) });
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(jsonRpcError(null, -32603, "The browser broker failed."));
      });
    });
    this.#port = await listenLoopback(
      server,
      () => new Error("The browser broker has no loopback port."),
      saved?.port ?? undefined,
    );
    this.#server = server;
    this.#options.identity.write({ port: this.#port, secret: this.#secret });
    this.#timer = setInterval(() => void this.releaseIdle(), REAP_INTERVAL_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.#stopUpstream();
  }

  /** How many agent sessions and tabs the broker holds now. For the load panel and for tests. */
  usage(): { sessions: number; tabs: number; upstream: boolean } {
    return { sessions: this.#ledger.sessionCount(), tabs: this.#ledger.totalTabs(), upstream: this.#upstream !== null };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const secret = this.#secret;
    if (secret === null) return reply(response, 503, jsonRpcError(null, -32000, "The browser broker is not ready."));
    // A browser page that points a name at this address must not reach the person's browser.
    const host = singleHeader(request.headers.host) ?? "";
    if (host !== `127.0.0.1:${this.#port}` && host !== `localhost:${this.#port}`)
      return reply(response, 403, jsonRpcError(null, -32000, "Wrong host."));
    if (!bearerMatches(singleHeader(request.headers.authorization), secret))
      return reply(response, 401, jsonRpcError(null, -32001, "Unauthorized."));
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp")
      return reply(response, 404, jsonRpcError(null, -32000, "Not found."));
    const method = request.method ?? "";
    if (method !== "POST" && method !== "GET" && method !== "DELETE")
      return reply(response, 405, jsonRpcError(null, -32000, "Method not allowed."));

    const session = singleHeader(request.headers["mcp-session-id"]);
    // A session id this broker did not issue, or one that ended, reads as missing: the client starts a new one.
    if (session !== undefined && !this.#ledger.has(session))
      return reply(response, 404, jsonRpcError(null, -32001, "Session not found."));
    if (session !== undefined) this.#ledger.touch(session, this.#now());

    if (method === "POST") return this.#handlePost(request, response, session);
    if (session === undefined) return reply(response, 400, jsonRpcError(null, -32000, "A session id is required."));
    return this.#forward(request, response, session, undefined, []);
  }

  #busyMessage(): string {
    return `The browser is in use by ${this.#ledger.sessionCount()} agents, which is the limit. Try again in a minute, or go on without the browser.`;
  }

  async #handlePost(request: IncomingMessage, response: ServerResponse, session: string | undefined): Promise<void> {
    const raw = await readBody(request);
    if (raw === "too-large") return reply(response, 413, jsonRpcError(null, -32000, "Request too large."));
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(response, 400, jsonRpcError(null, -32700, "Parse error."));
    }
    if (Array.isArray(body) && body.length > 1)
      return reply(response, 400, jsonRpcError(null, -32600, "Batches are not supported."));
    const entries = inspectRpc(body);
    const initialize = entries.find((entry) => entry.kind === "initialize");

    if (initialize && session === undefined && !this.#ledger.canAdmit())
      return reply(response, 200, jsonRpcError(initialize.id, -32000, this.#busyMessage()));
    if (!initialize && session === undefined)
      return reply(response, 400, jsonRpcError(null, -32000, "A session id is required."));

    if (session !== undefined) {
      const newTab = entries.find((entry) => entry.kind === "tab-new");
      if (newTab) {
        const decision = this.#ledger.checkNewTab(session);
        if (!decision.allowed)
          return reply(
            response,
            200,
            JSON.stringify({ jsonrpc: "2.0", id: newTab.id, result: refusalResult(decision) }),
          );
      }
    }
    await this.#forward(request, response, session, raw, entries);
  }

  async #forward(
    request: IncomingMessage,
    response: ServerResponse,
    session: string | undefined,
    body: Buffer | undefined,
    entries: readonly RpcEntry[],
  ): Promise<void> {
    let upstream: UpstreamProcess;
    try {
      upstream = await this.#ensureUpstream();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The browser did not start.";
      const id = entries[0]?.id ?? null;
      return reply(response, 200, jsonRpcError(id, -32000, message));
    }
    this.#emptySince = null;
    const target = new URL(upstream.url);
    const headers: Record<string, string> = {
      host: upstream.hostHeader ?? target.host,
      [BROKER_TOKEN_HEADER]: this.#upstreamToken ?? "",
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = singleHeader(request.headers[name]);
      if (value !== undefined) headers[name] = value;
    }
    if (body) headers["content-length"] = String(body.length);
    await new Promise<void>((resolve) => {
      const outgoing = httpRequest(
        { host: target.hostname, port: target.port, path: "/mcp", method: request.method, headers },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          const responseHeaders: Record<string, string> = {};
          for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = singleHeader(incoming.headers[name]);
            if (value !== undefined) responseHeaders[name] = value;
          }
          response.writeHead(status, responseHeaders);
          const tee: Buffer[] = [];
          let teeSize = 0;
          incoming.on("data", (chunk: Buffer) => {
            if (teeSize < MAX_TEE_BYTES) {
              tee.push(chunk);
              teeSize += chunk.length;
            }
            response.write(chunk);
          });
          incoming.on("end", () => {
            response.end();
            this.#afterResponse(
              request.method ?? "",
              session,
              incoming.headers,
              entries,
              Buffer.concat(tee).toString("utf8"),
            );
            resolve();
          });
          incoming.on("error", () => {
            response.destroy();
            resolve();
          });
        },
      );
      outgoing.on("error", () => {
        if (!response.headersSent)
          reply(response, 502, jsonRpcError(entries[0]?.id ?? null, -32000, "The browser server did not answer."));
        else response.destroy();
        resolve();
      });
      request.on("close", () => {
        if (!response.writableEnded) outgoing.destroy();
      });
      if (body) outgoing.write(body);
      outgoing.end();
    });
  }

  #afterResponse(
    method: string,
    session: string | undefined,
    headers: IncomingHttpHeaders,
    entries: readonly RpcEntry[],
    text: string,
  ): void {
    const issued = singleHeader(headers["mcp-session-id"]);
    if (method === "POST" && entries.some((entry) => entry.kind === "initialize") && issued) {
      this.#ledger.register(issued, this.#now());
      return;
    }
    if (method === "DELETE" && session !== undefined) {
      this.#ledger.endSession(session);
      return;
    }
    if (method === "POST" && session !== undefined) this.#ledger.applyDelta(session, tabsDelta(entries, text));
  }

  async #ensureUpstream(): Promise<UpstreamProcess> {
    if (this.#upstream) return this.#upstream;
    if (!this.#starting) {
      const spec = this.#options.upstream();
      if (!spec) throw new Error("No Playwright server is set up in Builders Bot.");
      const token = randomBytes(32).toString("base64url");
      const env: NodeJS.ProcessEnv = {
        ...spec.env,
        [BROKER_TOKEN_ENV]: token,
        NODE_OPTIONS: guardNodeOptions(this.#options.guardPath, spec.env.NODE_OPTIONS),
      };
      this.#starting = this.#launch({ ...spec, env }).then(
        (process) => {
          this.#upstream = process;
          this.#upstreamToken = token;
          this.#starting = null;
          process.onExit(() => {
            if (this.#upstream === process) this.#upstream = null;
            // Its sessions went with it. The agents read a missing session and start again.
            this.#ledger.endAll();
          });
          return process;
        },
        (error: unknown) => {
          this.#starting = null;
          throw error;
        },
      );
    }
    return this.#starting;
  }

  async #stopUpstream(): Promise<void> {
    const upstream = this.#upstream;
    this.#upstream = null;
    this.#upstreamToken = null;
    if (upstream) await upstream.stop();
  }

  /**
   * Ends the sessions that no agent has used for a while, and stops the upstream when none is left
   * for a while. A timer calls it; it is public so a test can run it at a chosen time.
   */
  async releaseIdle(): Promise<void> {
    const now = this.#now();
    const idleSessionMs = this.#options.idleSessionMs ?? 15 * 60_000;
    for (const id of this.#ledger.idleSessions(now, idleSessionMs)) {
      this.#ledger.endSession(id);
      await this.#endUpstreamSession(id);
    }
    if (!this.#upstream) return;
    if (this.#ledger.sessionCount() > 0) {
      this.#emptySince = null;
      return;
    }
    this.#emptySince ??= now;
    if (now - this.#emptySince >= (this.#options.idleUpstreamMs ?? 10 * 60_000)) {
      this.#emptySince = null;
      await this.#stopUpstream();
    }
  }

  /** Tells the upstream that a session is over, so it lets go of what the session held. */
  #endUpstreamSession(id: string): Promise<void> {
    const upstream = this.#upstream;
    if (!upstream) return Promise.resolve();
    const target = new URL(upstream.url);
    return new Promise<void>((resolve) => {
      const outgoing = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: "/mcp",
          method: "DELETE",
          headers: {
            host: upstream.hostHeader ?? target.host,
            "mcp-session-id": id,
            [BROKER_TOKEN_HEADER]: this.#upstreamToken ?? "",
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.on("end", () => resolve());
        },
      );
      outgoing.on("error", () => resolve());
      outgoing.end();
    });
  }
}

function reply(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return "too-large";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Starts the Playwright MCP server as a child process and waits for the address it prints. */
export const launchPlaywrightMcp: UpstreamLauncher = (spec) =>
  new Promise<UpstreamProcess>((resolve, reject) => {
    // The server prints the connect URL, with the token of the extension, when the extension does not
    // answer. A message that reaches an agent must not carry it.
    const secrets = [spec.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, spec.env[BROKER_TOKEN_ENV]].filter(
      (value): value is string => typeof value === "string",
    );
    const child: ChildProcess = spawn(spec.command, spec.args, { env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const exitListeners: (() => void)[] = [];
    const timeout = setTimeout(() => {
      fail(new Error("The Playwright server did not start in time."));
      child.kill("SIGKILL");
    }, UPSTREAM_START_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(maskSecrets(error.message, secrets)));
    };
    const onData = (data: Buffer) => {
      if (settled) return;
      output = (output + data.toString("utf8")).slice(-4_000);
      const match = /Listening on (https?:\/\/[^\s]+)/u.exec(output);
      if (!match?.[1]) return;
      settled = true;
      clearTimeout(timeout);
      const printed = new URL(match[1]);
      // `localhost` can resolve to ::1, which a server bound to 127.0.0.1 does not answer.
      const url = new URL(printed.origin);
      url.hostname = "127.0.0.1";
      resolve({
        url: url.origin,
        hostHeader: printed.host,
        onExit: (listener) => void exitListeners.push(listener),
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            child.once("exit", () => done());
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
          }),
      });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => fail(new Error(`The Playwright server could not start: ${error.message}`)));
    child.on("exit", () => {
      fail(
        new Error(
          `The Playwright server stopped before it was ready. ${output.trim().split("\n").at(-1) ?? ""}`.trim(),
        ),
      );
      for (const listener of exitListeners) listener();
    });
  });
