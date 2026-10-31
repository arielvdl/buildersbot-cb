// The Guard on MCP tool results that pass through a proxy of this app, such as the shared Playwright
// browser. A proxy streams each response to the agent; this reads the response as it streams, finds
// each tool result, checks its text, and puts the Guard's note in front of it when the check asks for
// one. Everything else in the stream passes at once and unchanged, so no other message waits.

import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/** Checks the text of one tool result. It answers the note to put in front, or null to leave it. */
export type GuardResultCheck = (text: string) => Promise<string | null>;

/**
 * The most characters of one message that the reader holds. A longer message is not read in full:
 * it gets the strong note in front, unread, and the rest passes on as it arrives; or, when no note
 * can go in, it does not pass at all.
 */
const MESSAGE_LIMIT = 8 * 1024 * 1024;

/** What the reader does with a message that is too long to read in full. */
export interface McpResultGuardOptions {
  /** Tests give a small limit. */
  readonly messageLimit?: number;
  /** The note for a result that the reader could not read in full. */
  readonly uncoveredNotice: string;
  /**
   * Called for each such result, so the caller can log it. `noted` is false when no note could go
   * in, and the message was replaced by a result that holds only the note.
   */
  readonly onUncovered?: (noted: boolean) => void;
}

/** Where the content list of a tool result starts in the first part of a message. */
const RESULT_START = /"result"\s{0,16}:\s{0,16}\{/u;
const CONTENT_START = /"content"\s{0,16}:\s{0,16}\[(\s{0,16})/u;

/**
 * The first part of a message with the note put first in its content list, or null when the part has
 * no content list of a result. The list is found by its text, because the rest of the message has
 * not arrived.
 */
export function withLeadingNote(prefix: string, notice: string): string | null {
  const result = RESULT_START.exec(prefix);
  if (!result) return null;
  const after = result.index + result[0].length;
  const content = CONTENT_START.exec(prefix.slice(after));
  if (!content) return null;
  const at = after + content.index + content[0].length;
  const empty = prefix.charAt(at) === "]";
  const item = JSON.stringify({ type: "text", text: notice });
  return `${prefix.slice(0, at)}${item}${empty ? "" : ","}${prefix.slice(at)}`;
}
/** Where one event of a stream ends. */
const EVENT_END = /\r?\n\r?\n/u;

/** The text of a tool result: its text items and the text of its embedded resources. */
function resultText(content: readonly unknown[]): string | null {
  const texts = content.flatMap((item) => {
    if (!isDynamicRecord(item)) return [];
    if (item.type === "text" && typeof item.text === "string") return [item.text];
    if (item.type === "resource" && isDynamicRecord(item.resource) && typeof item.resource.text === "string")
      return [item.resource.text];
    return [];
  });
  return texts.length > 0 ? texts.join("\n") : null;
}

/** A tool result with the note in front, or null when the message is not a tool result or needs no note. */
async function guardedMessage(message: unknown, check: GuardResultCheck): Promise<unknown | null> {
  if (!isDynamicRecord(message) || !isDynamicRecord(message.result) || !Array.isArray(message.result.content))
    return null;
  const text = resultText(message.result.content);
  if (text === null) return null;
  const notice = await check(text);
  if (notice === null) return null;
  return {
    ...message,
    result: { ...message.result, content: [{ type: "text", text: notice }, ...message.result.content] },
  };
}

/** One JSON body: a message, or a batch of messages. Null when nothing in it changes. */
async function guardedJson(text: string, check: GuardResultCheck): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    let changed = false;
    const messages: unknown[] = [];
    for (const message of parsed) {
      const guarded = await guardedMessage(message, check);
      changed ||= guarded !== null;
      messages.push(guarded ?? message);
    }
    return changed ? JSON.stringify(messages) : null;
  }
  const guarded = await guardedMessage(parsed, check);
  return guarded === null ? null : JSON.stringify(guarded);
}

/** One event of a stream, with its data lines replaced by the guarded message when it changes. */
async function guardedEvent(event: string, ending: string, check: GuardResultCheck): Promise<string> {
  const lines = event.split(/\r?\n/u);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
  if (data.length === 0) return event + ending;
  const guarded = await guardedJson(data.join("\n"), check);
  if (guarded === null) return event + ending;
  const others = lines.filter((line) => !line.startsWith("data:"));
  return [...others, `data: ${guarded}`].join("\n") + ending;
}

/** The id of a JSON-RPC message, near its start or at its end, as JSON text. */
const ID_AT_START =
  /^\s{0,16}(?:data:\s{0,16})?\{(?:"[^"]{1,40}"\s{0,16}:\s{0,16}(?:"[^"]{0,40}"|[-\d.]{1,20})\s{0,16},\s{0,16}){0,4}"id"\s{0,16}:\s{0,16}(-?\d{1,20}|"(?:[^"\\]|\\.){0,200}")/u;
const ID_AT_END = /"id"\s{0,16}:\s{0,16}(-?\d{1,20}|"(?:[^"\\]|\\.){0,200}")\s{0,16}\}\s{0,16}$/u;
/** How much of the end of a dropped message the reader keeps, to find its id. */
const TAIL_KEEP = 1_024;

/** What the reader does with the message that it is in now. */
type Mode = "read" | "pass" | "drop";

/**
 * Reads one MCP response as it streams. `push` takes each part of the body and gives back the text
 * to send on now; `end` gives back the rest. An event stream passes event by event; a JSON body is
 * read whole first. A message longer than the limit is never passed in silence: it gets the strong
 * note in front of its content, or, when no note can go in, it is replaced by a result that holds only
 * the note, or dropped when it has no id to answer.
 */
export class McpResultGuard {
  readonly #check: GuardResultCheck;
  readonly #stream: boolean;
  readonly #options: McpResultGuardOptions;
  readonly #limit: number;
  readonly #decoder = new TextDecoder();
  #pending = "";
  #mode: Mode = "read";
  /** The last characters seen in pass or drop mode, to find the end of an event across parts. */
  #carry = "";
  /** For a dropped message: the id, when its start had one, and the last characters seen. */
  #droppedId: string | null = null;
  #droppedHeader = "";
  #droppedTail = "";

  constructor(contentType: string | null, check: GuardResultCheck, options: McpResultGuardOptions) {
    this.#check = check;
    this.#options = options;
    this.#limit = options.messageLimit ?? MESSAGE_LIMIT;
    this.#stream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  }

  async push(chunk: Uint8Array | string): Promise<string> {
    let text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    let output = "";
    while (text) {
      if (this.#mode !== "read") {
        const ended = this.#eventEnd(text);
        const part = ended < 0 ? text : text.slice(0, ended);
        if (this.#mode === "pass") output += part;
        else this.#droppedTail = (this.#droppedTail + part).slice(-TAIL_KEEP);
        if (ended < 0) return output;
        output += this.#closeMessage();
        text = text.slice(ended);
        continue;
      }
      this.#pending += text;
      text = "";
      if (!this.#stream) {
        if (this.#pending.length > this.#limit) output += this.#uncovered();
        return output;
      }
      for (let match = EVENT_END.exec(this.#pending); match !== null; match = EVENT_END.exec(this.#pending)) {
        const event = this.#pending.slice(0, match.index);
        this.#pending = this.#pending.slice(match.index + match[0].length);
        output += await guardedEvent(event, match[0], this.#check);
      }
      // Every whole event is out; what is left is one event that is not whole yet.
      if (this.#pending.length > this.#limit) output += this.#uncovered();
    }
    return output;
  }

  /**
   * A message too long to read in full. None of it has gone out yet. The strong note goes in front of
   * its content, and the rest passes unread. When no note can go in, the message does not pass: the
   * rest is dropped, and a result that holds only the note answers its id. The caller hears of each.
   */
  #uncovered(): string {
    const prefix = this.#take();
    const noted = withLeadingNote(prefix, this.#options.uncoveredNotice);
    this.#options.onUncovered?.(noted !== null);
    this.#carry = prefix.slice(-3);
    if (noted !== null) {
      this.#mode = "pass";
      return noted;
    }
    this.#mode = "drop";
    const dataAt = prefix.search(/(?:^|\n)data:/u);
    this.#droppedHeader = this.#stream && dataAt > 0 ? prefix.slice(0, dataAt + 1) : "";
    const body = this.#stream && dataAt >= 0 ? prefix.slice(prefix.indexOf("data:", dataAt)) : prefix;
    this.#droppedId = ID_AT_START.exec(body)?.[1] ?? null;
    this.#droppedTail = prefix.slice(-TAIL_KEEP);
    return "";
  }

  /** Where the event that is passed or dropped ends in `text`, after its blank line, or -1. */
  #eventEnd(text: string): number {
    if (!this.#stream) return -1;
    const joined = this.#carry + text;
    const match = EVENT_END.exec(joined);
    this.#carry = joined.slice(-3);
    return match ? match.index + match[0].length - (joined.length - text.length) : -1;
  }

  /** Ends the message that was passed or dropped. A dropped message is answered with the note alone. */
  #closeMessage(): string {
    const dropped = this.#mode === "drop";
    this.#mode = "read";
    this.#carry = "";
    if (!dropped) return "";
    const id = this.#droppedId ?? ID_AT_END.exec(this.#droppedTail.trimEnd())?.[1] ?? null;
    this.#droppedId = null;
    this.#droppedTail = "";
    if (id === null) return "";
    const answer = JSON.stringify({
      jsonrpc: "2.0",
      id: JSON.parse(id),
      result: { content: [{ type: "text", text: this.#options.uncoveredNotice }], isError: true },
    });
    const header = this.#droppedHeader;
    this.#droppedHeader = "";
    return this.#stream ? `${header}data: ${answer}\n\n` : answer;
  }

  async end(): Promise<string> {
    const rest = this.#take() + this.#decoder.decode();
    if (this.#mode === "pass") return rest;
    if (this.#mode === "drop") {
      this.#droppedTail = (this.#droppedTail + rest).slice(-TAIL_KEEP);
      return this.#closeMessage();
    }
    if (this.#stream || !rest) return rest;
    return (await guardedJson(rest, this.#check)) ?? rest;
  }

  #take(): string {
    const text = this.#pending;
    this.#pending = "";
    return text;
  }
}
