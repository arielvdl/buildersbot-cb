import type { AppTextKey } from "@openbot/i18n";
import { SlidersHorizontal, UserRound } from "@openbot/ui";
import type { GlobalSearchAction } from "@openbot/ui/components/GlobalSearch";
import { paletteRank } from "../servers/server-settings-palette";
import { indexSettingsSearch, type SettingsSearchKeys } from "../settings/settings-search";
import type { WebAccountSettingsTab } from "./WebAccountSettings";

/** The tabs in the order of the tab list. */
const TABS: ReadonlyArray<WebAccountSettingsTab> = ["profile", "preferences"];

/** The place of each tab: "configurações" or "app" finds each one, as on desktop. */
const APP_SETTINGS_SCOPE: AppTextKey = "conversation.globalSearch.appSettings";

/**
 * The title of each tab and of the rows that `WebAccountSettings` shows in it, with the words that
 * also find them. The palette lists a tab when its words or the words of one of its rows match.
 */
const WEB_ACCOUNT_SETTINGS_SEARCH = {
  profile: {
    icon: UserRound,
    entries: [
      { titleKey: "settings.tab.profile.title", keywordsKey: "settings.search.keywords.profile" },
      { titleKey: "settings.profile.email.title", keywordsKey: "settings.search.keywords.email" },
      { titleKey: "settings.profile.sessions.title", keywordsKey: "settings.search.keywords.sessions" },
    ],
  },
  preferences: {
    icon: SlidersHorizontal,
    entries: [
      { titleKey: "webClient.settings.preferences.title", keywordsKey: "settings.search.keywords.general" },
      { titleKey: "webClient.app.installTitle", keywordsKey: "settings.search.keywords.mobileConnect" },
      { titleKey: "webClient.app.lockTitle" },
      { titleKey: "webClient.app.pushTitle", keywordsKey: "settings.search.keywords.desktopNotifications" },
      { titleKey: "settings.tab.notifications.title", keywordsKey: "settings.search.keywords.notifications" },
      { titleKey: "settings.notifications.whatYouHear", keywordsKey: "settings.search.keywords.whatYouHear" },
      { titleKey: "settings.appearance.theme.title", keywordsKey: "settings.search.keywords.theme" },
      { titleKey: "settings.language.title", keywordsKey: "settings.search.keywords.language" },
      { titleKey: "settings.sendShortcut.title", keywordsKey: "settings.search.keywords.sendShortcut" },
      { titleKey: "settings.showAgentSteps.title", keywordsKey: "settings.search.keywords.showAgentSteps" },
      { titleKey: "settings.taskSound.title", keywordsKey: "settings.search.keywords.taskSound" },
      { titleKey: "settings.soundFeedback.title", keywordsKey: "settings.search.keywords.soundFeedback" },
      { titleKey: "settings.analytics.title", keywordsKey: "settings.search.keywords.analytics" },
    ],
  },
} as const satisfies Record<
  WebAccountSettingsTab,
  { icon: typeof UserRound; entries: ReadonlyArray<Pick<SettingsSearchKeys, "titleKey" | "keywordsKey">> }
>;

/**
 * The palette results of the account settings of the web client: one for each tab, ranked as the
 * settings search ranks the tab and its rows.
 */
export function webAccountSettingsPaletteActions(options: {
  translators: ReadonlyArray<(key: AppTextKey) => string>;
  t: (key: AppTextKey) => string;
  open: (tab: WebAccountSettingsTab) => void;
}): GlobalSearchAction[] {
  return TABS.map((tab) => {
    const { icon, entries } = WEB_ACCOUNT_SETTINGS_SEARCH[tab];
    const keys = entries.map((entry): SettingsSearchKeys => ({ ...entry, scopeKey: APP_SETTINGS_SCOPE }));
    return {
      id: `settings:${tab}`,
      label: options.t(entries[0].titleKey),
      detail: options.t(APP_SETTINGS_SCOPE),
      group: "settings",
      icon,
      rank: paletteRank(indexSettingsSearch(keys, options.translators)),
      run: () => options.open(tab),
    };
  });
}
