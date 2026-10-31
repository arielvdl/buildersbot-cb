/**
 * The Cultura Builder sign-in of the web app: one Hub device grant, held by one browser.
 *
 * The bridge names each grant with a flow ID, and whoever polls with that ID gets the session when the
 * person approves the code on the Hub. So the flow ID never goes to JavaScript: the start answer sets
 * it in an HttpOnly cookie of this origin, and a poll reads it only from that cookie. A poll from
 * another browser has no cookie, and a page cannot read the cookie to send it somewhere else. The page
 * gets only what the person types or opens: the user code and the Hub address.
 *
 * `__Host-` keeps a subdomain from setting the cookie, and `SameSite=Strict` keeps it off requests that
 * another site starts. The cookie lives only as long as the code.
 *
 * Each flow has its own cookie, named with a random tag that the page gets and sends back. Two tabs, or
 * a browser tab and the installed web app that share the cookies, can then each wait for their own
 * code: a second start does not replace the flow of the first. The tag is not a secret. Without the
 * HttpOnly cookie, nobody can poll the flow.
 */

const COOKIE_PREFIX = "__Host-buildersbot-device-";
/** 8 random bytes in base64url. */
const TAG = /^[A-Za-z0-9_-]{11}$/u;
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";
/** The bridge refuses a longer flow ID (`device-bridge.ts`). */
const FLOW_ID_LIMIT = 128;
/** The Hub pages that a sign-in code can send the person to. */
const CULTURA_BUILDER_DOMAIN = "culturabuilder.com";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): string | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** A new tag for the cookie of one flow. */
export function newWebDeviceFlowTag(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(8))) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** The tag that a poll or a cancel sends, or null when it is not one that a start made. */
export function webDeviceFlowTag(value: unknown): string | null {
  return typeof value === "string" && TAG.test(value) ? value : null;
}

/**
 * The flow ID of the flow that `tag` names in this browser, or null. A cookie that the browser sends
 * twice is not trusted.
 */
export function webDeviceFlowId(request: Request, tag: string): string | null {
  const name = `${COOKIE_PREFIX}${tag}`;
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  const [value] = values;
  if (values.length !== 1 || value === undefined) return null;
  const encoded = value.slice(name.length + 1);
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(encoded)) return null;
  const flowId = fromBase64Url(encoded);
  return flowId && flowId.length <= FLOW_ID_LIMIT ? flowId : null;
}

/**
 * The `Set-Cookie` value that binds the flow `tag` to this browser for `maxAgeSeconds`, or the one that
 * clears it.
 */
export function webDeviceFlowCookie(tag: string, flow: { flowId: string; maxAgeSeconds: number } | null): string {
  const name = `${COOKIE_PREFIX}${tag}`;
  if (flow === null) return `${name}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
  const maxAge = Math.max(1, Math.floor(flow.maxAgeSeconds));
  return `${name}=${toBase64Url(flow.flowId)}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAge}`;
}

/**
 * A Hub address that the page may open, or null. It must be HTTPS on the Cultura Builder domain, or on
 * the bridge origin itself (a development bridge), so a changed bridge answer cannot send the person
 * to another site with the page's own button.
 */
export function deviceVerificationUrl(value: string | null, bridgeUrl: string): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return null;
    if (url.origin === new URL(bridgeUrl).origin) return url.toString();
    const host = url.hostname.toLowerCase();
    const onDomain = host === CULTURA_BUILDER_DOMAIN || host.endsWith(`.${CULTURA_BUILDER_DOMAIN}`);
    return url.protocol === "https:" && onDomain ? url.toString() : null;
  } catch {
    return null;
  }
}
