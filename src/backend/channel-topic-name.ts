/*
 * The name a fresh tab takes from its first message, written by the channel model: two or three
 * words that say what was asked, in the language of the request. The first line of the message is
 * still written at once as a placeholder, so the tab is never unnamed while the model runs.
 */

/** The characters of the request the model reads: a first message can carry a whole log. */
const PROMPT_CHARACTERS = 1_500;
/** The most words a generated name keeps. A model that answers with a phrase is cut, not refused. */
const NAME_WORDS = 3;
/** The most characters a generated name keeps, for a language that writes long words. */
const NAME_CHARACTERS = 48;

/**
 * Asks for a tab name. The channel name says where the tab sits, and the request is the only thing
 * the name is about.
 */
export function topicNamePrompt(channelName: string, text: string): string {
  return [
    "Name this channel tab in 2 or 3 words, in the language of the request, as a short title that says what was asked.",
    "No quotes, no final period, no emoji, no numbering. Answer with the name only.",
    "",
    `Channel: ${channelName}`,
    "Request:",
    text.slice(0, PROMPT_CHARACTERS),
  ].join("\n");
}

/**
 * The name a model answer holds: its first line, without fences, quotes, a `Tab:` label, list
 * marks or a final period, at most three words. Null when the answer holds nothing usable.
 */
export function cleanTopicName(answer: string): string | null {
  const line =
    answer
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0 && !/^```/u.test(candidate)) ?? "";
  const stripped = line
    .replace(/^\s*(?:tab|aba)\s*:\s*/iu, "")
    .replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/u, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`*_~]+$/gu, "")
    .replace(/[.;:,]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!stripped) return null;
  const words = stripped.split(" ").slice(0, NAME_WORDS).join(" ");
  // Code points, so a cut never splits a surrogate pair.
  const characters = Array.from(words);
  const name = (characters.length > NAME_CHARACTERS ? characters.slice(0, NAME_CHARACTERS).join("") : words).trim();
  return name || null;
}
