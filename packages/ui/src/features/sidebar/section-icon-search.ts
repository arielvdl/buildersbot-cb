/**
 * The search of the section icon picker: the categories, the text that a query matches, and the skin
 * tone of an emoji. Nothing here renders and nothing loads, so each rule has a test. The lists
 * themselves load with `import()` (`section-icon-assets.ts`).
 *
 * A query matches an item when each word of the query starts a word of the item. The words are the
 * English and the Portuguese names and keywords, in lowercase without accents, so "seguranca",
 * "segurança" and "security" find the shield in each language.
 */

import type { SidebarSectionGlyph } from "@openbot/contracts/ipc";

export const SECTION_ICON_CATEGORIES = [
  "general",
  "code",
  "communication",
  "data",
  "people",
  "objects",
  "nature",
  "food",
  "media",
  "business",
  "travel",
] as const;

export type SectionIconCategory = (typeof SECTION_ICON_CATEGORIES)[number];

/** The emoji categories, in the order of the numbers in `section-emoji-data.ts`. */
export const SECTION_EMOJI_CATEGORIES = [
  "faces",
  "people",
  "animals",
  "food",
  "travel",
  "activities",
  "objects",
  "symbols",
  "flags",
] as const;

export type SectionEmojiCategory = (typeof SECTION_EMOJI_CATEGORIES)[number];

/** 0 is the default yellow; 1 to 5 are the Fitzpatrick types, light to dark. */
export type SectionEmojiTone = 0 | 1 | 2 | 3 | 4 | 5;

export const SECTION_EMOJI_TONES = [0, 1, 2, 3, 4, 5] as const satisfies readonly SectionEmojiTone[];

export interface SectionIconEntry {
  glyph: SidebarSectionGlyph;
  category: SectionIconCategory;
  en: string;
  pt: string;
  /** The folded names. A match here comes before a match in the keywords only. */
  names: string;
  /** The folded names and keywords, with a space before each word. */
  words: string;
}

export interface SectionEmojiEntry {
  emoji: string;
  category: SectionEmojiCategory;
  /** True when the emoji takes the five skin tones. */
  skin: boolean;
  en: string;
  pt: string;
  names: string;
  words: string;
}

/** Lowercase, without accents, and with one space for each run of other characters than letters and digits. */
export function foldSectionSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function searchWords(text: string): string {
  return ` ${foldSectionSearchText(text)}`;
}

/** The icon library as entries of the search. The glyph name is a keyword too ("chart-pie"). */
export function sectionIconEntries(
  data: readonly (readonly [SidebarSectionGlyph, SectionIconCategory, string, string, string])[],
): SectionIconEntry[] {
  return data.map(([glyph, category, en, pt, keywords]) => {
    const names = searchWords(`${en} ${pt}`);
    return { glyph, category, en, pt, names, words: `${names}${searchWords(`${glyph} ${keywords}`)}` };
  });
}

/** The lines of `section-emoji-data.ts` as entries. A line that is not complete is left out. */
export function parseSectionEmojiData(data: string): SectionEmojiEntry[] {
  const entries: SectionEmojiEntry[] = [];
  for (const line of data.split("\n")) {
    const [emoji, category, skin, en, pt, keywords = ""] = line.split("\t");
    const categoryName = SECTION_EMOJI_CATEGORIES[Number(category)];
    if (!emoji || !categoryName || en === undefined || pt === undefined) continue;
    const names = searchWords(`${en} ${pt}`);
    entries.push({
      emoji,
      category: categoryName,
      skin: skin === "1",
      en,
      pt,
      names,
      words: `${names}${searchWords(keywords)}`,
    });
  }
  return entries;
}

/**
 * The items that match `query`, the items whose names match first. An empty query gives the items of
 * `category`, or every item when `category` is null. A query searches every category.
 */
export function searchSectionPicker<T extends { category: string; names: string; words: string }>(
  items: readonly T[],
  query: string,
  category: string | null,
): T[] {
  const terms = foldSectionSearchText(query).split(" ").filter(Boolean);
  if (terms.length === 0) return category === null ? [...items] : items.filter((item) => item.category === category);
  const byName: T[] = [];
  const byKeyword: T[] = [];
  for (const item of items) {
    if (!terms.every((term) => item.words.includes(` ${term}`))) continue;
    if (terms.every((term) => item.names.includes(` ${term}`))) byName.push(item);
    else byKeyword.push(item);
  }
  return [...byName, ...byKeyword];
}

const SKIN_TONE_MODIFIERS = ["\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"] as const;
const MODIFIER_BASE = /^\p{Emoji_Modifier_Base}$/u;

/**
 * The emoji with a skin tone: the modifier goes after each person or hand of the sequence, in the place
 * of its variation selector. Tone 0 keeps the emoji. Only an emoji whose `skin` is true takes it: the
 * data keeps that flag only where this rule gives the five Unicode sequences.
 */
export function sectionEmojiWithTone(emoji: string, tone: SectionEmojiTone): string {
  const modifier = tone === 0 ? undefined : SKIN_TONE_MODIFIERS[tone - 1];
  if (!modifier) return emoji;
  const points = [...emoji];
  let result = "";
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] ?? "";
    result += point;
    if (!MODIFIER_BASE.test(point)) continue;
    result += modifier;
    if (points[index + 1] === "️") index += 1;
  }
  return result;
}

/** Each emoji, and each of its skin tones, with its entry: a recent emoji keeps its tone and its name. */
export function sectionEmojiIndex(entries: readonly SectionEmojiEntry[]): Map<string, SectionEmojiEntry> {
  const index = new Map<string, SectionEmojiEntry>();
  for (const entry of entries) {
    index.set(entry.emoji, entry);
    if (!entry.skin) continue;
    for (const tone of SECTION_EMOJI_TONES) index.set(sectionEmojiWithTone(entry.emoji, tone), entry);
  }
  return index;
}
