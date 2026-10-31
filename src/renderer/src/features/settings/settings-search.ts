import type { AppTextKey } from "@openbot/i18n";

/** The text keys of one settings search entry: a tab, a row, or a section of the server settings. */
export interface SettingsSearchKeys {
  titleKey: AppTextKey;
  descriptionKey?: AppTextKey | undefined;
  /** More words that find the entry: other names, related words and words of the same family. */
  keywordsKey?: AppTextKey | undefined;
}

/** One field of an entry, folded once: the whole text and its words. */
interface FoldedField {
  text: string;
  words: readonly string[];
}

/** The folded text of an entry in each language that the search reads. */
interface FoldedEntry<Entry> {
  entry: Entry;
  titles: readonly FoldedField[];
  keywords: readonly FoldedField[];
  descriptions: readonly FoldedField[];
}

/** The index of a list of entries. Make it again when the language changes. */
export type SettingsSearchIndex<Entry> = ReadonlyArray<FoldedEntry<Entry>>;

/** A broad query shows a short list, not every entry. */
export const SETTINGS_SEARCH_LIMIT = 12;

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;
/** Scripts that do not put a space between words. A query in them can match inside a word. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * Lower case, with no accents and single spaces. "Notificações" and "notificacoes" give the same
 * text, so a query typed without accents finds the entry.
 */
export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function folded(value: string): FoldedField {
  const text = foldSearchText(value);
  return { text, words: text.split(WORD_SEPARATOR).filter(Boolean) };
}

/**
 * Folds the text of each entry, in each language of `translators`: the interface language first,
 * then English. A user who knows the English name of a setting finds it in each language.
 */
export function indexSettingsSearch<Entry extends SettingsSearchKeys>(
  entries: ReadonlyArray<Entry>,
  translators: ReadonlyArray<(key: AppTextKey) => string>,
): SettingsSearchIndex<Entry> {
  const texts = (key: AppTextKey | undefined): FoldedField[] => {
    if (!key) return [];
    const unique = new Set(translators.map((translate) => translate(key)));
    return [...unique].map(folded);
  };
  return entries.map((entry) => ({
    entry,
    titles: texts(entry.titleKey),
    keywords: texts(entry.keywordsKey),
    descriptions: texts(entry.descriptionKey),
  }));
}

/**
 * A query word matches a field when a word of the field starts with it, so "tema" finds "Tema" and
 * not "sistema". In a script with no spaces, it matches anywhere in the field.
 */
function wordMatches(field: FoldedField, token: string): boolean {
  if (NO_SPACE_SCRIPT.test(token)) return field.text.includes(token);
  return field.words.some((word) => word.startsWith(token));
}

function allWordsMatch(fields: ReadonlyArray<FoldedField>, tokens: ReadonlyArray<string>): boolean {
  return tokens.every((token) => fields.some((field) => wordMatches(field, token)));
}

/**
 * The rank of an entry for the query, or null when it does not match. A lower rank shows first:
 * the same title, a title that starts with the query, the words of the query in the title, in the
 * title and the keywords, and last in the description too.
 */
function rank(entry: FoldedEntry<unknown>, query: string, tokens: ReadonlyArray<string>): number | null {
  if (entry.titles.some((title) => title.text === query)) return 0;
  if (entry.titles.some((title) => title.text.startsWith(query))) return 1;
  if (allWordsMatch(entry.titles, tokens)) return 2;
  const named = [...entry.titles, ...entry.keywords];
  if (allWordsMatch(named, tokens)) return 3;
  if (allWordsMatch([...named, ...entry.descriptions], tokens)) return 4;
  return null;
}

/** The entries that match the query, best first. Entries of the same rank keep the order of the index. */
export function searchSettings<Entry>(
  query: string,
  index: SettingsSearchIndex<Entry>,
  shown: (entry: Entry) => boolean = () => true,
  limit = SETTINGS_SEARCH_LIMIT,
): Entry[] {
  const needle = foldSearchText(query);
  const tokens = needle.split(WORD_SEPARATOR).filter(Boolean);
  if (tokens.length === 0) return [];
  const ranked: Array<{ entry: Entry; rank: number; order: number }> = [];
  index.forEach((item, order) => {
    if (!shown(item.entry)) return;
    const value = rank(item, needle, tokens);
    if (value !== null) ranked.push({ entry: item.entry, rank: value, order });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.entry);
}

/**
 * The words that let the command palette find an entry: the titles and keywords of `entries` in each
 * language of `translators`, as written and without accents. The palette matches part of a text, so
 * this text holds both forms. For a tab, `entries` holds the tab and its rows.
 */
export function settingsSearchKeywords(
  entries: ReadonlyArray<SettingsSearchKeys>,
  translators: ReadonlyArray<(key: AppTextKey) => string>,
): string {
  const words = new Set<string>();
  for (const entry of entries) {
    for (const key of [entry.titleKey, entry.keywordsKey]) {
      if (!key) continue;
      for (const translate of translators) {
        const text = translate(key);
        words.add(text.toLocaleLowerCase());
        words.add(foldSearchText(text));
      }
    }
  }
  return [...words].join(" ");
}
