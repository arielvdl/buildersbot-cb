/**
 * Interface text from `@openbot/i18n` (`chromeExtension.*`), which the build writes to `_locales` with
 * the dots of each key turned into underscores, as Chrome's message names need.
 */

import type { messages } from "../../../../packages/i18n/src/messages/en/chromeExtension";

export type TextKey = keyof typeof messages;

export function t(key: TextKey, substitutions?: string[]): string {
  return chrome.i18n.getMessage(key.replaceAll(".", "_"), substitutions);
}
