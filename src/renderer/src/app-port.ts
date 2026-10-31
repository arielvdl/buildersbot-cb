import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the app shell and the cross-domain root modules reach in main, plus the shell actions
 * (`openUrl`, `openExternal`) that several domains share.
 */
export interface AppPort {
  getAppInfo: BuildersBotDesktopApi["getAppInfo"];
  getAppAppearancePreference: BuildersBotDesktopApi["getAppAppearancePreference"];
  getAppInterfaceSizePreference: BuildersBotDesktopApi["getAppInterfaceSizePreference"];
  getAppLanguagePreference: BuildersBotDesktopApi["getAppLanguagePreference"];
  getAppLogoColorPreference: BuildersBotDesktopApi["getAppLogoColorPreference"];
  onAppAppearancePreference: BuildersBotDesktopApi["onAppAppearancePreference"];
  onAppInterfaceSizePreference: BuildersBotDesktopApi["onAppInterfaceSizePreference"];
  onAppLanguagePreference: BuildersBotDesktopApi["onAppLanguagePreference"];
  onAppLogoColorPreference: BuildersBotDesktopApi["onAppLogoColorPreference"];
  openExternal: BuildersBotDesktopApi["openExternal"];
  openUrl: BuildersBotDesktopApi["openUrl"];
  openChatWindow: BuildersBotDesktopApi["openChatWindow"];
  getChatWindows: BuildersBotDesktopApi["getChatWindows"];
  onChatWindows: BuildersBotDesktopApi["onChatWindows"];
  setAppAppearancePreference: BuildersBotDesktopApi["setAppAppearancePreference"];
  setAppInterfaceSizePreference: BuildersBotDesktopApi["setAppInterfaceSizePreference"];
  setAppLanguagePreference: BuildersBotDesktopApi["setAppLanguagePreference"];
  setAppLogoColorPreference: BuildersBotDesktopApi["setAppLogoColorPreference"];
  getLoad: BuildersBotDesktopApi["getLoad"];
  setLoadLane: BuildersBotDesktopApi["setLoadLane"];
  runChannelNow: BuildersBotDesktopApi["runChannelNow"];
  stopWork: BuildersBotDesktopApi["stopWork"];
  resumeStoppedWork: BuildersBotDesktopApi["resumeStoppedWork"];
  reassignStoppedWork: BuildersBotDesktopApi["reassignStoppedWork"];
  setAutoRecovery: BuildersBotDesktopApi["setAutoRecovery"];
  setAgentLimit: BuildersBotDesktopApi["setAgentLimit"];
  getResumeOffer: BuildersBotDesktopApi["getResumeOffer"];
  resumeInterruptedWork: BuildersBotDesktopApi["resumeInterruptedWork"];
  dismissResumeOffer: BuildersBotDesktopApi["dismissResumeOffer"];
  agent: Pick<
    BuildersBotDesktopApi["agent"],
    "readConversationPage" | "searchConversationMessages" | "searchConversationFiles" | "listRoutines" | "listAgents"
  >;
  agentTemplates: Pick<BuildersBotDesktopApi["agentTemplates"], "onOpenLink" | "takePendingLink">;
  acpRegistry: BuildersBotDesktopApi["acpRegistry"];
  hostedSites: BuildersBotDesktopApi["hostedSites"];
  billing: BuildersBotDesktopApi["billing"];
  license: BuildersBotDesktopApi["license"];
  hostedServers: BuildersBotDesktopApi["hostedServers"];
  routineFeed: BuildersBotDesktopApi["routineFeed"];
  events: BuildersBotDesktopApi["events"];
  voice: Pick<
    BuildersBotDesktopApi["voice"],
    | "transcribe"
    | "finishDictation"
    | "cancelDictation"
    | "onDictationState"
    | "getSettings"
    | "getServer"
    | "startStream"
    | "appendStream"
    | "finishStream"
    | "cancelStream"
  >;
  plugins: Pick<BuildersBotDesktopApi["plugins"], "onOpenListing" | "takePendingListing">;
  servers: Pick<BuildersBotDesktopApi["servers"], "onInvite" | "takePendingInvite">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function appPort(): AppPort {
  return window.openbot;
}
