import { expandAttachmentReferences } from "@openbot/contracts/attachment-references";
import { expandChatTagReferences } from "@openbot/contracts/chat-tag-references";
import { markdownPlainText, markdownPreviewText } from "@openbot/contracts/markdown-preview-text";

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
