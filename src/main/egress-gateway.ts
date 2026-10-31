// The loopback egress gateway of one server process. See docs/architecture/egress-proxy.md.
//
// Agent processes and the Playwright browser use this HTTP proxy, never the upstream proxy itself,
// so they get no proxy password: only a token that is valid on loopback for the life of this
// process. The gateway sends each `CONNECT` and each absolute-form HTTP request on to the upstream
// with the stored credentials. It never opens a direct connection: when the upstream fails, or the
// setting blocks, it answers 502 with a sentence that names the setting.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { type EgressGatewayAddress, type EgressUpstream, upstreamAuthorization } from "./egress-proxy-options";

/** Where a new connection goes now. Read for each connection, so a change applies at once. */
export type EgressGatewayRoute = { kind: "proxy"; upstream: EgressUpstream } | { kind: "blocked" } | { kind: "off" };

/** What a connection told about the upstream. `ok` clears an earlier failure. */
export type EgressTrafficResult = "ok" | "unreachable" | "auth";

export interface EgressGatewayOptions {
  route: () => EgressGatewayRoute;
  onResult?: (result: EgressTrafficResult) => void;
  connectTimeoutMs?: number;
  maxConnections?: number;
}

/** A tunnel through the upstream, or why there is none. */
export type EgressTunnel =
  | { ok: true; socket: Socket; rest: Buffer }
  | { ok: false; reason: "unreachable" | "auth" | "refused"; status?: number };

const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const TARGET = /^(?:\[[0-9a-f:.]{2,45}\]|[a-z0-9.-]{1,253}):\d{1,5}$/iu;

/**
 * Opens `CONNECT target` through the upstream and resolves when the upstream answers. A 407 is
 * `auth`; a socket error or the time limit is `unreachable`; another status is `refused`, which
 * names the target, not the proxy.
 */
export function openEgressTunnel(upstream: EgressUpstream, target: string, timeoutMs: number): Promise<EgressTunnel> {
  return new Promise((resolve) => {
    let settled = false;
    let head = Buffer.alloc(0);
    const socket = connect({ host: upstream.host, port: upstream.port });
    const finish = (result: EgressTunnel) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      if (!result.ok) socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "unreachable" }), timeoutMs);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_RESPONSE_HEAD_BYTES) finish({ ok: false, reason: "unreachable" });
        return;
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(head.subarray(0, end).toString("latin1"))?.[1] ?? 0);
      if (status === 200) finish({ ok: true, socket, rest: head.subarray(end + 4) });
      else if (status === 407) finish({ ok: false, reason: "auth", status });
      else finish({ ok: false, reason: status ? "refused" : "unreachable", ...(status ? { status } : {}) });
    };
    socket.on("data", onData);
    socket.once("error", () => finish({ ok: false, reason: "unreachable" }));
    socket.once("close", () => finish({ ok: false, reason: "unreachable" }));
    socket.once("connect", () => {
      const authorization = upstreamAuthorization(upstream);
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`,
      );
    });
  });
}

/** The sentence that a tool shows when the gateway does not send its request. */
export function egressRefusalText(reason: "blocked" | "unreachable" | "auth" | "refused"): string {
  if (reason === "blocked") return sourceText("error.host.egressBlocked");
  if (reason === "auth") return sourceText("error.host.egressAuthRefused");
  if (reason === "refused") return sourceText("error.host.egressTargetRefused");
  return sourceText("error.host.egressUnreachable");
}

export class EgressGateway {
  readonly #options: EgressGatewayOptions;
  readonly #username = "builders-bot";
  readonly #token = randomBytes(24).toString("base64url");
  #server: Server | null = null;
  #port: number | null = null;
  #starting: Promise<void> | null = null;

  constructor(options: EgressGatewayOptions) {
    this.#options = options;
    registerSecretValue(this.#token);
  }

  /** Null until `start` resolves. */
  address(): EgressGatewayAddress | null {
    return this.#port === null ? null : { port: this.#port, username: this.#username, token: this.#token };
  }

  /** Listens on loopback only, on a port that the system chooses. Calling it again does nothing. */
  start(): Promise<void> {
    this.#starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => this.#forward(request, response));
      server.maxConnections = this.#options.maxConnections ?? 512;
      server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) =>
        this.#tunnel(request, client, head),
      );
      server.on("clientError", (_error, socket) => socket.destroy());
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The egress gateway has no port."));
          return;
        }
        this.#server = server;
        this.#port = address.port;
        resolve();
      });
    }).catch((error: unknown) => {
      this.#starting = null;
      throw error;
    });
    return this.#starting;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    this.#starting = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The token is compared in constant time; the user name is not a secret. */
  #authorized(request: IncomingMessage): boolean {
    const header = request.headers["proxy-authorization"];
    if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== this.#username) return false;
    const given = Buffer.from(decoded.slice(separator + 1), "utf8");
    const expected = Buffer.from(this.#token, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  #tunnel(request: IncomingMessage, client: Socket, head: Buffer): void {
    client.on("error", () => client.destroy());
    if (!this.#authorized(request)) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Builders Bot"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    const target = request.url ?? "";
    if (!TARGET.test(target)) {
      refuseSocket(client, 400, "Bad Request", "Invalid CONNECT target.");
      return;
    }
    const route = this.#options.route();
    if (route.kind !== "proxy") {
      refuseSocket(client, 502, "Bad Gateway", egressRefusalText("blocked"));
      return;
    }
    void openEgressTunnel(route.upstream, target, this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS).then(
      (tunnel) => {
        if (!tunnel.ok) {
          if (tunnel.reason !== "refused") this.#options.onResult?.(tunnel.reason);
          refuseSocket(client, 502, "Bad Gateway", egressRefusalText(tunnel.reason));
          return;
        }
        this.#options.onResult?.("ok");
        const upstream = tunnel.socket;
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (tunnel.rest.length) client.write(tunnel.rest);
        if (head.length) upstream.write(head);
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      },
    );
  }

  /** A plain `http://` request in absolute form goes to the upstream as it is, with the credentials. */
  #forward(request: IncomingMessage, response: ServerResponse): void {
    if (!this.#authorized(request)) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Builders Bot"', "Content-Length": "0" });
      response.end();
      return;
    }
    const target = request.url ?? "";
    if (!target.startsWith("http://")) {
      refuseResponse(response, 400, "This is a proxy. Send an absolute http:// URL or CONNECT.");
      return;
    }
    const route = this.#options.route();
    if (route.kind !== "proxy") {
      refuseResponse(response, 502, egressRefusalText("blocked"));
      return;
    }
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const authorization = upstreamAuthorization(route.upstream);
    if (authorization) headers["proxy-authorization"] = authorization;
    const outgoing = httpRequest({
      host: route.upstream.host,
      port: route.upstream.port,
      method: request.method,
      path: target,
      headers,
      timeout: this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });
    outgoing.on("response", (incoming) => {
      if (incoming.statusCode === 407) {
        incoming.resume();
        this.#options.onResult?.("auth");
        refuseResponse(response, 502, egressRefusalText("auth"));
        return;
      }
      this.#options.onResult?.("ok");
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("The egress proxy did not answer in time.")));
    outgoing.on("error", () => {
      this.#options.onResult?.("unreachable");
      if (!response.headersSent) refuseResponse(response, 502, egressRefusalText("unreachable"));
      else response.destroy();
    });
    request.pipe(outgoing);
  }
}

function refuseSocket(client: Socket, status: number, statusText: string, text: string): void {
  const body = Buffer.from(`${text}\n`, "utf8");
  client.end(
    `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.toString("utf8")}`,
  );
}

function refuseResponse(response: ServerResponse, status: number, text: string): void {
  const body = `${text}\n`;
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    Connection: "close",
  });
  response.end(body);
}
