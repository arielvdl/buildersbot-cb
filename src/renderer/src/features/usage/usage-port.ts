import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the usage panel reaches in main: the analytics of a server, its agents, and the events that
 * make the report stale.
 */
export interface UsagePort {
  agent: Pick<BuildersBotDesktopApi["agent"], "getHostAnalytics" | "listAgents" | "onScopedEvent">;
  servers: Pick<BuildersBotDesktopApi["servers"], "onEvent">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function usagePort(): UsagePort {
  return window.openbot;
}
