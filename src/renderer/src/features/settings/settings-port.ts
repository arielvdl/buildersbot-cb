import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the settings context reaches in main: the app-wide preferences, the switches for updates,
 * notifications and the Dynamic Island, and the local agents of the Agents tab.
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
  onAgentMemoryLimitPreference: BuildersBotDesktopApi["onAgentMemoryLimitPreference"];
  onApprovalAutomation: BuildersBotDesktopApi["onApprovalAutomation"];
  onOpenSettings: BuildersBotDesktopApi["onOpenSettings"];
  setAgentDefaults: BuildersBotDesktopApi["setAgentDefaults"];
  setAnalyticsPreference: BuildersBotDesktopApi["setAnalyticsPreference"];
  setAppBehaviorPreference: BuildersBotDesktopApi["setAppBehaviorPreference"];
  setBusyMessageModePreference: BuildersBotDesktopApi["setBusyMessageModePreference"];
  setExternalLinkPreference: BuildersBotDesktopApi["setExternalLinkPreference"];
  setRemoteNetworkRoute: BuildersBotDesktopApi["setRemoteNetworkRoute"];
  setRemoteSessionReusePreference: BuildersBotDesktopApi["setRemoteSessionReusePreference"];
  setGuardPreference: BuildersBotDesktopApi["setGuardPreference"];
  voice: Pick<BuildersBotDesktopApi["voice"], "getDictationPreference" | "setDictationPreference">;
  agent: Pick<BuildersBotDesktopApi["agent"], "listAgents" | "updateAgent">;
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
