// The Guard on MCP tool results that pass through a proxy of this app, such as the shared Playwright
// browser. A proxy streams each response to the agent; this reads the response as it streams, finds
// each tool result, checks its text, and puts the Guard's note in front of it when the check asks for
// one. Everything else in the stream passes at once and unchanged, so no other message waits.

import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/** Checks the text of one tool result. It answers the note to put in front, or null to leave it. */
export type GuardResultCheck = (text: string) => Promise<string | null>;

/** The most bytes that one message may have before the reader stops and passes the rest on as it is. */
const MESSAGE_LIMIT = 8 * 1024 * 1024;
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

/**
 * Reads one MCP response as it streams. `push` takes each part of the body and gives back the text
 * to send on now; `end` gives back the rest. An event stream passes event by event; a JSON body is
 * read whole first. A message longer than the limit passes as it is.
 */
export class McpResultGuard {
  readonly #check: GuardResultCheck;
  readonly #stream: boolean;
  readonly #decoder = new TextDecoder();
  #pending = "";
  #passThrough = false;

  constructor(contentType: string | null, check: GuardResultCheck) {
    this.#check = check;
    this.#stream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  }

  async push(chunk: Uint8Array | string): Promise<string> {
    const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    if (this.#passThrough) return text;
    this.#pending += text;
    if (!this.#stream) {
      if (this.#pending.length <= MESSAGE_LIMIT) return "";
      this.#passThrough = true;
      return this.#take();
    }
    let output = "";
    for (let match = EVENT_END.exec(this.#pending); match !== null; match = EVENT_END.exec(this.#pending)) {
      const event = this.#pending.slice(0, match.index);
      this.#pending = this.#pending.slice(match.index + match[0].length);
      output += await guardedEvent(event, match[0], this.#check);
    }
    if (this.#pending.length > MESSAGE_LIMIT) {
      this.#passThrough = true;
      output += this.#take();
    }
    return output;
  }

  async end(): Promise<string> {
    const rest = this.#take() + this.#decoder.decode();
    if (this.#passThrough || this.#stream || !rest) return rest;
    return (await guardedJson(rest, this.#check)) ?? rest;
  }

  #take(): string {
    const text = this.#pending;
    this.#pending = "";
    return text;
  }
}
