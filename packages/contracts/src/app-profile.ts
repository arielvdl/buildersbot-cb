/**
 * The app profile of an organization: which Marketplace apps the Apps tab lists first for the
 * people of one kind of company. The Cultura Builder Hub owns the value. The planned source is an
 * optional `appProfile` field in the answer of `GET {gateway}/session`, the same answer that gives
 * `empresa` (see docs/architecture/marketplace-apps-curation.md).
 *
 * Version 1 on the wire:
 *
 * ```json
 * {
 *   "version": 1,
 *   "tag": "Agência de design",
 *   "apps": { "show": ["figma", "canva", "slack"], "hide": ["stripe"] },
 *   "categories": ["design"],
 *   "updatedAt": "2026-10-31T12:00:00.000Z"
 * }
 * ```
 *
 * The value comes from the network, so it is data and never an instruction. It changes only which
 * apps the list shows before "Show all apps". It never installs, removes or disables an app, and
 * the client always lists an app that the user installed or connected.
 *
 * The decoder is strict: a field with the wrong type, a value over a limit, an id that is not a
 * slug, or text with markup or control characters refuses the whole profile, and the client then
 * uses its default list. A well-formed id that the catalog does not have is kept: a newer catalog can
 * have it, and the client ignores it until then. A category that this version does not know is
 * dropped for the same reason. Fields that version 1 does not name are ignored, so the Hub can add
 * an optional field without a new version. A change of meaning needs a new version.
 *
 * `version`, `apps.hide` and `categories` are optional. Many JSON writers send `null` for a field
 * with no value, so `null` reads as an absent field. A profile without `version` is version 1.
 */

import { SKILL_CATEGORIES, type SkillCategory } from "./ipc-skills";
import { isPluginSlug } from "./plugin-links";
import { isDynamicRecord } from "./runtime-values";
import { hasUnsafeAccountNameCharacters, normalizeAccountName } from "./validation";

export const APP_PROFILE_VERSION = 1;

export const APP_PROFILE_LIMITS = {
  /**
   * One profile as JSON, in UTF-16 code units: the text that `decodeAppProfileText` reads, and the
   * profile that the decoder gives, which the client keeps. The Hub keeps its whole `/session`
   * answer under 8 KB.
   */
  text: 8 * 1024,
  /** The visible characters of the tag. */
  tag: 48,
  /** The tag before it is measured, in UTF-16 code units, so a long text costs no work. */
  tagText: 256,
  /** The ids in `apps.show`, and again in `apps.hide`. */
  apps: 128,
  /** The entries of `categories`, known or not. */
  categories: 16,
  /** One category entry, in UTF-16 code units. */
  category: 32,
  /** The `updatedAt` text, in UTF-16 code units. */
  updatedAt: 40,
} as const;

/** What the client keeps of a profile after the decoder accepts it. */
export interface AppProfile {
  readonly version: typeof APP_PROFILE_VERSION;
  /** The name of the organization kind, as plain text. The Apps tab can show it as a subtitle. */
  readonly tag: string;
  readonly apps: {
    /** The apps that the list shows. Ids are catalog slugs or connector ids, without duplicates. */
    readonly show: readonly string[];
    /** The apps that the list does not show. `hide` wins over `show` and `categories`. */
    readonly hide: readonly string[];
  };
  /** Every app of these categories is also shown. Empty when the Hub sends none. */
  readonly categories: readonly SkillCategory[];
  /** When the Hub changed the profile, as ISO 8601 text. For diagnostics only. */
  readonly updatedAt: string;
}

/** `<` and `>` start markup. A tag never needs them. */
const MARKUP_PATTERN = /[<>]/u;
/** An ISO 8601 date and time, such as `2026-10-31T12:00:00.000Z` or `2026-10-31T12:00:00+01:00`. */
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

function countGraphemes(value: string): number {
  if (!Intl.Segmenter) return [...value].length;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
}

function decodeTag(value: unknown): string | null {
  if (typeof value !== "string" || value.length > APP_PROFILE_LIMITS.tagText) return null;
  if (hasUnsafeAccountNameCharacters(value) || MARKUP_PATTERN.test(value)) return null;
  const tag = normalizeAccountName(value);
  const length = countGraphemes(tag);
  return length > 0 && length <= APP_PROFILE_LIMITS.tag ? tag : null;
}

/** The ids of a list, without duplicates. Null when the list is too long or holds something other than a slug. */
function decodeIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > APP_PROFILE_LIMITS.apps) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isPluginSlug(entry)) return null;
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
}

/** The known categories, without duplicates. Null when the list is too long or holds something other than short text. */
function decodeCategories(value: unknown): SkillCategory[] | null {
  if (!Array.isArray(value) || value.length > APP_PROFILE_LIMITS.categories) return null;
  const categories: SkillCategory[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > APP_PROFILE_LIMITS.category) return null;
    const category = SKILL_CATEGORIES.find((known) => known === entry);
    if (category && !categories.includes(category)) categories.push(category);
  }
  return categories;
}

function decodeUpdatedAt(value: unknown): string | null {
  if (typeof value !== "string" || value.length > APP_PROFILE_LIMITS.updatedAt) return null;
  return ISO_DATE_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** An optional field with no value: absent, or `null`. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * The profile in a decoded JSON value, or null when the value is not a valid version 1 profile.
 * A profile that shows no app and no category is refused too: it would empty the list. So is a
 * profile that is longer than `APP_PROFILE_LIMITS.text` as JSON after decoding, so that the client
 * can keep each profile that it accepts.
 */
export function decodeAppProfile(value: unknown): AppProfile | null {
  if (!isDynamicRecord(value)) return null;
  if (!isAbsent(value.version) && value.version !== APP_PROFILE_VERSION) return null;
  const tag = decodeTag(value.tag);
  const updatedAt = decodeUpdatedAt(value.updatedAt);
  if (tag === null || updatedAt === null || !isDynamicRecord(value.apps)) return null;
  const show = decodeIds(value.apps.show);
  const hide = isAbsent(value.apps.hide) ? [] : decodeIds(value.apps.hide);
  const categories = isAbsent(value.categories) ? [] : decodeCategories(value.categories);
  if (show === null || hide === null || categories === null) return null;
  if (show.length === 0 && categories.length === 0) return null;
  const profile: AppProfile = { version: APP_PROFILE_VERSION, tag, apps: { show, hide }, categories, updatedAt };
  // The limits above keep this text under about 17,000 code units, so measuring it costs little.
  return JSON.stringify(profile).length <= APP_PROFILE_LIMITS.text ? profile : null;
}

/** The profile in a JSON text, or null when the text is too long, is not JSON, or is not a valid profile. */
export function decodeAppProfileText(text: string): AppProfile | null {
  if (text.length > APP_PROFILE_LIMITS.text) return null;
  try {
    return decodeAppProfile(JSON.parse(text));
  } catch {
    return null;
  }
}
