/**
 * The rule for a message that an agent sends in the person's Chrome (DESIGN §7, item 20). The Chrome
 * Web Store does not allow an extension to send messages for the person "without giving the user the
 * ability to confirm the content and intended recipients", so each send on a communication site waits
 * for a card with the text and the recipients, also when the person said "Always" for the project.
 *
 * The rule is a gate in code, before the action, not a model instruction. It fails closed:
 *
 * - a site is a communication site by the host of the page, or of the frame of the target (a chat
 *   widget in a frame), or of any frame of the last snapshot when the action has no target;
 * - a click is a send unless every element that the engine can resolve the target to has a name that
 *   is not a send. A ref names one element of the last snapshot, which the engine checks again before
 *   it acts. A role or text target is matched in the live page, which can have changed since the
 *   snapshot, so only an exact target can be told from a send: its name is the name of what the engine
 *   finds, and every element of the snapshot that it matches is checked too. A name with no letter or
 *   digit (an icon, an arrow) counts as no name, and no name counts as a send. A target that is not
 *   exact, a selector, a point and a stale ref count as a send;
 * - a key is read as the engine reads it (`parseShortcut`): Enter, NumpadEnter, Return and Space (which
 *   presses a focused button) are sends, and so is a key with Ctrl, Cmd or Alt (a mail site sends with
 *   Ctrl+Enter or Alt+S) unless it only edits text; a key that the engine refuses counts as a send;
 * - a `type` with `submit`, or with a new line or any other control or separator character, read as
 *   the engine reads it (`typedCharacters`), is a send;
 * - the card takes the text and the recipients from the last snapshot, so the caller refuses a send
 *   when an action ran after that snapshot (`ChromeTabsHost` counts them), and checks again after the
 *   person's answer that no action ran meanwhile.
 */

import type { BrowserElement, BrowserSnapshot, BrowserTarget } from "@openbot/contracts/ipc";
import { parseShortcut, typedCharacters } from "./browser-cdp-input";
import { textMatches } from "./browser-cdp-values";

/** Hosts where people write to each other: mail, chat, social networks, forums and code review. */
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
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "youtube.com",
  "news.ycombinator.com",
  "tiktok.com",
  "intercom.io",
  "zendesk.com",
  "crisp.chat",
  "tawk.to",
] as const;

/** Host labels that name mail or chat on any domain, such as `webmail.example.com`. */
const COMMUNICATION_LABELS = new Set(["mail", "webmail", "chat", "messages", "inbox", "messenger"]);

/**
 * Names of a control that sends, as people label them: English, Portuguese, Spanish, French, German,
 * Italian and Dutch. A name in another language with no word here is not a send; a control named only
 * by a symbol has no name.
 */
const SEND_NAME =
  /\b(send|sending|reply|reply all|respond|post|publish|tweet|retweet|repost|share|comment|submit|enviar|envie|envio|responder|publicar|postar|compartilhar|comentar|mandar|compartir|envoyer|envoi|répondre|publier|partager|commenter|poster|senden|absenden|antworten|veröffentlichen|teilen|kommentieren|posten|invia|inviare|rispondi|pubblica|condividi|commenta|verzenden|versturen|beantwoorden|plaatsen|delen)\b/iu;

/** Keys that send in a composer, or press the focused send button, as `parseShortcut` names them. */
const SEND_KEYS = new Set(["enter", "numpadenter", "return", " ", "space", "spacebar", "accept", "execute"]);
/** Keys that only edit or move in text, also with Ctrl, Cmd or Alt: select all, undo, redo, style. */
const EDIT_KEYS = new Set([
  "a",
  "z",
  "y",
  "b",
  "i",
  "u",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
  "backspace",
  "delete",
]);
const COMMAND_MODIFIERS = new Set(["Control", "Meta", "Alt"]);

/** Whether a name says what the control is: a letter or a digit, not only a symbol or an icon. */
const hasName = (name: string): boolean => /[\p{L}\p{N}]/u.test(name);
/** A character that ends a line or controls the input: a new line, a tab, a separator. */
const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** Field names that hold recipients. */
const RECIPIENT_NAME = /^(to|cc|bcc|recipients?|para|cc[oó]|destinat[áa]rios?)\b/iu;
/** A recipient shown as a chip: an e-mail address in the name of an option, a list item or a button. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
const CHIP_ROLES = new Set(["option", "listitem", "button", "gridcell", "row", "link"]);

const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox"]);
const MAX_CARD_TEXT = 1_500;
const MAX_RECIPIENTS = 20;

export function isCommunicationSite(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  } catch {
    return false;
  }
  if (COMMUNICATION_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) return true;
  const first = host.split(".")[0] ?? "";
  return COMMUNICATION_LABELS.has(first);
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
 * The elements of the last snapshot that a target can resolve to, as the engine resolves it; null when
 * the snapshot cannot tell (no snapshot, a stale ref, a selector or a point).
 */
function candidates(target: BrowserTarget | undefined, snapshot: BrowserSnapshot | null): BrowserElement[] | null {
  if (!target || !snapshot) return null;
  switch (target.kind) {
    case "ref": {
      if (target.revision !== snapshot.revision) return null;
      const element = snapshot.elements.find((entry) => entry.ref === target.ref);
      return element ? [element] : null;
    }
    case "role":
      return snapshot.elements.filter(
        (element) =>
          element.role === target.role &&
          (target.name === undefined || textMatches(element.name, target.name, target.exact === true)),
      );
    case "text":
      return snapshot.elements.filter((element) =>
        [element.name, element.description].some((value) => textMatches(value, target.text, target.exact === true)),
      );
    case "css":
    case "point":
      return null;
  }
}

/** Whether the target, or a frame that the action may reach, is on a communication site. */
function onCommunicationSite(url: string, action: ChromeAction, snapshot: BrowserSnapshot | null): boolean {
  if (isCommunicationSite(url)) return true;
  const elements = action.target ? (candidates(action.target, snapshot) ?? []) : (snapshot?.elements ?? []);
  return elements.some((element) => element.frame !== null && isCommunicationSite(element.frame.url));
}

/** The name that a role or text target gives, which an exact target shares with what the engine finds. */
function targetName(target: BrowserTarget): string | null {
  if (target.kind === "role") return target.name ?? null;
  if (target.kind === "text") return target.text;
  return null;
}

/** Whether the action sends, and the label of what sends; null when it does not send. */
function sendLabel(action: ChromeAction, snapshot: BrowserSnapshot | null): string | null {
  switch (action.tool) {
    case "click": {
      const { target } = action;
      // The engine finds a role or text target in the live page, by a part of its name unless it is
      // exact: what it finds can be another element than the snapshot showed.
      if ((target.kind === "role" || target.kind === "text") && target.exact !== true)
        return "a control that the agent named by a part of its name";
      const named = targetName(target);
      if (named !== null && (!hasName(named) || SEND_NAME.test(named))) return named.trim() || "a control with no name";
      const found = candidates(target, snapshot);
      // A target that the snapshot cannot name can be the send button: the card asks.
      if (found === null || found.length === 0) return "a control that the agent chose by position or selector";
      const sending = found.find((element) => !hasName(element.name) || SEND_NAME.test(element.name));
      if (!sending) return null;
      return hasName(sending.name) ? sending.name : "a control with no name";
    }
    case "press": {
      const parsed = parseShortcut(action.key);
      // A key that the engine refuses does nothing; one that this gate cannot read asks.
      if (!parsed) return action.key;
      const key = parsed.key.toLowerCase();
      if (SEND_KEYS.has(key)) return action.key;
      const command = parsed.modifiers.some((modifier) => COMMAND_MODIFIERS.has(modifier));
      return command && !EDIT_KEYS.has(key) ? action.key : null;
    }
    case "type":
      if (action.submit) return "Enter";
      return typedCharacters(action.text).some((character) => CONTROL_CHARACTER.test(character))
        ? "a new line or a control character"
        : null;
  }
}

/** The recipients that the snapshot shows: recipient fields, and chips with an e-mail address. */
function recipientsOf(elements: readonly BrowserElement[]): string[] {
  const fromFields = elements
    .filter((element) => element.role !== null && TEXT_ROLES.has(element.role) && RECIPIENT_NAME.test(element.name))
    .map((element) => element.value ?? "")
    .filter((value) => value.trim() !== "");
  const fromChips = elements
    .filter((element) => element.role !== null && CHIP_ROLES.has(element.role))
    .map((element) => EMAIL.exec(element.name)?.[0] ?? "")
    .filter((value) => value !== "");
  return [...new Set([...fromFields, ...fromChips])].slice(0, MAX_RECIPIENTS);
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
  if (!onCommunicationSite(url, action, snapshot)) return null;
  const label = sendLabel(action, snapshot);
  if (label === null) return null;
  const elements = snapshot?.elements ?? [];
  const fields = elements.filter((element) => element.role !== null && TEXT_ROLES.has(element.role) && element.value);
  const typed = action.tool === "type" ? [action.text.replace(/\r\n?/gu, "\n")] : [];
  const written = fields.filter((element) => !RECIPIENT_NAME.test(element.name)).map((element) => element.value ?? "");
  const text = [...written, ...typed].join("\n").trim();
  let site = url;
  try {
    site = new URL(url).origin;
  } catch {
    // A frame's site made it a communication site; the page URL stays as it is.
  }
  return {
    site,
    action: label,
    text: [...text].length > MAX_CARD_TEXT ? `${[...text].slice(0, MAX_CARD_TEXT - 1).join("")}…` : text,
    recipients: recipientsOf(elements),
  };
}
