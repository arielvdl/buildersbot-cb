import { type AppTextKey, translateFor } from "@openbot/i18n";
import { Button, Input, Search, Server, toast } from "@openbot/ui";
import { createMemo, createSignal, For, flush, Show } from "solid-js";
import { useI18n } from "../../i18n-context";
import { usePlatform } from "../../platform";
import { useServerSettings } from "../servers/server-settings";
import {
  SERVER_SETTINGS_SEARCH,
  type ServerSettingsSearchEntry,
  serverSettingsEntryShown,
} from "../servers/server-settings-sections";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { indexSettingsSearch, type SettingsSearchKeys, searchSettings } from "../settings/settings-search";
import {
  dynamicIslandSettingsShown,
  navItem,
  navItems,
  type SettingsRowState,
  type SettingsTab,
  settingsTabShown,
} from "../settings/settings-tabs";
import { useUpdates } from "../updates/updates-context";
import { ServerSettingsPageTitle, SettingsPageFrame } from "./SettingsPageFrame";
import { clearSettingsRowMark, openServerSettingsSection, revealSettingsRow } from "./settings-row-reveal";
import { type SettingsKind, useWindowPage } from "./window-page-context";

/** A personal search entry: a tab, or a row of a tab. A row has an anchor; a tab has none and opens at the top. */
type PersonalEntry = SettingsSearchKeys & {
  kind: "personal";
  tab: SettingsTab;
  anchor?: AppTextKey;
  shown?: (state: SettingsRowState) => boolean;
};

/** A section of the server settings, or a row of its General section. */
type ServerEntry = ServerSettingsSearchEntry & { kind: "server" };

type SearchEntry = PersonalEntry | ServerEntry;

/** Each personal tab, then its rows, in the order of the tab list. */
const PERSONAL_ENTRIES: ReadonlyArray<PersonalEntry> = navItems.flatMap((item): PersonalEntry[] => [
  {
    kind: "personal",
    tab: item.value,
    titleKey: item.titleKey,
    descriptionKey: item.descriptionKey,
    keywordsKey: item.keywordsKey,
  },
  ...item.rows.map(
    (row): PersonalEntry => ({
      kind: "personal",
      tab: item.value,
      titleKey: row.anchor,
      descriptionKey: row.descriptionKey,
      keywordsKey: row.keywordsKey,
      anchor: row.anchor,
      shown: row.shown,
    }),
  ),
]);

const SERVER_ENTRIES: ReadonlyArray<ServerEntry> = SERVER_SETTINGS_SEARCH.map((entry) => ({
  ...entry,
  kind: "server",
}));

/**
 * A settings page of the window: the user settings or the settings of a server. Both pages search
 * the user settings and the server settings; the page that is open lists its own entries first. The
 * search above the nav replaces the nav with matching entries. A result opens its tab or section and
 * moves to its row.
 */
export function SettingsPage(props: { kind: SettingsKind }) {
  const i18n = useI18n();
  const windowPage = useWindowPage();
  const settings = useSettings();
  const serverSettings = useServerSettings();
  const platform = usePlatform();
  const updates = useUpdates();
  const { activeServer, hostStatus, hostedServerIds, hostedServersLoaded } = useServers();
  const [query, setQuery] = createSignal("");
  /** The server whose sections the search lists: the one this page shows, else the active server. */
  const searchServer = () =>
    (props.kind === "server" ? serverSettings.serverSettingsTarget() : undefined) ?? activeServer();
  /**
   * The search reads the interface language and English, so "update" finds Atualizações. The index
   * folds each text once per language, not on each key press.
   */
  const index = createMemo(() => {
    const current = (key: AppTextKey) => i18n.t(key);
    const english = translateFor("en");
    const translators = i18n.locale() === "en" ? [current] : [current, (key: AppTextKey) => english(key)];
    const entries: SearchEntry[] =
      props.kind === "server" ? [...SERVER_ENTRIES, ...PERSONAL_ENTRIES] : [...PERSONAL_ENTRIES, ...SERVER_ENTRIES];
    return indexSettingsSearch(entries, translators);
  });
  const results = createMemo(() => {
    const value = query().trim();
    if (!value) return null;
    const platformName = platform.appInfo()?.platform;
    const islandShown = dynamicIslandSettingsShown(platformName, platform.chatWindow !== null);
    const rowState: SettingsRowState = {
      platform: platformName,
      general: settings.generalSettings(),
      update: updates.status(),
    };
    const server = searchServer();
    const serverContext = {
      platform: platformName,
      host: hostStatus(),
      hostedServerIds: hostedServersLoaded() ? hostedServerIds() : null,
      canLeave: true,
    };
    // An entry shows only where the page shows it: a tab of this computer, a row that the state does
    // not hide, a section that the server has.
    const shown = (entry: SearchEntry) => {
      if (entry.kind === "server") {
        return server !== undefined && serverSettingsEntryShown(entry, server, serverContext);
      }
      return settingsTabShown(entry.tab, islandShown) && (entry.shown?.(rowState) ?? true);
    };
    // This app and the server each show their best matches, so "servidor" also lists the server sections.
    return searchSettings(value, index(), shown, (entry) => entry.kind);
  });
  /** What a screen reader hears while the user types a query. */
  const resultStatus = () => {
    const rows = results();
    if (!rows) return "";
    return rows.length > 0
      ? i18n.t("app.settingsPage.resultCount", { count: rows.length })
      : i18n.t("app.settingsPage.noResults");
  };

  /** A row that the state hides shows no anchor in time; the user then reads why the tab does not show it. */
  const reveal = (panel: string, anchor: string) => {
    void revealSettingsRow(panel, anchor).then((result) => {
      if (result === "hidden") toast.info(i18n.t("app.settingsPage.rowHidden"));
    });
  };

  /**
   * Opens the tab or section of the result. For a row, it then scrolls to the row, marks it and puts
   * the focus on its control.
   */
  const openResult = (entry: SearchEntry) => {
    setQuery("");
    if (entry.kind === "server") {
      const server = searchServer();
      if (!server) return;
      openServerSettingsSection(serverSettings, server.id, null, entry.section);
      if (entry.anchor) reveal(entry.section, entry.anchor);
      else clearSettingsRowMark();
      return;
    }
    // A repeated tab opens again: `openAppSettings` clears a request for the same tab first.
    settings.openAppSettings(null, entry.tab);
    flush();
    if (entry.anchor) reveal(entry.tab, entry.anchor);
    else clearSettingsRowMark();
  };

  return (
    <SettingsPageFrame
      heading={
        <Show
          when={props.kind === "personal"}
          fallback={
            <Show when={serverSettings.serverSettingsTarget()}>
              {(server) => <ServerSettingsPageTitle server={server()} />}
            </Show>
          }
        >
          <h1 class="settings-page-title" tabindex={-1}>
            {i18n.t("app.settingsPage.title")}
          </h1>
        </Show>
      }
      sectionsHidden={results() !== null}
      onMounts={(mounts) => windowPage.setSettingsMounts(mounts)}
      // Escape clears the search, or else closes the page.
      onEscape={() => {
        if (query()) setQuery("");
        else windowPage.showAgents();
      }}
    >
      <label class="search-field settings-page-search">
        <Search aria-hidden="true" />
        <Input
          type="search"
          aria-label={i18n.t("app.settingsPage.search")}
          placeholder={i18n.t("app.settingsPage.searchPlaceholder")}
          spellcheck={false}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            const top = results()?.[0];
            if (event.key === "Enter" && top) {
              event.preventDefault();
              openResult(top);
            }
          }}
        />
      </label>
      {/* Always in the page, so a screen reader announces each change of the count. */}
      <span class="sr-only" role="status">
        {resultStatus()}
      </span>
      <Show when={results()}>
        {(rows) => (
          <Show
            when={rows().length > 0}
            fallback={<p class="settings-page-empty">{i18n.t("app.settingsPage.noResults")}</p>}
          >
            <ul class="settings-page-results" aria-label={i18n.t("app.settingsPage.results")}>
              <For each={rows()}>
                {(row) => {
                  // A server entry names the server, as the server entries of the command palette do.
                  const tab = row.kind === "server" ? null : navItem(row.tab);
                  const PlaceIcon = tab ? tab.icon : Server;
                  const place = () => (tab ? i18n.t(tab.titleKey) : (searchServer()?.name ?? ""));
                  // A tab result shows the tab description, as its title is already on the line above.
                  const titleKey = row.kind === "server" || row.anchor ? row.titleKey : navItem(row.tab).descriptionKey;
                  return (
                    <li>
                      <Button
                        variant="ghost"
                        type="button"
                        class="settings-page-result"
                        onClick={() => openResult(row)}
                      >
                        <span class="settings-page-result-section">
                          <PlaceIcon aria-hidden="true" />
                          {place()}
                        </span>
                        <span class="settings-page-result-title">{i18n.t(titleKey)}</span>
                      </Button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </SettingsPageFrame>
  );
}
