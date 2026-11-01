import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the settings context reaches in main: the app-wide preferences, the switches for updates,
 * notifications and the Dynamic Island, the local agents and their background processes of the
 * Agents tab, the lid-closed mode of the General tab, and the agents and the user's own notification
 * levels of each server for the Notifications tab.
 */
export interface SettingsPort {
  getAgentDefaults: BuildersBotDesktopApi["getAgentDefaults"];
  getAgentMemoryLimitPreference: BuildersBotDesktopApi["getAgentMemoryLimitPreference"];
  getAnalyticsPreference: BuildersBotDesktopApi["getAnalyticsPreference"];
  getAppBehaviorPreference: BuildersBotDesktopApi["getAppBehaviorPreference"];
  getApprovalAutomation: BuildersBotDesktopApi["getApprovalAutomation"];
  getBusyMessageModePreference: BuildersBotDesktopApi["getBusyMessageModePreference"];
  getExternalLinkPreference: BuildersBotDesktopApi["getExternalLinkPreference"];
  listExternalLinkBrowsers: BuildersBotDesktopApi["listExternalLinkBrowsers"];
  chooseExternalLinkApp: BuildersBotDesktopApi["chooseExternalLinkApp"];
  onExternalLinkFallback: BuildersBotDesktopApi["onExternalLinkFallback"];
  getRemoteNetworkRoute: BuildersBotDesktopApi["getRemoteNetworkRoute"];
  getRemoteSessionReusePreference: BuildersBotDesktopApi["getRemoteSessionReusePreference"];
  getGuardPreference: BuildersBotDesktopApi["getGuardPreference"];
  /** The encrypted files of this computer that cannot be decrypted now, for the notice of the General tab. */
  getUnreadableSecrets: BuildersBotDesktopApi["getUnreadableSecrets"];
  /** A treg setup of the person's own in the MCP files of other agent apps, for the notice of the General tab. */
  getPersonalVendorMcp: BuildersBotDesktopApi["getPersonalVendorMcp"];
  onAgentMemoryLimitPreference: BuildersBotDesktopApi["onAgentMemoryLimitPreference"];
  onAnalyticsPreference: BuildersBotDesktopApi["onAnalyticsPreference"];
  onApprovalAutomation: BuildersBotDesktopApi["onApprovalAutomation"];
  onOpenSettings: BuildersBotDesktopApi["onOpenSettings"];
  onOpenUpdateSettings: BuildersBotDesktopApi["onOpenUpdateSettings"];
  setAgentDefaults: BuildersBotDesktopApi["setAgentDefaults"];
  setAnalyticsPreference: BuildersBotDesktopApi["setAnalyticsPreference"];
  setAppBehaviorPreference: BuildersBotDesktopApi["setAppBehaviorPreference"];
  setBusyMessageModePreference: BuildersBotDesktopApi["setBusyMessageModePreference"];
  setExternalLinkPreference: BuildersBotDesktopApi["setExternalLinkPreference"];
  setRemoteNetworkRoute: BuildersBotDesktopApi["setRemoteNetworkRoute"];
  setRemoteSessionReusePreference: BuildersBotDesktopApi["setRemoteSessionReusePreference"];
  setGuardPreference: BuildersBotDesktopApi["setGuardPreference"];
  /** The advanced optimizations (beta) of this computer, for the General tab. */
  getOptimizations: BuildersBotDesktopApi["getOptimizations"];
  setOptimizations: BuildersBotDesktopApi["setOptimizations"];
  /** The retries and backup model of a start that fails, for the Agents tab. */
  getStartRetry: BuildersBotDesktopApi["getStartRetry"];
  setStartRetry: BuildersBotDesktopApi["setStartRetry"];
  voice: Pick<BuildersBotDesktopApi["voice"], "getDictationPreference" | "setDictationPreference">;
  agent: Pick<
    BuildersBotDesktopApi["agent"],
    | "listAgents"
    | "listModels"
    | "updateAgent"
    | "listAgentNotificationLevels"
    | "setAgentNotificationLevel"
    | "onScopedEvent"
  >;
  backgroundProcesses: BuildersBotDesktopApi["backgroundProcesses"];
  lidAwake: BuildersBotDesktopApi["lidAwake"];
  dynamicIsland: Pick<
    BuildersBotDesktopApi["dynamicIsland"],
    "getBuiltInDisplayGeometry" | "getPreference" | "setPreference"
  >;
  notifications: Pick<
    BuildersBotDesktopApi["notifications"],
    "getPreference" | "openSettings" | "setPreference" | "test"
  >;
  update: Pick<BuildersBotDesktopApi["update"], "getPreference" | "onPreference" | "setPreference">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function settingsPort(): SettingsPort {
  return window.openbot;
}
