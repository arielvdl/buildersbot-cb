// One request through the upstream proxy to a public IP location service, so an admin sees the
// address, city and country that the agents' traffic has. See docs/architecture/egress-proxy.md.
//
// The request goes through a `CONNECT` tunnel of the upstream, never direct. The answer is read
// with a size limit and each field is checked, because the service is outside our control.

import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { EGRESS_PROXY_LIMITS } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { openEgressTunnel } from "./egress-gateway";
import type { EgressUpstream } from "./egress-proxy-options";

/** Where the check asks. Tests give a loopback service with `secure: false`. */
export interface EgressCheckTarget {
  host: string;
  port: number;
  path: string;
  secure: boolean;
}

/** ipinfo.io answers `{ ip, city, region, country }` without a key, over HTTPS. */
export const EGRESS_CHECK_TARGET: EgressCheckTarget = { host: "ipinfo.io", port: 443, path: "/json", secure: true };

export type EgressCheckResult =
  | { ok: true; ip: string; city: string | null; region: string | null; country: string | null }
  | { ok: false; reason: "unreachable" | "auth" | "check" };

const MAX_ANSWER_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * The time limit of a Team API request to the update or test route of a server. Each one waits for a
 * check: a tunnel and an answer, each up to `DEFAULT_TIMEOUT_MS`, through a slow residential proxy.
 * With the default limit of a request, a save that the host did keep showed a failure, and the time
 * limit could mark the server offline.
 */
export const EGRESS_PROXY_REMOTE_TIMEOUT_MS = 45_000;

function place(value: unknown): string | null {
  if (!isString(value)) return null;
  const text = value.trim();
  return text && text.length <= EGRESS_PROXY_LIMITS.place ? text : null;
}

/** The fields of the answer, or null when it has no IP address. */
export function parseEgressCheckAnswer(value: unknown): Omit<Extract<EgressCheckResult, { ok: true }>, "ok"> | null {
  if (!isDynamicRecord(value)) return null;
  const ip = place(value.ip);
  if (!ip || ip.length > EGRESS_PROXY_LIMITS.ip || !/^[0-9a-f:.]+$/iu.test(ip)) return null;
  const country = place(value.country)?.toUpperCase() ?? null;
  return {
    ip,
    city: place(value.city),
    region: place(value.region),
    country: country && /^[A-Z]{2}$/u.test(country) ? country : null,
  };
}

export async function checkEgressProxy(
  upstream: EgressUpstream,
  target: EgressCheckTarget = EGRESS_CHECK_TARGET,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<EgressCheckResult> {
  const tunnel = await openEgressTunnel(upstream, `${target.host}:${target.port}`, timeoutMs);
  if (!tunnel.ok) return { ok: false, reason: tunnel.reason === "auth" ? "auth" : "unreachable" };
  const socket = tunnel.socket;
  socket.on("error", () => socket.destroy());
  // The tunnel answer and the first bytes of the service cannot arrive together: the service has not
  // been asked yet. Any byte here is not from the service, so the check fails.
  if (tunnel.rest.length) {
    socket.destroy();
    return { ok: false, reason: "check" };
  }
  const connection: Socket = target.secure ? tlsConnect({ socket, servername: target.host }) : socket;
  return new Promise<EgressCheckResult>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (result: EgressCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "check" }), timeoutMs);
    // One request with `Connection: close`, written by hand: the answer ends when the service closes.
    const send = () =>
      connection.write(
        `GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: application/json\r\nUser-Agent: BuildersBot-egress-check\r\nConnection: close\r\n\r\n`,
      );
    if (target.secure) connection.once("secureConnect", send);
    else send();
    connection.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) finish({ ok: false, reason: "check" });
      else chunks.push(chunk);
    });
    connection.once("error", () => finish({ ok: false, reason: "check" }));
    connection.once("close", () => {
      const answer = readCheckAnswer(Buffer.concat(chunks));
      finish(answer ? { ok: true, ...answer } : { ok: false, reason: "check" });
    });
  });
}

/** The fields of a 200 answer with a JSON body, plain or chunked, or null. */
function readCheckAnswer(raw: Buffer): ReturnType<typeof parseEgressCheckAnswer> {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const head = raw.subarray(0, end).toString("latin1");
  if (!/^HTTP\/1\.[01] 200 /u.test(head)) return null;
  let body = raw.subarray(end + 4);
  if (/^transfer-encoding:\s*chunked\s*$/imu.test(head)) {
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const lineEnd = body.indexOf("\r\n", offset);
      if (lineEnd < 0) return null;
      const length = Number.parseInt(body.subarray(offset, lineEnd).toString("latin1"), 16);
      if (!Number.isSafeInteger(length) || length < 0) return null;
      if (length === 0) break;
      parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + length));
      offset = lineEnd + 2 + length + 2;
    }
    body = Buffer.concat(parts);
  }
  try {
    return parseEgressCheckAnswer(JSON.parse(body.toString("utf8")));
  } catch {
    return null;
  }
}
