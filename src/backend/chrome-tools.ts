/**
 * `openbot_chrome`: the browser tools on the tabs of the person's own Chrome, through the Builders Bot
 * extension (DESIGN §10.2). The definitions are those of `openbot_browser`, with descriptions of their
 * own, so an agent reads one schema and gets one result format in either browser. `openbot_browser`
 * keeps the Builders Bot browser, with the Vault, persistent sessions and takeover from the phone.
 *
 * The namespace exists for an agent only while web access is "chrome" and its turn may use the
 * owner's Chrome; the router grants it per call. Tools that need what this release does not carry to
 * Chrome yet (upload by content, the secret handoff, the card fill, the takeover card, recording, the
 * environment and the agent's own scripts) are not in it.
 */

import { advertisedJsonSchema } from "./agent/advertised-json-schema";
import { BROWSER_TOOL_DEFINITIONS, type BrowserToolCall } from "./browser-tools";

export const OPENBOT_CHROME_NAMESPACE = "openbot_chrome";

export const CHROME_TOOL_NAMES = [
  "open",
  "list_tabs",
  "status",
  "snapshot",
  "navigate",
  "click",
  "type",
  "fill_fields",
  "press",
  "hover",
  "scroll",
  "select_option",
  "set_checked",
  "drag",
  "wait_for",
  "screenshot",
  "handle_dialog",
  "close_tab",
] as const;
export type ChromeToolName = (typeof CHROME_TOOL_NAMES)[number];

/**
 * Tools of `openbot_browser` that run the agent's own JavaScript in the page. In Chrome they read the
 * person's signed-in sites, so they are off unless the person allows them for the project (DESIGN §7,
 * item 19). They are not in the catalog; a call gets `scripts_disabled`.
 */
export const CHROME_SCRIPT_TOOLS: ReadonlySet<string> = new Set(["evaluate", "run_script"]);

const CHROME_DESCRIPTIONS: Partial<Record<ChromeToolName, string>> = {
  open: "Open an HTTP(S) URL in a tab of the person's own Chrome, which keeps the person's sign-ins. The tab joins the tab group named after this project, in the background, without focus. Your blank tab is reused; prefer navigate in a tab you have.",
  list_tabs:
    "List your tabs in the person's Chrome, including popups that your pages opened (openerTabId). The same tabs stay yours in your next turn: navigate one of them before you open another.",
  status: "Get your Chrome tabs and their state.",
  close_tab: "Close one of your Chrome tabs. Close the extra tabs you opened as soon as you are done with them.",
};

function isChromeToolName(name: string): name is ChromeToolName {
  return CHROME_TOOL_NAMES.some((candidate) => candidate === name);
}

const CHROME_TOOL_DEFINITIONS = BROWSER_TOOL_DEFINITIONS.filter((definition) => isChromeToolName(definition.name));

export const CHROME_DYNAMIC_TOOLS = [
  {
    type: "namespace" as const,
    name: OPENBOT_CHROME_NAMESPACE,
    description:
      "Operate tabs of the person's own Chrome through the Builders Bot extension: the person's real, signed-in browser, in a tab group named after the project.",
    tools: CHROME_TOOL_DEFINITIONS.map((definition) => ({
      type: "function" as const,
      name: definition.name,
      description:
        (isChromeToolName(definition.name) ? CHROME_DESCRIPTIONS[definition.name] : undefined) ??
        definition.description,
      inputSchema: advertisedJsonSchema(definition.schema),
    })),
  },
];

export type ChromeToolCall = Extract<BrowserToolCall, { tool: ChromeToolName }>;

/** Parses a call of the namespace, with the same schemas as `openbot_browser`. */
export function parseChromeToolCall(tool: string, value: unknown): ChromeToolCall {
  const definition = CHROME_TOOL_DEFINITIONS.find((candidate) => candidate.name === tool);
  if (!definition || !isChromeToolName(definition.name)) throw new Error(`Unknown Chrome tool: ${tool}`);
  const call = definition.parse(value);
  if (!isChromeCall(call)) throw new Error(`Unknown Chrome tool: ${tool}`);
  return call;
}

function isChromeCall(call: BrowserToolCall): call is ChromeToolCall {
  return isChromeToolName(call.tool);
}

/** The guidance that a search or a describe of a Chrome tool returns. */
export const CHROME_TOOL_GUIDANCE = [
  "These are openbot_chrome tools, not direct tools: run them with openbot.tool_call and their qualified names. They drive tabs of the person's own Chrome, which is signed in to the person's sites: act only as the task needs.",
  "Take a snapshot before you act. Prefer revision-bound refs and unique role/name targets, then text, CSS, and coordinates. Input actions return a short status; call snapshot when you need to read the page.",
  "Your tabs are in the tab group of this project, and they stay yours in your next turn: call list_tabs and navigate a tab you have before you open another. Open a second tab only when you need two pages at the same time, and close extra tabs when you are done. The extension refuses a new tab past a small limit for you, for the project and for all agents; then close or reuse a tab.",
  "Banks, exchanges, password vaults, Google and Apple accounts, and government sites are blocked for agents in Chrome: ask the person to do that step. A send, reply, or post on a mail, chat, or social site waits for the person to approve the text and recipients on a card. When the person pauses or stops the agents in Chrome, wait and tell the person; do not work around it.",
  "For a password, a code, a card, a file upload, or a site that needs the person, use openbot_browser instead.",
].join("\n");
