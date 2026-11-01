import { createHash } from "node:crypto";
import { chatTagReferences, leadingAddress } from "@openbot/contracts/chat-tag-references";
import type { ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";

/**
 * Inline and spill for the channel context: the optimization `channel-context-spill`. A packet
 * carries the messages that the assignment needs in full and a short part of the others, with the
 * size of each message and the offset where `channel_history` continues it. The whole text stays in
 * the channel. With the optimization off, nothing here runs.
 */

/** The id of the optimization in Settings > Advanced optimizations. */
export const CHANNEL_CONTEXT_SPILL = "channel-context-spill";
/** The most characters of a message that a packet carries in full: the request, a reply, a mention. */
export const KEPT_CHARACTERS = 4_000;
/** The characters of any other message in a packet. */
export const EXCERPT_CHARACTERS = 1_200;
/** The characters of a large result in a packet, and of a row of the compact `channel_history`. */
export const PREVIEW_CHARACTERS = 200;
/** The characters that one `channel_history` read of a message gives. */
export const READ_PAGE_CHARACTERS = 12_000;
/** The most rows of one page of the compact `channel_history`, and its default. */
export const HISTORY_PAGE_LIMIT = 20;
/** The last messages of a packet that it carries in full. */
const LAST_KEPT = 2;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

export interface SpillPart {
  text: string;
  /** Where the next read starts, or null when `text` is the whole message. */
  nextOffset: number | null;
}

/** A slice end that does not split a surrogate pair. */
function safeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** The fenced code blocks of a Markdown text, as [start of the opening line, end of the closing line). */
function fences(text: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let open: { start: number; marker: string } | null = null;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const marker = FENCE.exec(text.slice(start, end))?.[1];
    if (marker) {
      if (!open) open = { start, marker };
      else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
        blocks.push([open.start, end]);
        open = null;
      }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  if (open) blocks.push([open.start, text.length]);
  return blocks;
}

/**
 * The first part of a text, at most `limit` characters. It ends at a paragraph, a line or a word
 * when one is near the limit. It does not end inside a code block: the cut moves to the line before
 * the block when that keeps at least a quarter of the limit, and otherwise the block is closed after
 * its last whole line.
 */
export function cutText(text: string, limit: number): SpillPart {
  if (text.length <= limit) return { text, nextOffset: null };
  const floor = Math.floor(limit * 0.6);
  let end = safeEnd(text, limit);
  const paragraph = text.lastIndexOf("\n\n", end);
  const line = text.lastIndexOf("\n", end);
  const space = text.lastIndexOf(" ", end);
  if (paragraph >= floor) end = paragraph;
  else if (line >= floor) end = line;
  else if (space >= floor) end = space;
  const block = fences(text).find(([open, close]) => open < end && end < close);
  if (!block) return { text: text.slice(0, end), nextOffset: end };
  if (block[0] >= Math.floor(limit / 4)) return { text: text.slice(0, block[0]), nextOffset: block[0] };
  const close = `\n${FENCE.exec(text.slice(block[0]))?.[1] ?? "```"}`;
  let inner = safeEnd(text, Math.max(block[0] + 1, limit - close.length));
  const lastLine = text.lastIndexOf("\n", inner);
  if (lastLine > block[0]) inner = lastLine;
  return { text: `${text.slice(0, inner)}${close}`, nextOffset: inner };
}

/** One page of a message for `channel_history` with a messageId, from `offset`. */
export function readPage(text: string, offset: number): SpillPart & { offset: number } {
  const end = safeEnd(text, offset + READ_PAGE_CHARACTERS);
  return { offset, text: text.slice(offset, end), nextOffset: end < text.length ? end : null };
}

/** A short one-line preview of a message for the compact `channel_history`. */
export function preview(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= PREVIEW_CHARACTERS ? flat : `${flat.slice(0, safeEnd(flat, PREVIEW_CHARACTERS))}…`;
}

/** One row of the compact `channel_history`: no task, no channel, no whole text. */
export function historyLine(message: ChannelMessage) {
  return {
    id: message.id,
    sequence: message.sequence,
    author: message.author.name,
    authorKind: message.author.kind,
    ...(message.message.replyToMessageId ? { replyToMessageId: message.message.replyToMessageId } : {}),
    ...(message.message.attachments?.length ? { attachments: message.message.attachments.length } : {}),
    chars: message.message.text.length,
    preview: preview(message.message.text),
  };
}

/** A short hash of one part of a packet, so a delta can leave out a part that has not changed. */
export function partHash(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 22);
}

/** Whether the text names this agent: a mention tag, `@everyone`, or its name typed after "@" first. */
function mentions(text: string, agent: { id: string; name: string }): boolean {
  if (!text.includes("@")) return false;
  if (chatTagReferences(text).some((reference) => reference.kind === "agent" && reference.id === agent.id)) return true;
  if (leadingAddress(text).everyone) return true;
  const name = agent.name.trim();
  const typed = text.trimStart();
  return (
    name.length > 0 &&
    typed.startsWith("@") &&
    typed.slice(1, 1 + name.length).toLowerCase() === name.toLowerCase() &&
    !/^[\p{L}\p{N}_'’-]/u.test(typed.slice(1 + name.length))
  );
}

/**
 * The messages of a packet that it carries in full: the sources of the task (its request, the
 * messages it names and the replies they answer), a message that one of them quotes or that the
 * instruction names by id, a message that mentions this agent, the result of a task that this one
 * depends on or started, and the last messages.
 */
export function keptMessageIds(
  messages: readonly ChannelMessage[],
  task: ChannelTask,
  agent: { id: string; name: string },
  sources: ReadonlySet<string>,
  tasks: readonly ChannelTask[],
): Set<string> {
  const kept = new Set(sources);
  for (const message of messages.slice(-LAST_KEPT)) kept.add(message.id);
  const related = new Set([
    ...task.dependencies,
    ...tasks.filter((item) => item.parentTaskId === task.id).map((item) => item.id),
  ]);
  const quoted = new Set<string>();
  for (const message of messages)
    if (sources.has(message.id))
      for (const reference of chatTagReferences(message.message.text))
        if (reference.kind === "quote") quoted.add(reference.id);
  for (const message of messages) {
    if (
      quoted.has(message.id) ||
      task.instruction.includes(message.id) ||
      (message.author.id !== agent.id && mentions(message.message.text, agent)) ||
      (message.id.startsWith("channel-result-") && message.taskId !== null && related.has(message.taskId))
    )
      kept.add(message.id);
  }
  return kept;
}

/** A plain answer row: no plan, card, visual reply or question. */
function plainAnswer(message: ChannelMessage): boolean {
  const type = message.message.itemType;
  return !type || type === "agentMessage" || type === "final_answer" || type === "commentary";
}

/**
 * The text a packet gives for one message. A kept message is cut at `KEPT_CHARACTERS`. A large
 * result or other non-answer row that is not kept gives only a preview; any other message gives an
 * excerpt. A cut message names its size and where `channel_history` continues it.
 */
export function spillText(message: ChannelMessage, kept: boolean): SpillPart & { chars: number } {
  const text = message.message.text;
  const large = text.length > KEPT_CHARACTERS && (message.id.startsWith("channel-result-") || !plainAnswer(message));
  const limit = kept ? KEPT_CHARACTERS : large ? PREVIEW_CHARACTERS : EXCERPT_CHARACTERS;
  return { ...cutText(text, limit), chars: text.length };
}
