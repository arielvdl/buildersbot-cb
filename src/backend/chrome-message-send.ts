/**
 * The rule for a message that an agent sends in the person's Chrome (DESIGN §7, item 20). The Chrome
 * Web Store does not allow an extension to send messages for the person "without giving the user the
 * ability to confirm the content and intended recipients", so each send on a communication site waits
 * for a card with the text and the recipients, also when the person said "Always" for the project.
 *
 * The rule is a gate in code, before the action, not a model instruction. It is a heuristic: a site is
 * a communication site by its host, and an action is a send by the name of what it clicks, an Enter
 * key, or a type with submit. On such a site, a click on a target that the host cannot name (a CSS
 * selector or a point) counts as a send, so the rule fails closed.
 */

import type { BrowserElement, BrowserSnapshot, BrowserTarget } from "@openbot/contracts/ipc";

/** Hosts where people write to each other: mail, chat, social networks and forums. */
const COMMUNICATION_HOSTS = [
  "mail.google.com",
  "chat.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.proton.me",
  "app.fastmail.com",
  "app.slack.com",
  "discord.com",
  "web.whatsapp.com",
  "web.telegram.org",
  "teams.microsoft.com",
  "teams.live.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "facebook.com",
  "messenger.com",
  "instagram.com",
  "threads.net",
  "bsky.app",
  "reddit.com",
  "mastodon.social",
  "web.skype.com",
  "zoom.us",
] as const;

/** Host labels that name mail or chat on any domain, such as `webmail.example.com`. */
const COMMUNICATION_LABELS = new Set(["mail", "webmail", "chat", "messages", "inbox"]);

/** Names of a control that sends, in English and Portuguese, as people label them. */
const SEND_NAME =
  /\b(send|sending|reply|reply all|respond|post|publish|tweet|retweet|repost|share|comment|submit|enviar|envie|envio|responder|publicar|postar|compartilhar|comentar|mandar)\b/iu;

/** Field names that hold recipients. */
const RECIPIENT_NAME = /^(to|cc|bcc|recipients?|para|cco|destinat[áa]rios?)\b/iu;

const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox"]);
const MAX_CARD_TEXT = 1_500;

export function isCommunicationSite(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (COMMUNICATION_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) return true;
  const first = host.split(".")[0] ?? "";
  return COMMUNICATION_LABELS.has(first);
}

/** The element that a target names in the last snapshot, when the target is a ref of it. */
function elementOf(target: BrowserTarget | undefined, snapshot: BrowserSnapshot | null): BrowserElement | null {
  if (target?.kind !== "ref" || !snapshot) return null;
  return snapshot.elements.find((element) => element.ref === target.ref) ?? null;
}

/** The name of what an action targets, or null when only the page knows it. */
function targetName(target: BrowserTarget | undefined, snapshot: BrowserSnapshot | null): string | null {
  if (!target) return null;
  switch (target.kind) {
    case "ref":
      return elementOf(target, snapshot)?.name ?? null;
    case "role":
      return target.name ?? null;
    case "text":
      return target.text;
    case "css":
    case "point":
      return null;
  }
}

/** One agent action in a tab, as the gate sees it. */
export type ChromeAction =
  | { readonly tool: "click"; readonly target: BrowserTarget }
  | { readonly tool: "press"; readonly key: string; readonly target?: BrowserTarget | undefined }
  | {
      readonly tool: "type";
      readonly text: string;
      readonly submit: boolean;
      readonly target?: BrowserTarget | undefined;
    };

/** What the person reads on the card. */
export interface MessageSendCard {
  readonly site: string;
  /** The name of the control, or the key, that sends. */
  readonly action: string;
  readonly text: string;
  readonly recipients: string[];
}

/**
 * Whether the action sends a message, and the card for it: null when it does not. `snapshot` is the
 * last snapshot that this agent read of the tab; the card takes the text and the recipients from it.
 */
export function messageSendCard(
  url: string,
  action: ChromeAction,
  snapshot: BrowserSnapshot | null,
): MessageSendCard | null {
  if (!isCommunicationSite(url)) return null;
  let label: string | null;
  switch (action.tool) {
    case "click": {
      const name = targetName(action.target, snapshot);
      // A target that the host cannot name can be the send button: the card asks.
      if (name !== null && !SEND_NAME.test(name)) return null;
      label = name ?? "a control that the agent chose by position or selector";
      break;
    }
    case "press": {
      const key = action.key.split("+").at(-1)?.toLowerCase() ?? "";
      if (key !== "enter") return null;
      label = action.key;
      break;
    }
    case "type":
      if (!action.submit && !action.text.includes("\n")) return null;
      label = action.submit ? "Enter" : "a new line";
      break;
  }
  const fields = (snapshot?.elements ?? []).filter(
    (element) => element.role !== null && TEXT_ROLES.has(element.role) && element.value,
  );
  const recipients = fields
    .filter((element) => RECIPIENT_NAME.test(element.name))
    .map((element) => element.value ?? "")
    .slice(0, 20);
  const typed = action.tool === "type" ? [action.text] : [];
  const written = fields.filter((element) => !RECIPIENT_NAME.test(element.name)).map((element) => element.value ?? "");
  const text = [...written, ...typed].join("\n").trim();
  let site = url;
  try {
    site = new URL(url).origin;
  } catch {
    // The URL was checked above.
  }
  return {
    site,
    action: label,
    text: [...text].length > MAX_CARD_TEXT ? `${[...text].slice(0, MAX_CARD_TEXT - 1).join("")}…` : text,
    recipients,
  };
}
