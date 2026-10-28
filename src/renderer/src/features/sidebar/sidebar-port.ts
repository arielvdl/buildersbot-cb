import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the sidebar reaches in main: the saved sidebar layout and its changes, and the free space
 * on the disk of a server for the storage card.
 */
export interface SidebarPort {
  agent: Pick<BuildersBotDesktopApi["agent"], "getSidebarLayout" | "mutateSidebarLayout">;
  storage: Pick<BuildersBotDesktopApi["storage"], "getDisk">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function sidebarPort(): SidebarPort {
  return window.openbot;
}
