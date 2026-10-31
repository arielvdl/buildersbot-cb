// What the Guard sends to its reviewer model: the least that lets the model judge. Only short parts
// of one suspicious item go out, never the conversation, and every secret in them is masked before
// they leave this computer. The parts are the places that the local check marked, so text that an
// attacker puts in front of an injection cannot push the injection out of the reviewer's view.

import { GUARD_JUDGE_EXCERPT_LIMIT } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { type GuardHit, type GuardTriage, guardFindingBarsClearance, guardFindingNeedsReview } from "./guard-triage";

/** A line of an environment file whose name says that its value is a secret. */
const SECRET_ENV_LINE =
  /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]{0,80}(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PASSWD|PWD|DSN|DATABASE_URL|PRIVATE|CREDENTIALS?|AUTH)[A-Za-z0-9_]{0,40}\s*[=:]\s*)\S.*$/gimu;
/**
 * A user name and a password inside a URL, up to the last `@` before the host. It runs before the
 * email rule of the log mask: that rule would take `P4ssw0rd@api.example.com` for an email and leave
 * the start of the password.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/?#]{1,512}@(?=[^\s/?#@]{1,253}(?:[/?#\s:]|$))/giu;
/** The value of a command line flag that carries a secret, such as `--password hunter2` or `--token=…`. */
const SECRET_FLAG =
  /((?:^|[\s"'])--?(?:password|passwd|pass|pwd|token|secret|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key|bearer)(?:=|\s{1,4})["']?)(?!\$|\[redacted)[^\s"']{1,512}/giu;
/** `curl -u user:password`, and the attached password of `mysql -pSECRET`. */
const USER_PASSWORD_FLAG = /((?:^|\s)(?:-u|--user|--proxy-user|-U)\s{1,4}["']?[^\s"':]{1,128}:)(?!\$)[^\s"']{1,256}/gu;
const MYSQL_PASSWORD = /(\b(?:mysql|mysqldump|mariadb|mysqladmin)\b[^\n]{0,200}?\s-p)(?!\s)[^\s"']{1,256}/gu;
/** A key in a connection string: Azure storage and service bus, and `Password=` of a database. */
const CONNECTION_KEY =
  /\b((?:AccountKey|SharedAccessKey|SharedAccessSignature|AccessKey|Password|Pwd)\s{0,4}=\s{0,4})[^;"'\s]{1,1024}/giu;
/** The secret part of a chat webhook or a bot address: whoever has it can post as the bot. */
const CHAT_WEBHOOK =
  /(https:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)\/|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{1,30}\/|[\w-]{1,63}\.webhook\.office\.com\/webhookb2\/|api\.telegram\.org\/(?:file\/)?bot))[^\s"'<>)]{1,512}/giu;
/** A Telegram bot token, and a Discord bot token. */
const BOT_TOKEN = /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}|\b[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6,7}\.[\w-]{27,40}\b/gu;
/** Key shapes that the log mask does not know: Google OAuth client secrets and Stripe test keys. */
const OTHER_KEY_PREFIX = /\b(?:GOCSPX-|rk_test_|sk_test_|pk_live_)[A-Za-z0-9_-]{8,}/gu;
/** The value of a session cookie written as JSON, as a browser tool lists cookies. */
const COOKIE_JSON =
  /("name"\s{0,4}:\s{0,4}"[^"]{0,40}(?:sess|sid|auth|token|login|jwt)[^"]{0,40}"\s{0,4},\s{0,4}"value"\s{0,4}:\s{0,4}")[^"]{1,4096}"/giu;
/** A private key of PGP, with its body. */
const PGP_PRIVATE_KEY =
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]{0,65536}?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/gu;
/** A long base64 run with a `+` and a digit, such as an Azure key: a `/` in it does not end it. */
const BASE64_RUN = /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]{0,300}\+)(?=[A-Za-z0-9+/]{0,300}\d)[A-Za-z0-9+/]{40,}={0,2}/gu;
/**
 * A long run of key-like characters with letters and digits, such as an unknown token or a key. A
 * `/` ends the run, so the path of a URL stays readable.
 */
const KEY_LIKE_RUN =
  /(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]{0,200}\d)(?=[A-Za-z0-9+_-]{0,200}[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/gu;
/** Every character that a reader does not see: default-ignorable code points and format characters. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
/** The characters of a credential. A cut inside such a run could leave half a secret at an edge. */
const TOKEN_CHARACTER = /[A-Za-z0-9._~+/=-]/u;
const WHITESPACE = /\s/u;
/** Between two parts of the excerpt. */
const SEPARATOR = "\n[…]\n";
/** How far a part grows to start or end at a whole line, and else at a whole word. */
const LINE_REACH = 200;
const WORD_REACH = 64;
/** The context around each marked place, from the most to none, until the parts fit. */
const CONTEXTS = [300, 150, 60, 0] as const;

/**
 * Masks the secrets in a text: credentials in a URL first, then the secrets that the log mask does
 * not know (command line flags, connection string keys, chat webhooks, bot tokens, more key shapes,
 * session cookies as JSON and PGP keys), then the rules that keep secrets out of the logs (known key
 * shapes, tokens, private keys, credential assignments, emails and every secret this app saved),
 * secret lines of an environment file, and any long key-like run.
 */
export function maskSecrets(text: string): string {
  const early = text
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(PGP_PRIVATE_KEY, "[redacted]")
    .replace(CHAT_WEBHOOK, "$1[redacted]")
    .replace(BOT_TOKEN, "[redacted]")
    .replace(SECRET_FLAG, "$1[redacted]")
    .replace(USER_PASSWORD_FLAG, "$1[redacted]")
    .replace(MYSQL_PASSWORD, "$1[redacted]")
    .replace(CONNECTION_KEY, "$1[redacted]")
    .replace(OTHER_KEY_PREFIX, "[redacted]")
    .replace(COOKIE_JSON, '$1[redacted]"');
  return redactText(early)
    .replace(SECRET_ENV_LINE, "$1[redacted]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(BASE64_RUN, "[redacted]")
    .replace(KEY_LIKE_RUN, "[redacted]");
}

/** What the reviewer reads, and whether it shows every place that the reviewer must see to clear the item. */
export interface GuardExcerpt {
  readonly text: string;
  /**
   * False when a place that the local check marked is not in `text`: the item was read only in
   * part, a finding has no place or more places than were recorded, or the places did not fit the
   * limit, or the item holds a fake verdict. The reviewer can then ask about the item, but it cannot
   * clear it.
   */
  readonly covered: boolean;
}

type Range = readonly [start: number, end: number];

function isToken(text: string, index: number): boolean {
  return index >= 0 && index < text.length && TOKEN_CHARACTER.test(text.charAt(index));
}

/**
 * A range that starts and ends at a whole line when the line is near, else at a whole word. A
 * partial token that is left at an edge, outside the marked place, is taken out: it could be half
 * of a secret that the mask cannot recognise alone.
 */
function wholeRange(text: string, [start, end]: Range, [placeStart, placeEnd]: Range): Range {
  let from = start;
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  if (from - lineStart <= LINE_REACH) from = lineStart;
  else {
    let back = from;
    while (back > 0 && from - back < WORD_REACH && !WHITESPACE.test(text.charAt(back - 1))) back -= 1;
    if (back === 0 || WHITESPACE.test(text.charAt(back - 1))) from = back;
  }
  while (from < placeStart && isToken(text, from - 1) && isToken(text, from)) from += 1;

  let to = end;
  const lineEnd = text.indexOf("\n", to);
  const lineStop = lineEnd < 0 ? text.length : lineEnd;
  if (lineStop - to <= LINE_REACH) to = lineStop;
  else {
    let forward = to;
    while (forward < text.length && forward - to < WORD_REACH && !WHITESPACE.test(text.charAt(forward))) forward += 1;
    if (forward === text.length || WHITESPACE.test(text.charAt(forward))) to = forward;
  }
  while (to > placeEnd && isToken(text, to) && isToken(text, to - 1)) to -= 1;
  return [from, Math.max(from, to)];
}

/** The ranges around these places, joined where they meet. */
function rangesAround(text: string, places: readonly GuardHit[], context: number): Range[] {
  const ranges = places
    .map((place): { range: Range; place: Range } => ({
      range: [Math.max(0, place.start - context), Math.min(text.length, place.end + context)],
      place: [place.start, place.end],
    }))
    .map(({ range, place }) => wholeRange(text, range, place))
    .sort((left, right) => left[0] - right[0]);
  const joined: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = joined.at(-1);
    if (last && start <= last[1] + SEPARATOR.length) last[1] = Math.max(last[1], end);
    else joined.push([start, end]);
  }
  return joined;
}

function joinParts(text: string, ranges: readonly Range[]): string {
  return ranges.map(([start, end]) => maskSecrets(text.slice(start, end))).join(SEPARATOR);
}

function contains(ranges: readonly Range[], place: GuardHit): boolean {
  return ranges.some(([start, end]) => start <= place.start && place.end <= end);
}

/**
 * The parts of one item that the reviewer reads: at most `limit` characters, cut around every place
 * that the local check marked, with hidden text written out and every secret masked. When the
 * places do not all fit, the parts with the heaviest findings come first and the excerpt is not
 * covered.
 */
export function judgeExcerpt(
  triage: Pick<GuardTriage, "text" | "hits" | "findings" | "incomplete" | "unplaced">,
  limit: number = GUARD_JUDGE_EXCERPT_LIMIT,
): GuardExcerpt {
  const { text } = triage;
  const required = triage.hits.filter((hit) => guardFindingNeedsReview(hit.code));
  // Every finding that the reviewer must see has a recorded place, and every place was recorded. An
  // item that holds a fake verdict is never covered: that text may be what fooled the reviewer.
  const placed =
    !triage.incomplete &&
    !triage.unplaced &&
    !triage.findings.some((finding) => guardFindingBarsClearance(finding.code)) &&
    triage.findings
      .filter((finding) => guardFindingNeedsReview(finding.code))
      .every((finding) => required.some((hit) => hit.code === finding.code));

  // A short item goes whole. Masking can only shorten a text by little, so a long one is not tried.
  if (text.length <= limit * 2) {
    const whole = maskSecrets(text);
    if (whole.length <= limit) return { text: whole, covered: placed };
  }
  if (required.length === 0) {
    const [start, end] = wholeRange(text, [0, Math.min(text.length, limit)], [0, 0]);
    return { text: joinParts(text, [[start, end]]).slice(0, limit), covered: false };
  }

  for (const context of CONTEXTS) {
    const ranges = rangesAround(text, required, context);
    const excerpt = joinParts(text, ranges);
    if (excerpt.length <= limit) {
      return { text: excerpt, covered: placed && required.every((place) => contains(ranges, place)) };
    }
  }

  // The places do not fit: take them one at a time, the earliest first, while they fit.
  const kept: GuardHit[] = [];
  let excerpt = "";
  for (const place of [...required].sort((left, right) => left.start - right.start)) {
    const joined = joinParts(text, rangesAround(text, [...kept, place], 0));
    if (joined.length > limit) continue;
    kept.push(place);
    excerpt = joined;
  }
  if (!excerpt) {
    const first = required[0];
    excerpt = first ? maskSecrets(text.slice(first.start, first.end)).slice(0, limit) : "";
  }
  return { text: excerpt, covered: false };
}

/** A short, safe name of the item for the reviewer, such as `openbot_browser.snapshot on example.com`. */
export function judgeSubject(value: string): string {
  return maskSecrets(value.replace(INVISIBLE, ""))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 200);
}
