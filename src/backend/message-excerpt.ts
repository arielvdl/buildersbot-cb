/**
 * The most characters that a kept first or last message has: the first message and the preview of a
 * side thread (also as migration 49 fills them), and the first and last message of an agent's own chat.
 */
export const MESSAGE_EXCERPT_LIMIT = 2000;

/**
 * The text trimmed. A text that is longer than `MESSAGE_EXCERPT_LIMIT` characters is cut, and ends
 * with "…", so the details of a thread show that the text continues. The cut counts characters, not
 * UTF-16 units, so it never splits one character in two. Migration 49 cuts in the same way.
 */
export function messageExcerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_EXCERPT_LIMIT) return trimmed;
  const characters = Array.from(trimmed);
  if (characters.length <= MESSAGE_EXCERPT_LIMIT) return trimmed;
  return `${characters
    .slice(0, MESSAGE_EXCERPT_LIMIT - 1)
    .join("")
    .replace(/[\t\n\r ]+$/u, "")}…`;
}
