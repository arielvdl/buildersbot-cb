import type { AppTextKey } from "@openbot/i18n";

/** The text keys of one settings search entry: a tab, a row, or a section of the server settings. */
export interface SettingsSearchKeys {
  titleKey: AppTextKey;
  descriptionKey?: AppTextKey | undefined;
  /** More words that find the entry: other names, related words and words of the same family. */
  keywordsKey?: AppTextKey | ReadonlyArray<AppTextKey> | undefined;
  /**
   * The words of the place that holds the entry, such as "server" for each entry of the server
   * settings. A query word that names the place counts as found, so "vault of the server" finds the
   * Vault section as "vault" does.
   */
  scopeKey?: AppTextKey | undefined;
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
  scopes: readonly FoldedField[];
}

/** The index of a list of entries. Make it again when the language changes. */
export interface SettingsSearchIndex<Entry> {
  entries: ReadonlyArray<FoldedEntry<Entry>>;
  /** Folded words that do not name a setting, such as "do" in "cofre do servidor" or "the". */
  fillers: ReadonlySet<string>;
}

/** An entry that matches a query, with its rank: a lower rank shows first. */
export interface RankedSettingsEntry<Entry> {
  entry: Entry;
  rank: number;
}

/** A broad query shows a short list for each group, not every entry. */
export const SETTINGS_SEARCH_LIMIT = 12;

/** The catalog key that lists the filler words of a language, separated by commas. */
const FILLER_WORDS_KEY: AppTextKey = "settings.search.fillerWords";
/** A query that only names the place of an entry ranks it as a match of all words in its title. */
const SCOPE_RANK = 2;
/** A query word that is this long can match inside a word of a title, such as "vorschau" in "Nachrichtenvorschau". */
const INSIDE_WORD_LENGTH = 5;

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;
/** Scripts that do not put a space between words. A query in them can match inside a word. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * Lower case, with no accents and single spaces. "Notificações" and "notificacoes" give the same
 * text, so a query typed without accents finds the entry. Only the Latin, Greek and Cyrillic accents
 * go; the marks of Japanese kana stay, and NFC joins Korean syllables again.
 */
export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/gu, "").normalize("NFC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

/** The keyword keys of an entry as a list. */
export function keyList(keys: SettingsSearchKeys["keywordsKey"]): ReadonlyArray<AppTextKey> {
  if (keys === undefined) return [];
  return typeof keys === "string" ? [keys] : keys;
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
  const texts = (keys: SettingsSearchKeys["keywordsKey"]): FoldedField[] => {
    const unique = new Set(keyList(keys).flatMap((key) => translators.map((translate) => translate(key))));
    return [...unique].map(folded);
  };
  const fillers = new Set(
    translators.flatMap((translate) => translate(FILLER_WORDS_KEY).split(",").map(foldSearchText).filter(Boolean)),
  );
  return {
    entries: entries.map((entry) => ({
      entry,
      titles: texts(entry.titleKey),
      keywords: texts(entry.keywordsKey),
      descriptions: texts(entry.descriptionKey),
      scopes: texts(entry.scopeKey),
    })),
    fillers,
  };
}

/** A query word, and the forms that a word of an entry can start with. */
interface QueryWord {
  text: string;
  forms: readonly string[];
}

/**
 * The query word, and the word without a plural or feminine ending of English, Portuguese or
 * Spanish. "agentes" then finds "Agente", "papeis" finds "Papel", "notificacoes" finds "Notificação"
 * and "minima" finds "Mínimo".
 */
function queryWord(text: string): QueryWord {
  const forms = [text];
  if (text.length >= 6) {
    if (text.endsWith("oes")) forms.push(`${text.slice(0, -3)}ao`);
    if (text.endsWith("eis")) forms.push(`${text.slice(0, -3)}el`);
    if (text.endsWith("ais")) forms.push(`${text.slice(0, -3)}al`);
    if (text.endsWith("es")) forms.push(text.slice(0, -2));
  }
  if (text.length >= 4 && text.endsWith("s")) forms.push(text.slice(0, -1));
  if (text.length >= 5 && text.endsWith("a")) forms.push(`${text.slice(0, -1)}o`);
  return { text, forms };
}

/**
 * A query word matches a field when a word of the field starts with it, so "tema" finds "Tema" and
 * not "sistema". In a script with no spaces, it matches anywhere in the field.
 */
function wordMatches(field: FoldedField, word: QueryWord): boolean {
  if (NO_SPACE_SCRIPT.test(word.text)) return field.text.includes(word.text);
  return field.words.some((candidate) => word.forms.some((form) => candidate.startsWith(form)));
}

function anyFieldMatches(fields: ReadonlyArray<FoldedField>, word: QueryWord): boolean {
  return fields.some((field) => wordMatches(field, word));
}

function allWordsMatch(fields: ReadonlyArray<FoldedField>, words: ReadonlyArray<QueryWord>): boolean {
  return words.every((word) => anyFieldMatches(fields, word));
}

/**
 * The rank of an entry for the query words. A lower rank shows first: the same title, a title that
 * starts with the query, the words in the title, in the title and the keywords, in the description
 * too, and last a long word inside a word of the title.
 */
type Rank = 0 | 1 | 2 | 3 | 4 | 5;

/** The rank of an entry for the query words, or null when it does not match. */
function rankWords(entry: FoldedEntry<unknown>, needle: string, words: ReadonlyArray<QueryWord>): Rank | null {
  if (entry.titles.some((title) => title.text === needle)) return 0;
  if (entry.titles.some((title) => title.text.startsWith(needle))) return 1;
  if (allWordsMatch(entry.titles, words)) return 2;
  const named = [...entry.titles, ...entry.keywords];
  if (allWordsMatch(named, words)) return 3;
  const all = [...named, ...entry.descriptions];
  if (allWordsMatch(all, words)) return 4;
  const inside = (word: QueryWord) =>
    word.text.length >= INSIDE_WORD_LENGTH && entry.titles.some((title) => title.text.includes(word.text));
  if (words.every((word) => anyFieldMatches(all, word) || inside(word))) return 5;
  return null;
}

/**
 * The rank of an entry, where a query word that names the place of the entry counts as found:
 * "cofre do servidor" ranks the Vault section of the server as "cofre" does.
 */
function rank(entry: FoldedEntry<unknown>, needle: string, words: ReadonlyArray<QueryWord>): number | null {
  const plain = rankWords(entry, needle, words);
  if (entry.scopes.length === 0 || plain === 0) return plain;
  const rest = words.filter((word) => !anyFieldMatches(entry.scopes, word));
  if (rest.length === words.length) return plain;
  const scoped = rest.length === 0 ? SCOPE_RANK : rankWords(entry, rest.map((word) => word.text).join(" "), rest);
  if (scoped === null) return plain;
  return plain === null ? scoped : Math.min(plain, scoped);
}

/**
 * The entries that match the query, best first, with their rank. Entries of the same rank keep the
 * order of the index. A filler word, such as "do" or "the", and a one-letter word count only when
 * the query has no other word.
 */
export function rankSettings<Entry>(
  query: string,
  index: SettingsSearchIndex<Entry>,
  shown: (entry: Entry) => boolean = () => true,
): RankedSettingsEntry<Entry>[] {
  const needle = foldSearchText(query);
  const all = needle.split(WORD_SEPARATOR).filter(Boolean);
  const named = all.filter((word) => NO_SPACE_SCRIPT.test(word) || (word.length > 1 && !index.fillers.has(word)));
  const words = (named.length > 0 ? named : all).map(queryWord);
  if (words.length === 0) return [];
  const ranked: Array<RankedSettingsEntry<Entry> & { order: number }> = [];
  index.entries.forEach((item, order) => {
    if (!shown(item.entry)) return;
    const value = rank(item, needle, words);
    if (value !== null) ranked.push({ entry: item.entry, rank: value, order });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ entry, rank: value }) => ({ entry, rank: value }));
}

/**
 * The entries that match the query, best first. `groupOf` puts the entries in groups, such as this
 * app and a server, and each group shows at most `limit` entries: a query that finds many rows of
 * one group does not hide the other group.
 */
export function searchSettings<Entry>(
  query: string,
  index: SettingsSearchIndex<Entry>,
  shown: (entry: Entry) => boolean = () => true,
  groupOf: (entry: Entry) => string = () => "",
  limit = SETTINGS_SEARCH_LIMIT,
): Entry[] {
  const counts = new Map<string, number>();
  const results: Entry[] = [];
  for (const { entry } of rankSettings(query, index, shown)) {
    const group = groupOf(entry);
    const count = counts.get(group) ?? 0;
    if (count >= limit) continue;
    counts.set(group, count + 1);
    results.push(entry);
  }
  return results;
}
