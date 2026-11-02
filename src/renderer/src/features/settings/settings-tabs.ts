import type { AppInfo, UpdateStatus } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Bell,
  Bot,
  CircleArrowDown,
  CreditCard,
  Gauge,
  Mic,
  MousePointer2,
  PanelTop,
  ScanEye,
  Server,
  Settings,
  ShieldCheck,
  Smartphone,
  UserRound,
} from "@openbot/ui";
import type { GeneralSettingsValue } from "@openbot/ui/features/settings/app-settings";
import type { AGENT_DEFAULT_SETTINGS } from "@openbot/ui/features/settings/SettingsAgentsTab";

export type SettingsTab =
  | "general"
  | "agents"
  | "guard"
  | "load"
  | "task-reviewer"
  | "notifications"
  | "voice"
  | "dynamic-island"
  | "computer-use"
  | "profile"
  | "billing"
  | "mobile-connect"
  | "updates"
  | "hosted-servers";

/** The state that decides whether a tab shows a row now. */
export interface SettingsRowState {
  platform: AppInfo["platform"] | undefined;
  general: GeneralSettingsValue;
  /** The Updates tab shows its rows by the update phase and by the host that manages the updates. */
  update: Pick<UpdateStatus, "phase" | "managedByHost">;
}

/**
 * A row of a tab that the settings search finds. `anchor` is the title key of the row and also its
 * anchor: the row markup sets `data-settings-row` to it, so a search result can move to the row.
 * `bun run check:ui` fails when a `data-settings-row` has no row here, or a row here has no markup.
 */
export interface SettingsRow {
  anchor: AppTextKey;
  descriptionKey?: AppTextKey;
  /** More words that find the row, such as other names and related words. */
  keywordsKey?: AppTextKey;
  /** False while the tab does not show the row, so the search does not list it. */
  shown?: (state: SettingsRowState) => boolean;
}

/**
 * A tab holds the keys of its label and its header text, not the text itself. The list is read at
 * module level, before any component exists to translate it, and a label captured there would keep
 * the language the app started in. `rows` lists the rows of the tab in page order, for the search.
 */
type SettingsNavItem = {
  value: SettingsTab;
  titleKey: AppTextKey;
  descriptionKey: AppTextKey;
  keywordsKey: AppTextKey;
  icon: typeof Settings;
  rows: ReadonlyArray<SettingsRow>;
};

type AgentDefaultRow = (typeof AGENT_DEFAULT_SETTINGS)[number];

/**
 * The rows of the Agents tab, one for each setting that `SettingsAgentsTab` lists, in its order. Its
 * markup sets the anchor from `AGENT_DEFAULT_SETTINGS`, so the type requires each setting here with
 * the same title.
 */
const AGENT_ROWS = {
  allowAutomation: {
    anchor: "agentSettings.automation.title",
    descriptionKey: "agentSettings.automation.description",
    keywordsKey: "settings.search.keywords.agentAutomation",
  },
  allowNewChat: {
    anchor: "agentSettings.agentNewChat.title",
    descriptionKey: "agentSettings.agentNewChat.description",
  },
  quickAcknowledgement: {
    anchor: "agentSettings.quickAcknowledgement.title",
    descriptionKey: "agentSettings.quickAcknowledgement.description",
  },
  securityGuard: {
    anchor: "agentSettings.securityGuard.title",
    descriptionKey: "agentSettings.securityGuard.description",
    keywordsKey: "settings.search.keywords.promptGuard",
  },
  busyMessageMode: {
    anchor: "settings.busyMessage.title",
    descriptionKey: "settings.busyMessage.description",
    keywordsKey: "settings.search.keywords.busyMessage",
  },
} as const satisfies {
  [Key in AgentDefaultRow["key"]]: SettingsRow & { anchor: Extract<AgentDefaultRow, { key: Key }>["title"] };
};

const autoUpdateKeywords = "settings.search.keywords.autoUpdate";
/** A host that manages the updates replaces the three update switches with one note. */
const updatesManaged = (state: SettingsRowState) => state.update.managedByHost === true;

export const navItems: ReadonlyArray<SettingsNavItem> = [
  {
    value: "general",
    titleKey: "settings.tab.general.title",
    descriptionKey: "settings.tab.general.description",
    keywordsKey: "settings.search.keywords.general",
    icon: Settings,
    rows: [
      {
        anchor: "settings.appearance.theme.title",
        descriptionKey: "settings.appearance.theme.description",
        keywordsKey: "settings.search.keywords.theme",
      },
      {
        anchor: "settings.appearance.transparentWindow.title",
        descriptionKey: "settings.appearance.transparentWindow.description",
        keywordsKey: "settings.search.keywords.transparentWindow",
        shown: (state) => state.platform === "darwin",
      },
      {
        anchor: "settings.language.title",
        descriptionKey: "settings.language.description",
        keywordsKey: "settings.search.keywords.language",
      },
      {
        anchor: "settings.interfaceSize.title",
        descriptionKey: "settings.interfaceSize.description",
        keywordsKey: "settings.search.keywords.interfaceSize",
      },
      {
        anchor: "settings.leftColumn.title",
        descriptionKey: "settings.leftColumn.description",
        keywordsKey: "settings.search.keywords.leftColumn",
      },
      {
        anchor: "settings.logoColor.title",
        descriptionKey: "settings.logoColor.description",
        keywordsKey: "settings.search.keywords.logoColor",
      },
      {
        anchor: "settings.sendShortcut.title",
        descriptionKey: "settings.sendShortcut.description",
        keywordsKey: "settings.search.keywords.sendShortcut",
      },
      {
        anchor: "settings.showAgentSteps.title",
        descriptionKey: "settings.showAgentSteps.description",
        keywordsKey: "settings.search.keywords.showAgentSteps",
      },
      {
        anchor: "settings.askBeforeForce.title",
        descriptionKey: "settings.askBeforeForce.description",
        keywordsKey: "settings.search.keywords.askBeforeForce",
      },
      {
        anchor: "settings.promptGuard.title",
        descriptionKey: "settings.promptGuard.description",
        keywordsKey: "settings.search.keywords.promptGuard",
      },
      {
        anchor: "settings.dictation.title",
        descriptionKey: "settings.dictation.description",
        keywordsKey: "settings.search.keywords.dictation",
      },
      {
        anchor: "settings.dictation.key",
        descriptionKey: "settings.dictation.keyDescription",
        keywordsKey: "settings.search.keywords.dictationKey",
        shown: (state) => state.general.dictationEnabled,
      },
      {
        anchor: "settings.dictation.mode",
        descriptionKey: "settings.dictation.modeDescription",
        keywordsKey: "settings.search.keywords.dictationMode",
        shown: (state) => state.general.dictationEnabled,
      },
      {
        anchor: "settings.dictation.engine",
        descriptionKey: "settings.dictation.engineDescription",
        keywordsKey: "settings.search.keywords.dictationEngine",
        shown: (state) => state.general.dictationEnabled,
      },
      {
        anchor: "settings.externalLinks.title",
        descriptionKey: "settings.externalLinks.description",
        keywordsKey: "settings.search.keywords.externalLinks",
      },
      {
        anchor: "settings.launchAtLogin.title",
        descriptionKey: "settings.launchAtLogin.description",
        keywordsKey: "settings.search.keywords.launchAtLogin",
        shown: (state) => state.general.launchAtLogin !== null,
      },
      {
        anchor: "settings.keepRemoteSessions.title",
        descriptionKey: "settings.keepRemoteSessions.description",
        keywordsKey: "settings.search.keywords.keepRemoteSessions",
      },
      {
        anchor: "settings.keepRunning.title",
        descriptionKey: "settings.keepRunning.description",
        keywordsKey: "settings.search.keywords.keepRunning",
        shown: (state) => state.general.keepRunningInBackground !== null,
      },
      {
        anchor: "settings.keepAwake.title",
        descriptionKey: "settings.keepAwake.description",
        keywordsKey: "settings.search.keywords.keepAwake",
        shown: (state) => state.general.keepAwake !== null,
      },
      {
        anchor: "settings.keepAwakeOnBattery.title",
        descriptionKey: "settings.keepAwakeOnBattery.description",
        keywordsKey: "settings.search.keywords.keepAwakeOnBattery",
        shown: (state) => state.general.keepAwake !== null,
      },
      // `LidAwakeSettings` shows these rows on macOS. A Mac with no lid shows the first one with a note. The
      // battery and time rows show only in a lid mode that uses them; a result for a hidden row says why.
      {
        anchor: "settings.lidAwake.title",
        descriptionKey: "settings.lidAwake.description",
        keywordsKey: "settings.search.keywords.lidAwake",
        shown: (state) => state.platform === "darwin" && state.general.keepAwake !== null,
      },
      {
        anchor: "settings.lidAwake.test.title",
        descriptionKey: "settings.lidAwake.test.description",
        keywordsKey: "settings.search.keywords.lidAwakeTest",
        shown: (state) => state.platform === "darwin" && state.general.keepAwake !== null,
      },
      {
        anchor: "settings.lidAwake.batteryFloor.title",
        descriptionKey: "settings.lidAwake.batteryFloor.description",
        keywordsKey: "settings.search.keywords.keepAwakeOnBattery",
        shown: (state) => state.platform === "darwin" && state.general.keepAwake !== null,
      },
      {
        anchor: "settings.lidAwake.timeLimit.title",
        descriptionKey: "settings.lidAwake.timeLimit.description",
        keywordsKey: "settings.search.keywords.lidAwake",
        shown: (state) => state.platform === "darwin" && state.general.keepAwake !== null,
      },
      {
        anchor: "settings.restoreWorkspace.title",
        descriptionKey: "settings.restoreWorkspace.description",
        keywordsKey: "settings.search.keywords.restoreWorkspace",
      },
      {
        anchor: "settings.browserInApp.title",
        descriptionKey: "settings.browserInApp.description",
        keywordsKey: "settings.search.keywords.browserInApp",
      },
      {
        anchor: "settings.chromeAgents.title",
        descriptionKey: "settings.chromeAgents.description",
        keywordsKey: "settings.search.keywords.chromeAgents",
      },
      {
        anchor: "settings.culturaBuilderFullContext.title",
        descriptionKey: "settings.culturaBuilderFullContext.description",
        keywordsKey: "settings.search.keywords.culturaBuilderFullContext",
      },
      {
        anchor: "settings.analytics.title",
        descriptionKey: "settings.analytics.description",
        keywordsKey: "settings.search.keywords.analytics",
      },
      {
        anchor: "settings.optimizations.title",
        descriptionKey: "settings.optimizations.description",
        keywordsKey: "settings.search.keywords.optimizations",
      },
    ],
  },
  {
    value: "agents",
    titleKey: "settings.tab.agents.title",
    descriptionKey: "settings.tab.agents.description",
    keywordsKey: "settings.search.keywords.agents",
    icon: Bot,
    rows: [
      // A new agent setting fails the type of AGENT_ROWS until it has a row there, and then shows here.
      ...Object.values(AGENT_ROWS),
      {
        anchor: "settings.backgroundProcesses.title",
        descriptionKey: "settings.backgroundProcesses.description",
        keywordsKey: "settings.search.keywords.backgroundProcesses",
      },
    ],
  },
  {
    value: "guard",
    titleKey: "guard.tab.title",
    descriptionKey: "guard.tab.description",
    keywordsKey: "settings.search.keywords.guard",
    icon: ShieldCheck,
    rows: [
      {
        anchor: "guard.level.title",
        descriptionKey: "guard.level.description",
        keywordsKey: "settings.search.keywords.guardLevel",
      },
      {
        anchor: "guard.model.title",
        descriptionKey: "guard.model.description",
        keywordsKey: "settings.search.keywords.guardModel",
      },
      { anchor: "guard.ask.title", descriptionKey: "guard.ask.card", keywordsKey: "settings.search.keywords.guardAsk" },
      {
        anchor: "guard.leaves.title",
        descriptionKey: "guard.leaves.suspicious",
        keywordsKey: "settings.search.keywords.guardLeaves",
      },
    ],
  },
  // The load of this computer ("Carga" in Portuguese): the ring of the rail opens it. The stopped work,
  // with actions on many runs at once, then what runs and the switches of the load.
  {
    value: "load",
    titleKey: "settings.tab.load.title",
    descriptionKey: "settings.tab.load.description",
    keywordsKey: "settings.search.keywords.load",
    icon: Gauge,
    rows: [
      {
        anchor: "settings.load.stopped.title",
        descriptionKey: "settings.load.stopped.description",
        keywordsKey: "settings.search.keywords.load",
      },
      {
        anchor: "settings.load.overview.title",
        descriptionKey: "settings.load.overview.description",
        keywordsKey: "settings.search.keywords.load",
      },
    ],
  },
  // The task reviewer ("Fiscal" in Portuguese). Its switches are also on the load page;
  // both places change the same preference through the same calls.
  {
    value: "task-reviewer",
    titleKey: "settings.tab.taskReviewer.title",
    descriptionKey: "settings.tab.taskReviewer.description",
    keywordsKey: "settings.search.keywords.taskReviewer",
    icon: ScanEye,
    rows: [
      {
        anchor: "settings.taskReviewer.enabled.title",
        descriptionKey: "settings.taskReviewer.enabled.description",
        keywordsKey: "settings.search.keywords.taskReviewer",
      },
      {
        anchor: "settings.taskReviewer.quiet.title",
        descriptionKey: "settings.taskReviewer.quiet.description",
        keywordsKey: "settings.search.keywords.taskReviewerQuiet",
      },
      {
        anchor: "settings.taskReviewer.model.title",
        descriptionKey: "settings.taskReviewer.model.description",
        keywordsKey: "settings.search.keywords.taskReviewerModel",
      },
      {
        anchor: "app.rail.load.recoveryTitle",
        descriptionKey: "settings.taskReviewer.load.description",
        keywordsKey: "settings.search.keywords.taskReviewerRecovery",
      },
      {
        anchor: "app.rail.load.recoveryReassign",
        descriptionKey: "settings.taskReviewer.reassign.description",
        keywordsKey: "settings.search.keywords.taskReviewerRecovery",
      },
      {
        anchor: "settings.loadPanel.title",
        descriptionKey: "settings.loadPanel.description",
        keywordsKey: "settings.search.keywords.taskReviewerRecovery",
      },
      { anchor: "settings.taskReviewer.waits.title", keywordsKey: "settings.search.keywords.taskReviewer" },
      { anchor: "settings.taskReviewer.recent.title", keywordsKey: "settings.search.keywords.taskReviewer" },
      { anchor: "settings.taskReviewer.does.title", keywordsKey: "settings.search.keywords.taskReviewer" },
      { anchor: "settings.taskReviewer.doesNot.title", keywordsKey: "settings.search.keywords.taskReviewer" },
    ],
  },
  {
    value: "profile",
    titleKey: "settings.tab.profile.title",
    descriptionKey: "settings.tab.profile.description",
    keywordsKey: "settings.search.keywords.profile",
    icon: UserRound,
    rows: [
      {
        anchor: "settings.profile.email.title",
        descriptionKey: "settings.profile.email.description",
        keywordsKey: "settings.search.keywords.email",
      },
      {
        anchor: "settings.profile.sessions.title",
        descriptionKey: "settings.profile.sessions.description",
        keywordsKey: "settings.search.keywords.sessions",
      },
    ],
  },
  {
    value: "notifications",
    titleKey: "settings.tab.notifications.title",
    descriptionKey: "settings.tab.notifications.description",
    keywordsKey: "settings.search.keywords.notifications",
    icon: Bell,
    rows: [
      { anchor: "settings.notifications.whatYouHear", keywordsKey: "settings.search.keywords.whatYouHear" },
      {
        anchor: "settings.desktopNotifications.title",
        descriptionKey: "settings.desktopNotifications.description",
        keywordsKey: "settings.search.keywords.desktopNotifications",
      },
      { anchor: "settings.notificationPreview.title", descriptionKey: "settings.notificationPreview.description" },
      { anchor: "settings.testNotification.title", descriptionKey: "settings.testNotification.description" },
      {
        anchor: "settings.sounds.title",
        descriptionKey: "settings.sounds.description",
        keywordsKey: "settings.search.keywords.sounds",
      },
      {
        anchor: "settings.sounds.muteAll.title",
        descriptionKey: "settings.sounds.muteAll.description",
        keywordsKey: "settings.search.keywords.taskSound",
      },
      { anchor: "settings.sounds.macos.title", descriptionKey: "settings.sounds.macos.description" },
      {
        anchor: "settings.sounds.recent.title",
        descriptionKey: "settings.sounds.description",
        keywordsKey: "settings.search.keywords.soundFeedback",
      },
    ],
  },
  {
    value: "voice",
    titleKey: "settings.tab.voice.title",
    descriptionKey: "settings.tab.voice.description",
    keywordsKey: "settings.search.keywords.voice",
    icon: Mic,
    rows: [
      { anchor: "settings.voice.models.title", keywordsKey: "settings.search.keywords.voiceModels" },
      // The grant of the system: only macOS and Windows tell it.
      {
        anchor: "settings.voice.microphone.title",
        descriptionKey: "settings.voice.microphone.agentCommands",
        shown: (state) => state.platform === "darwin" || state.platform === "win32",
      },
      {
        anchor: "settings.voice.language.title",
        descriptionKey: "settings.voice.language.description",
        keywordsKey: "settings.search.keywords.voiceLanguage",
      },
      {
        anchor: "settings.voice.speech.readReplies.title",
        descriptionKey: "settings.voice.speech.readReplies.description",
        keywordsKey: "settings.search.keywords.readReplies",
      },
      { anchor: "settings.voice.speech.voice.title", keywordsKey: "settings.search.keywords.speechVoice" },
      {
        anchor: "settings.voice.server.section",
        descriptionKey: "settings.voice.server.title",
        keywordsKey: "settings.search.keywords.voiceServer",
      },
    ],
  },
  {
    value: "dynamic-island",
    titleKey: "settings.tab.dynamicIsland.title",
    descriptionKey: "settings.tab.dynamicIsland.description",
    keywordsKey: "settings.search.keywords.dynamicIsland",
    icon: PanelTop,
    rows: [
      { anchor: "settings.notch.show.title", descriptionKey: "settings.notch.show.description" },
      { anchor: "settings.notch.idle.title", descriptionKey: "settings.notch.idle.description" },
      { anchor: "settings.notch.displays.title", descriptionKey: "settings.notch.displays.description" },
      { anchor: "settings.notch.haptics.title", descriptionKey: "settings.notch.haptics.description" },
      { anchor: "settings.notch.servers.title", descriptionKey: "settings.notch.servers.description" },
      { anchor: "settings.notch.size.title", descriptionKey: "settings.notch.size.description" },
    ],
  },
  {
    value: "computer-use",
    titleKey: "settings.tab.computerUse.title",
    descriptionKey: "settings.tab.computerUse.description",
    keywordsKey: "settings.search.keywords.computerUse",
    icon: MousePointer2,
    rows: [
      {
        anchor: "computerUse.permissions.title",
        descriptionKey: "computerUse.permissions.description",
        keywordsKey: "settings.search.keywords.computerUsePermissions",
      },
    ],
  },
  {
    value: "billing",
    titleKey: "settings.tab.billing.title",
    descriptionKey: "settings.tab.billing.description",
    keywordsKey: "settings.search.keywords.billing",
    icon: CreditCard,
    rows: [],
  },
  {
    value: "mobile-connect",
    titleKey: "settings.tab.mobileConnect.title",
    descriptionKey: "settings.tab.mobileConnect.description",
    keywordsKey: "settings.search.keywords.mobileConnect",
    icon: Smartphone,
    rows: [
      { anchor: "settings.mobileConnect.phones.title", descriptionKey: "settings.mobileConnect.phones.description" },
      { anchor: "settings.mobileConnect.phones.add", descriptionKey: "settings.mobileConnect.add.webApp.question" },
      // The tab shows it while this computer has a server. Without one, the search says that it does not show now.
      {
        anchor: "settings.mobileConnect.reach.publish",
        descriptionKey: "settings.mobileConnect.reach.offline.where",
        keywordsKey: "settings.search.keywords.mobileConnectPublish",
      },
      { anchor: "settings.mobileConnect.route.title", descriptionKey: "settings.mobileConnect.route.description" },
    ],
  },
  {
    value: "updates",
    titleKey: "settings.tab.updates.title",
    descriptionKey: "settings.tab.updates.description",
    keywordsKey: "settings.search.keywords.updates",
    icon: CircleArrowDown,
    rows: [
      {
        anchor: "settings.updates.track.title",
        descriptionKey: "settings.updates.track.description",
        keywordsKey: "settings.search.keywords.updateTrack",
      },
      // The tab offers the restart in each phase but the install itself.
      { anchor: "settings.updates.idleRestart.title", shown: (state) => state.update.phase !== "installing" },
      {
        anchor: "settings.updates.autoDownload.title",
        descriptionKey: "settings.updates.autoDownload.description",
        keywordsKey: autoUpdateKeywords,
        shown: (state) => !updatesManaged(state),
      },
      {
        anchor: "settings.updates.autoInstall.title",
        descriptionKey: "settings.updates.autoInstall.description",
        keywordsKey: autoUpdateKeywords,
        shown: (state) => !updatesManaged(state),
      },
      {
        anchor: "settings.updates.allowRemote.title",
        descriptionKey: "settings.updates.allowRemote.description",
        shown: (state) => !updatesManaged(state),
      },
      {
        anchor: "settings.updates.managed.title",
        descriptionKey: "settings.updates.managed.description",
        shown: updatesManaged,
      },
    ],
  },
  {
    value: "hosted-servers",
    titleKey: "settings.tab.hostedServers.title",
    descriptionKey: "settings.tab.hostedServers.description",
    keywordsKey: "settings.search.keywords.hostedServers",
    icon: Server,
    rows: [],
  },
];

export function navItem(tab: SettingsTab): SettingsNavItem {
  const found = navItems.find((item) => item.value === tab);
  if (!found) throw new Error(`Unknown settings tab: ${tab}`);
  return found;
}

/**
 * Whether the settings panel and its search show the tab. Hosted servers opens from its own entry, not
 * from this panel.
 */
export function settingsTabShown(tab: SettingsTab, dynamicIslandShown: boolean): boolean {
  if (tab === "hosted-servers") return false;
  return tab !== "dynamic-island" || dynamicIslandShown;
}

/**
 * The Dynamic Island exists only on macOS, and only the main window owns it: main rejects its calls
 * from a chat window.
 */
export function dynamicIslandSettingsShown(platform: AppInfo["platform"] | undefined, chatWindow: boolean): boolean {
  return platform === "darwin" && !chatWindow;
}
