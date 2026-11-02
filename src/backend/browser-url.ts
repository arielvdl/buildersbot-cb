import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { sourceText } from "@openbot/i18n/source";

/**
 * The address that an agent asked for, with https when it names no scheme. Only http and https pass.
 * It has no Electron dependency, so the host of the person's Chrome uses it too.
 */
export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error(sourceText("error.backend.browserUrlRequired"));
  if (value.length > INPUT_LIMITS.browserUrl) throw new Error(sourceText("error.backend.browserUrlTooLong"));
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(sourceText("error.backend.browserUrlProtocol"));
  }
  return url.toString();
}
