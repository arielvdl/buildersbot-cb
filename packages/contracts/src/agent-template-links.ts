/**
 * The addresses one agent template has: the page a person shares, the link that opens that template in
 * the app, and the browser client's entry for it.
 *
 * ```
 * https://buildersbot.culturabuilder.com/agents/<id>    the link a person shares and the app copies
 * openbot://agents/<id>                                 the link the page button opens
 * /app?agent=<id>                                       the page's link to the browser client, on the same origin
 * ```
 *
 * The template is stored by the account service that the app uses, so the share link is on that
 * service's site: the Builders Bot one, which also serves `/agents/<id>` and the web app. A link on the
 * upstream `openbot.run` site, from before, still opens in the app.
 *
 * This follows `plugin-links.ts`: the host gives the kind, one path segment gives the id, and a
 * query is refused, so the shape cannot grow an `?install=1`. A link opens a preview in the app;
 * installing is still a press of Install there.
 */

import { BUILDERSBOT_CONTROL_PLANE_FALLBACK_ORIGIN, BUILDERSBOT_CONTROL_PLANE_ORIGIN } from "./invite-links";

export const OPENBOT_AGENT_TEMPLATE_ORIGIN = "https://openbot.run";
/** The Builders Bot account service, which stores the templates of this build and serves their pages. */
export const BUILDERSBOT_AGENT_TEMPLATE_ORIGIN = BUILDERSBOT_CONTROL_PLANE_ORIGIN;
export const OPENBOT_AGENT_TEMPLATE_PATH_PREFIX = "/agents/";
export const OPENBOT_AGENT_TEMPLATE_HOST = "agents";
export const WEB_APP_AGENT_TEMPLATE_PARAM = "agent";

/** The Worker makes ids from 16 random bytes in base64url, which is 22 characters. */
const AGENT_TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export function isAgentTemplateId(value: string): boolean {
  return AGENT_TEMPLATE_ID_PATTERN.test(value);
}

/**
 * The site a share link names: the Builders Bot site, `openbot.run`, or a loopback origin while a
 * developer runs the Account Worker on this computer. Nothing else passes, so a configured address
 * cannot turn the copied link into another site.
 */
export function isAgentTemplateShareOrigin(origin: string): boolean {
  if (origin === BUILDERSBOT_AGENT_TEMPLATE_ORIGIN || origin === OPENBOT_AGENT_TEMPLATE_ORIGIN) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

/**
 * The share origin for an Account Worker: the Builders Bot site for the Builders Bot service (on its
 * main or its own address), the local Worker in development, `openbot.run` otherwise.
 */
export function agentTemplateShareOrigin(apiOrigin: string): string {
  if (apiOrigin === BUILDERSBOT_CONTROL_PLANE_ORIGIN || apiOrigin === BUILDERSBOT_CONTROL_PLANE_FALLBACK_ORIGIN)
    return BUILDERSBOT_AGENT_TEMPLATE_ORIGIN;
  return apiOrigin !== OPENBOT_AGENT_TEMPLATE_ORIGIN && isAgentTemplateShareOrigin(apiOrigin)
    ? apiOrigin
    : OPENBOT_AGENT_TEMPLATE_ORIGIN;
}

export function createAgentTemplateShareUrl(id: string, origin: string = BUILDERSBOT_AGENT_TEMPLATE_ORIGIN): string {
  assertAgentTemplateId(id);
  if (!isAgentTemplateShareOrigin(origin)) throw new Error("The Builders Bot agent link origin is invalid.");
  return `${origin}${OPENBOT_AGENT_TEMPLATE_PATH_PREFIX}${id}`;
}

/**
 * The browser client's entry for a template. It opens the same preview as the app; `/app` removes the
 * query after it reads it, so a reload does not open the preview again.
 */
export function createWebAppAgentTemplatePath(id: string): string {
  assertAgentTemplateId(id);
  return `/app?${WEB_APP_AGENT_TEMPLATE_PARAM}=${id}`;
}

/** The template id in a `/app` query, or null when the query names none or an invalid one. */
export function agentTemplateIdFromWebAppSearch(search: string): string | null {
  const id = new URLSearchParams(search).get(WEB_APP_AGENT_TEMPLATE_PARAM);
  return id !== null && isAgentTemplateId(id) ? id : null;
}

export function createBuildersBotAgentTemplateUrl(id: string): string {
  assertAgentTemplateId(id);
  return `openbot://${OPENBOT_AGENT_TEMPLATE_HOST}/${id}`;
}

/** The template id a link names, in either form. Throws for anything else. */
export function parseAgentTemplateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Builders Bot agent link is invalid.");
  }

  // The origin is compared as one string, so `openbot.run.example.com` does not pass.
  const canonical =
    url.protocol === "https:" &&
    (url.origin === BUILDERSBOT_AGENT_TEMPLATE_ORIGIN || url.origin === OPENBOT_AGENT_TEMPLATE_ORIGIN) &&
    url.pathname.startsWith(OPENBOT_AGENT_TEMPLATE_PATH_PREFIX);
  const customScheme = url.protocol === "openbot:" && url.hostname === OPENBOT_AGENT_TEMPLATE_HOST;
  if (
    (!canonical && !customScheme) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("The Builders Bot agent link is invalid.");
  }

  const rest = canonical
    ? url.pathname.slice(OPENBOT_AGENT_TEMPLATE_PATH_PREFIX.length)
    : url.pathname.replace(/^\//u, "");
  const segments = rest.split("/");
  if (segments.length !== 1) throw new Error("The Builders Bot agent link is invalid.");
  const id = segments[0] ?? "";
  assertAgentTemplateId(id);
  return id;
}

function assertAgentTemplateId(id: string): void {
  if (!isAgentTemplateId(id)) throw new Error("The Builders Bot agent link is invalid.");
}
