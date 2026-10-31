// What the Guard sends to its reviewer model: the least that lets the model judge. Only a short
// part of one suspicious item goes out, never the conversation, and every secret in it is masked
// before it leaves this computer.

import { GUARD_JUDGE_EXCERPT_LIMIT } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";

/** A line of an environment file whose name says that its value is a secret. */
const SECRET_ENV_LINE =
  /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]{0,80}(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PASSWD|PWD|DSN|DATABASE_URL|PRIVATE|CREDENTIALS?|AUTH)[A-Za-z0-9_]{0,40}\s*[=:]\s*)\S.*$/gimu;
/** A user name and a password inside a URL. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/giu;
/**
 * A long run of key-like characters with letters and digits, such as an unknown token or a key. A
 * `/` ends the run, so the path of a URL stays readable.
 */
const KEY_LIKE_RUN =
  /(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]{0,200}\d)(?=[A-Za-z0-9+_-]{0,200}[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/gu;
/** Unicode tag characters carry ASCII that no reader sees. The reviewer gets it written out. */
const TAG_RUN = /[\u{E0020}-\u{E007E}]+/gu;
const INVISIBLE = /[​-‍⁠-⁤­᠎﻿\u{E0000}-\u{E007F}]/gu;
/** Where an injection usually starts, to center the excerpt on it. */
const ANCHOR =
  /ignor|disregard|forget|instruc|system prompt|you are now|from now on|note to|if you are an|reviewer|verdict|\[INST\]|<\|im_start|curl|wget|base64|\/dev\/tcp|send|upload|envie|mande|revel|\.env\b|id_rsa|password|token|secret/iu;

/**
 * Masks the secrets in a text: the rules that keep secrets out of the logs (known key shapes,
 * tokens, private keys, credential assignments, emails and every secret this app saved), secret
 * lines of an environment file, credentials in a URL, and any long key-like run.
 */
export function maskSecrets(text: string): string {
  return redactText(text)
    .replace(SECRET_ENV_LINE, "$1[redacted]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(KEY_LIKE_RUN, "[redacted]");
}

/** Writes out the ASCII that tag characters hide, and removes the other invisible characters. */
export function revealHiddenText(text: string): string {
  return text
    .replace(
      TAG_RUN,
      (run) =>
        `[hidden text: ${[...run].map((char) => String.fromCharCode((char.codePointAt(0) ?? 0xe0020) - 0xe0000)).join("")}]`,
    )
    .replace(INVISIBLE, "");
}

/** Cuts a text at whole words, so no half of a masked or unmasked value stays at an edge. */
function wholeWords(text: string, cutStart: boolean, cutEnd: boolean): string {
  let result = text;
  if (cutStart) {
    const space = result.search(/\s/u);
    result = space >= 0 ? result.slice(space + 1) : "";
  }
  if (cutEnd) {
    const space = Math.max(result.lastIndexOf(" "), result.lastIndexOf("\n"), result.lastIndexOf("\t"));
    result = space >= 0 ? result.slice(0, space) : "";
  }
  return result;
}

/**
 * The part of one item that the reviewer reads: at most `limit` characters, centered near the first
 * place that looks like an instruction or a transfer, with hidden text written out and every secret
 * masked. The text is masked in a wider window first and cut after, so a secret at the edge of the
 * excerpt is masked whole before the cut.
 */
export function judgeExcerpt(text: string, limit: number = GUARD_JUDGE_EXCERPT_LIMIT): string {
  const visible = revealHiddenText(text.normalize("NFKC"));
  if (visible.length <= limit) return maskSecrets(visible).slice(0, limit);
  const anchor = Math.max(0, visible.search(ANCHOR));
  const wideStart = Math.max(0, anchor - limit * 2);
  const wideEnd = Math.min(visible.length, anchor + limit * 3);
  const masked = maskSecrets(visible.slice(wideStart, wideEnd));
  const offset = Math.min(anchor - wideStart, masked.length);
  const start = Math.max(0, offset - Math.floor(limit / 4));
  const end = Math.min(masked.length, start + limit);
  const cut = wholeWords(
    masked.slice(start, end),
    start > 0 || wideStart > 0,
    end < masked.length || wideEnd < visible.length,
  );
  return cut.slice(0, limit);
}

/** A short, safe name of the item for the reviewer, such as `openbot_browser.snapshot on example.com`. */
export function judgeSubject(value: string): string {
  return maskSecrets(value.replace(INVISIBLE, ""))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 200);
}
