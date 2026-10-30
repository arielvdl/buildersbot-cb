// @vitest-environment node
// The Playwright broker against a fake upstream that speaks the part of MCP the broker reads.
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type BrokerIdentityStore, PlaywrightBroker, type UpstreamProcess } from "./playwright-broker";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: { action?: string } };
}

interface RpcReply {
  id: number;
  error?: { message: string };
  result?: { isError?: boolean; content: { text: string }[] };
}

interface Fake {
  server: Server;
  url: string;
  /** The only `Host` the fake answers. */
  hostHeader: string;
  /** Every request the fake upstream got: `METHOD session body`. */
  requests: string[];
  /** The headers of the last request, to see what the broker forwards. */
  lastHeaders: Record<string, string | string[] | undefined>;
  sessions: Set<string>;
  failNextTab: boolean;
}

const fakes: Fake[] = [];
const brokers: PlaywrightBroker[] = [];

afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const fake of fakes.splice(0)) {
    fake.server.closeAllConnections();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  }
});

async function fakeUpstream(): Promise<Fake> {
  const requests: string[] = [];
  const lastHeaders: Fake["lastHeaders"] = {};
  const state = { requests, sessions: new Set<string>(), tabs: new Map<string, number>() };
  const fake = { requests, sessions: state.sessions, failNextTab: false, lastHeaders };
  let counter = 0;
  let expectedHost = "";
  const server = createServer((request, response) => {
    // The real Playwright server answers only the host it prints, so this one does as well.
    if (request.headers.host !== expectedHost) {
      response.writeHead(403, { "content-type": "text/plain" }).end(`Access is only allowed at ${expectedHost}`);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const session = String(request.headers["mcp-session-id"] ?? "");
      state.requests.push(`${request.method} ${session} ${text}`);
      Object.assign(fake.lastHeaders, request.headers);
      if (request.method === "DELETE") {
        state.sessions.delete(session);
        response.writeHead(200).end();
        return;
      }
      const message: RpcMessage = text ? JSON.parse(text) : {};
      if (message.method === "initialize") {
        counter += 1;
        const id = `upstream-${counter}`;
        state.sessions.add(id);
        state.tabs.set(id, 1);
        response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": id });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n\n`);
        return;
      }
      if (message.method === "tools/call") {
        const action = message.params?.arguments?.action;
        let isError = false;
        if (action === "new") {
          if (fake.failNextTab) {
            fake.failNextTab = false;
            isError = true;
          } else state.tabs.set(session, (state.tabs.get(session) ?? 1) + 1);
        }
        if (action === "close") state.tabs.set(session, Math.max(0, (state.tabs.get(session) ?? 1) - 1));
        const lines = Array.from(
          { length: state.tabs.get(session) ?? 0 },
          (_, index) => `- ${index}: [x](about:blank)`,
        );
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: `### Result\n${lines.join("\n")}` }],
              ...(isError ? { isError } : {}),
            },
          })}\n\n`,
        );
        return;
      }
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  expectedHost = `localhost:${address.port}`;
  const full: Fake = Object.assign(fake, {
    server,
    url: `http://127.0.0.1:${address.port}`,
    hostHeader: expectedHost,
  });
  fakes.push(full);
  return full;
}

function memoryIdentity(): BrokerIdentityStore & { saved: { port: number; secret: string } | null } {
  const store: BrokerIdentityStore & { saved: { port: number; secret: string } | null } = {
    saved: null,
    read: () => (store.saved ? { port: store.saved.port, secret: store.saved.secret } : null),
    write: (identity) => {
      store.saved = identity;
    },
  };
  return store;
}

interface Setup {
  broker: PlaywrightBroker;
  fake: Fake;
  launched: () => number;
  stopped: () => number;
  exit: () => void;
  base: string;
  bearer: string;
  identity: ReturnType<typeof memoryIdentity>;
}

async function setup(
  options: {
    limits?: { tabsPerSession: number; tabsTotal: number; sessions: number };
    noSpec?: boolean;
    clock?: { now: number };
  } = {},
): Promise<Setup> {
  const fake = await fakeUpstream();
  let launches = 0;
  let stops = 0;
  const exitListeners: (() => void)[] = [];
  const identity = memoryIdentity();
  const clock = options.clock ?? { now: 1_000 };
  const broker = new PlaywrightBroker({
    upstream: () => (options.noSpec ? null : { command: "unused", args: [], env: {} }),
    identity,
    limits: options.limits ?? { tabsPerSession: 2, tabsTotal: 3, sessions: 2 },
    now: () => clock.now,
    launch: async (): Promise<UpstreamProcess> => {
      launches += 1;
      return {
        url: fake.url,
        hostHeader: fake.hostHeader,
        stop: async () => {
          stops += 1;
        },
        onExit: (listener) => void exitListeners.push(listener),
      };
    },
  });
  brokers.push(broker);
  await broker.start();
  const endpoint = broker.endpoint();
  if (!endpoint) throw new Error("no endpoint");
  return {
    broker,
    fake,
    launched: () => launches,
    stopped: () => stops,
    exit: () => {
      for (const listener of exitListeners) listener();
    },
    base: endpoint.url,
    bearer: endpoint.bearer,
    identity,
  };
}

interface Reply {
  status: number;
  text: string;
  session: string | null;
}

async function post(s: Setup, body: unknown, session?: string, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(s.base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${s.bearer}`,
      ...(session ? { "mcp-session-id": session } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text(), session: response.headers.get("mcp-session-id") };
}

const initialize = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-06-18" },
});
const tabs = (id: number, action: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "browser_tabs", arguments: { action } },
});

async function open(s: Setup): Promise<string> {
  const reply = await post(s, initialize());
  if (!reply.session) throw new Error(`no session: ${reply.text}`);
  return reply.session;
}

describe("the door", () => {
  it("refuses a request with no bearer, and one with a wrong bearer", async () => {
    const s = await setup();
    const none = await fetch(s.base, { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
    const wrong = await fetch(s.base, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(wrong.status).toBe(401);
    expect(s.launched()).toBe(0);
  });

  it("refuses a request that names another host, as a rebound name would", async () => {
    const s = await setup();
    const url = new URL(s.base);
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: "/mcp",
          method: "POST",
          headers: { host: "evil.example", authorization: `Bearer ${s.bearer}`, "content-type": "application/json" },
        },
        (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify(initialize()));
    });
    expect(status).toBe(403);
    expect(s.launched()).toBe(0);
  });

  it("answers only /mcp, and only POST, GET and DELETE", async () => {
    const s = await setup();
    const other = await fetch(s.base.replace("/mcp", "/other"), { headers: { authorization: `Bearer ${s.bearer}` } });
    expect(other.status).toBe(404);
    const put = await fetch(s.base, { method: "PUT", headers: { authorization: `Bearer ${s.bearer}` } });
    expect(put.status).toBe(405);
  });

  it("does not forward the bearer of the agent to the upstream", async () => {
    const s = await setup();
    await open(s);
    expect(s.fake.lastHeaders.authorization).toBeUndefined();
  });

  it("rejects a body that is too large or is not JSON", async () => {
    const s = await setup();
    expect((await post(s, "{ not json")).status).toBe(400);
    expect((await post(s, "x".repeat(1_100_000))).status).toBe(413);
  });

  it("rejects a batch of requests", async () => {
    const s = await setup();
    const reply = await post(s, [initialize(1), initialize(2)]);
    expect(reply.status).toBe(400);
  });
});

describe("the upstream", () => {
  it("starts only when an agent asks, once, and not for a refused request", async () => {
    const s = await setup();
    expect(s.launched()).toBe(0);
    await fetch(s.base, { method: "POST", body: "{}" });
    expect(s.launched()).toBe(0);
    await open(s);
    await open(s);
    expect(s.launched()).toBe(1);
  });

  it("tells the agent, in words, when there is no Playwright server to start", async () => {
    const s = await setup({ noSpec: true });
    const reply = await post(s, initialize(9));
    const body: RpcReply = JSON.parse(reply.text);
    expect(body.id).toBe(9);
    expect(body.error?.message).toContain("No Playwright server");
  });

  it("forgets the sessions when the upstream ends, so an agent starts again", async () => {
    const s = await setup();
    const session = await open(s);
    s.exit();
    const reply = await post(s, tabs(2, "list"), session);
    expect(reply.status).toBe(404);
  });
});

describe("the sessions", () => {
  it("keeps each agent's own session id, and sends a request to the upstream with it", async () => {
    const s = await setup();
    const a = await open(s);
    const b = await open(s);
    expect(a).not.toBe(b);
    await post(s, tabs(2, "list"), a);
    expect(s.fake.requests.at(-1)).toContain(`POST ${a}`);
  });

  it("reads an unknown session as missing", async () => {
    const s = await setup();
    const reply = await post(s, tabs(2, "list"), "never-issued");
    expect(reply.status).toBe(404);
  });

  it("refuses a new session past the limit, with a message and the request id", async () => {
    const s = await setup();
    await open(s);
    await open(s);
    const reply = await post(s, initialize(5));
    const body: RpcReply = JSON.parse(reply.text);
    expect(body.id).toBe(5);
    expect(body.error?.message).toContain("in use by 2 agents");
    expect(s.broker.usage().sessions).toBe(2);
  });

  it("frees a place when a session is deleted", async () => {
    const s = await setup();
    const a = await open(s);
    await open(s);
    const del = await fetch(s.base, {
      method: "DELETE",
      headers: { authorization: `Bearer ${s.bearer}`, "mcp-session-id": a },
    });
    expect(del.status).toBe(200);
    expect(s.broker.usage().sessions).toBe(1);
    expect((await post(s, initialize())).session).not.toBeNull();
  });

  it("requires a session id for GET and for a request that is not initialize", async () => {
    const s = await setup();
    const get = await fetch(s.base, { headers: { authorization: `Bearer ${s.bearer}` } });
    expect(get.status).toBe(400);
    expect((await post(s, tabs(1, "list"))).status).toBe(400);
  });
});

describe("the tab limits", () => {
  it("lets an agent open tabs up to its limit, then answers with a refusal that says what to do", async () => {
    const s = await setup();
    const a = await open(s);
    expect((await post(s, tabs(2, "new"), a)).text).not.toContain("isError");
    expect((await post(s, tabs(3, "new"), a)).text).not.toContain("isError");
    const refused = await post(s, tabs(4, "new"), a);
    const body: RpcReply = JSON.parse(refused.text);
    expect(body.id).toBe(4);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toContain("browser_tabs action=close");
    // The refused request never reached the upstream.
    expect(s.fake.requests.filter((line) => line.includes('"action":"new"'))).toHaveLength(2);
    expect(s.broker.usage().tabs).toBe(2);
  });

  it("opens again after a close", async () => {
    const s = await setup();
    const a = await open(s);
    await post(s, tabs(2, "new"), a);
    await post(s, tabs(3, "new"), a);
    await post(s, tabs(4, "close"), a);
    const reply = await post(s, tabs(5, "new"), a);
    expect(reply.text).not.toContain('"isError":true');
    expect(s.broker.usage().tabs).toBe(2);
  });

  it("holds all agents to the total", async () => {
    const s = await setup();
    const a = await open(s);
    const b = await open(s);
    await post(s, tabs(2, "new"), a);
    await post(s, tabs(3, "new"), a);
    await post(s, tabs(4, "new"), b);
    const refused = await post(s, tabs(5, "new"), b);
    const refusedBody: RpcReply = JSON.parse(refused.text);
    expect(refusedBody.result?.isError).toBe(true);
    expect(refused.text).toContain("together");
  });

  it("does not count a tab the upstream failed to open", async () => {
    const s = await setup();
    const a = await open(s);
    s.fake.failNextTab = true;
    await post(s, tabs(2, "new"), a);
    expect(s.broker.usage().tabs).toBe(0);
  });

  it("gives the tabs back when a session ends", async () => {
    const s = await setup();
    const a = await open(s);
    await post(s, tabs(2, "new"), a);
    await fetch(s.base, { method: "DELETE", headers: { authorization: `Bearer ${s.bearer}`, "mcp-session-id": a } });
    expect(s.broker.usage().tabs).toBe(0);
  });
});

describe("the identity", () => {
  it("keeps the same port and bearer across a restart, so a resumed agent finds its address", async () => {
    const first = await setup();
    const url = first.base;
    const saved = first.identity.saved;
    expect(saved?.secret).toBeTruthy();
    await first.broker.stop();

    const broker = new PlaywrightBroker({
      upstream: () => null,
      identity: { read: () => saved, write: () => {} },
    });
    brokers.push(broker);
    await broker.start();
    expect(broker.endpoint()).toEqual({ url, bearer: saved?.secret });
  });

  it("gives no endpoint before start and after stop", async () => {
    const s = await setup();
    await s.broker.stop();
    expect(s.broker.endpoint()).toBeNull();
  });
});

describe("the idle stop", () => {
  async function idleSetup() {
    const clock = { now: 1_000 };
    const fake = await fakeUpstream();
    let stops = 0;
    const broker = new PlaywrightBroker({
      upstream: () => ({ command: "unused", args: [], env: {} }),
      identity: memoryIdentity(),
      now: () => clock.now,
      idleSessionMs: 1_000,
      idleUpstreamMs: 1_000,
      launch: async () => ({
        url: fake.url,
        hostHeader: fake.hostHeader,
        stop: async () => {
          stops += 1;
        },
        onExit: () => {},
      }),
    });
    brokers.push(broker);
    await broker.start();
    const endpoint = broker.endpoint();
    if (!endpoint) throw new Error("no endpoint");
    const reply = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${endpoint.bearer}`,
      },
      body: JSON.stringify(initialize()),
    });
    await reply.text();
    const session = reply.headers.get("mcp-session-id") ?? "";
    /** A request from the agent, which keeps its session in use. */
    const touch = async () => {
      const answer = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${endpoint.bearer}`,
          "mcp-session-id": session,
        },
        body: JSON.stringify(tabs(2, "list")),
      });
      await answer.text();
    };
    return { clock, fake, broker, stops: () => stops, touch };
  }

  it("ends a session that was idle, and tells the upstream so", async () => {
    const { clock, fake, broker } = await idleSetup();
    expect(broker.usage().sessions).toBe(1);
    await broker.releaseIdle();
    expect(broker.usage().sessions).toBe(1);

    clock.now += 2_000;
    await broker.releaseIdle();
    expect(broker.usage().sessions).toBe(0);
    expect(fake.requests.some((line) => line.startsWith("DELETE upstream-"))).toBe(true);
    expect(fake.sessions.size).toBe(0);
  });

  it("stops the upstream only after it has had no session for the idle time", async () => {
    const { clock, broker, stops } = await idleSetup();
    clock.now += 2_000;
    await broker.releaseIdle();
    expect(broker.usage().upstream).toBe(true);
    expect(stops()).toBe(0);

    clock.now += 2_000;
    await broker.releaseIdle();
    expect(stops()).toBe(1);
    expect(broker.usage().upstream).toBe(false);
  });

  it("keeps the upstream while a session is in use", async () => {
    const { clock, broker, stops, touch } = await idleSetup();
    clock.now += 800;
    await touch();
    clock.now += 800;
    await broker.releaseIdle();
    expect(broker.usage().sessions).toBe(1);
    clock.now += 800;
    await touch();
    clock.now += 800;
    await broker.releaseIdle();
    expect(broker.usage().sessions).toBe(1);
    expect(stops()).toBe(0);
  });
});
