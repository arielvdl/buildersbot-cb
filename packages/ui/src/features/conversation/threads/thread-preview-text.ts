import { expandAttachmentReferences } from "@openbot/contracts/attachment-references";
import { expandChatTagReferences } from "@openbot/contracts/chat-tag-references";
import { markdownPlainText, markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import type { ThreadItem } from "./thread-types";

/**
 * A stored message as words: a mention, a skill, a quote and a file show by their names. The stored
 * text keeps the markers as written, so a rename of an agent or a file later does not change it.
 */
function readableText(text: string): string {
  return expandAttachmentReferences(expandChatTagReferences(text));
}

/**
 * A stored message as one line of plain text, for a hover preview: the Markdown marks go and the
 * blocks join with spaces, so the preview shows as much of the text as its lines can hold.
 */
export function chatPreviewLine(text: string): string {
  return text.trim() ? markdownPreviewText(readableText(text)) : "";
}

/**
 * A stored message as plain text that keeps its paragraphs and list items on their own lines, for
 * the details of a thread, where the person reads and copies it.
 */
export function chatPreviewBlock(text: string): string {
  return text.trim() ? markdownPlainText(readableText(text)) : "";
}

/**
 * The two texts say the same, apart from spaces and line breaks. A thread that the person started
 * has the same first and last message until the person writes again, and a preview shows it once.
 */
export function sameMessageText(first: string, last: string): boolean {
  const words = (text: string) => text.replace(/\s+/gu, " ").trim();
  return words(first) !== "" && words(first) === words(last);
}

/**
 * A side thread with a message to show. A host older than the preview sends none, and a new thread
 * has none yet: its tab then has no preview and no details.
 */
export function threadHasDetails(thread: ThreadItem | undefined): thread is ThreadItem {
  return thread?.kind === "side" && (thread.firstMessage.trim() !== "" || thread.preview.trim() !== "");
}
