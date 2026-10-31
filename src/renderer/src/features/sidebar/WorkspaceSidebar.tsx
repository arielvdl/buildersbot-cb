import { type ChatWindowTarget, canAdministerServer } from "@openbot/contracts/ipc";
import { AGENT_HIDDEN_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { computeAgentAvatarMoods } from "@openbot/ui/features/agents/agent-avatar-mood";
import { DRAFT_THREAD_ID, MAIN_THREAD_ID } from "@openbot/ui/features/conversation/threads/thread-types";
import { Sidebar } from "@openbot/ui/features/sidebar/Sidebar";
import { SidebarMachineCard } from "@openbot/ui/features/sidebar/SidebarMachineCard";
import { SidebarMobileAppCard } from "@openbot/ui/features/sidebar/SidebarMobileAppCard";
import { SidebarStorageCard } from "@openbot/ui/features/sidebar/SidebarStorageCard";
import { computeSidebarAgentStates, sidebarChannelWaits } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import type { SidebarActivityFilter, SidebarChatTabs } from "@openbot/ui/features/sidebar/sidebar-types";
import { sidebarChatTabsKey } from "@openbot/ui/features/sidebar/sidebar-types";
import { teamMemberName } from "@openbot/ui/features/team/TeamPersonAvatar";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import { appPort } from "../../app-port";
import { type ChatHistoryEntry, chatHistoryKeys } from "../../chat-history";
import { useLayout } from "../../layout";
import { DirectConversation } from "../../lazy-views";
import { sectionRailShowsOn } from "../../left-column";
import { useNavigation } from "../../navigation";
import { usePlatform } from "../../platform";
import { useTurns } from "../../turns";
import { useAgentTasks } from "../agent-tasks/agent-tasks-context";
import { useAgentThreads } from "../agent-threads/agent-threads-context";
import { useAgentActions } from "../agents/agent-actions";
import { attentionByAgent } from "../agents/agent-runtime-snapshot";
import { agentThreadAttention } from "../agents/agent-thread-attention";
import { useAgents } from "../agents/agents-context";
import { readChannelLastTopics, saveChannelLastTopic } from "../channels/channel-tabs-model";
import { useChannels } from "../channels/channels-context";
import { useConversation } from "../conversation/conversation-context";
import { useDirectMessages } from "../conversation/direct-messages-context";
import { useServerActions } from "../servers/server-actions";
import { serverRoleCanAdminister } from "../servers/server-capabilities";
import { useServerSettings } from "../servers/server-settings";
import { serverUpdateBadge, showServerUpdate } from "../servers/server-update-flow";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { usePresence } from "../team/team-context";
import { SidebarUpdateIsland } from "../updates/SidebarUpdateIsland";
import { useWindowPage } from "../window/window-page-context";
import { createMachineCard } from "./machine-card";
import { useSidebar } from "./sidebar-context";
import { createStorageCard } from "./storage-card";

/** Dismissing the mobile app card is a choice of this computer, like the sidebar width. The key is
 * new with the Android release, so a computer that dismissed the iPhone-only card sees it once more. */
const MOBILE_APP_DISMISSED_STORAGE_KEY = "openbot:mobile-app-card-dismissed";

/**
 * The list of Agents and people. It reads the most domains of any pane, and every
 * one of them for the same reason: a sidebar row shows who exists, who is
 * working, who has replied and who is pinned, which is four domains before any
 * of the actions on the row context menu.
 *
 * `peopleEnabled` arrives as a prop because the shell already computes it to
 * decide which pane renders. Deriving it a second time here would let the two
 * answers disagree for a frame.
 */
export function WorkspaceSidebar(props: { peopleEnabled: boolean }) {
  const { t } = useText();
  const layout = useLayout();
  const windowPage = useWindowPage();
  const platform = usePlatform();
  const channels = useChannels();
  const { activeServer, activeServerId, activeServerSupportsCapability } = useServers();
  // The chats that main shows in a window of their own. Main sends the list on each change.
  const [chatWindows, setChatWindows] = createSignal<ChatWindowTarget[]>([]);
  onSettled(() => {
    const unsubscribe = appPort().onChatWindows(setChatWindows);
    void appPort()
      .getChatWindows()
      .then(setChatWindows)
      .catch(() => undefined);
    return unsubscribe;
  });
  const windowAgentIds = createMemo(
    () => new Set(chatWindows().flatMap((target) => (target.serverId === activeServerId() ? [target.agentId] : []))),
  );
  const { openServerSettings, serverSettingsOpen } = useServerSettings();
  const serverActions = useServerActions();
  const { openAppSettings, setSkillsMarketplaceOpen } = useSettings();
  const {
    agentList,
    agentListConnecting,
    agentListSettled,
    activeAgent,
    agentSetupDraft,
    duplicatingAgentIds,
    openAgentSetup,
    userHiddenAgents,
    userHiddenAgentIds,
  } = useAgents();
  const { editAgent, duplicateAgent, duplicateSection, duplicatingSectionIds, deleteAgent, setAgentHiddenByUser } =
    useAgentActions();
  // The host refuses a member: a hidden agent stops for every member, as a deleted one does.
  const hideAllowed = () =>
    activeServerSupportsCapability(AGENT_HIDDEN_CAPABILITY) && serverRoleCanAdminister(activeServer());
  const { activeTurns, queues, failedTurns, usageLimits, pendingPrompts, pendingApprovals, approvals } = useTurns();
  const { unreadReplies, recentReplies, markAllAgentMessagesRead } = useConversation();
  const { directPeople, teamPresence } = usePresence();
  const { activeDirectMember, activeDirectMemberId, directThreads } = useDirectMessages();
  const { selectAgent, selectDirectMember, setGlobalSearchVisibility, chatHistory } = useNavigation();
  const agentTasks = useAgentTasks();
  const agentThreads = useAgentThreads();
  /** The last open tab of each channel, so its row opens there and the tab stays marked. */
  const [lastChannelTopics, setLastChannelTopics] = createSignal(readChannelLastTopics());
  createEffect(
    () => `${channels.state.selectedId ?? ""}\n${channels.state.topicId ?? ""}`,
    () => {
      const channelId = channels.state.selectedId;
      const topicId = channels.state.topicId;
      if (channelId && topicId) setLastChannelTopics(saveChannelLastTopic(channelId, topicId));
    },
  );
  /* Channels reach the sidebar as data, not as a list of their own: they sit in the layout's
   * sections beside the agents, so the sidebar has to be able to order and group them. The Routines
   * view lists only agents: a channel has no routine canvas. Declared before `chatTabs`, whose memo
   * reads it as soon as it is created. */
  const channelsListed = () => channels.supported() && layout.sidebarView() !== "routines";
  const visibleChannels = createMemo(() =>
    channelsListed() ? channels.state.channels.filter((channel) => !channel.archived) : [],
  );
  /** The tab a channel row opens: its open one, the last one it had, or the first. */
  const channelTopicFor = (channelId: string): string | undefined => {
    if (channels.state.selectedId === channelId && channels.state.topicId) return channels.state.topicId;
    const topics = visibleChannels().find((channel) => channel.id === channelId)?.topics ?? [];
    const last = lastChannelTopics()[channelId];
    return topics.find((topic) => topic.id === last)?.id ?? topics[0]?.id;
  };
  const openChannel = (channelId: string) => {
    const topicId = channelTopicFor(channelId);
    void channels.open(channelId).then(() => {
      if (topicId) void channels.setTopic(topicId);
    });
  };
  const openChatTab = (kind: "agent" | "channel", chatId: string, tabId: string) => {
    if (kind === "channel") {
      void channels.open(chatId).then(() => channels.setTopic(tabId));
      return;
    }
    if (selectAgent(chatId)) agentThreads.open(chatId, tabId);
  };
  /** The tabs of each chat, as its row shows them: the agent's own chat and its threads, a channel's tabs. */
  const chatTabs = createMemo((): Record<string, SidebarChatTabs> => {
    const tabsByChat: Record<string, SidebarChatTabs> = {};
    if (agentTasks.available()) {
      for (const agent of agentList()) {
        const snapshot = agentTasks.snapshot(agent.id);
        const ids = snapshot ? agentThreads.openIds(agent.id) : agentThreads.storedOpenIds(agent.id);
        const tasks = snapshot?.tasks ?? [];
        const tabs = [
          { id: MAIN_THREAD_ID, title: t("sidebar.tabs.main") },
          ...ids.flatMap((id) => {
            const task = tasks.find((entry) => entry.id === id);
            return task
              ? [{ id, title: task.title, working: task.state === "running", queued: task.state === "queued" }]
              : [];
          }),
          ...(agentThreads.hasDraft(agent.id) ? [{ id: DRAFT_THREAD_ID, title: t("sidebar.tabs.thread") }] : []),
        ];
        if (tabs.length > 1) {
          tabsByChat[sidebarChatTabsKey({ kind: "agent", id: agent.id })] = {
            tabs,
            activeId: agentThreads.activeId(agent.id),
          };
        }
      }
    }
    for (const channel of visibleChannels()) {
      const topics = channel.topics ?? [];
      if (topics.length < 2) continue;
      const activeId =
        (channels.state.selectedId === channel.id ? channels.state.topicId : null) ?? lastChannelTopics()[channel.id];
      tabsByChat[sidebarChatTabsKey({ kind: "channel", id: channel.id })] = {
        tabs: topics.map((topic) => ({
          id: topic.id,
          title: topic.name,
          unread: topic.unreadCount,
          working: (topic.activeTasks ?? 0) > 0,
          queued: (topic.openTasks ?? 0) > (topic.activeTasks ?? 0),
        })),
        activeId: topics.some((topic) => topic.id === activeId) ? (activeId ?? "") : (topics[0]?.id ?? ""),
      };
    }
    return tabsByChat;
  });
  // A chat that is not open has no thread list here yet. Its stored tabs are read so the row can show them.
  createEffect(
    () =>
      agentTasks.available()
        ? agentList()
            .filter((agent) => !agentTasks.snapshot(agent.id) && agentThreads.storedOpenIds(agent.id).length > 0)
            .map((agent) => agent.id)
            .join("\n")
        : "",
    (missing) => {
      for (const agentId of missing ? missing.split("\n") : []) void agentTasks.loadTasks(agentId);
    },
  );
  /**
   * Opens the agent's chat with a new thread. A host without threads has no such item, and neither has a
   * chat window: another agent opens in a window of its own, which does not get the new thread.
   */
  const newAgentThread = () =>
    agentTasks.available() && !platform.chatWindow
      ? (agentId: string) => {
          if (selectAgent(agentId)) agentThreads.startNew(agentId);
        }
      : undefined;
  /** The name of a chat as its sidebar row shows it. */
  const chatName = (entry: ChatHistoryEntry | undefined): { name: string } | null => {
    if (!entry) return null;
    if (entry.kind === "agent") return { name: agentList().find((agent) => agent.id === entry.id)?.name ?? "" };
    if (entry.kind === "channel") {
      return { name: channels.state.channels.find((channel) => channel.id === entry.id)?.name ?? "" };
    }
    const member = directPeople().find((person) => person.id === entry.id);
    return { name: member ? teamMemberName(member) : "" };
  };
  const {
    sidebarLayout,
    collapsedSidebarSectionIds,
    mutateSidebarLayout,
    toggleSidebarSection,
    pinnedSidebarItems,
    sidebarPeopleOrder,
    pinSidebarItem,
    unpinSidebarItem,
    reorderPinnedSidebarItems,
    reorderSidebarPeople,
    selectedRailSectionId,
    selectRailSection,
  } = useSidebar();
  const [mobileAppDismissed, setMobileAppDismissed] = createSignal(
    window.localStorage.getItem(MOBILE_APP_DISMISSED_STORAGE_KEY) === "true",
  );
  /** The list filter: only active channels, only active agents, or the layout as it is when null. */
  const [activityFilter, setActivityFilter] = createSignal<SidebarActivityFilter | null>(null);
  const storageCard = createStorageCard(activeServer);
  const machineCard = createMachineCard(activeServer);
  // A clear in Server settings frees space and can change an alert level, so both cards read
  // again when settings close.
  createEffect(serverSettingsOpen, (open, wasOpen) => {
    if (!open && wasOpen) {
      storageCard.refresh();
      machineCard.refresh();
    }
  });
  // One warning card at a time. A disk machine card covers the disk, so it replaces the storage
  // card. A memory or CPU card gives way to a full disk, unless it is critical itself.
  const footerCard = createMemo(() => {
    const machine = machineCard.card();
    const storage = storageCard.card();
    if (machine && (machine.metric === "disk" || !storage || (machine.critical && storage.level !== "full")))
      return { kind: "machine" as const, card: machine };
    return storage ? { kind: "storage" as const, card: storage } : null;
  });
  const shownMachineCard = () => {
    const shown = footerCard();
    return shown?.kind === "machine" ? shown.card : null;
  };
  const shownStorageCard = () => {
    const shown = footerCard();
    return shown?.kind === "storage" ? shown.card : null;
  };
  // As the host picks it: the responsible member while an active admin, otherwise the owner.
  const machineRecipient = (memberId: string | null) => {
    const members = teamPresence().members;
    const member =
      members.find(
        (candidate) => candidate.id === memberId && !candidate.disabled && canAdministerServer(candidate.role),
      ) ?? members.find((candidate) => candidate.role === "owner");
    return member ? member.name?.trim() || member.username : null;
  };

  /* A channel can open while the Routines view is on: from search, a notification, or a selection
   * restored at start. Its row must be in the list, so the list goes back to the agents view. */
  createEffect(
    () => layout.sidebarView() === "routines" && channels.state.selectedId !== null,
    (channelOpenInRoutines) => {
      if (channelOpenInRoutines) layout.setSidebarView("agents");
    },
  );

  /* The agent conversation shows only the waits of the agent's own thread. A wait in a channel
   * thread stays out of "Needs you", because selecting the row cannot answer it. */
  const sidebarAgentStates = createMemo(() =>
    computeSidebarAgentStates({
      agentIds: agentList().map((agent) => agent.id),
      activeTurns: activeTurns(),
      queues: queues(),
      unreadReplies: unreadReplies(),
      recentReplies: recentReplies(),
      ...agentThreadAttention({ agents: agentList(), pendingPrompts: pendingPrompts(), approvals: approvals() }),
      failedTurns: failedTurns(),
      usageLimits: usageLimits(),
    }),
  );

  /* A wait in a channel thread goes to the channel instead. Selecting the channel opens the view
   * that answers it. */
  const channelWaits = createMemo(() => {
    const prompts = Object.values(pendingPrompts());
    return sidebarChannelWaits({
      channels: visibleChannels(),
      prompts: prompts.flatMap((event) => (event?.type === "prompt" ? [event] : [])),
      takeovers: prompts.flatMap((event) => (event?.type === "browser-takeover-requested" ? [event.request] : [])),
      approvals: approvals(),
    });
  });

  /* The badge says what an agent is doing; the face says how it is going. `isAgentWorking` is
   * shared, and a routine mark only replaces the badge for that same agent. */
  const agentMoods = createMemo(() =>
    computeAgentAvatarMoods({
      agentIds: agentList().map((agent) => agent.id),
      activeTurns: activeTurns(),
      queues: queues(),
      failedTurns: failedTurns(),
      pendingPrompts: attentionByAgent(pendingPrompts(), agentList()),
      pendingApprovals: pendingApprovals(),
      recentReplies: recentReplies(),
    }),
  );

  return (
    <Sidebar
      channels={visibleChannels()}
      deletedChannels={channelsListed() ? channels.state.channels.filter((channel) => channel.archived) : []}
      activeChannelId={channels.state.selectedId}
      onSelectChannel={openChannel}
      chatTabs={chatTabs()}
      onOpenChatTab={openChatTab}
      onEditChannel={(id) => void channels.editChannel(id)}
      onDeleteChannel={channels.deletionSupported() ? channels.remove : undefined}
      onRestoreChannel={channels.deletionSupported() ? channels.restore : undefined}
      showingArchivedChannels={channelsListed() && channels.state.archived}
      onToggleArchivedChannels={channelsListed() ? channels.toggleArchived : undefined}
      onCreateChannel={channelsListed() ? channels.create : undefined}
      onMarkAllRead={() => {
        void markAllAgentMessagesRead();
        void channels.markAllRead();
      }}
      hasUnread={
        agentList().some((agent) => !userHiddenAgentIds().has(agent.id) && (unreadReplies()[agent.id] ?? 0) > 0) ||
        channels.hasUnread()
      }
      view={layout.sidebarView()}
      activityFilter={activityFilter()}
      onActivityFilterChange={setActivityFilter}
      serverName={activeServer()?.name ?? t("sidebar.topbar.localServer")}
      onOpenServerSettings={(trigger) => {
        const server = activeServer();
        if (server) openServerSettings(server.id, trigger);
      }}
      chatHistory={{
        back: chatName(chatHistory.previous()),
        forward: chatName(chatHistory.next()),
        keys: chatHistoryKeys(platform.appInfo()?.platform === "darwin"),
        onBack: chatHistory.goBack,
        onForward: chatHistory.goForward,
      }}
      serverUpdate={(() => {
        const server = activeServer();
        const badge = server ? serverUpdateBadge(server.id) : null;
        return server && badge ? { ...badge, onOpen: () => void showServerUpdate(server.id) } : undefined;
      })()}
      serverMenu={
        platform.appInfo()
          ? {
              servers: serverActions.orderedServers(),
              view: layout.serverView(),
              onViewChange: layout.setServerView,
              onSelect: serverActions.select,
              onAdd: serverActions.add,
              addCreatesServer: serverActions.addCreatesServer(),
              ...serverActions.callbacks,
            }
          : undefined
      }
      // Only Agents, Routines, Workflows and Schedule show the rail; another page has no rail column.
      sectionRail={
        layout.sectionRailVisible() && sectionRailShowsOn(windowPage.page())
          ? { selectedId: selectedRailSectionId(), onSelect: selectRailSection }
          : undefined
      }
      sectionIconsSupported={activeServer()?.kind === "local" && activeServerSupportsCapability("sidebar-layout")}
      markersSupported={activeServer()?.kind === "local" && activeServerSupportsCapability("sidebar-layout")}
      agents={agentList()}
      activeAgentId={activeDirectMember() || channels.state.selectedId ? "" : (activeAgent()?.id ?? "")}
      showPeople={props.peopleEnabled}
      people={directPeople()}
      directThreads={directThreads()}
      activeDirectMemberId={activeDirectMemberId()}
      agentStates={sidebarAgentStates()}
      channelWaits={channelWaits()}
      agentMoods={agentMoods()}
      layout={sidebarLayout()}
      layoutMutable={activeServerSupportsCapability("sidebar-layout")}
      collapsedSectionIds={collapsedSidebarSectionIds()}
      onMutateLayout={mutateSidebarLayout}
      sectionDuplicateSupported={
        activeServerSupportsCapability("agent-duplication") && activeServerSupportsCapability("sidebar-layout")
      }
      duplicatingSectionIds={duplicatingSectionIds()}
      onDuplicateSection={duplicateSection}
      sectionColorSupported={activeServer()?.kind === "local" && activeServerSupportsCapability("sidebar-layout")}
      onToggleSection={toggleSidebarSection}
      pinnedItems={pinnedSidebarItems()}
      peopleOrder={sidebarPeopleOrder()}
      onPin={pinSidebarItem}
      onUnpin={unpinSidebarItem}
      onReorderPinned={reorderPinnedSidebarItems}
      onReorderPeople={reorderSidebarPeople}
      onSelectAgent={selectAgent}
      onSelectPerson={(memberId) => void selectDirectMember(memberId)}
      onPreloadDirectConversation={props.peopleEnabled ? () => void DirectConversation.preload() : undefined}
      onCreateAgent={() => {
        channels.close();
        openAgentSetup();
      }}
      onEditAgent={editAgent}
      duplicateSupported={activeServerSupportsCapability("agent-duplication")}
      duplicatingAgentIds={duplicatingAgentIds()}
      onDuplicateAgent={duplicateAgent}
      onDeleteAgent={deleteAgent}
      userHiddenAgents={userHiddenAgents()}
      onHideAgent={hideAllowed() ? (agentId) => void setAgentHiddenByUser(agentId, true) : undefined}
      onRestoreAgent={hideAllowed() ? (agentId) => void setAgentHiddenByUser(agentId, false) : undefined}
      onNewAgentThread={newAgentThread()}
      onOpenAgentWindow={
        platform.landingPreview
          ? undefined
          : (agentId) => void appPort().openChatWindow({ serverId: activeServerId(), agentId })
      }
      windowAgentIds={windowAgentIds()}
      compact={layout.leftPanelCompact()}
      onExpand={layout.expandSidebar}
      onOpenSearch={() => setGlobalSearchVisibility(true)}
      footer={
        <>
          {/* One card at a time. A machine over its alert level comes first, then a disk that is
           * almost full; the mobile app card comes last. */}
          <Show when={shownMachineCard()}>
            {(card) => (
              <SidebarMachineCard
                serverName={activeServer()?.name ?? ""}
                metric={card().metric}
                percent={card().percent}
                level={card().level}
                freeBytes={card().freeBytes}
                critical={card().critical}
                recipientName={machineRecipient(card().responsibleMemberId)}
                onOpenDetails={() => openServerSettings(card().serverId, null, "storage")}
                onDismiss={() => machineCard.dismiss(card().serverId, card())}
              />
            )}
          </Show>
          <Show when={shownStorageCard()}>
            {(card) => (
              <SidebarStorageCard
                level={card().level}
                serverName={activeServer()?.name ?? ""}
                freeBytes={card().freeBytes}
                totalBytes={card().totalBytes}
                onFreeUpSpace={() => openServerSettings(card().serverId, null, "storage")}
                onDismiss={() => storageCard.dismiss(card().serverId)}
              />
            )}
          </Show>
          <Show when={!platform.landingPreview && !footerCard() && !mobileAppDismissed()}>
            <SidebarMobileAppCard
              onOpenInstall={() => openAppSettings(null, "mobile-connect")}
              onDismiss={() => {
                window.localStorage.setItem(MOBILE_APP_DISMISSED_STORAGE_KEY, "true");
                setMobileAppDismissed(true);
              }}
            />
          </Show>
          <SidebarUpdateIsland />
        </>
      }
      onOpenMarketplace={() => setSkillsMarketplaceOpen(true)}
      agentsConnecting={agentListConnecting()}
      emptyAction={
        agentList().length === 0 && agentListSettled()
          ? {
              label: t("sidebar.empty.firstAgent"),
              avatarSeed: agentSetupDraft().avatarSeed,
              avatarHue: agentSetupDraft().avatarHue,
              onSelect: () => {
                channels.close();
                openAgentSetup();
              },
            }
          : undefined
      }
    />
  );
}
