import type { ServerSummary } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { BookMarked, Server } from "@openbot/ui";
import type { GlobalSearchAction } from "@openbot/ui/components/GlobalSearch";
import {
  indexSettingsSearch,
  rankSettings,
  type SettingsSearchIndex,
  type SettingsSearchKeys,
} from "../settings/settings-search";
import {
  SERVER_SETTINGS_SEARCH,
  SERVER_SETTINGS_SECTIONS,
  type ServerSettingsSearchEntry,
  type ServerSettingsSection,
} from "./server-settings-sections";

/**
 * The rows of the server settings that the palette lists as results of their own. The value is the
 * end of the result id, which did not change. The words of the other rows find their section.
 */
const PALETTE_SERVER_ROWS: Partial<Record<AppTextKey, string>> = {
  "server.settings.memoryLimit": "memory-limit",
  "server.settings.memoryReview": "memory-review",
};

/**
 * The words of an entry that the palette reads: the title, the keywords and the place. The palette
 * does not read descriptions, so a word that only a description holds does not add a result.
 */
export function paletteSearchEntry(entry: SettingsSearchKeys): SettingsSearchKeys {
  return { titleKey: entry.titleKey, keywordsKey: entry.keywordsKey, scopeKey: entry.scopeKey };
}

/**
 * The rank of one palette result for a query: the best rank of its entries, as the settings search
 * ranks them, or null when no entry matches.
 */
export function paletteRank<Entry>(index: SettingsSearchIndex<Entry>): (query: string) => number | null {
  return (query) => rankSettings(query, index)[0]?.rank ?? null;
}

export interface ServerSettingsPaletteOptions {
  server: ServerSummary;
  /** Whether the settings of the server show the entry now. */
  shown: (entry: ServerSettingsSearchEntry) => boolean;
  /** The interface language, then English. */
  translators: ReadonlyArray<(key: AppTextKey) => string>;
  t: (key: AppTextKey) => string;
  /** Opens a section of the settings of the server, and for a row also moves to the row. */
  open: (section: ServerSettingsSection, anchor: AppTextKey | undefined) => void;
}

/**
 * The palette results of the server settings: each section that the settings show, which the words
 * of the section and of its rows find, and the rows of `PALETTE_SERVER_ROWS` as results of their own.
 * The desktop app and the web client both list them.
 */
export function serverSettingsPaletteActions(options: ServerSettingsPaletteOptions): GlobalSearchAction[] {
  const shown = SERVER_SETTINGS_SEARCH.filter(options.shown);
  const ownResult = (entry: ServerSettingsSearchEntry) =>
    entry.anchor === undefined ? undefined : PALETTE_SERVER_ROWS[entry.anchor];
  const actions: GlobalSearchAction[] = [];
  for (const entry of shown) {
    const row = ownResult(entry);
    if (entry.anchor !== undefined && row === undefined) continue;
    const entries =
      row === undefined
        ? [
            entry,
            ...shown.filter(
              (other) => other.anchor !== undefined && other.section === entry.section && !ownResult(other),
            ),
          ]
        : [entry];
    const index = indexSettingsSearch(entries.map(paletteSearchEntry), options.translators);
    actions.push({
      id: `server:${row ?? entry.section}`,
      label: options.t(entry.titleKey),
      detail: options.server.name,
      group: "settings",
      // The Server icon tells the General of the server from the General of the app.
      icon:
        row !== undefined
          ? BookMarked
          : entry.section === "general"
            ? Server
            : SERVER_SETTINGS_SECTIONS[entry.section].icon,
      rank: paletteRank(index),
      run: () => options.open(entry.section, row === undefined ? undefined : entry.anchor),
    });
  }
  return actions;
}
