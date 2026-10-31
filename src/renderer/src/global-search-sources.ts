import { SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import { type AppTextKey, translateFor } from "@openbot/i18n";
import { BookMarked, Bot, CalendarClock, Hash, Server, Store } from "@openbot/ui";
import type {
  GlobalSearchAction,
  GlobalSearchFile,
  GlobalSearchPage,
  GlobalSearchRoutine,
  GlobalSearchSectionScope,
  GlobalSearchTab,
} from "@openbot/ui/components/GlobalSearch";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal } from "solid-js";
import { formatMessageTime } from "./app-message-projection";
import { appPort } from "./app-port";
import { useAgents } from "./features/agents/agents-context";
import { useChannels } from "./features/channels/channels-context";
import { globalSearchChannels } from "./features/channels/global-search-channels";
import { useServerSettings } from "./features/servers/server-settings";
import {
  SERVER_SETTINGS_SEARCH,
  SERVER_SETTINGS_SECTIONS,
  serverSettingsEntryShown,
} from "./features/servers/server-settings-sections";
import { useServers } from "./features/servers/servers-context";
import { useSettings } from "./features/settings/settings-context";
import { settingsSearchKeywords } from "./features/settings/settings-search";
import { dynamicIslandSettingsShown, navItems, settingsTabShown } from "./features/settings/settings-tabs";
import { useSectionRailFocus } from "./features/sidebar/section-rail-focus";
import { useSidebar } from "./features/sidebar/sidebar-context";
import { useUsage } from "./features/usage/usage-context";
import { openServerSettingsSection, revealSettingsRow } from "./features/window/settings-row-reveal";
import { useWindowPage } from "./features/window/window-page-context";
import { useLayout } from "./layout";
import { sectionRailShowsOn } from "./left-column";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";

const FILE_SEARCH_LIMIT = 50;

/**
 * The rows of the server settings that the palette lists as results of their own. The value is the
 * end of the result id, which did not change. A result opens General and moves to the row. The words
 * of the other rows find their section.
 */
const PALETTE_SERVER_ROWS: Partial<Record<AppTextKey, string>> = {
  "server.settings.memoryLimit": "memory-limit",
  "server.settings.memoryReview": "memory-review",
};

/**
 * What global search finds besides agents and messages: channels, routines, files, commands and
 * settings pages. Routines load each time the search opens, as no store keeps every agent's list.
 * Files come from this computer's database, so a joined server shows no Files filter. It also gives
 * the tab that the search opens on, and the section of the rail that the search can keep.
 */
export function useGlobalSearchSources(open: () => boolean) {
  const { t, locale } = useText();
  const platform = usePlatform();
  const channels = useChannels();
  const { agentList, agentSetupOpen, creatingAgent, openAgentSetup, setSettingsRequest } = useAgents();
  const { selectAgent, globalSearchOpener } = useNavigation();
  const { activeServer, hostStatus } = useServers();
  const serverSettings = useServerSettings();
  const { openAppSettings, setSkillsMarketplaceOpen, generalSettings } = useSettings();
  const { openSchedule } = useUsage();
  const [routines, setRoutines] = createSignal<GlobalSearchRoutine[]>([]);
  const [routinesLoading, setRoutinesLoading] = createSignal(false);
  let routineRequest = 0;

  const layout = useLayout();
  const windowPage = useWindowPage();
  const { sidebarLayout } = useSidebar();
  const sectionRail = useSectionRailFocus();

  const local = () => activeServer()?.kind === "local";

  // Lazy: the overlay reads these only while the search is open.
  const searchChannels = createMemo(
    () => (channels.supported() ? globalSearchChannels(channels.state.channels) : undefined),
    { lazy: true },
  );

  /** The Routines view opens the search on its Routines tab; every other view opens it on All. */
  const initialTab = (): GlobalSearchTab | undefined =>
    windowPage.page() === "agents" && layout.sidebarView() === "routines" ? "routines" : undefined;

  /**
   * The section that the rail selects, while the page shows the rail. The search then offers to keep
   * only the results of that section. "All", and a page without the rail, give no scope.
   */
  const sectionScope = createMemo(
    (): GlobalSearchSectionScope | undefined => {
      if (!sectionRailShowsOn(windowPage.page())) return undefined;
      const sectionId = sectionRail.focus();
      if (sectionId === null) return undefined;
      const name =
        sectionId === SIDEBAR_UNASSIGNED_SECTION_ID
          ? t("sidebar.section.unassigned")
          : sidebarLayout().sections.find((section) => section.id === sectionId)?.name;
      return name === undefined ? undefined : { name, includes: sectionRail.inSection };
    },
    { lazy: true },
  );

  createEffect(
    () => (open() ? agentList() : null),
    (agents) => {
      const request = ++routineRequest;
      if (!agents) {
        setRoutinesLoading(false);
        return;
      }
      setRoutinesLoading(true);
      const names = new Map(agents.map((agent) => [agent.id, agent.name]));
      void Promise.all(
        agents.map((agent) =>
          appPort()
            .agent.listRoutines(agent.id)
            .catch(() => []),
        ),
      ).then((lists) => {
        if (request !== routineRequest) return;
        setRoutines(() =>
          lists.flat().map((routine) => ({
            id: routine.id,
            name: routine.name,
            agentId: routine.agentId,
            detail: names.get(routine.agentId) ?? "",
          })),
        );
        setRoutinesLoading(false);
      });
    },
  );

  async function searchFiles(query: string, cursor?: string): Promise<GlobalSearchPage<GlobalSearchFile>> {
    const page = await appPort().agent.searchConversationFiles({
      query,
      ...(cursor === undefined ? {} : { cursor }),
      limit: FILE_SEARCH_LIMIT,
    });
    return {
      results: page.results.map((result) => ({
        id: result.attachment.id,
        name: result.attachment.name,
        agentId: result.agentId,
        messageId: result.messageId,
        time: formatMessageTime(result.createdAt),
      })),
      nextCursor: page.nextCursor,
    };
  }

  function selectRoutine(routine: GlobalSearchRoutine): void {
    const agentId = routine.agentId;
    // As in `editAgent`: the agent cannot change while a new agent is being created.
    if (!agentId || (agentSetupOpen() && creatingAgent())) return;
    selectAgent(agentId);
    setSettingsRequest({ agentId, nonce: Date.now(), routine: { routineId: routine.id, name: routine.name } });
  }

  const actions = createMemo<GlobalSearchAction[]>(
    () => {
      const server = activeServer();
      const dynamicIslandShown = dynamicIslandSettingsShown(platform.appInfo()?.platform, platform.chatWindow !== null);
      const list: GlobalSearchAction[] = [
        {
          id: "new-agent",
          label: t("sidebar.new.agent"),
          group: "actions",
          icon: Bot,
          run: () => {
            channels.close();
            openAgentSetup();
          },
        },
      ];
      if (channels.supported()) {
        list.push({
          id: "new-channel",
          label: t("sidebar.new.channel"),
          group: "actions",
          icon: Hash,
          run: channels.create,
        });
      }
      list.push({
        id: "marketplace",
        label: t("sidebar.topbar.openMarketplace"),
        group: "actions",
        icon: Store,
        run: () => setSkillsMarketplaceOpen(true),
      });
      if (server) {
        list.push({
          id: "schedule",
          label: t("routine.calendar.open"),
          group: "actions",
          icon: CalendarClock,
          run: () => openSchedule(server.id, globalSearchOpener()),
        });
      }
      // The interface language and English, as written and without accents, and for a tab the titles
      // of its rows: "acordado", "update" and "notificacoes" each find their page.
      const english = translateFor("en");
      const translators =
        locale() === "en"
          ? [(key: AppTextKey) => t(key)]
          : [(key: AppTextKey) => t(key), (key: AppTextKey) => english(key)];
      const platformName = platform.appInfo()?.platform;
      const rowState = { platform: platformName, general: generalSettings() };
      for (const item of navItems) {
        // Hosted servers shows only for an account with hosting, which the dialog checks when it opens.
        if (!settingsTabShown(item.value, dynamicIslandShown)) continue;
        const rows = item.rows
          .filter((row) => row.shown?.(rowState) ?? true)
          .map((row) => ({ titleKey: row.anchor, keywordsKey: row.keywordsKey }));
        list.push({
          id: `settings:${item.value}`,
          label: t(item.titleKey),
          detail: t("conversation.globalSearch.appSettings"),
          keywords: settingsSearchKeywords([item, ...rows], translators),
          group: "settings",
          icon: item.icon,
          run: () => openAppSettings(globalSearchOpener(), item.value),
        });
      }
      if (server) {
        const context = { platform: platformName, host: hostStatus() };
        const shown = SERVER_SETTINGS_SEARCH.filter((entry) => serverSettingsEntryShown(entry, server, context));
        for (const entry of shown) {
          const row = entry.anchor ? PALETTE_SERVER_ROWS[entry.anchor] : undefined;
          if (row && entry.anchor) {
            const anchor = entry.anchor;
            list.push({
              id: `server:${row}`,
              label: t(entry.titleKey),
              detail: server.name,
              keywords: settingsSearchKeywords([entry], translators),
              group: "settings",
              icon: BookMarked,
              run: () => {
                openServerSettingsSection(serverSettings, server.id, globalSearchOpener(), entry.section);
                void revealSettingsRow(entry.section, anchor);
              },
            });
            continue;
          }
          // The other rows of a section find the section.
          if (entry.anchor) continue;
          const rowsOfSection = shown.filter((other) => other.anchor && other.section === entry.section);
          list.push({
            id: `server:${entry.section}`,
            label: t(entry.titleKey),
            detail: server.name,
            keywords: settingsSearchKeywords([entry, ...rowsOfSection], translators),
            group: "settings",
            // The Server icon tells the General of the server from the General of the app.
            icon: entry.section === "general" ? Server : SERVER_SETTINGS_SECTIONS[entry.section].icon,
            run: () => openServerSettingsSection(serverSettings, server.id, globalSearchOpener(), entry.section),
          });
        }
      }
      return list;
    },
    { lazy: true },
  );

  return {
    initialTab,
    sectionScope,
    channels: searchChannels,
    routines,
    routinesLoading,
    actions,
    searchFiles: () => (local() ? searchFiles : undefined),
    openChannel: (channelId: string) => void channels.open(channelId),
    selectRoutine,
  };
}
