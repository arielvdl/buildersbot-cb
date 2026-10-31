// The `fetch` of the requests that this process sends for the agents: the MCP OAuth proxy, the
// GitHub MCP proxy and the MCP test. With the egress proxy on, these requests go through the
// loopback gateway of this server, as an agent's own requests do, so they use the proxy and fail
// closed with it. See docs/architecture/egress-proxy.md.

import { egressBypassMatches } from "@openbot/contracts/ipc";
import { ProxyAgent, fetch as proxiedFetch } from "undici";
import { egressRefusalText } from "./egress-gateway";
import type { EgressGatewayAddress, EgressMode } from "./egress-proxy-options";

/**
 * The body of an `undici` answer as a stream of the platform, read as it arrives, so an event
 * stream reaches the caller at once. A cancel of the caller cancels the answer.
 */
function platformStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

/** The statuses that a `Response` cannot have a body with. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export interface EgressFetchOptions {
  mode: () => EgressMode;
  /** The gateway of this server, or null when it did not start. */
  gateway: () => EgressGatewayAddress | null;
  /** The platform fetch, for the switch off and the bypass hosts. */
  direct?: typeof fetch;
}

export interface EgressFetch {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

/**
 * Off, or for a bypass host, the request goes direct as before. On, it goes to the gateway with the
 * gateway token, which sends it to the upstream with the stored credentials, or answers 502 while the
 * setting blocks. A gateway that did not start refuses: the request never goes direct.
 */
export function createEgressFetch(options: EgressFetchOptions): EgressFetch {
  const direct = options.direct ?? fetch;
  let agent: { port: number; dispatcher: ProxyAgent } | null = null;

  const dispatcherFor = (gateway: EgressGatewayAddress): ProxyAgent => {
    if (agent?.port === gateway.port) return agent.dispatcher;
    const previous = agent?.dispatcher;
    const credentials = Buffer.from(`${gateway.username}:${gateway.token}`, "utf8").toString("base64");
    agent = {
      port: gateway.port,
      dispatcher: new ProxyAgent({ uri: `http://127.0.0.1:${gateway.port}`, token: `Basic ${credentials}` }),
    };
    void previous?.close().catch(() => undefined);
    return agent.dispatcher;
  };

  const egressFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const mode = options.mode();
    const target = new URL(input instanceof Request ? input.url : input);
    if (mode.kind === "off" || egressBypassMatches(target.hostname, mode.bypass)) return direct(input, init);
    const gateway = options.gateway();
    if (!gateway) throw new TypeError(egressRefusalText("blocked"));
    // The platform `Request` reads every form of input and body once, the way `fetch` does.
    const request = new Request(input, init);
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const answer = await proxiedFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      redirect: request.redirect,
      signal: request.signal,
      dispatcher: dispatcherFor(gateway),
      ...(body ? { body } : {}),
    });
    const stream = NULL_BODY_STATUSES.has(answer.status) || !answer.body ? null : platformStream(answer.body);
    const response = new Response(stream, {
      status: answer.status,
      statusText: answer.statusText,
      headers: [...answer.headers],
    });
    // A caller reads where a redirect ended, as with the platform fetch.
    Object.defineProperty(response, "url", { value: answer.url });
    Object.defineProperty(response, "redirected", { value: answer.redirected });
    return response;
  };

  return {
    fetch: egressFetch,
    close: async () => {
      const current = agent;
      agent = null;
      await current?.dispatcher.close();
    },
  };
}
