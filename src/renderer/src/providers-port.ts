import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What provider state reaches in main: connecting, signing in and refreshing providers, and the
 * runtimes Builders Bot installs for them, on this computer or on a host the account administers.
 */
export interface ProvidersPort {
  cancelProviderCodeLogin: BuildersBotDesktopApi["cancelProviderCodeLogin"];
  connectProvider: BuildersBotDesktopApi["connectProvider"];
  cancelProviderSignIn: BuildersBotDesktopApi["cancelProviderSignIn"];
  refreshAgentProviders: BuildersBotDesktopApi["refreshAgentProviders"];
  setProviderOn: BuildersBotDesktopApi["setProviderOn"];
  restartProvider: BuildersBotDesktopApi["restartProvider"];
  cancelProviderRestart: BuildersBotDesktopApi["cancelProviderRestart"];
  startProviderCodeLogin: BuildersBotDesktopApi["startProviderCodeLogin"];
  providerRuntimes: BuildersBotDesktopApi["providerRuntimes"];
  connectProviderAccount: BuildersBotDesktopApi["connectProviderAccount"];
  cancelProviderAccountSignIn: BuildersBotDesktopApi["cancelProviderAccountSignIn"];
  renameProviderAccount: BuildersBotDesktopApi["renameProviderAccount"];
  removeProviderAccount: BuildersBotDesktopApi["removeProviderAccount"];
  providerUsageResets: BuildersBotDesktopApi["providerUsageResets"];
  resetProviderUsage: BuildersBotDesktopApi["resetProviderUsage"];
  /** The same, for the host of a joined server the account administers. */
  providerAdmin: BuildersBotDesktopApi["providerAdmin"];
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function providersPort(): ProvidersPort {
  return window.openbot;
}
